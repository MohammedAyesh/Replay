/**
 * Start over (DELETE /recordings/:id/claim-match/game) against a real
 * database: it has to take away everything the claim left behind for THIS
 * player on THIS recording, and nothing that belongs to anyone else or that
 * the player made himself.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express, { type Express } from "express";
import { and, eq, inArray } from "drizzle-orm";

vi.mock("../lib/claimMatchStorage", () => ({
  deleteClaimSegment: vi.fn(),
  readClaimSegment: vi.fn(),
  readCompressedClaimSegment: vi.fn(),
  writeClaimSegment: vi.fn(),
}));

// Background stats fills would race this file's own cleanup; nothing here reads them.
vi.mock("../lib/matchStatsCacheJobs", () => ({
  queueMatchStatsCacheForMatch: vi.fn(),
  queueMatchStatsCacheForRecording: vi.fn(),
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
  claimChainLabelsTable,
  claimMatchIdentityBindingsTable,
  claimMatchOffPitchSpansTable,
  claimMatchProgressTable,
  fieldsTable,
  footageRequestsTable,
  matchPlayersTable,
  matchTeamSpansTable,
  recordingSchedulesTable,
  recordingTrackingBundlesTable,
  recordingTrackingSegmentsTable,
  recordingsTable,
  userClipsTable,
  usersTable,
  type TrackingManifest,
  type TrackingSegmentPayload,
} from "@workspace/db";
import { readClaimSegment } from "../lib/claimMatchStorage";
import { getLocalAccountUserId, getLocalUserId } from "../lib/clerkUserBridge";
import { ensureRoomForRequest } from "../lib/matchRooms";

const TAG = `start-over-${Date.now()}`;
const OBJECT_PATH = `${TAG}/segment-0.json`;
const FPS = 25;

let app: Express;
let fieldId: number;
let adminId: number;
let playerId: number;
let rivalId: number;
let recordingId: number;
let bundleId: number;
let requestId: number;
let roomId: number;
let roomCode: string;

function boxes(from: number, to: number, x0: number, dx: number, y: number) {
  const out = [];
  for (let frame = from; frame <= to; frame++) out.push({ frame, x: x0 + dx * (frame - from), y, w: 20, h: 40 });
  return out;
}

const segment: TrackingSegmentPayload = {
  segmentIndex: 0, name: "only", startFrame: 0, endFrame: 199, startSeconds: 0, endSeconds: 8,
  tracks: [
    { id: "t1", startFrame: 0, endFrame: 99, boxes: boxes(0, 99, 100, 2, 200) },
    { id: "t2", startFrame: 100, endFrame: 199, boxes: boxes(100, 199, 300, 2, 200) },
    { id: "t3", startFrame: 0, endFrame: 199, boxes: boxes(0, 199, 900, -2, 400) },
  ],
  crossings: [], inPlaySpans: [], events: [],
} as never;

const manifest: TrackingManifest = {
  version: 1, label: "start over", width: 1920, height: 1080, frameRate: FPS,
  frameCount: 200, duration: 8, matchOffset: 0, videoStartSeconds: 0, segmentCount: 1,
  segments: [{ index: 0, name: "only", startFrame: 0, endFrame: 199, startSeconds: 0, endSeconds: 8, objectPath: OBJECT_PATH }],
  summary: { segments: [{ segmentIndex: 0, startFrame: 0, endFrame: 199, startSeconds: 0, endSeconds: 8,
    tracks: segment.tracks.map((t) => ({ id: t.id, startFrame: t.startFrame, endFrame: t.endFrame })), events: [] }] },
} as never;

function actAs(userId: number) {
  vi.mocked(getLocalAccountUserId).mockResolvedValue(userId);
  vi.mocked(getLocalUserId).mockResolvedValue(userId);
}

const gameUrl = (suffix = "") => `/api/recordings/${recordingId}/claim-match/game${suffix}`;
const chainUrl = () => `/api/recordings/${recordingId}/claim-match/chain`;

async function fingerprint(): Promise<string> {
  return (await request(app).get(gameUrl())).body.bundleFingerprint as string;
}

/** A finished /find claim that switched to team B at 2 s, plus one recorded decision. */
async function finishClaim(userId: number) {
  actAs(userId);
  const fp = await fingerprint();
  const decision = await request(app).post(gameUrl("/decision")).send({
    kind: "confirm", frame: 10, rightTrackId: "t1", bundleFingerprint: fp,
  });
  expect(decision.status).toBe(200);
  const save = await request(app).put(gameUrl()).send({
    state: {
      step: "done",
      matchChoices: [roomCode],
      switches: [{ atSeconds: 2, team: "B", teamChanged: true, shirtChanged: false, matchCode: roomCode }],
    },
    parts: [{ trackId: "t1", fromFrame: 0, toFrame: 99 }, { trackId: "t2", fromFrame: 100, toFrame: 199 }],
    bench: [{ fromSeconds: 7, toSeconds: 7.5 }],
    done: true,
    bundleFingerprint: fp,
  });
  expect(save.status).toBe(200);
}

