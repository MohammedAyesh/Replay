import { beforeAll, afterAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express, { type Express } from "express";
import { strToU8, zipSync } from "fflate";
import { eq } from "drizzle-orm";
import {
  db,
  fieldsTable,
  recordingsTable,
  recordingTrackingBundlesTable,
  recordingTrackingSegmentsTable,
  claimMatchIdentityBindingsTable,
  usersTable,
  type TrackingManifest,
} from "@workspace/db";

vi.mock("../lib/claimMatchStorage", () => ({
  deleteClaimSegment: vi.fn(),
  readClaimSegment: vi.fn(),
  readCompressedClaimSegment: vi.fn(),
  writeClaimSegment: vi.fn(),
}));

vi.mock("../lib/clerkUserBridge", () => ({
  getLocalAccountUserId: vi.fn(),
  getLocalUserId: vi.fn(),
  unauthenticatedResponse: vi.fn((res: any, _req: any, error = "Unauthenticated") => {
    res.status(401).json({ error });
  }),
}));

import claimMatchRouter, {
  completionAllowed,
  deriveClaimState,
  syncIdentityBinding,
  storeUploadBundle,
  trackingBundleFingerprint,
  type UploadBundle,
} from "./claimMatch";
import { deleteClaimSegment, readClaimSegment, writeClaimSegment } from "../lib/claimMatchStorage";
import { getLocalUserId } from "../lib/clerkUserBridge";

const mockedDeleteClaimSegment = vi.mocked(deleteClaimSegment);
const mockedReadClaimSegment = vi.mocked(readClaimSegment);
const mockedWriteClaimSegment = vi.mocked(writeClaimSegment);
const mockedGetLocalUserId = vi.mocked(getLocalUserId);
const TEST_TAG = `claim-replace-${Date.now()}`;

let app: Express;
let adminId: number;
let recordingId: number;
let fieldId: number;
let claimantAId: number;
let claimantBId: number;

const bindingManifest = {
  version: 1,
  label: "binding test",
  width: 100,
  height: 100,
  frameRate: 1,
  frameCount: 100,
  duration: 100,
  matchOffset: 0,
  segmentCount: 1,
  segments: [{ index: 0, name: "only", startFrame: 0, endFrame: 99, startSeconds: 0, endSeconds: 100 }],
} as never;

const bindingSegments = [{
  segmentIndex: 0,
  name: "only",
  startFrame: 0,
  endFrame: 99,
  startSeconds: 0,
  endSeconds: 100,
  tracks: [{ id: "piece-a", startFrame: 0, endFrame: 99, boxes: [] }],
  crossings: [],
  inPlaySpans: [],
  events: [],
}] as never;

function bindingCorrection(id: number, userId: number) {
  return {
    id,
    userId,
    recordingId,
    clientId: `binding-${id}`,
    momentSeconds: id * 10,
    rejectedTrackId: null,
    chosenTrackId: "piece-a",
    answerMethod: "anchor-yes",
    questionCount: 1,
    undone: false,
    createdAt: new Date(1_000 + id),
    updatedAt: new Date(1_000 + id),
  };
}

function makeUpload(): UploadBundle {
  const segment = (index: number): UploadBundle["segments"][number] => ({
    version: 1,
    segmentIndex: index,
    name: index === 0 ? "one" : "two",
    startFrame: index * 2,
    endFrame: index * 2 + 1,
    startSeconds: index * 0.08,
    endSeconds: (index + 1) * 0.08,
    tracks: [],
    crossings: [],
    inPlaySpans: [],
    events: [],
  });
  const segments = [segment(0), segment(1)];
  return {
    manifest: {
      version: 1,
      label: "replacement test",
      width: 1920,
      height: 1080,
      frameRate: 25,
      frameCount: 4,
      duration: 0.16,
      matchOffset: 0,
      videoStartSeconds: 0,
      segmentCount: segments.length,
      segments: segments.map((item) => ({
        index: item.segmentIndex,
        name: item.name,
        startFrame: item.startFrame,
        endFrame: item.endFrame,
        startSeconds: item.startSeconds,
        endSeconds: item.endSeconds,
        objectPath: "",
      })),
    },
    segments,
  };
}

async function insertPreviousBundle(): Promise<void> {
  const upload = makeUpload();
  const manifest: TrackingManifest = {
    ...upload.manifest,
    segments: upload.manifest.segments.map((segment, index) => ({
      ...segment,
      objectPath: `/objects/old-segment-${index}`,
      ...(index === 0 ? { spritesPath: "/objects/old-sprites-0" } : {}),
    })),
  };
  const [bundle] = await db
    .insert(recordingTrackingBundlesTable)
    .values({ recordingId, manifest, uploadedBy: adminId })
    .returning({ id: recordingTrackingBundlesTable.id });
  await db.insert(recordingTrackingSegmentsTable).values(
    upload.segments.map((segment) => ({
      bundleId: bundle.id,
      segmentIndex: segment.segmentIndex,
      name: segment.name,
      startFrame: segment.startFrame,
      endFrame: segment.endFrame,
      startSeconds: segment.startSeconds,
      endSeconds: segment.endSeconds,
      objectPath: `/objects/old-segment-${segment.segmentIndex}`,
      compressedBytes: 10,
      trackCount: segment.tracks.length,
      crossingCount: segment.crossings.length,
    })),
  );
}

async function currentManifest(): Promise<TrackingManifest> {
  const [row] = await db
    .select({ manifest: recordingTrackingBundlesTable.manifest })
    .from(recordingTrackingBundlesTable)
    .where(eq(recordingTrackingBundlesTable.recordingId, recordingId));
  return row.manifest;
}

beforeAll(async () => {
  const [field] = await db
    .insert(fieldsTable)
    .values({ name: `Replacement ${TEST_TAG}`, location: "Test" })
    .returning({ id: fieldsTable.id });
  fieldId = field.id;
  const [admin] = await db
    .insert(usersTable)
    .values({
      name: `Replacement Admin ${TEST_TAG}`,
      email: `${TEST_TAG}@test.local`,
      isGuest: false,
      profileComplete: false,
      isAdmin: true,
    })
    .returning({ id: usersTable.id });
  adminId = admin.id;
  const [claimantA] = await db
    .insert(usersTable)
    .values({
      name: `Claimant A ${TEST_TAG}`,
      email: `claimant-a-${TEST_TAG}@test.local`,
      isGuest: false,
      profileComplete: false,
      isAdmin: false,
    })
    .returning({ id: usersTable.id });
  claimantAId = claimantA.id;
  const [claimantB] = await db
    .insert(usersTable)
    .values({
      name: `Claimant B ${TEST_TAG}`,
      email: `claimant-b-${TEST_TAG}@test.local`,
      isGuest: false,
      profileComplete: false,
      isAdmin: false,
    })
    .returning({ id: usersTable.id });
  claimantBId = claimantB.id;
  const [recording] = await db
    .insert(recordingsTable)
    .values({
      fieldId,
      court: "1",
      date: "2026-09-01",
      timeSlot: "10:00",
      duration: "00:01",
      videoUrl: "https://example.test/match.m3u8",
      isVisible: true,
    })
    .returning({ id: recordingsTable.id });
  recordingId = recording.id;
  app = express();
  app.use(express.json());
  app.use("/api", claimMatchRouter);
});

beforeEach(async () => {
  await db.delete(recordingTrackingBundlesTable).where(eq(recordingTrackingBundlesTable.recordingId, recordingId));
  await insertPreviousBundle();
  mockedDeleteClaimSegment.mockReset();
  mockedDeleteClaimSegment.mockResolvedValue(undefined);
  mockedReadClaimSegment.mockReset();
  mockedWriteClaimSegment.mockReset();
  mockedGetLocalUserId.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.delete(recordingTrackingBundlesTable).where(eq(recordingTrackingBundlesTable.recordingId, recordingId));
  await db.delete(recordingsTable).where(eq(recordingsTable.id, recordingId));
  await db.delete(usersTable).where(eq(usersTable.id, adminId));
  await db.delete(usersTable).where(eq(usersTable.id, claimantAId));
  await db.delete(usersTable).where(eq(usersTable.id, claimantBId));
  await db.delete(fieldsTable).where(eq(fieldsTable.id, fieldId));
});

describe("Claim Match tracking bundle replacement", () => {
  it("attaches, validates, and removes a pitch model without replacing segment objects", async () => {
    mockedGetLocalUserId.mockResolvedValue(adminId);
    const pitchModel = {
      calibrationId: "replacement-calibration",
      fittedAt: "2026-01-15T12:00:00.000Z",
      calibratedAspectRatio: 1920 / 1080,
      pitchWidthMetres: 105,
      pitchHeightMetres: 68,
      // The grid layout is normalized image space; these pitch coordinates are
      // intentionally independent of the bundle's 1920x1080 dimensions.
      grid: [
        [{ x: 0, y: 0 }, { x: 105, y: 0 }],
        [{ x: 0, y: 68 }, { x: 105, y: 68 }],
      ],
    };

    const attached = await request(app)
      .patch(`/api/admin/recordings/${recordingId}/tracking-bundle`)
      .send({ pitchModel });

    expect(attached.status).toBe(200);
    expect(attached.body.pitchModel).toEqual({
      calibrationId: "replacement-calibration",
      fittedAt: "2026-01-15T12:00:00.000Z",
      calibratedAspectRatio: 1920 / 1080,
      gridRows: 2,
      gridColumns: 2,
      pitchWidthMetres: 105,
      pitchHeightMetres: 68,
    });
    expect((await currentManifest()).pitchModel).toEqual(pitchModel);

    const framingMismatch = await request(app)
      .patch(`/api/admin/recordings/${recordingId}/tracking-bundle`)
      .send({
        pitchModel: {
          ...pitchModel,
          calibratedAspectRatio: 2,
        },
      });
    expect(framingMismatch.status).toBe(400);
    expect(framingMismatch.body.error).toMatch(/aspect ratio/i);
    expect((await currentManifest()).pitchModel).toEqual(pitchModel);

    const invalid = await request(app)
      .patch(`/api/admin/recordings/${recordingId}/tracking-bundle`)
      .send({
        pitchModel: {
          pitchWidthMetres: 105,
          pitchHeightMetres: 68,
          grid: [[{ x: 0, y: 0 }, { x: 105, y: 0 }], [{ x: 0, y: 68 }]],
        },
      });

    expect(invalid.status).toBe(400);
    expect((await currentManifest()).pitchModel).toEqual(pitchModel);

    const removed = await request(app)
      .patch(`/api/admin/recordings/${recordingId}/tracking-bundle`)
      .send({ pitchModel: null });

    expect(removed.status).toBe(200);
    expect(removed.body.pitchModel).toBeNull();
    expect((await currentManifest()).pitchModel).toBeUndefined();
  });

  it("cleans already-written objects and preserves the previous bundle after a later write fails", async () => {
    let writeCount = 0;
    mockedWriteClaimSegment.mockImplementation(async () => {
      writeCount++;
      if (writeCount === 2) throw new Error("storage write failed");
      return { objectPath: "/objects/new-segment-0", compressedBytes: 10 };
    });

    await expect(storeUploadBundle(recordingId, adminId, makeUpload())).rejects.toThrow("storage write failed");

    expect(mockedDeleteClaimSegment).toHaveBeenCalledWith("/objects/new-segment-0");
    expect(mockedDeleteClaimSegment).not.toHaveBeenCalledWith("/objects/old-segment-0");
    expect((await currentManifest()).segments[0].objectPath).toBe("/objects/old-segment-0");
  });

  it("cleans all new objects and preserves the previous bundle when the database transaction fails", async () => {
    mockedWriteClaimSegment
      .mockResolvedValueOnce({ objectPath: "/objects/new-segment-0", compressedBytes: 10 })
      .mockResolvedValueOnce({ objectPath: "/objects/new-segment-1", compressedBytes: 10 });
    const transactionSpy = vi.spyOn(db, "transaction").mockRejectedValue(new Error("database transaction failed"));

    await expect(storeUploadBundle(recordingId, adminId, makeUpload())).rejects.toThrow("database transaction failed");

    expect(mockedDeleteClaimSegment).toHaveBeenCalledWith("/objects/new-segment-0");
    expect(mockedDeleteClaimSegment).toHaveBeenCalledWith("/objects/new-segment-1");
    expect(mockedDeleteClaimSegment).not.toHaveBeenCalledWith("/objects/old-segment-0");
    expect((await currentManifest()).segments[1].objectPath).toBe("/objects/old-segment-1");
    transactionSpy.mockRestore();
  });

  it("removes the previous segment and sprite objects only after a successful replacement", async () => {
    mockedWriteClaimSegment
      .mockResolvedValueOnce({ objectPath: "/objects/new-segment-0", compressedBytes: 10 })
      .mockResolvedValueOnce({ objectPath: "/objects/new-segment-1", compressedBytes: 10 });

    await storeUploadBundle(recordingId, adminId, makeUpload());

    expect(mockedDeleteClaimSegment).toHaveBeenCalledWith("/objects/old-segment-0");
    expect(mockedDeleteClaimSegment).toHaveBeenCalledWith("/objects/old-segment-1");
    expect(mockedDeleteClaimSegment).toHaveBeenCalledWith("/objects/old-sprites-0");
    expect(mockedDeleteClaimSegment).not.toHaveBeenCalledWith("/objects/new-segment-0");
    expect((await currentManifest()).segments[0].objectPath).toBe("/objects/new-segment-0");
  });

  it("keeps one owner, disputes a second claimant, and transfers ownership atomically", async () => {
    const [bundle] = await db
      .select()
      .from(recordingTrackingBundlesTable)
      .where(eq(recordingTrackingBundlesTable.recordingId, recordingId));
    const firstAnswers = [
      bindingCorrection(1, claimantAId),
      bindingCorrection(2, claimantAId),
      bindingCorrection(3, claimantAId),
    ];
    const derived = deriveClaimState(bindingManifest, bindingSegments, firstAnswers as never);

    const first = await syncIdentityBinding(claimantAId, recordingId, bundle, derived);
    expect(first?.state).toBe("confirmed");
    const second = await syncIdentityBinding(
      claimantBId,
      recordingId,
      bundle,
      deriveClaimState(bindingManifest, bindingSegments, [
        bindingCorrection(4, claimantBId),
        bindingCorrection(5, claimantBId),
        bindingCorrection(6, claimantBId),
      ] as never),
    );
    expect(second?.state).toBe("disputed");
    expect(completionAllowed(derived, second ?? null)).toBe(false);

    mockedGetLocalUserId.mockResolvedValue(adminId);
    const transferred = await request(app)
      .patch(`/api/admin/claim-match/disputes/${second!.id}`)
      .send({ winnerUserId: claimantBId });
    expect(transferred.status).toBe(200);

    const bindings = await db
      .select({
        userId: claimMatchIdentityBindingsTable.userId,
        state: claimMatchIdentityBindingsTable.state,
      })
      .from(claimMatchIdentityBindingsTable)
      .where(eq(claimMatchIdentityBindingsTable.recordingId, recordingId));
    expect(bindings).toEqual(expect.arrayContaining([
      { userId: claimantAId, state: "released" },
      { userId: claimantBId, state: "confirmed" },
    ]));
    expect(bindings.filter((row) => row.state === "confirmed")).toHaveLength(1);
  });

  it("turns simultaneous claims for one person into one confirmation and one dispute", async () => {
    await db
      .delete(claimMatchIdentityBindingsTable)
      .where(eq(claimMatchIdentityBindingsTable.recordingId, recordingId));
    const [bundle] = await db
      .select()
      .from(recordingTrackingBundlesTable)
      .where(eq(recordingTrackingBundlesTable.recordingId, recordingId));
    const results = await Promise.all([
      syncIdentityBinding(claimantAId, recordingId, bundle, deriveClaimState(
        bindingManifest,
        bindingSegments,
        [bindingCorrection(7, claimantAId), bindingCorrection(8, claimantAId), bindingCorrection(9, claimantAId)] as never,
      )),
      syncIdentityBinding(claimantBId, recordingId, bundle, deriveClaimState(
        bindingManifest,
        bindingSegments,
        [bindingCorrection(10, claimantBId), bindingCorrection(11, claimantBId), bindingCorrection(12, claimantBId)] as never,
      )),
    ]);
    expect(results.map((result) => result?.state).sort()).toEqual(["confirmed", "disputed"]);
    expect(await db
      .select()
      .from(claimMatchIdentityBindingsTable)
      .where(eq(claimMatchIdentityBindingsTable.recordingId, recordingId))).toHaveLength(2);
  });

  it("allows regrouping when the claimant has no recorded vouched fragment", async () => {
    const upload = makeUpload();
    const stateSegment = {
      version: 1,
      segmentIndex: 0,
      name: "only",
      startFrame: 0,
      endFrame: 1,
      startSeconds: 0,
      endSeconds: 0.08,
      tracks: [{ id: "piece-a", startFrame: 0, endFrame: 1, boxes: [] }],
      crossings: [],
      inPlaySpans: [],
      events: [],
    };
    mockedReadClaimSegment.mockResolvedValue(Buffer.from(JSON.stringify(stateSegment)));
    const stateSegments = [{
      segmentIndex: 0,
      startFrame: 0,
      endFrame: 1,
      startSeconds: 0,
      endSeconds: 0.08,
      tracks: [{ id: "piece-a", startFrame: 0, endFrame: 1 }],
      events: [],
    }];
    const fingerprint = trackingBundleFingerprint(upload.manifest, stateSegments);
    const originalIdentities = [{
      id: "person-a",
      parts: [{ trackId: "piece-a", fromFrame: 0, toFrame: 1 }],
    }];
    await db
      .update(recordingTrackingBundlesTable)
      .set({
        manifest: {
          ...upload.manifest,
          summary: { segments: stateSegments } as never,
          identities: originalIdentities,
          provenance: {
            bundleFingerprint: fingerprint,
            identityMapBundleFingerprint: fingerprint,
          },
        },
      })
      .where(eq(recordingTrackingBundlesTable.recordingId, recordingId));
    const originalManifest = {
      ...(bindingManifest as object),
      provenance: {
        bundleFingerprint: fingerprint,
        identityMapBundleFingerprint: fingerprint,
      },
      identities: originalIdentities,
    };
    const derived = deriveClaimState(originalManifest as never, bindingSegments, [
      bindingCorrection(13, claimantAId),
      bindingCorrection(14, claimantAId),
      bindingCorrection(15, claimantAId),
    ] as never);
    const [bundle] = await db
      .select()
      .from(recordingTrackingBundlesTable)
      .where(eq(recordingTrackingBundlesTable.recordingId, recordingId));
    const binding = await syncIdentityBinding(claimantAId, recordingId, bundle, derived);
    expect(binding?.vouchedFragments).toEqual([]);

    mockedGetLocalUserId.mockResolvedValue(adminId);
    const reassignedMap = {
      bundleFingerprint: fingerprint,
      identities: [{ id: "person-a", parts: [{ trackId: "piece-b", fromFrame: 0, toFrame: 1 }] }],
    };
    const preview = await request(app)
      .put(`/api/admin/recordings/${recordingId}/identities`)
      .send(reassignedMap);
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({ lockedClaims: 0, lockedFragments: 0, requiresRelease: false });
    expect((await db
      .select({ state: claimMatchIdentityBindingsTable.state })
      .from(claimMatchIdentityBindingsTable)
      .where(eq(claimMatchIdentityBindingsTable.id, binding!.id)))[0].state).toBe("confirmed");

    const saved = await request(app)
      .put(`/api/admin/recordings/${recordingId}/identities`)
      .send(reassignedMap);
    expect(saved.status).toBe(200);
    expect(saved.body.lockedClaims).toBe(0);
    expect((await db
      .select({ state: claimMatchIdentityBindingsTable.state })
      .from(claimMatchIdentityBindingsTable)
       .where(eq(claimMatchIdentityBindingsTable.id, binding!.id)))[0].state).toBe("confirmed");
  });

  it("automatically splits one inferred row for disjoint human-vouched fragments", async () => {
    await db.delete(claimMatchIdentityBindingsTable).where(eq(claimMatchIdentityBindingsTable.recordingId, recordingId));
    const [bundle] = await db
      .select()
      .from(recordingTrackingBundlesTable)
      .where(eq(recordingTrackingBundlesTable.recordingId, recordingId));
    const manifest = {
      ...(bindingManifest as object),
      provenance: { bundleFingerprint: "fragment-test", identityMapBundleFingerprint: "fragment-test" },
      identities: [{
        id: "person-a",
        parts: [{ trackId: "piece-a", fromFrame: 0, toFrame: 99 }],
      }],
    } as never;
    const fullSegments = [{
      ...(bindingSegments[0] as object),
      tracks: [{
        id: "piece-a",
        startFrame: 0,
        endFrame: 99,
        boxes: [
          ...Array.from({ length: 40 }, (_, frame) => ({ frame, x: 10, y: 10, w: 10, h: 10 })),
          ...Array.from({ length: 40 }, (_, index) => ({ frame: index + 60, x: 10, y: 10, w: 10, h: 10 })),
        ],
      }],
    }] as never;
    await db
      .update(recordingTrackingBundlesTable)
      .set({ manifest })
      .where(eq(recordingTrackingBundlesTable.id, bundle.id));
    const firstDerived = deriveClaimState(manifest, bindingSegments, [
      bindingCorrection(1, claimantAId),
    ] as never, fullSegments);
    const first = await syncIdentityBinding(claimantAId, recordingId, { ...bundle, manifest }, firstDerived);
    expect(first?.state).toBe("confirmed");
    expect(first?.vouchedFragments).toEqual([{ trackId: "piece-a", fromFrame: 0, toFrame: 39 }]);

    const secondDerived = deriveClaimState(manifest, bindingSegments, [
      bindingCorrection(7, claimantBId),
    ] as never, fullSegments);
    const second = await syncIdentityBinding(claimantBId, recordingId, { ...bundle, manifest }, secondDerived);
    expect(second?.state).toBe("confirmed");
    expect(second?.personId).not.toBe("person-a");

    const bindings = await db
      .select({ userId: claimMatchIdentityBindingsTable.userId, personId: claimMatchIdentityBindingsTable.personId, state: claimMatchIdentityBindingsTable.state, vouchedFragments: claimMatchIdentityBindingsTable.vouchedFragments })
      .from(claimMatchIdentityBindingsTable)
      .where(eq(claimMatchIdentityBindingsTable.recordingId, recordingId));
    expect(bindings).toEqual(expect.arrayContaining([
      expect.objectContaining({ userId: claimantAId, state: "confirmed", vouchedFragments: [{ trackId: "piece-a", fromFrame: 0, toFrame: 39 }] }),
      expect.objectContaining({ userId: claimantBId, state: "confirmed", vouchedFragments: [{ trackId: "piece-a", fromFrame: 60, toFrame: 99 }] }),
    ]));
    const savedManifest = await currentManifest();
    expect(savedManifest.identities?.some((identity) => identity.id === "person-a:inferred")).toBe(true);
  });

  it("keeps overlapping human-vouched fragments as a dispute", async () => {
    await db.delete(claimMatchIdentityBindingsTable).where(eq(claimMatchIdentityBindingsTable.recordingId, recordingId));
    const [bundle] = await db
      .select()
      .from(recordingTrackingBundlesTable)
      .where(eq(recordingTrackingBundlesTable.recordingId, recordingId));
    const manifest = {
      ...(bindingManifest as object),
      provenance: { bundleFingerprint: "fragment-test", identityMapBundleFingerprint: "fragment-test" },
      identities: [{
        id: "person-a",
        parts: [{ trackId: "piece-a", fromFrame: 0, toFrame: 99 }],
      }],
    } as never;
    const fullSegments = [{
      ...(bindingSegments[0] as object),
      tracks: [{
        id: "piece-a",
        startFrame: 0,
        endFrame: 99,
        boxes: Array.from({ length: 100 }, (_, frame) => ({ frame, x: 10, y: 10, w: 10, h: 10 })),
      }],
    }] as never;
    await db.update(recordingTrackingBundlesTable).set({ manifest }).where(eq(recordingTrackingBundlesTable.id, bundle.id));
    const first = await syncIdentityBinding(
      claimantAId,
      recordingId,
      { ...bundle, manifest },
      deriveClaimState(manifest, bindingSegments, [bindingCorrection(1, claimantAId)] as never, fullSegments),
    );
    const second = await syncIdentityBinding(
      claimantBId,
      recordingId,
      { ...bundle, manifest },
      deriveClaimState(manifest, bindingSegments, [bindingCorrection(2, claimantBId)] as never, fullSegments),
    );
    expect(first?.state).toBe("confirmed");
    expect(second?.state).toBe("disputed");
  });

  it("releases a vouched fragment only through the admin release action", async () => {
    await db.delete(claimMatchIdentityBindingsTable).where(eq(claimMatchIdentityBindingsTable.recordingId, recordingId));
    const [bundle] = await db
      .select()
      .from(recordingTrackingBundlesTable)
      .where(eq(recordingTrackingBundlesTable.recordingId, recordingId));
    const manifest = {
      ...(bindingManifest as object),
      provenance: { bundleFingerprint: "fragment-test", identityMapBundleFingerprint: "fragment-test" },
      identities: [{
        id: "person-a",
        parts: [{ trackId: "piece-a", fromFrame: 0, toFrame: 99 }],
      }],
    } as never;
    const fullSegments = [{
      ...(bindingSegments[0] as object),
      tracks: [{
        id: "piece-a",
        startFrame: 0,
        endFrame: 99,
        boxes: Array.from({ length: 100 }, (_, frame) => ({ frame, x: 10, y: 10, w: 10, h: 10 })),
      }],
    }] as never;
    const binding = await syncIdentityBinding(
      claimantAId,
      recordingId,
      { ...bundle, manifest },
      deriveClaimState(manifest, bindingSegments, [bindingCorrection(1, claimantAId)] as never, fullSegments),
    );
    mockedGetLocalUserId.mockResolvedValue(adminId);
    const response = await request(app).post(`/api/admin/claim-match/bindings/${binding!.id}/release`);
    expect(response.status).toBe(200);
    expect(response.body.state).toBe("released");
    const [released] = await db
      .select({ state: claimMatchIdentityBindingsTable.state, vouchedFragments: claimMatchIdentityBindingsTable.vouchedFragments })
      .from(claimMatchIdentityBindingsTable)
      .where(eq(claimMatchIdentityBindingsTable.id, binding!.id));
    expect(released).toEqual({ state: "released", vouchedFragments: [] });
  });

  it("returns a useful ZIP constraint error without exposing storage internals", async () => {
    mockedGetLocalUserId.mockResolvedValue(adminId);
    const upload = makeUpload();
    const zip = zipSync({
      "manifest.json": strToU8(JSON.stringify(upload.manifest)),
      "segments/one.json": strToU8(JSON.stringify(upload.segments[0])),
      "segments/two.json": strToU8(JSON.stringify(upload.segments[1])),
      "notes.txt": strToU8("unexpected"),
    });

    const response = await request(app)
      .put(`/api/admin/recordings/${recordingId}/tracking-bundle`)
      .attach("bundle", Buffer.from(zip), "tracking.zip");

    expect(response.status).toBe(400);
    expect(response.body.error).toContain("unexpected file");
    expect(response.body.error).not.toContain("PRIVATE_OBJECT_DIR");
    expect((await currentManifest()).segments[0].objectPath).toBe("/objects/old-segment-0");
  });
});