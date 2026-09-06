/**
 * Regression guard for the read/write access asymmetry fixed on 2026-09-06.
 *
 * The read path (getClaimMatchBundleForRequest) has always had an admin
 * bypass so an admin can validate a tracking bundle before the recording is
 * scheduled for players. The three write paths -- progress PATCH, corrections
 * POST, correction undo -- used getVisibleRecordingBundle, which has none.
 *
 * isRecordingVisible() returns false when a field has no recording_schedules
 * rows at all, so that is the DEFAULT state of every unscheduled recording.
 * The result was that an admin could open /claim-match/<id>, see all eight
 * identity checkpoints and answer every one, while each write returned 404 and
 * nothing was ever stored. The client reported those 404s as "Saved on this
 * device" and then discarded them, so the only visible symptom was the
 * first-run identity prompt reappearing on every single load.
 *
 * These tests hold both halves: an admin can write to an unscheduled
 * recording, and an ordinary account still cannot.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express, { type Express } from "express";
import { eq } from "drizzle-orm";

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

import {
  db,
  claimMatchCorrectionsTable,
  claimMatchProgressTable,
  fieldsTable,
  recordingSchedulesTable,
  recordingTrackingBundlesTable,
  recordingsTable,
  usersTable,
  type TrackingManifest,
} from "@workspace/db";
import { getLocalAccountUserId, getLocalUserId } from "../lib/clerkUserBridge";

const mockedAccountUser = vi.mocked(getLocalAccountUserId);
const mockedLocalUser = vi.mocked(getLocalUserId);

const TAG = `claim-write-access-${Date.now()}`;
const EMPTY_ANCHOR_TRACK = "__none__";

let app: Express;
let fieldId: number;
let adminId: number;
let playerId: number;
let recordingId: number;

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

/** An "I am not in this moment" answer, which needs no real track id. */
function anchorNoBody(clientId: string) {
  return {
    clientId,
    momentSeconds: 1,
    chosenTrackId: EMPTY_ANCHOR_TRACK,
    answerMethod: "anchor-no",
    questionCount: 8,
  };
}

function progressBody() {
  return {
    currentTrackId: null,
    stage: "picker",
    confirmedFromSeconds: 0,
    currentPositionSeconds: 4,
    claimedPercent: 0,
    clipsUnlocked: 0,
    completed: false,
    earnedClips: [],
  };
}

function actAs(userId: number) {
  mockedAccountUser.mockResolvedValue(userId);
  mockedLocalUser.mockResolvedValue(userId);
}

beforeAll(async () => {
  const { default: claimMatchRouter } = await import("./claimMatch");
  app = express();
  app.use(express.json());
  app.use("/api", claimMatchRouter);

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

  await db.insert(recordingTrackingBundlesTable).values({
    recordingId,
    uploadedBy: adminId,
    manifest,
  });
});

beforeEach(async () => {
  await db.delete(claimMatchCorrectionsTable)
    .where(eq(claimMatchCorrectionsTable.recordingId, recordingId));
  await db.delete(claimMatchProgressTable)
    .where(eq(claimMatchProgressTable.recordingId, recordingId));
  await db.delete(recordingSchedulesTable).where(eq(recordingSchedulesTable.fieldId, fieldId));
  vi.clearAllMocks();
});

afterAll(async () => {
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

  it("lets an admin SAVE a correction — this returned 404 before 2026-09-06", async () => {
    actAs(adminId);
    const res = await request(app)
      .post(`/api/recordings/${recordingId}/claim-match/corrections`)
      .send(anchorNoBody(`${TAG}-admin-1`));
    expect(res.status).toBe(201);

    const stored = await db.select()
      .from(claimMatchCorrectionsTable)
      .where(eq(claimMatchCorrectionsTable.recordingId, recordingId));
    expect(stored).toHaveLength(1);
  });

  it("lets an admin SAVE progress — this returned 404 before 2026-09-06", async () => {
    actAs(adminId);
    const res = await request(app)
      .patch(`/api/recordings/${recordingId}/claim-match`)
      .send(progressBody());
    expect(res.status).toBe(200);
  });

  it("still refuses an ordinary account, and says 403 rather than 404", async () => {
    actAs(playerId);
    const res = await request(app)
      .post(`/api/recordings/${recordingId}/claim-match/corrections`)
      .send(anchorNoBody(`${TAG}-player-1`));
    // 403 matters as much as the refusal: 404 sent the client down its
    // permanent-discard path while telling the user the answer was saved.
    expect(res.status).toBe(403);

    const stored = await db.select()
      .from(claimMatchCorrectionsTable)
      .where(eq(claimMatchCorrectionsTable.recordingId, recordingId));
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
      .post(`/api/recordings/${recordingId}/claim-match/corrections`)
      .send(anchorNoBody(`${TAG}-player-2`));
    expect(res.status).toBe(201);
  });
});