async function rosterRow(userId: number) {
  const [row] = await db.select().from(matchPlayersTable)
    .where(and(eq(matchPlayersTable.matchId, roomId), eq(matchPlayersTable.userId, userId)));
  return row;
}

beforeAll(async () => {
  const { default: claimChainRouter } = await import("./claimChain");
  const { default: claimGameRouter } = await import("./claimGame");
  app = express();
  app.use(express.json());
  app.use("/api", claimChainRouter);
  app.use("/api", claimGameRouter);

  const [field] = await db.insert(fieldsTable).values({ name: `${TAG} field`, location: "Test", cameraId: `cam-${TAG}` })
    .returning({ id: fieldsTable.id });
  fieldId = field.id;
  const made = await db.insert(usersTable).values([
    { name: `${TAG} admin`, email: `${TAG}-admin@test.local`, isGuest: false, profileComplete: true, isAdmin: true },
    { name: "Mohammed", email: `${TAG}-player@test.local`, isGuest: false, profileComplete: true, isAdmin: false },
    { name: `${TAG} rival`, email: `${TAG}-rival@test.local`, isGuest: false, profileComplete: true, isAdmin: false },
  ]).returning({ id: usersTable.id });
  [adminId, playerId, rivalId] = made.map((row) => row.id);

  const [recording] = await db.insert(recordingsTable).values({
    fieldId, court: "1", date: "2026-09-06", timeSlot: "18:00", duration: "00:00:08",
    videoUrl: "https://example.test/start-over.m3u8", isVisible: true,
  }).returning({ id: recordingsTable.id });
  recordingId = recording.id;
  await db.insert(recordingSchedulesTable).values({
    fieldId, allowedDate: "2026-09-06", startTime: "00:00", endTime: "23:59", label: `${TAG} visibility`,
  });
  const [bundle] = await db.insert(recordingTrackingBundlesTable).values({ recordingId, uploadedBy: adminId, manifest })
    .returning({ id: recordingTrackingBundlesTable.id });
  bundleId = bundle.id;
  await db.insert(recordingTrackingSegmentsTable).values({
    bundleId, segmentIndex: 0, name: "only", startFrame: 0, endFrame: 199, startSeconds: 0, endSeconds: 8,
    objectPath: OBJECT_PATH, trackCount: 3, crossingCount: 0,
  });

  const [booking] = await db.insert(footageRequestsTable).values({
    fieldId, cameraId: `cam-${TAG}`, requestedBy: adminId,
    startLocal: "2026-09-06 18:00", endLocal: "2026-09-06 19:00", requestedSeconds: 3600, status: "ready",
  }).returning();
  requestId = booking.id;
  const room = await ensureRoomForRequest(booking);
  roomId = room.id;
  roomCode = room.code;
});

