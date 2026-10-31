/**
 * The match stats cache is only recomputed when its fingerprint says the
 * inputs changed. Claimed parts are not the only input: team switches (team
 * spans and the claim's saved switches / shirt epochs), off-pitch spans and
 * goal votes all feed matchStats, and a cache that ignores them keeps
 * reporting the numbers from before a team switch for good.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express, { type Express } from "express";
import { and, eq } from "drizzle-orm";

vi.mock("./claimMatchStorage", () => ({
  deleteClaimSegment: vi.fn(),
  readClaimSegment: vi.fn(),
  readCompressedClaimSegment: vi.fn(),
  writeClaimSegment: vi.fn(),
}));

vi.mock("./clerkUserBridge", () => ({
  getLocalAccountUserId: vi.fn(),
  getLocalUserId: vi.fn(),
  unauthenticatedResponse: vi.fn((res: any, _req: any, error = "Unauthenticated") => {
    res.status(401).json({ error });
  }),
}));

// The routes queue background fills; this file runs the fills itself.
vi.mock("./matchStatsCacheJobs", () => ({
  queueMatchStatsCacheForMatch: vi.fn(),
  queueMatchStatsCacheForRecording: vi.fn(),
}));

import {
  db,
  claimMatchOffPitchSpansTable,
  claimMatchProgressTable,
  fieldsTable,
  footageRequestsTable,
  matchPlayerStatsCacheTable,
  matchPlayersTable,
  matchTeamSpansTable,
  recordingGoalVotesTable,
  recordingSchedulesTable,
  recordingTrackingBundlesTable,
  recordingTrackingSegmentsTable,
  recordingsTable,
  usersTable,
  type MatchPlayerStatsCacheValue,
  type TrackingManifest,
  type TrackingSegmentPayload,
} from "@workspace/db";
import { readClaimSegment } from "./claimMatchStorage";
import { getLocalAccountUserId, getLocalUserId } from "./clerkUserBridge";
import { queueMatchStatsCacheForRecording } from "./matchStatsCacheJobs";
import { ensureRoomForRequest } from "./matchRooms";
import { fillMatchStatsCacheForMatch } from "./matchFeed";
import { claimIdentityId } from "../routes/claimChain";

const TAG = `stats-fresh-${Date.now()}`;
const FPS = 25;
let app: Express;
let fieldId: number;
let adminId: number;
let playerId: number;
let recordingId: number;
let bundleId: number;
let requestId: number;
let roomId: number;
let roomCode: string;
let rosterId: number;

function boxes(from: number, to: number) {
  const out = [];
  for (let frame = from; frame <= to; frame++) out.push({ frame, x: 100 + frame * 2, y: 200, w: 20, h: 40 });
  return out;
}

const segment: TrackingSegmentPayload = {
  segmentIndex: 0, name: "only", startFrame: 0, endFrame: 199, startSeconds: 0, endSeconds: 8,
  tracks: [
    { id: "t1", startFrame: 0, endFrame: 99, boxes: boxes(0, 99) },
    { id: "t2", startFrame: 100, endFrame: 199, boxes: boxes(100, 199) },
  ],
  crossings: [], inPlaySpans: [], events: [],
} as never;

function manifestFor(userId: number, recId: number): TrackingManifest {
  return {
    version: 1, label: "stats fresh", width: 1920, height: 1080, frameRate: FPS,
    frameCount: 200, duration: 8, matchOffset: 0, videoStartSeconds: 0, segmentCount: 1,
    segments: [{ index: 0, name: "only", startFrame: 0, endFrame: 199, startSeconds: 0, endSeconds: 8, objectPath: `${TAG}/s0.json` }],
    summary: { segments: [{ segmentIndex: 0, startFrame: 0, endFrame: 199, startSeconds: 0, endSeconds: 8,
      tracks: segment.tracks.map((t) => ({ id: t.id, startFrame: t.startFrame, endFrame: t.endFrame })), events: [] }] },
    identities: [{
      id: claimIdentityId(userId, recId), name: "Mohammed",
      parts: [{ trackId: "t1", fromFrame: 0, toFrame: 99 }, { trackId: "t2", fromFrame: 100, toFrame: 199 }],
    }],
  } as never;
}

const SENTINEL = 999;

async function cacheRow() {
  const [row] = await db.select().from(matchPlayerStatsCacheTable).where(and(
    eq(matchPlayerStatsCacheTable.matchId, roomId), eq(matchPlayerStatsCacheTable.matchPlayerId, rosterId)));
  return row;
}

/**
 * A cache row that is current for the inputs as they are now, carrying
 * numbers no real computation produces -- so a recompute is visible.
 */
