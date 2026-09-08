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
  syncIdentityBinding,
  storeUploadBundle,
  trackingBundleFingerprint,
  type ClaimVouchedFragment,
  type ResolvedClaimIdentity,
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

/**
 * The two fields syncIdentityBinding reads, built directly instead of through
 * the deleted anchor flow's deriveClaimState. Every fixture below used to
 * resolve to exactly one person with total support and no conflicting moment,
 * which is what the counts record; personId and the fragments are the parts the
 * dispute and split assertions actually turn on.
 */
function claimOf(
  personId: string,
  fragments: ClaimVouchedFragment[],
  answerCount = 1,
  resolutionMethod: ResolvedClaimIdentity["resolutionMethod"] = "identity-map",
): { identityResolution: ResolvedClaimIdentity; vouchedFragments: ClaimVouchedFragment[] } {
  return {
    identityResolution: {
      personId,
      resolutionMethod,
      supportCount: answerCount,
      acceptedAnswerCount: answerCount,
      supportPercent: 100,
      conflictMoments: [],
    },
    vouchedFragments: fragments,
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
  it("refuses a pitch model, because that belongs to the camera now", async () => {
    mockedGetLocalUserId.mockResolvedValue(adminId);
    const before = await currentManifest();

    const refused = await request(app)
      .patch(`/api/admin/recordings/${recordingId}/tracking-bundle`)
      .send({
        pitchModel: {
          calibrationId: "replacement-calibration",
          fittedAt: "2026-01-15T12:00:00.000Z",
          calibratedAspectRatio: 1920 / 1080,
          pitchWidthMetres: 105,
          pitchHeightMetres: 68,
          grid: [
            [{ x: 0, y: 0 }, { x: 105, y: 0 }],
            [{ x: 0, y: 68 }, { x: 105, y: 68 }],
          ],
        },
      });

    // Refused rather than accepted-and-ignored: a model stored here would be
    // overwritten by the camera's on the way out, so silently taking it would
    // be an edit that appears to work and changes nothing.
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/camera/i);
    expect((await currentManifest()).pitchModel).toEqual(before.pitchModel);

    const timeOnly = await request(app)
      .patch(`/api/admin/recordings/${recordingId}/tracking-bundle`)
      .send({ videoStartSeconds: 12 });
    expect(timeOnly.status).toBe(200);
    expect((await currentManifest()).videoStartSeconds).toBe(12);
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
    // This bundle carries no identity map, so both claimants resolve straight
    // to the source track: one person, two claimants.
    const first = await syncIdentityBinding(
      claimantAId,
      recordingId,
      bundle,
      claimOf("piece-a", [], 3, "track-fallback"),
    );
    expect(first?.state).toBe("confirmed");
    const second = await syncIdentityBinding(
      claimantBId,
      recordingId,
      bundle,
      claimOf("piece-a", [], 3, "track-fallback"),
    );
    // Same person, so this is a contest rather than a split.
    expect(second?.personId).toBe(first?.personId);
    expect(second?.state).toBe("disputed");
    // completionAllowed used to say a binding that is not confirmed cannot be
    // awarded. That rule now lives in the chain flow as `bindingAwards`,
    // mirrored here against the binding this claim actually produced.
    const bindingAwards = !second || second.state === "confirmed";
    expect(bindingAwards).toBe(false);

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
      syncIdentityBinding(claimantAId, recordingId, bundle, claimOf("piece-a", [], 3, "track-fallback")),
      syncIdentityBinding(claimantBId, recordingId, bundle, claimOf("piece-a", [], 3, "track-fallback")),
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
    // The answers landed outside person-a's two-frame part, so the claim fell
    // back to the source track and recorded no vouched fragment at all. That
    // empty fragment list is what leaves the map regroupable.
    const derived = claimOf("piece-a", [], 3, "track-fallback");
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
    await db
      .update(recordingTrackingBundlesTable)
      .set({ manifest })
      .where(eq(recordingTrackingBundlesTable.id, bundle.id));
    // piece-a detects across frames 0-39 and again across 60-99, so the two
    // claimants vouch for disjoint runs of the same inferred row.
    const first = await syncIdentityBinding(
      claimantAId,
      recordingId,
      { ...bundle, manifest },
      claimOf("person-a", [{ trackId: "piece-a", fromFrame: 0, toFrame: 39 }]),
    );
    expect(first?.state).toBe("confirmed");
    expect(first?.vouchedFragments).toEqual([{ trackId: "piece-a", fromFrame: 0, toFrame: 39 }]);

    const second = await syncIdentityBinding(
      claimantBId,
      recordingId,
      { ...bundle, manifest },
      claimOf("person-a", [{ trackId: "piece-a", fromFrame: 60, toFrame: 99 }]),
    );
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
    await db.update(recordingTrackingBundlesTable).set({ manifest }).where(eq(recordingTrackingBundlesTable.id, bundle.id));
    // piece-a detects unbroken across frames 0-99, so both claimants vouch for
    // the same run and there is nothing to split.
    const first = await syncIdentityBinding(
      claimantAId,
      recordingId,
      { ...bundle, manifest },
      claimOf("person-a", [{ trackId: "piece-a", fromFrame: 0, toFrame: 99 }]),
    );
    const second = await syncIdentityBinding(
      claimantBId,
      recordingId,
      { ...bundle, manifest },
      claimOf("person-a", [{ trackId: "piece-a", fromFrame: 0, toFrame: 99 }]),
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
    const binding = await syncIdentityBinding(
      claimantAId,
      recordingId,
      { ...bundle, manifest },
      claimOf("person-a", [{ trackId: "piece-a", fromFrame: 0, toFrame: 99 }]),
    );
    mockedGetLocalUserId.mockResolvedValue(claimantAId);
    const forbiddenList = await request(app).get(`/api/admin/recordings/${recordingId}/claim-match/bindings`);
    expect(forbiddenList.status).toBe(403);

    mockedGetLocalUserId.mockResolvedValue(adminId);
    const listed = await request(app).get(`/api/admin/recordings/${recordingId}/claim-match/bindings`);
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: binding!.id,
        claimantName: expect.stringContaining("Claimant A"),
        claimedAt: expect.any(String),
      }),
    ]));

    const response = await request(app).post(`/api/admin/claim-match/bindings/${binding!.id}/release`);
    expect(response.status).toBe(200);
    expect(response.body.state).toBe("released");
    const [released] = await db
      .select({ state: claimMatchIdentityBindingsTable.state, vouchedFragments: claimMatchIdentityBindingsTable.vouchedFragments })
      .from(claimMatchIdentityBindingsTable)
      .where(eq(claimMatchIdentityBindingsTable.id, binding!.id));
    expect(released).toEqual({ state: "released", vouchedFragments: [] });
  });

  it("persists parked and deleted fragment decisions beside the identity map", async () => {
    mockedGetLocalUserId.mockResolvedValue(adminId);
    await db.delete(claimMatchIdentityBindingsTable).where(eq(claimMatchIdentityBindingsTable.recordingId, recordingId));
    const manifest = {
      ...(bindingManifest as object),
      summary: { segments: bindingSegments },
      provenance: { bundleFingerprint: "decision-test", identityMapBundleFingerprint: "decision-test" },
    } as unknown as TrackingManifest;
    const fingerprint = trackingBundleFingerprint(
      manifest,
      manifest.summary?.segments ?? bindingSegments,
    );
    const anchoredManifest = {
      ...manifest,
      provenance: { bundleFingerprint: fingerprint, identityMapBundleFingerprint: fingerprint },
    };
    await db
      .update(recordingTrackingBundlesTable)
      .set({ manifest: anchoredManifest })
      .where(eq(recordingTrackingBundlesTable.recordingId, recordingId));
    const decisions = [
      { trackId: "piece-a", fromFrame: 50, toFrame: 74, action: "parked" as const },
      { trackId: "piece-a", fromFrame: 75, toFrame: 99, action: "deleted" as const },
    ];

    const saved = await request(app)
      .put(`/api/admin/recordings/${recordingId}/identities`)
      .send({
        bundleFingerprint: fingerprint,
        identities: [{ id: "person-a", parts: [{ trackId: "piece-a", fromFrame: 0, toFrame: 49 }] }],
        identityDecisions: decisions,
      });

    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect((await currentManifest()).identityDecisions).toEqual(decisions);

    const legacySaved = await request(app)
      .put(`/api/admin/recordings/${recordingId}/identities`)
      .send({
        bundleFingerprint: fingerprint,
        identities: [{ id: "person-a", parts: [{ trackId: "piece-a", fromFrame: 0, toFrame: 49 }] }],
      });
    expect(legacySaved.status).toBe(200);
    expect((await currentManifest()).identityDecisions).toEqual(decisions);

    const conflicting = await request(app)
      .put(`/api/admin/recordings/${recordingId}/identities`)
      .send({
        bundleFingerprint: fingerprint,
        identities: [{ id: "person-a", parts: [{ trackId: "piece-a", fromFrame: 50, toFrame: 99 }] }],
        identityDecisions: [decisions[0]],
      });
    expect(conflicting.status).toBe(400);
    expect(conflicting.body.error).toContain("cannot also remain");
  });

  it("accepts documentation files without changing replacement storage behavior", async () => {
    mockedGetLocalUserId.mockResolvedValue(adminId);
    mockedWriteClaimSegment
      .mockResolvedValueOnce({ objectPath: "/objects/new-segment-0", compressedBytes: 10 })
      .mockResolvedValueOnce({ objectPath: "/objects/new-segment-1", compressedBytes: 10 });
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

    expect(response.status).toBe(200);
    expect((await currentManifest()).segments[0].objectPath).toBe("/objects/new-segment-0");
    expect(mockedDeleteClaimSegment).toHaveBeenCalledWith("/objects/old-segment-0");
    expect(mockedDeleteClaimSegment).toHaveBeenCalledWith("/objects/old-segment-1");
  });
});