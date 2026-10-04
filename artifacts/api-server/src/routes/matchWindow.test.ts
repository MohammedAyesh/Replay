/**
 * PATCH /admin/recordings/:id/match-window, and every place the window is
 * applied: the booking links that match stats, team stats, the report and the
 * Home tiles are summed over (lib/matchFeed.ts), the /find picker's booking
 * windows (claimGame.claimMatchChoices), claim coverage and completion, and
 * the clips a claim earns -- plus what a bundle replacement does with it.
 *
 * Recording 392's shape, shrunk: 100 s of footage where the first 70 s are
 * someone else's game. Track "early" is a player of that game (0-70 s),
 * "late" one of ours (70-100 s). A goal at 30 s belongs to the other group,
 * one at 85 s to this match. Booking A (18:00-18:01, 0-60 s) only covers the
 * overrun; booking B (18:01-18:30) covers 60-100 s.
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

vi.mock("../lib/clerkUserBridge", () => ({
  getLocalAccountUserId: vi.fn(),
  getLocalUserId: vi.fn(),
  getLocalUserRecord: vi.fn(),
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
  matchRoomsTable,
  recordingSchedulesTable,
  recordingTrackingBundlesTable,
  recordingTrackingSegmentsTable,
  recordingsTable,
  usersTable,
  type TrackingManifest,
  type TrackingSegmentPayload,
} from "@workspace/db";
import { SetRecordingMatchWindowResponse } from "@workspace/api-zod";
import { deleteClaimSegment, readClaimSegment, writeClaimSegment } from "../lib/claimMatchStorage";
import { getLocalAccountUserId, getLocalUserId } from "../lib/clerkUserBridge";
import { ensureRoomForRequest, loadRoomById } from "../lib/matchRooms";
import { recordingsForRoom, roomsForRecording } from "../lib/matchFeed";

const mockedReadClaimSegment = vi.mocked(readClaimSegment);
const mockedWriteClaimSegment = vi.mocked(writeClaimSegment);
const mockedDeleteClaimSegment = vi.mocked(deleteClaimSegment);
const mockedAccountUser = vi.mocked(getLocalAccountUserId);
const mockedLocalUser = vi.mocked(getLocalUserId);

const TAG = `match-window-${Date.now()}`;
const OBJECT_PATH = `${TAG}/segment-0.json`;
const FPS = 10;

let app: Express;
let storeUploadBundle: typeof import("./claimMatch").storeUploadBundle;
let fieldId: number;
let adminId: number;
let playerId: number;
let recordingId: number;
let bundleId: number;
let roomA: { id: number; code: string };
let roomB: { id: number; code: string };
const requestIds: number[] = [];

function boxes(from: number, to: number, x0: number) {
  const out = [];
  for (let frame = from; frame <= to; frame += 1) out.push({ frame, x: x0, y: 200, w: 20, h: 40 });
  return out;
}

const segment: TrackingSegmentPayload = {
  segmentIndex: 0,
  name: "only",
  startFrame: 0,
  endFrame: 999,
  startSeconds: 0,
  endSeconds: 100,
  tracks: [
    { id: "early", startFrame: 0, endFrame: 699, boxes: boxes(0, 699, 100) },
    { id: "late", startFrame: 700, endFrame: 999, boxes: boxes(700, 999, 300) },
    { id: "straddle", startFrame: 600, endFrame: 999, boxes: boxes(600, 999, 600) },
  ],
  crossings: [],
  inPlaySpans: [],
  events: [
    { type: "goal", time: 30, label: "Their goal" },
    { type: "goal", time: 85, label: "Our goal" },
  ],
} as never;

const baseManifest: TrackingManifest = {
  version: 1,
  label: "match window test",
  width: 1920,
  height: 1080,
  frameRate: FPS,
  frameCount: 1000,
  duration: 100,
  matchOffset: 0,
  videoStartSeconds: 0,
  segmentCount: 1,
  segments: [{
    index: 0, name: "only", startFrame: 0, endFrame: 999, startSeconds: 0, endSeconds: 100, objectPath: OBJECT_PATH,
  }],
  summary: {
    segments: [{
      segmentIndex: 0,
      startFrame: 0,
      endFrame: 999,
      startSeconds: 0,
      endSeconds: 100,
      tracks: segment.tracks.map((t) => ({ id: t.id, startFrame: t.startFrame, endFrame: t.endFrame })),
      events: segment.events,
    }],
  },
} as never;

function actAs(userId: number | null) {
  mockedAccountUser.mockResolvedValue(userId as never);
  mockedLocalUser.mockResolvedValue(userId as never);
}

async function storedManifest(): Promise<TrackingManifest> {
  const [row] = await db
    .select({ manifest: recordingTrackingBundlesTable.manifest })
    .from(recordingTrackingBundlesTable)
    .where(eq(recordingTrackingBundlesTable.recordingId, recordingId));
  return row.manifest;
}

async function progress() {
  const [row] = await db.select().from(claimMatchProgressTable).where(and(
    eq(claimMatchProgressTable.recordingId, recordingId),
    eq(claimMatchProgressTable.userId, playerId),
  ));
  return row;
}

const windowUrl = (id = recordingId) => `/api/admin/recordings/${id}/match-window`;
const chainUrl = () => `/api/recordings/${recordingId}/claim-match/chain`;

async function setWindow(body: unknown) {
  actAs(adminId);
  return request(app).patch(windowUrl()).send(body as object);
}

async function adminSetChain(parts: Array<{ trackId: string; fromFrame: number; toFrame: number }>) {
  actAs(playerId);
  const fingerprint = (await request(app).get(chainUrl())).body.bundleFingerprint;
  actAs(adminId);
  const res = await request(app)
    .post(`/api/admin/recordings/${recordingId}/claim-match/chain-for-user`)
    .send({ userId: playerId, parts, bundleFingerprint: fingerprint });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res;
}

async function booking(startLocal: string, endLocal: string) {
  const [row] = await db.insert(footageRequestsTable).values({
    fieldId,
    cameraId: `cam-${TAG}`,
    requestedBy: adminId,
    startLocal,
    endLocal,
    requestedSeconds: 60,
    status: "scheduled",
  }).returning();
  requestIds.push(row.id);
  const room = await ensureRoomForRequest(row);
  return { id: room.id, code: room.code };
}

beforeAll(async () => {
  const claimChain = await import("./claimChain");
  const claimGame = await import("./claimGame");
  const matchWindow = await import("./matchWindow");
  ({ storeUploadBundle } = await import("./claimMatch"));
  app = express();
  app.use(express.json());
  app.use("/api", claimChain.default);
  app.use("/api", claimGame.default);
  app.use("/api", matchWindow.default);

  const [field] = await db.insert(fieldsTable).values({ name: `${TAG} field`, location: "Test" })
    .returning({ id: fieldsTable.id });
  fieldId = field.id;
  const made = await db.insert(usersTable).values([
    { name: `${TAG} admin`, email: `${TAG}-admin@test.local`, isGuest: false, profileComplete: true, isAdmin: true },
    { name: `${TAG} player`, email: `${TAG}-player@test.local`, isGuest: false, profileComplete: true, isAdmin: false },
  ]).returning({ id: usersTable.id });
  [adminId, playerId] = made.map((row) => row.id);

  const [recording] = await db.insert(recordingsTable).values({
    fieldId,
    court: "1",
    date: "2026-09-06",
    timeSlot: "18:00",
    duration: "00:01:40",
    videoUrl: "https://example.test/match-window.m3u8",
    isVisible: true,
  }).returning({ id: recordingsTable.id });
  recordingId = recording.id;
  await db.insert(recordingSchedulesTable).values({
    fieldId, allowedDate: "2026-09-06", startTime: "00:00", endTime: "23:59", label: `${TAG} visibility`,
  });
  const [bundle] = await db.insert(recordingTrackingBundlesTable).values({
    recordingId, uploadedBy: adminId, manifest: baseManifest,
  }).returning({ id: recordingTrackingBundlesTable.id });
  bundleId = bundle.id;
  await db.insert(recordingTrackingSegmentsTable).values({
    bundleId, segmentIndex: 0, name: "only", startFrame: 0, endFrame: 999, startSeconds: 0, endSeconds: 100,
    objectPath: OBJECT_PATH, trackCount: segment.tracks.length, crossingCount: 0,
  });

  roomA = await booking("2026-09-06 18:00", "2026-09-06 18:01");
  roomB = await booking("2026-09-06 18:01", "2026-09-06 18:30");
});

beforeEach(async () => {
  await db.delete(claimChainLabelsTable).where(eq(claimChainLabelsTable.recordingId, recordingId));
  await db.delete(claimMatchIdentityBindingsTable).where(eq(claimMatchIdentityBindingsTable.recordingId, recordingId));
  await db.delete(claimMatchOffPitchSpansTable).where(eq(claimMatchOffPitchSpansTable.recordingId, recordingId));
  await db.delete(claimMatchProgressTable).where(eq(claimMatchProgressTable.recordingId, recordingId));
  vi.clearAllMocks();
  mockedReadClaimSegment.mockResolvedValue(Buffer.from(JSON.stringify(segment), "utf8") as never);
  mockedDeleteClaimSegment.mockResolvedValue(undefined as never);
  await db.update(recordingTrackingBundlesTable)
    .set({ manifest: baseManifest, updatedAt: new Date() })
    .where(eq(recordingTrackingBundlesTable.recordingId, recordingId));
  actAs(adminId);
});

afterAll(async () => {
  await db.delete(claimMatchIdentityBindingsTable).where(eq(claimMatchIdentityBindingsTable.recordingId, recordingId));
  await db.delete(claimMatchProgressTable).where(eq(claimMatchProgressTable.recordingId, recordingId));
  await db.delete(claimChainLabelsTable).where(eq(claimChainLabelsTable.recordingId, recordingId));
  if (requestIds.length) {
    await db.delete(matchRoomsTable).where(inArray(matchRoomsTable.footageRequestId, requestIds));
    await db.delete(footageRequestsTable).where(inArray(footageRequestsTable.id, requestIds));
  }
  await db.delete(recordingSchedulesTable).where(eq(recordingSchedulesTable.fieldId, fieldId));
  await db.delete(recordingsTable).where(eq(recordingsTable.id, recordingId));
  for (const id of [adminId, playerId]) await db.delete(usersTable).where(eq(usersTable.id, id));
  await db.delete(fieldsTable).where(eq(fieldsTable.id, fieldId));
});

describe("the endpoint", () => {
  it("refuses anyone but an admin", async () => {
    actAs(playerId);
    expect((await request(app).patch(windowUrl()).send({ startSeconds: 70 })).status).toBe(403);
    actAs(null);
    expect((await request(app).patch(windowUrl()).send({ startSeconds: 70 })).status).toBe(403);
    expect((await storedManifest()).provenance?.matchWindow).toBeUndefined();
  });

  it("validates 0 <= start < end <= duration", async () => {
    for (const body of [
      {},
      { startSeconds: "70" },
      { startSeconds: -1 },
      { startSeconds: 100 },
      { startSeconds: 150 },
      { startSeconds: 50, endSeconds: 50 },
      { startSeconds: 50, endSeconds: 40 },
      { startSeconds: 50, endSeconds: 101 },
      { startSeconds: 50, why: "x".repeat(501) },
    ]) {
      const res = await setWindow(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect((await storedManifest()).provenance?.matchWindow).toBeUndefined();
  });

  it("is a 404 for a recording without a bundle", async () => {
    actAs(adminId);
    expect((await request(app).patch(windowUrl(2_000_000_000)).send({ startSeconds: 10 })).status).toBe(404);
  });

  it("stores the window without moving the bundle fingerprint, and clears it", async () => {
    actAs(playerId);
    const before = (await request(app).get(chainUrl())).body.bundleFingerprint;

    const res = await setWindow({ startSeconds: 70, why: "previous booking ran over" });
    expect(res.status).toBe(200);
    expect(SetRecordingMatchWindowResponse.safeParse(res.body).success).toBe(true);
    expect(res.body).toMatchObject({
      recordingId,
      duration: 100,
      matchWindow: { startSeconds: 70, endSeconds: null, source: "admin", setBy: adminId, why: "previous booking ran over" },
    });
    expect((await storedManifest()).provenance?.matchWindow).toMatchObject({ startSeconds: 70, source: "admin" });

    actAs(playerId);
    const after = await request(app).get(chainUrl());
    expect(after.body.bundleFingerprint).toBe(before);
    const game = await request(app).get(`/api/recordings/${recordingId}/claim-match/game`);
    expect(game.body.matchWindow).toEqual({ startSeconds: 70, endSeconds: 100 });

    const cleared = await setWindow({ startSeconds: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.matchWindow).toBeNull();
    expect((await storedManifest()).provenance?.matchWindow).toBeUndefined();
    actAs(playerId);
    expect((await request(app).get(`/api/recordings/${recordingId}/claim-match/game`)).body.matchWindow).toBeNull();
  });

  it("keeps the rest of provenance", async () => {
    await db.update(recordingTrackingBundlesTable)
      .set({ manifest: { ...baseManifest, provenance: { linker: "relink2.py" } } as TrackingManifest })
      .where(eq(recordingTrackingBundlesTable.recordingId, recordingId));
    await setWindow({ startSeconds: 70, endSeconds: 95 });
    expect((await storedManifest()).provenance).toMatchObject({
      linker: "relink2.py",
      matchWindow: { startSeconds: 70, endSeconds: 95 },
    });
  });
});

describe("match stats are summed over the window only", () => {
  it("clips booking links and drops a booking that only covers the overrun", async () => {
    const ctxA = (await loadRoomById(roomA.id))!;
    const ctxB = (await loadRoomById(roomB.id))!;
    expect((await recordingsForRoom(ctxA)).map((l) => [l.fromSeconds, l.toSeconds])).toEqual([[0, 60]]);
    expect((await recordingsForRoom(ctxB)).map((l) => [l.fromSeconds, l.toSeconds])).toEqual([[60, 100]]);

    await setWindow({ startSeconds: 70 });
    expect(await recordingsForRoom(ctxA)).toEqual([]);
    expect((await recordingsForRoom(ctxB)).map((l) => [l.fromSeconds, l.toSeconds])).toEqual([[70, 100]]);

    const rooms = await roomsForRecording(recordingId);
    expect(rooms.map((r) => [r.room.id, r.fromSeconds, r.toSeconds])).toEqual([[roomB.id, 70, 100]]);
  });

  it("clips the /find picker's booking windows the same way", async () => {
    actAs(playerId);
    const before = (await request(app).get(`/api/recordings/${recordingId}/claim-match/game`)).body;
    expect(before.matches.map((m: any) => [m.code, m.startSeconds, m.endSeconds]).sort())
      .toEqual([[roomA.code, 0, 60], [roomB.code, 60, 100]].sort());

    await setWindow({ startSeconds: 70 });
    actAs(playerId);
    const after = (await request(app).get(`/api/recordings/${recordingId}/claim-match/game`)).body;
    expect(after.matches.map((m: any) => [m.code, m.startSeconds, m.endSeconds])).toEqual([[roomB.code, 70, 100]]);
  });
});

describe("claims inside the window", () => {
  it("earns no clip for the other group's goal, and setting the window takes one away", async () => {
    // Claimed the whole recording, overrun included.
    await adminSetChain([
      { trackId: "early", fromFrame: 0, toFrame: 699 },
      { trackId: "late", fromFrame: 700, toFrame: 999 },
    ]);
    expect((await progress()).earnedClips.map((clip) => clip.momentSeconds)).toEqual([30, 85]);

    const res = await setWindow({ startSeconds: 70 });
    expect(res.body.resyncedClaims).toBe(1);
    const row = await progress();
    expect(row.earnedClips.map((clip) => clip.momentSeconds)).toEqual([85]);
    expect(row.completed).toBe(true);
    expect(row.claimedPercent).toBe(100);

    actAs(playerId);
    const chain = (await request(app).get(chainUrl())).body;
    // Coverage is the window's 30 s, all of it followed.
    expect(chain.coverageSeconds).toBeCloseTo(30, 0);
    expect(chain.coveragePercent).toBe(100);
  });

  it("measures completion against the window, and only the claimant's own save completes it", async () => {
    // 30 s of a 100 s recording: 30%, short of the bar.
    await adminSetChain([{ trackId: "late", fromFrame: 700, toFrame: 999 }]);
    expect((await progress()).completed).toBe(false);

    await setWindow({ startSeconds: 70 });
    actAs(playerId);
    const chain = (await request(app).get(chainUrl())).body;
    expect(chain.coveragePercent).toBe(100);
    expect(chain.completed).toBe(true);
    // The re-derivation after an admin edit never grants a completion...
    expect((await progress()).completed).toBe(false);
    // ...the claimant's next save does.
    await adminSetChain([{ trackId: "late", fromFrame: 700, toFrame: 999 }]);
    const row = await progress();
    expect(row.completed).toBe(true);
    expect(row.earnedClips.map((clip) => clip.momentSeconds)).toEqual([85]);
  });

  it("does not bring back a claim an admin released", async () => {
    await adminSetChain([
      { trackId: "early", fromFrame: 0, toFrame: 699 },
      { trackId: "late", fromFrame: 700, toFrame: 999 },
    ]);
    await db.update(claimMatchIdentityBindingsTable)
      .set({ state: "released", vouchedFragments: [] })
      .where(eq(claimMatchIdentityBindingsTable.recordingId, recordingId));

    const res = await setWindow({ startSeconds: 70 });
    expect(res.body.resyncedClaims).toBe(0);
    const [binding] = await db.select().from(claimMatchIdentityBindingsTable)
      .where(eq(claimMatchIdentityBindingsTable.recordingId, recordingId));
    expect(binding.state).toBe("released");
  });

  it("counts nothing for a claim that lies entirely outside the window", async () => {
    await setWindow({ startSeconds: 70 });
    await adminSetChain([{ trackId: "early", fromFrame: 0, toFrame: 699 }]);
    const row = await progress();
    expect(row.completed).toBe(false);
    expect(row.claimedPercent).toBe(0);
    expect(row.earnedClips).toEqual([]);
  });
});

describe("bundle replacement", () => {
  function upload(provenance?: Record<string, unknown>) {
    const { summary: _summary, ...manifest } = baseManifest as TrackingManifest & { summary?: unknown };
    return {
      manifest: {
        ...manifest,
        ...(provenance ? { provenance } : {}),
        segments: manifest.segments.map(({ objectPath: _objectPath, ...range }) => range),
      },
      segments: [segment],
    } as never;
  }

  beforeEach(() => {
    mockedWriteClaimSegment.mockImplementation(async (relativePath: string) => ({
      objectPath: `/objects/${TAG}/${relativePath}`,
      compressedBytes: 10,
    }) as never);
  });

  it("keeps an admin window when the new bundle carries none", async () => {
    await setWindow({ startSeconds: 70, why: "kick-off at 1:10" });
    await storeUploadBundle(recordingId, adminId, upload({ linker: "relink3.py" }));
    expect((await storedManifest()).provenance).toMatchObject({
      linker: "relink3.py",
      matchWindow: { startSeconds: 70, source: "admin", setBy: adminId, why: "kick-off at 1:10" },
    });
  });

  it("takes the new bundle's detector window over an admin one", async () => {
    await setWindow({ startSeconds: 70 });
    await storeUploadBundle(recordingId, adminId, upload({
      matchWindow: { startSeconds: 65, endSeconds: null, source: "detector" },
    }));
    const window = (await storedManifest()).provenance?.matchWindow as Record<string, unknown>;
    expect(window).toMatchObject({ startSeconds: 65, source: "detector" });
    expect(window.setBy).toBeUndefined();
  });

  it("drops a detector window that does not fit the new footage", async () => {
    await storeUploadBundle(recordingId, adminId, upload({
      matchWindow: { startSeconds: 500, source: "detector" },
    }));
    expect((await storedManifest()).provenance?.matchWindow).toBeUndefined();
  });
});
