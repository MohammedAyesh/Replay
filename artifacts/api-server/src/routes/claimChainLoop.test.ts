/**
 * Drive the real endpoints the way a person does, and insist the flow makes
 * progress. Not "does each call return something sensible" -- the per-call
 * tests cover that -- but "does answering a question ever get you a DIFFERENT
 * question".
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express, { type Express } from "express";
import { eq } from "drizzle-orm";

vi.mock("../lib/claimMatchStorage", () => ({
  deleteClaimSegment: vi.fn(), readClaimSegment: vi.fn(),
  readCompressedClaimSegment: vi.fn(), writeClaimSegment: vi.fn(),
}));
vi.mock("../lib/clerkUserBridge", () => ({
  getLocalAccountUserId: vi.fn(), getLocalUserId: vi.fn(),
  unauthenticatedResponse: vi.fn((res: any, _r: any, e = "Unauthenticated") => res.status(401).json({ error: e })),
}));

import {
  db, claimChainLabelsTable, fieldsTable, recordingSchedulesTable,
  recordingTrackingBundlesTable, recordingTrackingSegmentsTable, recordingsTable,
  usersTable, type TrackingManifest, type TrackingSegmentPayload,
} from "@workspace/db";
import { readClaimSegment } from "../lib/claimMatchStorage";
import { getLocalAccountUserId, getLocalUserId } from "../lib/clerkUserBridge";

const TAG = `loop-${Date.now()}`;
const FPS = 20;
let app: Express, fieldId: number, adminId: number, playerId: number;
let recordingId: number, bundleId: number;

/**
 * One player, as the tracker actually sees them on a floodlit five-a-side
 * pitch: one id, but the detector drops them for half a second whenever they
 * pass a floodlight or another body. Boxes exist either side of each gap.
 */
function fragmented(id: string, y: number, from: number, to: number, gapEvery: number, gapLen: number) {
  const boxes = [];
  for (let f = from; f <= to; f++) {
    if (Math.floor((f - from) / gapEvery) % 2 === 1 && (f - from) % gapEvery < gapLen) continue;
    boxes.push({ frame: f, x: 100 + (f - from) * 2, y, w: 20, h: 40 });
  }
  return { id, startFrame: boxes[0].frame, endFrame: boxes[boxes.length - 1].frame, boxes };
}

const segment: TrackingSegmentPayload = {
  segmentIndex: 0, name: "only", startFrame: 0, endFrame: 2399,
  startSeconds: 0, endSeconds: 120,
  tracks: [
    // 30-frame (1.5 s) holes every 200 frames -- well past maxBridgeGapFrames.
    fragmented("ME", 500, 0, 2399, 200, 30),
    fragmented("OTHER", 700, 0, 2399, 320, 20),
    { id: "SPARSE", startFrame: 100, endFrame: 2300,
      boxes: Array.from({ length: 111 }, (_, i) => ({ frame: 100 + i * 20, x: 300, y: 900, w: 20, h: 40 })) },
  ],
  crossings: [{ frame: 700, trackId: "ME", otherTrackId: "OTHER", confidence: 0.2 }],
  inPlaySpans: [], events: [],
} as never;

const manifest: TrackingManifest = {
  version: 1, label: "loop", width: 1920, height: 1080, frameRate: FPS,
  frameCount: 2400, duration: 120, matchOffset: 0, videoStartSeconds: 0, segmentCount: 1,
  segments: [{ index: 0, name: "only", startFrame: 0, endFrame: 2399, startSeconds: 0, endSeconds: 120, objectPath: `${TAG}/s0.json` }],
  summary: { segments: [{ segmentIndex: 0, startFrame: 0, endFrame: 2399, startSeconds: 0, endSeconds: 120,
    tracks: segment.tracks.map((t) => ({ id: t.id, startFrame: t.startFrame, endFrame: t.endFrame })), events: [] }] },
} as never;

const url = (s = "") => `/api/recordings/${recordingId}/claim-match/chain${s}`;