async function primeCache() {
  await db.delete(matchPlayerStatsCacheTable).where(eq(matchPlayerStatsCacheTable.matchId, roomId));
  await fillMatchStatsCacheForMatch(roomId);
  const row = await cacheRow();
  expect(row).toBeTruthy();
  await db.update(matchPlayerStatsCacheTable)
    .set({ stats: { ...row.stats, touches: SENTINEL } as MatchPlayerStatsCacheValue })
    .where(eq(matchPlayerStatsCacheTable.id, row.id));
  // Nothing changed: the fill leaves a current row alone.
  await fillMatchStatsCacheForMatch(roomId);
  expect((await cacheRow()).stats.touches).toBe(SENTINEL);
}

beforeAll(async () => {
  const { default: claimGameRouter } = await import("../routes/claimGame");
  const { default: claimOffPitchRouter } = await import("../routes/claimOffPitch");
  app = express();
  app.use(express.json());
  app.use("/api", claimGameRouter);
  app.use("/api", claimOffPitchRouter);

  const [field] = await db.insert(fieldsTable).values({ name: `${TAG} field`, location: "Test", cameraId: `cam-${TAG}` })
    .returning({ id: fieldsTable.id });
  fieldId = field.id;
  const made = await db.insert(usersTable).values([
    { name: `${TAG} admin`, email: `${TAG}-admin@test.local`, isGuest: false, profileComplete: true, isAdmin: true },
    { name: "Mohammed", email: `${TAG}-player@test.local`, isGuest: false, profileComplete: true, isAdmin: false },
  ]).returning({ id: usersTable.id });
  [adminId, playerId] = made.map((row) => row.id);
  const [recording] = await db.insert(recordingsTable).values({
    fieldId, court: "1", date: "2026-09-06", timeSlot: "18:00", duration: "00:00:08",
    videoUrl: "https://example.test/stats-fresh.m3u8", isVisible: true,
  }).returning({ id: recordingsTable.id });
  recordingId = recording.id;
  await db.insert(recordingSchedulesTable).values({
    fieldId, allowedDate: "2026-09-06", startTime: "00:00", endTime: "23:59", label: `${TAG} visibility`,
  });
  const [bundle] = await db.insert(recordingTrackingBundlesTable)
    .values({ recordingId, uploadedBy: adminId, manifest: manifestFor(playerId, recordingId) })
    .returning({ id: recordingTrackingBundlesTable.id });
  bundleId = bundle.id;
  await db.insert(recordingTrackingSegmentsTable).values({
    bundleId, segmentIndex: 0, name: "only", startFrame: 0, endFrame: 199, startSeconds: 0, endSeconds: 8,
    objectPath: `${TAG}/s0.json`, trackCount: 2, crossingCount: 0,
  });
  const [booking] = await db.insert(footageRequestsTable).values({
    fieldId, cameraId: `cam-${TAG}`, requestedBy: adminId,
    startLocal: "2026-09-06 18:00", endLocal: "2026-09-06 19:00", requestedSeconds: 3600, status: "ready",
  }).returning();
  requestId = booking.id;
  const room = await ensureRoomForRequest(booking);
  roomId = room.id;
  roomCode = room.code;
  const [player] = await db.insert(matchPlayersTable).values({
    matchId: roomId, userId: playerId, displayName: "Mohammed", rsvp: "in", team: "A", inviteToken: `${TAG}-me`,
  }).returning({ id: matchPlayersTable.id });
  rosterId = player.id;
});

beforeEach(async () => {
  vi.clearAllMocks();
  vi.mocked(readClaimSegment).mockResolvedValue(Buffer.from(JSON.stringify(segment), "utf8") as never);
  vi.mocked(getLocalAccountUserId).mockResolvedValue(playerId);
  vi.mocked(getLocalUserId).mockResolvedValue(playerId);
  await db.delete(matchTeamSpansTable).where(eq(matchTeamSpansTable.matchId, roomId));
  await db.delete(claimMatchOffPitchSpansTable).where(eq(claimMatchOffPitchSpansTable.recordingId, recordingId));
  await db.delete(claimMatchProgressTable).where(eq(claimMatchProgressTable.recordingId, recordingId));
  await db.delete(recordingGoalVotesTable).where(eq(recordingGoalVotesTable.recordingId, recordingId));
  await primeCache();
});

