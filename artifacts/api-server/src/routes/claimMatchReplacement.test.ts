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
  storeUploadBundle,
  type UploadBundle,
} from "./claimMatch";
import { deleteClaimSegment, writeClaimSegment } from "../lib/claimMatchStorage";
import { getLocalUserId } from "../lib/clerkUserBridge";

const mockedDeleteClaimSegment = vi.mocked(deleteClaimSegment);
const mockedWriteClaimSegment = vi.mocked(writeClaimSegment);
const mockedGetLocalUserId = vi.mocked(getLocalUserId);
const TEST_TAG = `claim-replace-${Date.now()}`;

let app: Express;
let adminId: number;
let recordingId: number;
let fieldId: number;

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
  app.use("/api", claimMatchRouter);
});

beforeEach(async () => {
  await db.delete(recordingTrackingBundlesTable).where(eq(recordingTrackingBundlesTable.recordingId, recordingId));
  await insertPreviousBundle();
  mockedDeleteClaimSegment.mockReset();
  mockedDeleteClaimSegment.mockResolvedValue(undefined);
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
  await db.delete(fieldsTable).where(eq(fieldsTable.id, fieldId));
});

describe("Claim Match tracking bundle replacement", () => {
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