beforeAll(async () => {
  const { default: r } = await import("./claimChain");
  app = express(); app.use(express.json()); app.use("/api", r);
  const [f] = await db.insert(fieldsTable).values({ name: `${TAG} f`, location: "T" }).returning({ id: fieldsTable.id });
  fieldId = f.id;
  const made = await db.insert(usersTable).values([
    { name: `${TAG} a`, email: `${TAG}-a@t.local`, isGuest: false, profileComplete: true, isAdmin: true },
    { name: "Mohammed", email: `${TAG}-p@t.local`, isGuest: false, profileComplete: true, isAdmin: false },
  ]).returning({ id: usersTable.id });
  [adminId, playerId] = made.map((m) => m.id);
  const [rec] = await db.insert(recordingsTable).values({
    fieldId, court: "1", date: "2026-09-06", timeSlot: "18:00", duration: "00:02:00",
    videoUrl: "https://e.test/x.m3u8", isVisible: true,
  }).returning({ id: recordingsTable.id });
  recordingId = rec.id;
  await db.insert(recordingSchedulesTable).values({ fieldId, allowedDate: "2026-09-06", startTime: "00:00", endTime: "23:59", label: `${TAG} v` });
  const [b] = await db.insert(recordingTrackingBundlesTable).values({ recordingId, uploadedBy: adminId, manifest })
    .returning({ id: recordingTrackingBundlesTable.id });
  bundleId = b.id;
  await db.insert(recordingTrackingSegmentsTable).values({
    bundleId, segmentIndex: 0, name: "only", startFrame: 0, endFrame: 2399,
    startSeconds: 0, endSeconds: 120, objectPath: `${TAG}/s0.json`, trackCount: 3, crossingCount: 1 });
});

beforeEach(async () => {
  try { await db.delete(claimChainLabelsTable).where(eq(claimChainLabelsTable.recordingId, recordingId)); } catch { /* table may be absent on purpose */ }
  vi.clearAllMocks();
  vi.mocked(readClaimSegment).mockResolvedValue(Buffer.from(JSON.stringify(segment), "utf8") as never);
  vi.mocked(getLocalAccountUserId).mockResolvedValue(playerId);
  vi.mocked(getLocalUserId).mockResolvedValue(playerId);
  await db.update(recordingTrackingBundlesTable).set({ manifest }).where(eq(recordingTrackingBundlesTable.id, bundleId));
});

afterAll(async () => {
  await db.delete(recordingSchedulesTable).where(eq(recordingSchedulesTable.fieldId, fieldId));
  await db.delete(recordingsTable).where(eq(recordingsTable.id, recordingId));
  for (const id of [adminId, playerId]) await db.delete(usersTable).where(eq(usersTable.id, id));
  await db.delete(fieldsTable).where(eq(fieldsTable.id, fieldId));
});