beforeEach(async () => {
  await db.delete(claimChainLabelsTable).where(eq(claimChainLabelsTable.recordingId, recordingId));
  await db.delete(claimMatchIdentityBindingsTable).where(eq(claimMatchIdentityBindingsTable.recordingId, recordingId));
  await db.delete(claimMatchOffPitchSpansTable).where(eq(claimMatchOffPitchSpansTable.recordingId, recordingId));
  await db.delete(claimMatchProgressTable).where(eq(claimMatchProgressTable.recordingId, recordingId));
  await db.delete(matchPlayersTable).where(eq(matchPlayersTable.matchId, roomId));
  await db.delete(userClipsTable).where(inArray(userClipsTable.userId, [playerId, rivalId]));
  await db.update(recordingTrackingBundlesTable).set({ manifest }).where(eq(recordingTrackingBundlesTable.id, bundleId));
  vi.clearAllMocks();
  vi.mocked(readClaimSegment).mockResolvedValue(Buffer.from(JSON.stringify(segment), "utf8") as never);
  actAs(playerId);
});

afterAll(async () => {
  await db.delete(footageRequestsTable).where(eq(footageRequestsTable.id, requestId));
  await db.delete(recordingSchedulesTable).where(eq(recordingSchedulesTable.fieldId, fieldId));
  await db.delete(recordingsTable).where(eq(recordingsTable.id, recordingId));
  for (const id of [adminId, playerId, rivalId]) await db.delete(usersTable).where(eq(usersTable.id, id));
  await db.delete(fieldsTable).where(eq(fieldsTable.id, fieldId));
});

