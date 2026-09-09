/**
 * A camera's calibration, and the metres it produces.
 *
 * Two things had never been tested at all, and both were broken:
 *
 *  - `GET /admin/recordings/:id/player-metrics` built its player list from the
 *    old flow's correction rows, so someone who claimed themselves on the
 *    claim page was not a player with no stats -- they were absent entirely.
 *  - The pitch model was uploaded per recording, so the same grid had to be
 *    re-uploaded nightly and a wrong one could not be corrected across the
 *    footage it had already spoiled.
 *
 * The whole path is exercised here: upload a calibration to a camera, and a
 * claim on a recording that camera shot comes back in metres.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express, { type Express } from "express";
import { eq } from "drizzle-orm";

const WIDTH = 1920;
const HEIGHT = 1080;

/**
 * One track walking the full width of the image at constant height.
 *
 * The boxes are the input to every number below, so they are deliberately
 * simple: bottom-centre moves from x=100 to x=1090 across 100 frames at a
 * fixed y, which under the calibration below is a straight line along the
 * pitch of a length the assertions can state exactly.
 */
const segment = {
  version: 1,
  segmentIndex: 0,
  name: "camera-pitch",
  startFrame: 0,
  endFrame: 99,
  startSeconds: 0,
  endSeconds: 10,
  tracks: [{
    id: "t1",
    startFrame: 0,
    endFrame: 99,
    boxes: Array.from({ length: 100 }, (_, frame) => ({
      frame,
      x: 100 + frame * 10,
      y: 400,
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
  unauthenticatedResponse: vi.fn((res: { status: (code: number) => { json: (body: unknown) => void } }) => {
    res.status(401).json({ error: "Unauthenticated" });
  }),
}));

import {
  camerasTable,
  db,
  claimMatchIdentityBindingsTable,
  claimMatchProgressTable,
  fieldsTable,
  recordingSchedulesTable,
  recordingTrackingBundlesTable,
  recordingTrackingSegmentsTable,
  recordingsTable,
  usersTable,
} from "@workspace/db";
import { getLocalAccountUserId, getLocalUserId } from "../lib/clerkUserBridge";

const mockedAccountUser = vi.mocked(getLocalAccountUserId);
const mockedLocalUser = vi.mocked(getLocalUserId);

const TAG = `camera-pitch-${Date.now()}`;
const CAMERA_ID = `${TAG}-cam`;

let app: Express;
let fieldId: number;
let adminId: number;
let playerId: number;
let recordingId: number;
let bundleId: number;

/**
 * A calibration that maps the image onto a 105x68 m pitch corner to corner.
 *
 * With this grid, x in pixels maps linearly onto 0..105 m, so the track's
 * bottom-centre walk from x=120 to x=1110 is (1110-120)/1920 * 105 = 54.14 m.
 * The claim's smoothing shortens that a little; the assertions bracket it
 * rather than pinning a smoothed constant.
 */
const pitchModel = {
  calibrationId: `${TAG}-calibration`,
  fittedAt: "2026-02-01T09:00:00.000Z",
  calibratedAspectRatio: WIDTH / HEIGHT,
  pitchWidthMetres: 105,
  pitchHeightMetres: 68,
  grid: [
    [{ x: 0, y: 0 }, { x: 105, y: 0 }],
    [{ x: 0, y: 68 }, { x: 105, y: 68 }],
  ],
};

const manifest = {
  version: 1,
  label: "camera pitch test",
  width: WIDTH,
  height: HEIGHT,
  frameRate: 10,
  frameCount: 100,
  duration: 10,
  matchOffset: 0,
  videoStartSeconds: 0,
  segmentCount: 1,
  segments: [{
    index: 0,
    name: "camera-pitch",
    startFrame: 0,
    endFrame: 99,
    startSeconds: 0,
    endSeconds: 10,
    objectPath: "/objects/camera-pitch",
  }],
  summary: {
    segments: [{
      segmentIndex: 0,
      name: "camera-pitch",
      startFrame: 0,
      endFrame: 99,
      startSeconds: 0,
      endSeconds: 10,
      tracks: [{ id: "t1", startFrame: 0, endFrame: 99 }],
      events: [],
    }],
  },
  // The claim, exactly as the claim page would have written it.
  identities: [{
    id: "person-1",
    name: "Chain Claimant",
    parts: [{ trackId: "t1", fromFrame: 0, toFrame: 99, tapFrame: 0, reviewedThrough: 100 }],
  }],
};

beforeAll(async () => {
  const { default: camerasRouter } = await import("./cameras");
  const { default: claimMatchRouter } = await import("./claimMatch");
  app = express();
  app.use(express.json());
  app.use("/api", camerasRouter);
  app.use("/api", claimMatchRouter);

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

  const [field] = await db.insert(fieldsTable).values({
    name: `${TAG} field`,
    location: "Test",
    cameraId: CAMERA_ID,
  }).returning({ id: fieldsTable.id });
  fieldId = field.id;

  const [recording] = await db.insert(recordingsTable).values({
    fieldId,
    court: "1",
    date: "2026-09-01",
    timeSlot: "18:00",
    duration: "00:00:10",
    videoUrl: "https://example.test/camera-pitch.m3u8",
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
    name: "camera-pitch",
    startFrame: 0,
    endFrame: 99,
    startSeconds: 0,
    endSeconds: 10,
    objectPath: "/objects/camera-pitch",
    compressedBytes: 0,
    trackCount: 1,
    crossingCount: 0,
  });

  // The claim itself: a confirmed binding on the identity above.
  await db.insert(claimMatchIdentityBindingsTable).values({
    userId: playerId,
    recordingId,
    personId: "person-1",
    trackingBundleId: bundleId,
    bundleFingerprint: "camera-pitch-fingerprint",
    state: "confirmed",
    resolutionMethod: "chain",
    supportCount: 1,
    acceptedAnswerCount: 1,
    supportPercent: 100,
    personParts: ["t1"],
    vouchedFragments: [{ trackId: "t1", fromFrame: 0, toFrame: 99 }],
  });
});

beforeEach(async () => {
  await db.delete(camerasTable).where(eq(camerasTable.id, CAMERA_ID));
  mockedAccountUser.mockResolvedValue(adminId);
  mockedLocalUser.mockResolvedValue(adminId);
});

afterAll(async () => {
  await db.delete(camerasTable).where(eq(camerasTable.id, CAMERA_ID));
  await db.delete(claimMatchIdentityBindingsTable)
    .where(eq(claimMatchIdentityBindingsTable.recordingId, recordingId));
  await db.delete(claimMatchProgressTable)
    .where(eq(claimMatchProgressTable.recordingId, recordingId));
  await db.delete(recordingTrackingSegmentsTable)
    .where(eq(recordingTrackingSegmentsTable.bundleId, bundleId));
  await db.delete(recordingTrackingBundlesTable)
    .where(eq(recordingTrackingBundlesTable.id, bundleId));
  await db.delete(recordingSchedulesTable).where(eq(recordingSchedulesTable.fieldId, fieldId));
  await db.delete(recordingsTable).where(eq(recordingsTable.id, recordingId));
  await db.delete(fieldsTable).where(eq(fieldsTable.id, fieldId));
  await db.delete(usersTable).where(eq(usersTable.id, adminId));
  await db.delete(usersTable).where(eq(usersTable.id, playerId));
});

async function uploadModel(body: unknown) {
  return request(app).put(`/api/admin/cameras/${CAMERA_ID}/pitch-model`).send(body as object);
}

async function metrics() {
  return request(app).get(`/api/admin/recordings/${recordingId}/player-metrics`);
}

describe("a camera owns its calibration", () => {
  it("lists a camera a field names, even before anyone uploads a model", async () => {
    const listed = await request(app).get("/api/admin/cameras");

    expect(listed.status).toBe(200);
    const camera = listed.body.cameras.find((row: { id: string }) => row.id === CAMERA_ID);
    expect(camera).toBeDefined();
    expect(camera.pitchModel).toBeNull();
    expect(camera.fields).toEqual([{ id: fieldId, name: `${TAG} field` }]);
    expect(camera.trackedRecordings).toBe(1);
  });

  it("accepts a model bare or wrapped, and summarises it", async () => {
    const bare = await uploadModel(pitchModel);
    expect(bare.status).toBe(200);
    expect(bare.body.pitchModel).toMatchObject({
      calibrationId: pitchModel.calibrationId,
      gridRows: 2,
      gridColumns: 2,
      pitchWidthMetres: 105,
      pitchHeightMetres: 68,
    });

    // A fitting tool that wraps its output must not need hand-editing first.
    const wrapped = await uploadModel({ pitchModel });
    expect(wrapped.status).toBe(200);
    expect(wrapped.body.pitchModel.calibrationId).toBe(pitchModel.calibrationId);
  });

  it("refuses a ragged grid rather than storing one that cannot be interpolated", async () => {
    const refused = await uploadModel({
      ...pitchModel,
      grid: [[{ x: 0, y: 0 }, { x: 105, y: 0 }], [{ x: 0, y: 68 }]],
    });

    expect(refused.status).toBe(400);
    const [stored] = await db.select().from(camerasTable).where(eq(camerasTable.id, CAMERA_ID));
    expect(stored).toBeUndefined();
  });

  it("accepts a grid that sees past the touchline, because every real one does", async () => {
    // cam1's fitted model has 36% of its points outside the pitch: the rows
    // above the far touchline are the camera looking at the fence. Requiring
    // every point to sit inside the pitch rejected precisely the calibrations
    // that were correct.
    const seesPastTheLine = await uploadModel({
      ...pitchModel,
      grid: [
        [{ x: -60, y: -30 }, { x: 160, y: -30 }],
        [{ x: 0, y: 68 }, { x: 105, y: 68 }],
      ],
    });
    expect(seesPastTheLine.status).toBe(200);
  });

  it("still refuses a grid fitted in the wrong units", async () => {
    // Centimetres instead of metres: two orders of magnitude out, which is the
    // mistake the bound is actually there to catch.
    const centimetres = await uploadModel({
      ...pitchModel,
      grid: [
        [{ x: 0, y: 0 }, { x: 10500, y: 0 }],
        [{ x: 0, y: 6800 }, { x: 10500, y: 6800 }],
      ],
    });
    expect(centimetres.status).toBe(400);
  });

  it("refuses an admin-shaped request from someone who is not an admin", async () => {
    mockedLocalUser.mockResolvedValue(playerId);
    expect((await uploadModel(pitchModel)).status).toBe(403);
    expect((await request(app).get("/api/admin/cameras")).status).toBe(403);
  });
});

describe("what a calibration is worth", () => {
  it("shows a chain claimant with no metres until the camera has a model", async () => {
    const before = await metrics();

    expect(before.status).toBe(200);
    // The regression this file exists for: the claim was made on the claim
    // page, which writes no correction rows. Before, this list was empty.
    expect(before.body.players).toHaveLength(1);
    expect(before.body.players[0].userId).toBe(playerId);
    expect(before.body.pitchModel).toBeNull();
    expect(before.body.players[0].playerStats.distanceMetres).toBeNull();
    expect(before.body.players[0].playerStats.heatmap.coordinateSpace).toBe("camera");
    expect(before.body.players[0].playerStats.minutesPlayed).toBeGreaterThan(0);
  });

  it("turns the same claim into metres once the camera is calibrated", async () => {
    expect((await uploadModel(pitchModel)).status).toBe(200);
    const after = await metrics();

    expect(after.status).toBe(200);
    expect(after.body.pitchModel.calibrationId).toBe(pitchModel.calibrationId);
    const stats = after.body.players[0].playerStats;
    expect(stats.heatmap.coordinateSpace).toBe("pitch");
    // The track crosses 990 px of a 1920 px image mapped onto 105 m, so about
    // 54 m before smoothing. Bracketed, not pinned: the exact figure is the
    // smoother's business and pinning it would make this a change detector.
    expect(stats.distanceMetres).toBeGreaterThan(35);
    expect(stats.distanceMetres).toBeLessThan(55);
    expect(after.body.players[0].topSpeedMetresPerSecond).toBeGreaterThan(0);
  });

  it("ignores a model fitted for a different crop instead of reporting fiction", async () => {
    // Same grid, but declared as fitted for a 2:1 image. The numbers would
    // still come out; they would just not be where the player was.
    expect((await uploadModel({ ...pitchModel, calibratedAspectRatio: 2 })).status).toBe(200);
    const after = await metrics();

    expect(after.status).toBe(200);
    expect(after.body.pitchModel).toBeNull();
    expect(after.body.players[0].playerStats.distanceMetres).toBeNull();
    expect(after.body.players[0].playerStats.heatmap.coordinateSpace).toBe("camera");
  });

  it("takes the metres away again when the model is removed", async () => {
    expect((await uploadModel(pitchModel)).status).toBe(200);
    expect((await metrics()).body.players[0].playerStats.distanceMetres).not.toBeNull();

    const removed = await request(app)
      .delete(`/api/admin/cameras/${CAMERA_ID}/pitch-model`);
    expect(removed.status).toBe(200);
    expect(removed.body.pitchModel).toBeNull();

    const after = await metrics();
    expect(after.body.players[0].playerStats.distanceMetres).toBeNull();
  });

  it("reaches every recording that camera shot, not just the next one", async () => {
    // The point of the move. One upload, and footage already in the database
    // -- shot before the calibration existed -- is in metres.
    expect((await metrics()).body.players[0].playerStats.distanceMetres).toBeNull();
    expect((await uploadModel(pitchModel)).status).toBe(200);
    expect((await metrics()).body.players[0].playerStats.distanceMetres).not.toBeNull();
  });
});