describe("a whole claim, answered the way a person answers it", () => {
  it("keeps making progress instead of asking every couple of seconds", async () => {
    const me = segment.tracks[0];
    let res = await request(app).post(url("/tap")).send({ trackId: "ME", frame: 10, name: "Mohammed" });
    expect(res.status).toBe(200);

    let steps = 0;
    while (res.body.nextUncertainty && steps < 40) {
      steps += 1;
      const u = res.body.nextUncertainty;
      if (u.kind === "swap") {
        res = await request(app).post(url("/confirm")).send({ frame: u.frame });
      } else {
        // A person finds themselves again a few frames later and taps.
        const next = me.boxes.find((b: any) => b.frame > u.frame);
        if (!next) break;
        res = await request(app).post(url("/tap")).send({ trackId: "ME", frame: next.frame });
      }
      expect(res.status).toBe(200);
    }

    // 2400 frames of one player. A handful of questions is a claim; forty is
    // an interrogation and nobody finishes it.
    expect(steps).toBeLessThan(12);
  });

  /**
   * The client refetches on window focus -- react-query's default. Alt-tab
   * away and back, or take a screenshot, and a GET lands. A GET carries no
   * "and this is the frame I just answered", so it is the one request that
   * has to stand on stored state alone.
   */
  it("a refetch does not resurrect a question that was already answered", async () => {
    const me = segment.tracks[0];
    let res = await request(app).post(url("/tap")).send({ trackId: "ME", frame: 10, name: "Mohammed" });
    const answers: number[] = [];
    for (let i = 0; i < 4 && res.body.nextUncertainty; i++) {
      const u = res.body.nextUncertainty;
      answers.push(u.frame);
      const next = me.boxes.find((b: any) => b.frame > u.frame);
      if (!next) break;
      res = await request(app).post(url("/tap")).send({ trackId: "ME", frame: next.frame });
    }
    const afterAnswering = res.body.nextUncertainty?.frame ?? null;

    const reread = await request(app).get(url());
    const afterRefetch = reread.body.nextUncertainty?.frame ?? null;

    expect(afterRefetch).not.toBeNull();
    // A refetch must not hand back a moment already dealt with. If it does,
    // reachedStop (>=) fires at once on a stop behind the playhead and the
    // page wedges into play-pause-play-pause.
    expect(afterRefetch!).toBeGreaterThanOrEqual(afterAnswering!);
  });

  /**
   * The detector caught this player once, then lost them for a second. That
   * is ordinary in a crowd under floodlights -- and `extendChain` refuses to
   * bridge a gap longer than maxBridgeGapFrames, so the part it creates ends
   * on the very frame that was tapped.
   */
  it("a tap onto a sparse detection does not stop you where you just tapped", async () => {
    await request(app).post(url("/tap")).send({ trackId: "ME", frame: 10, name: "Mohammed" });
    const tapped = await request(app).post(url("/tap")).send({ trackId: "SPARSE", frame: 500 });
    expect(tapped.status).toBe(200);
    const parts = tapped.body.chain.filter((p: any) => p.trackId === "SPARSE");
    const write = tapped.body.nextUncertainty?.frame ?? null;
    const reread = await request(app).get(url());
    const get = reread.body.nextUncertainty?.frame ?? null;

    expect(get).not.toBe(500);
    if (get !== null) expect(get).toBeGreaterThan(500);
  });

  /**
   * Tap a player on the very last frame the detector has of them. The chain
   * then ends exactly where the tap was, and the two request shapes have to
   * agree about it: a write carries `afterFrame` and knows the frame is
   * answered, a GET does not and has only the stored chain to go on. Before
   * the floor became exclusive of the tap, they disagreed -- and the GET's
   * answer was a stop sitting on the playhead.
   */
  it("tapping on a track's final frame does not leave a stop sitting on the playhead", async () => {
    await request(app).post(url("/tap")).send({ trackId: "ME", frame: 10, name: "Mohammed" });
    const last = (segment.tracks[2] as any).endFrame; // SPARSE ends at 2300
    const write = await request(app).post(url("/tap")).send({ trackId: "SPARSE", frame: last });
    expect(write.status).toBe(200);
    const reread = await request(app).get(url());
    const fromWrite = write.body.nextUncertainty?.frame ?? null;
    const fromGet = reread.body.nextUncertainty?.frame ?? null;
    expect(fromGet).toBe(fromWrite);
    if (fromGet !== null) expect(fromGet).toBeGreaterThan(last);
  });

  it('"yes, still me" survives a refetch', async () => {
    await request(app).post(url("/tap")).send({ trackId: "ME", frame: 10, name: "Mohammed" });
    let res = await request(app).get(url());
    const swap = res.body.nextUncertainty;
    expect(swap).toMatchObject({ kind: "swap", frame: 700 });

    const confirmed = await request(app).post(url("/confirm")).send({ frame: 700 });
    expect(confirmed.body.nextUncertainty?.frame).not.toBe(700);

    // A confirm changes nothing about the chain, so it is the answer with the
    // least to stand on. If it does not survive a refetch, the crossing comes
    // straight back the moment the window regains focus.
    const reread = await request(app).get(url());
    expect(reread.body.nextUncertainty?.frame ?? null).not.toBe(700);
  });
});