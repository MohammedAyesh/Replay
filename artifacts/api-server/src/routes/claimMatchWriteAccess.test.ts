/**
 * Regression guard for the read/write access asymmetry fixed on 2026-09-06.
 *
 * The read path (getClaimMatchBundleForRequest) has always had an admin
 * bypass so an admin can validate a tracking bundle before the recording is
 * scheduled for players. The write paths used getVisibleRecordingBundle,
 * which has none.
 *
 * isRecordingVisible() returns false when a field has no recording_schedules
 * rows at all, so that is the DEFAULT state of every unscheduled recording.
 * The result was that an admin could open the claim page and answer every
 * question while each write returned 404 and nothing was ever stored. The
 * client reported those 404s as "Saved on this device" and then discarded
 * them, so the only visible symptom was the first-run prompt reappearing on
 * every single load.
 *
 * The flow those writes belonged to is gone; the gate is not. Both halves are
 * still held here, now through the chain's tap, which shares the same
 * getClaimMatchWritableBundle: an admin can write to an unscheduled recording,
 * and an ordinary account still cannot.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express, { type Express } from "express";
import { eq } from "drizzle-orm";

/** One track with real boxes, so a tap has something to land on. */
const segment = {
  version: 1,
  segmentIndex: 0,
  name: "only",
  startFrame: 0,
  endFrame: 249,
  startSeconds: 0,
  endSeconds: 10,
  tracks: [{
    id: "t1",
    startFrame: 0,
    endFrame: 249,
    boxes: Array.from({ length: 250 }, (_, frame) => ({
      frame,
      x: 100 + frame,
      y: 200,
      w: 40,
      h: 80,
    })),
  }],
  crossings: [],
  inPlaySpans: [],
  events: [],
};