describe("Start over cleans up this player's claim on this recording", () => {
  it("forgets his decision labels, so answered frames and the correction count start at zero", async () => {
    await finishClaim(rivalId);
    await finishClaim(playerId);
    const before = await db.select().from(claimChainLabelsTable).where(eq(claimChainLabelsTable.recordingId, recordingId));
    expect(before.filter((l) => l.userId === playerId)).toHaveLength(1);

    actAs(playerId);
    expect((await request(app).delete(gameUrl())).status).toBe(200);

    const after = await db.select().from(claimChainLabelsTable).where(eq(claimChainLabelsTable.recordingId, recordingId));
    expect(after.filter((l) => l.userId === playerId)).toHaveLength(0);
    // The other player's decision is his, and stays.
    expect(after.filter((l) => l.userId === rivalId)).toHaveLength(1);

    // A fresh claim after starting over counts no corrections it never made.
    const fp = await fingerprint();
    await request(app).put(gameUrl()).send({
      state: { step: "follow" }, parts: [{ trackId: "t1", fromFrame: 0, toFrame: 99 }], bench: [], done: false, bundleFingerprint: fp,
    });
    const [progress] = await db.select().from(claimMatchProgressTable).where(and(
      eq(claimMatchProgressTable.userId, playerId), eq(claimMatchProgressTable.recordingId, recordingId)));
    expect(progress.correctionCount).toBe(0);
  });

  it("removes his claim team-switch spans in the match over this recording, and keeps everyone else's", async () => {
    await finishClaim(rivalId);
    await finishClaim(playerId);
    const mine = await rosterRow(playerId);
    const rival = await rosterRow(rivalId);
    expect(mine).toBeTruthy();
    // A span the organiser set by hand is not the claim's to take away.
    await db.insert(matchTeamSpansTable).values({
      matchId: roomId, matchPlayerId: mine.id, fromOffsetSec: 0, toOffsetSec: 1, team: "A", source: "manual",
    });
    const claimSpans = async (playerRowId: number) => db.select().from(matchTeamSpansTable).where(and(
      eq(matchTeamSpansTable.matchId, roomId), eq(matchTeamSpansTable.matchPlayerId, playerRowId)));
    expect((await claimSpans(mine.id)).filter((s) => s.source === "claim")).toHaveLength(1);

    actAs(playerId);
    expect((await request(app).delete(gameUrl())).status).toBe(200);

    const left = await claimSpans(mine.id);
    expect(left.filter((s) => s.source === "claim")).toHaveLength(0);
    expect(left.filter((s) => s.source === "manual")).toHaveLength(1);
    expect((await claimSpans(rival.id)).filter((s) => s.source === "claim")).toHaveLength(1);
  });

  it("removes the moment clips Replay made from the claim, never a clip he cut himself", async () => {
    await finishClaim(playerId);
    const [moment, shared, ownCut] = await db.insert(userClipsTable).values([
      { userId: playerId, videoId: "vid-start-over", title: "Goal · 0:05", startTime: "0.1", endTime: "0.9", visibility: "private" },
      // A moment clip he has since made public: his now.
      { userId: playerId, videoId: "vid-start-over", title: "Shot · 0:03", startTime: "0", endTime: "0.7", visibility: "public" },
      { userId: playerId, videoId: "vid-start-over", title: "My run", startTime: "0", endTime: "0.5", visibility: "private", sourceRecordingId: recordingId },
    ]).returning({ id: userClipsTable.id });
    await db.update(claimMatchProgressTable).set({
      earnedClips: [
        { id: "goal-5", title: "Goal · 0:05", momentSeconds: 5, kind: "goal", status: "accepted", userClipId: moment.id },
        { id: "shot-3", title: "Shot · 0:03", momentSeconds: 3, kind: "shot", status: "accepted", userClipId: shared.id },
      ],
    }).where(and(eq(claimMatchProgressTable.userId, playerId), eq(claimMatchProgressTable.recordingId, recordingId)));

    expect((await request(app).delete(gameUrl())).status).toBe(200);

    const left = await db.select({ id: userClipsTable.id }).from(userClipsTable).where(eq(userClipsTable.userId, playerId));
    const ids = left.map((c) => c.id);
    expect(ids).not.toContain(moment.id);
    expect(ids).toContain(shared.id);
    expect(ids).toContain(ownCut.id);
  });

  it("does not take away the roster place (there is no marker of which rows a claim created)", async () => {
    await finishClaim(playerId);
    expect(await rosterRow(playerId)).toBeTruthy();
    expect((await request(app).delete(gameUrl())).status).toBe(200);
    expect(await rosterRow(playerId)).toBeTruthy();
  });

  it("a player's own Start over does not read as 'reset by admin'", async () => {
    await finishClaim(playerId);
    expect((await request(app).delete(gameUrl())).status).toBe(200);
    const chain = await request(app).get(chainUrl());
    expect(chain.status).toBe(200);
    expect(chain.body.chain).toEqual([]);
    expect(chain.body.resetByAdmin).toBe(false);
  });

  it("an administrator's release still reads as 'reset by admin'", async () => {
    await finishClaim(playerId);
    // An admin release takes the chain away and marks the binding released.
    const { claimIdentityId } = await import("./claimChain");
    const stored = (await db.select({ manifest: recordingTrackingBundlesTable.manifest }).from(recordingTrackingBundlesTable)
      .where(eq(recordingTrackingBundlesTable.id, bundleId)))[0].manifest;
    await db.update(recordingTrackingBundlesTable).set({
      manifest: { ...stored, identities: (stored.identities ?? []).filter((i) => i.id !== claimIdentityId(playerId, recordingId)) },
    }).where(eq(recordingTrackingBundlesTable.id, bundleId));
    await db.update(claimMatchIdentityBindingsTable).set({ state: "released" }).where(and(
      eq(claimMatchIdentityBindingsTable.userId, playerId), eq(claimMatchIdentityBindingsTable.recordingId, recordingId)));
    const chain = await request(app).get(chainUrl());
    expect(chain.body.resetByAdmin).toBe(true);
  });
});