afterAll(async () => {
  await db.delete(footageRequestsTable).where(eq(footageRequestsTable.id, requestId));
  await db.delete(recordingSchedulesTable).where(eq(recordingSchedulesTable.fieldId, fieldId));
  await db.delete(recordingsTable).where(eq(recordingsTable.id, recordingId));
  for (const id of [adminId, playerId]) await db.delete(usersTable).where(eq(usersTable.id, id));
  await db.delete(fieldsTable).where(eq(fieldsTable.id, fieldId));
});

describe("the stats cache fingerprint covers every input of the stats", () => {
  it("a team switch (a claim team span) makes the cache recompute", async () => {
    await db.insert(matchTeamSpansTable).values({
      matchId: roomId, matchPlayerId: rosterId, fromOffsetSec: 2, toOffsetSec: 8, team: "B", source: "claim",
    });
    await fillMatchStatsCacheForMatch(roomId);
    expect((await cacheRow()).stats.touches).not.toBe(SENTINEL);
  });

  it("a saved shirt change in the claim's switches makes the cache recompute", async () => {
    await db.insert(claimMatchProgressTable).values({
      userId: playerId, recordingId,
      gameState: { matchChoices: [roomCode], switches: [{ atSeconds: 3, team: "B", teamChanged: true, shirtChanged: true, matchCode: roomCode }] },
    });
    await fillMatchStatsCacheForMatch(roomId);
    expect((await cacheRow()).stats.touches).not.toBe(SENTINEL);
  });

  it("an off-pitch span makes the cache recompute", async () => {
    await db.insert(claimMatchOffPitchSpansTable).values({
      userId: playerId, recordingId, clientId: `${TAG}-bench`, fromSeconds: 5, toSeconds: 6,
    });
    await fillMatchStatsCacheForMatch(roomId);
    expect((await cacheRow()).stats.touches).not.toBe(SENTINEL);
  });

  it("a goal vote makes the cache recompute", async () => {
    await db.insert(recordingGoalVotesTable).values({ recordingId, atTenths: 40, userId: playerId, verdict: "goal", matchId: roomId });
    await fillMatchStatsCacheForMatch(roomId);
    expect((await cacheRow()).stats.touches).not.toBe(SENTINEL);
  });
});

describe("saves that change those inputs invalidate the cache and queue a refresh", () => {
  it("a state-only /find save that changes the switches", async () => {
    const save = await request(app).put(`/api/recordings/${recordingId}/claim-match/game`).send({
      state: { matchChoices: [roomCode], switches: [{ atSeconds: 3, team: "B", teamChanged: true, shirtChanged: true, matchCode: roomCode }] },
      bench: [],
      done: false,
    });
    expect(save.status).toBe(200);
    expect(await cacheRow()).toBeUndefined();
    expect(queueMatchStatsCacheForRecording).toHaveBeenCalledWith(recordingId, expect.anything());
  });

  it("a state-only save that leaves the switches alone does not throw the cache away", async () => {
    const save = await request(app).put(`/api/recordings/${recordingId}/claim-match/game`).send({
      state: { step: "intro" }, bench: [], done: false,
    });
    expect(save.status).toBe(200);
    expect((await cacheRow())?.stats.touches).toBe(SENTINEL);
  });

  it("declaring and removing off-pitch time", async () => {
    const add = await request(app).post(`/api/recordings/${recordingId}/claim-match/off-pitch`)
      .send({ clientId: `${TAG}-op`, fromSeconds: 5, toSeconds: 6 });
    expect(add.status).toBe(201);
    expect(await cacheRow()).toBeUndefined();
    expect(queueMatchStatsCacheForRecording).toHaveBeenCalledWith(recordingId, expect.anything());

    await primeCache();
    vi.mocked(queueMatchStatsCacheForRecording).mockClear();
    const remove = await request(app).delete(`/api/recordings/${recordingId}/claim-match/off-pitch/${TAG}-op`);
    expect(remove.status).toBe(200);
    expect(await cacheRow()).toBeUndefined();
    expect(queueMatchStatsCacheForRecording).toHaveBeenCalledWith(recordingId, expect.anything());
  });
});