vi.mock("../lib/claimMatchStorage", () => ({
  deleteClaimSegment: vi.fn(),
  readClaimSegment: vi.fn(async () => Buffer.from(JSON.stringify(segment))),
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

import {
  db,
  claimMatchIdentityBindingsTable,
  claimMatchProgressTable,
  fieldsTable,
  recordingSchedulesTable,
  recordingTrackingBundlesTable,
  recordingTrackingSegmentsTable,
  recordingsTable,
  usersTable,
  type TrackingManifest,
} from "@workspace/db";
import { getLocalAccountUserId, getLocalUserId } from "../lib/clerkUserBridge";

const mockedAccountUser = vi.mocked(getLocalAccountUserId);
const mockedLocalUser = vi.mocked(getLocalUserId);

const TAG = `claim-write-access-${Date.now()}`;

let app: Express;
let fieldId: number;
let adminId: number;
let playerId: number;
let recordingId: number;
let bundleId: number;

/**
 * A manifest carrying its own `summary`, so getClaimStateSegments never has to
 * read segment objects from storage. Geometry and timings are arbitrary; these
 * tests are about access control, not tracking.
 */
const manifest: TrackingManifest = {
  version: 1,
  label: "write access test",
  width: 1920,
  height: 1080,
  frameRate: 25,
  frameCount: 250,
  duration: 10,
  matchOffset: 0,
  videoStartSeconds: 0,
  segmentCount: 1,
  segments: [{
    index: 0,
    name: "only",
    startFrame: 0,
    endFrame: 249,
    startSeconds: 0,
    endSeconds: 10,
    objectPath: "",
  }],
  summary: {
    segments: [{
      segmentIndex: 0,
      startFrame: 0,
      endFrame: 249,
      startSeconds: 0,
      endSeconds: 10,
      tracks: [{ id: "t1", startFrame: 0, endFrame: 249 }],
      events: [],
    }],
  },
};

/** "That is me, here" -- the only write the claim page makes. */
function tapBody(name: string) {
  return { trackId: "t1", frame: 10, name };
}

function actAs(userId: number) {
  mockedAccountUser.mockResolvedValue(userId);
  mockedLocalUser.mockResolvedValue(userId);
}

beforeAll(async () => {
  const { default: claimMatchRouter } = await import("./claimMatch");
  const { default: claimChainRouter } = await import("./claimChain");
  app = express();
  app.use(express.json());
  app.use("/api", claimMatchRouter);
  app.use("/api", claimChainRouter);

  const [field] = await db.insert(fieldsTable).values({
    name: `${TAG} field`,
    location: "Test",
  }).returning({ id: fieldsTable.id });
  fieldId = field.id;

  const [admin] = await db.insert(usersTable).values({
    name: `${TAG} admin`,
    email: `${TAG}-admin@test.local`,
    isGuest: false,
    profileComplete: true,
    isAdmin: true,
  }).returning({ id: usersTable.id });
  adminId = admin.id;

  const [player] = await db.insert(usersTable).values({
    name: `${TAG} player`,
    email: `${TAG}-player@test.local`,
    isGuest: false,
    profileComplete: true,
    isAdmin: false,
  }).returning({ id: usersTable.id });
  playerId = player.id;

  // Deliberately NO recording_schedules row for this field: that is what makes
  // the recording invisible to players and is the default for anything an
  // admin is still validating.
  const [recording] = await db.insert(recordingsTable).values({
    fieldId,
    court: "1",
    date: "2026-08-31",
    timeSlot: "18:00",
    duration: "00:10:00",
    videoUrl: "https://example.test/unscheduled.m3u8",
    isVisible: true,
  }).returning({ id: recordingsTable.id });
  recordingId = recording.id;

  const [bundle] = await db.insert(recordingTrackingBundlesTable).values({
    recordingId,
    uploadedBy: adminId,
    manifest,
  }).returning({ id: recordingTrackingBundlesTable.id });
  bundleId = bundle.id;

  await db.insert(recordingTrackingSegmentsTable).values({
    bundleId,
    segmentIndex: 0,
    name: "only",
    startFrame: 0,
    endFrame: 249,
    startSeconds: 0,
    endSeconds: 10,
    objectPath: "/objects/write-access",
    compressedBytes: 0,
    trackCount: 1,
    crossingCount: 0,
  });
});

beforeEach(async () => {
  await db.delete(claimMatchIdentityBindingsTable)
    .where(eq(claimMatchIdentityBindingsTable.recordingId, recordingId));
  await db.delete(claimMatchProgressTable)
    .where(eq(claimMatchProgressTable.recordingId, recordingId));
  await db.delete(recordingSchedulesTable).where(eq(recordingSchedulesTable.fieldId, fieldId));
  vi.clearAllMocks();
});

afterAll(async () => {
  await db.delete(recordingTrackingSegmentsTable)
    .where(eq(recordingTrackingSegmentsTable.bundleId, bundleId));
  await db.delete(recordingSchedulesTable).where(eq(recordingSchedulesTable.fieldId, fieldId));
  await db.delete(recordingsTable).where(eq(recordingsTable.id, recordingId));
  await db.delete(usersTable).where(eq(usersTable.id, adminId));
  await db.delete(usersTable).where(eq(usersTable.id, playerId));
  await db.delete(fieldsTable).where(eq(fieldsTable.id, fieldId));
});

describe("claim-match write access on an unscheduled recording", () => {
  it("lets an admin READ it (the bypass that always existed)", async () => {
    actAs(adminId);
    const res = await request(app).get(`/api/recordings/${recordingId}/claim-match`);
    expect(res.status).toBe(200);
  });

  it("lets an admin CLAIM on it — this returned 404 before 2026-09-06", async () => {
    actAs(adminId);
    const res = await request(app)
      .post(`/api/recordings/${recordingId}/claim-match/chain/tap`)
      .send(tapBody(`${TAG} admin`));
    expect(res.status).toBe(200);

    const stored = await db.select()
      .from(claimMatchProgressTable)
      .where(eq(claimMatchProgressTable.recordingId, recordingId));
    expect(stored).toHaveLength(1);
  });

  it("still refuses an ordinary account, and says 403 rather than 404", async () => {
    actAs(playerId);
    const res = await request(app)
      .post(`/api/recordings/${recordingId}/claim-match/chain/tap`)
      .send(tapBody(`${TAG} player`));
    // 403 matters as much as the refusal: 404 sent the client down its
    // permanent-discard path while telling the user the answer was saved.
    expect(res.status).toBe(403);

    const stored = await db.select()
      .from(claimMatchProgressTable)
      .where(eq(claimMatchProgressTable.recordingId, recordingId));
    expect(stored).toHaveLength(0);
  });

  it("lets an ordinary account write once the recording IS scheduled", async () => {
    await db.insert(recordingSchedulesTable).values({
      fieldId,
      allowedDate: "2026-08-31",
      startTime: "00:00",
      endTime: "23:59",
      label: `${TAG} visibility`,
    });
    actAs(playerId);
    const res = await request(app)
      .post(`/api/recordings/${recordingId}/claim-match/chain/tap`)
      .send(tapBody(`${TAG} player scheduled`));
    expect(res.status).toBe(200);
  });
});
