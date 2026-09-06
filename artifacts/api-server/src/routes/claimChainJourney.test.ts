/**
 * One person's whole claim, end to end, through the real endpoints.
 *
 * The per-endpoint tests in claimChain.test.ts each check one call. This
 * checks the SEQUENCE, which is where the interesting failures live: every
 * individual response can be correct while the flow they add up to is a loop,
 * or asks about a moment that was answered two calls ago, or quietly stops
 * asking about anything at all.
 *
 * It found one before it was finished. Confirming "yes, still me" leaves the
 * chain unchanged, so the same crossing stayed the earliest uncertainty and
 * came straight back the instant playback resumed -- forever, for as long as
 * the person kept answering it. Tapping the OTHER player at that crossing did
 * the same thing from the other side, because the crossing involves the new
 * track just as symmetrically as the old one.
 *
 * THE MATCH
 *
 * Two players approach each other and cross at frame 100, and the tracker gets
 * it wrong: after the crossing, track A carries on along B's line and B along
 * A's. That is what a real swap looks like in the geometry, and it is the case
 * the detector exists for. A third player, C, is elsewhere the whole time and
 * has a crossing recorded with A at frame 200 where nothing actually happens --
 * there to prove a crossing on its own is not a reason to interrupt someone.
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
  claimChainLabelsTable,
  fieldsTable,
  recordingSchedulesTable,
  recordingTrackingBundlesTable,
  recordingTrackingSegmentsTable,
  recordingsTable,
  usersTable,
  type TrackingManifest,
  type TrackingSegmentPayload,
} from "@workspace/db";
import { readClaimSegment } from "../lib/claimMatchStorage";
import { getLocalAccountUserId, getLocalUserId } from "../lib/clerkUserBridge";

const TAG = `claim-journey-${Date.now()}`;
const OBJECT_PATH = `${TAG}/segment-0.json`;
const FPS = 25;
const CROSS = 100;

let app: Express;
let fieldId: number;
let adminId: number;
let playerId: number;
let recordingId: number;
let bundleId: number;

/** A straight run: one box per frame, constant velocity. */
function run(from: number, to: number, x0: number, vx: number, y: number, h: number) {
  return Array.from({ length: to - from + 1 }, (_, i) => ({
    frame: from + i,
    x: x0 + vx * i,
    y,
    w: 20,
    h,
  }));
}

/**
 * A and B meet at x=500 on frame 100 travelling in opposite directions, and
 * each carries on along the OTHER's line afterwards. Straight-through costs
 * 8 + 8; swapped costs 0 + 0; the evidence is 16 against a threshold of 6.
 * Heights are equal so the signal here is velocity alone and the test is not
 * quietly passing on a height difference.
 */
const segment: TrackingSegmentPayload = {
  segmentIndex: 0,
  name: "only",
  startFrame: 0,
  endFrame: 299,
  startSeconds: 0,
  endSeconds: 12,
  tracks: [
    {
      id: "A",
      startFrame: 0,
      endFrame: 299,
      boxes: [...run(0, CROSS - 1, 100, 4, 200, 40), ...run(CROSS, 299, 500, -4, 200, 40)],
    },
    {
      id: "B",
      startFrame: 0,
      endFrame: 299,
      boxes: [...run(0, CROSS - 1, 900, -4, 200, 40), ...run(CROSS, 299, 500, 4, 200, 40)],
    },
    { id: "C", startFrame: 0, endFrame: 299, boxes: run(0, 299, 100, 0, 800, 40) },
  ],
  crossings: [
    { frame: CROSS, trackId: "A", otherTrackId: "B", confidence: 0.8 },
    // Nothing happens here: both carry straight on, and the tracker was sure.
    { frame: 200, trackId: "A", otherTrackId: "C", confidence: 0.9 },
  ],
  inPlaySpans: [],
  events: [],
} as never;

const manifest: TrackingManifest = {
  version: 1,
  label: "journey",
  width: 1920,
  height: 1080,
  frameRate: FPS,
  frameCount: 300,
  duration: 12,
  matchOffset: 0,
  videoStartSeconds: 0,
  segmentCount: 1,
  segments: [{
    index: 0, name: "only", startFrame: 0, endFrame: 299,
    startSeconds: 0, endSeconds: 12, objectPath: OBJECT_PATH,
  }],
  summary: {
    segments: [{
      segmentIndex: 0, startFrame: 0, endFrame: 299, startSeconds: 0, endSeconds: 12,
      tracks: segment.tracks.map((t) => ({ id: t.id, startFrame: t.startFrame, endFrame: t.endFrame })),
      events: [],
    }],
  },
} as never;

const url = (suffix = "") => `/api/recordings/${recordingId}/claim-match/chain${suffix}`;

beforeAll(async () => {
  const { default: claimChainRouter } = await import("./claimChain");
  app = express();
  app.use(express.json());
  app.use("/api", claimChainRouter);

  const [field] = await db.insert(fieldsTable)
    .values({ name: `${TAG} field`, location: "Test" })
    .returning({ id: fieldsTable.id });
  fieldId = field.id;

  const made = await db.insert(usersTable).values([
    { name: `${TAG} admin`, email: `${TAG}-a@test.local`, isGuest: false, profileComplete: true, isAdmin: true },
    { name: "Mohammed", email: `${TAG}-p@test.local`, isGuest: false, profileComplete: true, isAdmin: false },
  ]).returning({ id: usersTable.id });
  [adminId, playerId] = made.map((row) => row.id);

  const [recording] = await db.insert(recordingsTable).values({
    fieldId, court: "1", date: "2026-09-06", timeSlot: "18:00",
    duration: "00:00:12", videoUrl: "https://example.test/j.m3u8", isVisible: true,
  }).returning({ id: recordingsTable.id });
  recordingId = recording.id;

  await db.insert(recordingSchedulesTable).values({
    fieldId, allowedDate: "2026-09-06", startTime: "00:00", endTime: "23:59", label: `${TAG} vis`,
  });

  const [bundle] = await db.insert(recordingTrackingBundlesTable)
    .values({ recordingId, uploadedBy: adminId, manifest })
    .returning({ id: recordingTrackingBundlesTable.id });
  bundleId = bundle.id;

  await db.insert(recordingTrackingSegmentsTable).values({
    bundleId, segmentIndex: 0, name: "only", startFrame: 0, endFrame: 299,
    startSeconds: 0, endSeconds: 12, objectPath: OBJECT_PATH,
    trackCount: 3, crossingCount: 2,
  });
});

beforeEach(async () => {
  await db.delete(claimChainLabelsTable).where(eq(claimChainLabelsTable.recordingId, recordingId));
  vi.clearAllMocks();
  vi.mocked(readClaimSegment).mockResolvedValue(Buffer.from(JSON.stringify(segment), "utf8") as never);
  vi.mocked(getLocalAccountUserId).mockResolvedValue(playerId);
  vi.mocked(getLocalUserId).mockResolvedValue(playerId);
  await db.update(recordingTrackingBundlesTable)
    .set({ manifest })
    .where(eq(recordingTrackingBundlesTable.id, bundleId));
});

afterAll(async () => {
  await db.delete(recordingSchedulesTable).where(eq(recordingSchedulesTable.fieldId, fieldId));
  await db.delete(recordingsTable).where(eq(recordingsTable.id, recordingId));
  for (const id of [adminId, playerId]) {
    await db.delete(usersTable).where(eq(usersTable.id, id));
  }
  await db.delete(fieldsTable).where(eq(fieldsTable.id, fieldId));
});

describe("the whole claim, one call after another", () => {
  it("stops at the swap, not at the crossing where nothing happened", async () => {
    const tapped = await request(app).post(url("/tap"))
      .send({ trackId: "A", frame: 20, name: "Mohammed" });
    expect(tapped.status).toBe(200);
    expect(tapped.body.chain).toEqual([{ trackId: "A", fromFrame: 20, toFrame: 299 }]);

    // A crossing on its own is not a reason to interrupt someone. The one at
    // frame 200 is closer to the track end and would win if it were raised.
    expect(tapped.body.nextUncertainty).toMatchObject({
      kind: "swap",
      frame: CROSS,
      trackId: "A",
      otherTrackId: "B",
    });
  });

  it("does not ask the same question again after 'yes, still me'", async () => {
    await request(app).post(url("/tap")).send({ trackId: "A", frame: 20, name: "Mohammed" });
    const confirmed = await request(app).post(url("/confirm"))
      .send({ frame: CROSS, decisionMs: 1400 });

    // The chain is unchanged by a confirm, so without suppression this comes
    // back identical and the person answers it forever.
    expect(confirmed.body.nextUncertainty?.frame).not.toBe(CROSS);
    expect(confirmed.body.nextUncertainty).toMatchObject({ kind: "track-end", frame: 299 });

    // And it stays answered on a fresh read, not just in that one response.
    const reread = await request(app).get(url());
    expect(reread.body.nextUncertainty).toMatchObject({ kind: "track-end", frame: 299 });
  });

  it("does not ask it again from the other side after switching players", async () => {
    await request(app).post(url("/tap")).send({ trackId: "A", frame: 20, name: "Mohammed" });
    const switched = await request(app).post(url("/tap"))
      .send({ trackId: "B", frame: CROSS, rejectedTrackId: "A", decisionMs: 2600 });

    expect(switched.body.chain).toEqual([
      { trackId: "A", fromFrame: 20, toFrame: 99 },
      { trackId: "B", fromFrame: CROSS, toFrame: 299 },
    ]);
    // The crossing involves B exactly as symmetrically as it involved A.
    expect(switched.body.nextUncertainty?.frame).not.toBe(CROSS);
    expect(switched.body.nextUncertainty).toMatchObject({ kind: "track-end", frame: 299 });
  });

  it("records the switch as a labelled correction with its geometry", async () => {
    await request(app).post(url("/tap")).send({ trackId: "A", frame: 20, name: "Mohammed" });
    await db.delete(claimChainLabelsTable).where(eq(claimChainLabelsTable.recordingId, recordingId));
    await request(app).post(url("/tap"))
      .send({ trackId: "B", frame: CROSS, rejectedTrackId: "A", decisionMs: 2600 });

    const [label] = await db.select().from(claimChainLabelsTable)
      .where(eq(claimChainLabelsTable.recordingId, recordingId));
    expect(label).toMatchObject({
      kind: "switch", atFrame: CROSS, wrongTrackId: "A", rightTrackId: "B", decisionMs: 2600,
    });
    // The detector's own reading, stored so it can be scored against the human.
    expect(label.detectorSwapEvidence).toBeGreaterThan(0);
    const geom = label.geom as any;
    expect(geom.chosen.trackId).toBe("B");
    expect(geom.rejected.trackId).toBe("A");
    expect(geom.alternatives.map((a: any) => a.trackId)).toEqual(["C"]);
  });

  it("ends with nothing left to ask, and the right seconds attributed", async () => {
    await request(app).post(url("/tap")).send({ trackId: "A", frame: 20, name: "Mohammed" });
    await request(app).post(url("/tap"))
      .send({ trackId: "B", frame: CROSS, rejectedTrackId: "A" });
    const done = await request(app).post(url("/not-me")).send({ frame: 299 });

    expect(done.body.nextUncertainty).toBeNull();
    // Frames 20..298 at 25fps. Coverage is what was watched and confirmed --
    // it cannot be inflated by one lucky tap, and there is no tie to collapse.
    expect(done.body.coverageSeconds).toBeCloseTo((299 - 20) / FPS, 2);
  });

  it("leaves one identity on the board, named by the person in it", async () => {
    await request(app).post(url("/tap")).send({ trackId: "A", frame: 20, name: "Mohammed" });
    await request(app).post(url("/tap"))
      .send({ trackId: "B", frame: CROSS, rejectedTrackId: "A" });

    const [row] = await db.select({ manifest: recordingTrackingBundlesTable.manifest })
      .from(recordingTrackingBundlesTable)
      .where(eq(recordingTrackingBundlesTable.id, bundleId));
    const identities = row.manifest.identities ?? [];
    expect(identities).toHaveLength(1);
    expect(identities[0].name).toBe("Mohammed");
    expect(identities[0].parts).toEqual([
      { trackId: "A", fromFrame: 20, toFrame: 99 },
      { trackId: "B", fromFrame: CROSS, toFrame: 299 },
    ]);
    // The map has to claim to belong to THIS bundle or usableIdentityMap
    // discards the whole thing and the work becomes invisible.
    expect(row.manifest.provenance?.identityMapBundleFingerprint)
      .toBe(row.manifest.provenance?.bundleFingerprint);
  });

  it("gives up cleanly mid-way and can be picked up again later", async () => {
    await request(app).post(url("/tap")).send({ trackId: "A", frame: 20, name: "Mohammed" });
    const lost = await request(app).post(url("/not-me")).send({ frame: 60 });
    expect(lost.body.chain).toEqual([{ trackId: "A", fromFrame: 20, toFrame: 59 }]);
    // We were just told we lost them at 60. Turning round and announcing that
    // we lost them at 59 would be absurd.
    expect(lost.body.nextUncertainty).toBeNull();

    const again = await request(app).post(url("/tap")).send({ trackId: "B", frame: 150 });
    expect(again.body.chain).toEqual([
      { trackId: "A", fromFrame: 20, toFrame: 59 },
      { trackId: "B", fromFrame: 150, toFrame: 299 },
    ]);
  });

  it("keeps the person's own name through every later decision", async () => {
    await request(app).post(url("/tap")).send({ trackId: "A", frame: 20, name: "Ayesh" });
    await request(app).post(url("/not-me")).send({ frame: 60 });
    const later = await request(app).post(url("/tap")).send({ trackId: "B", frame: 150 });
    // Only the first tap carries a name; every later call sends none, and a
    // null must not be read as "clear it".
    expect(later.body.name).toBe("Ayesh");
  });

  it("records every kind of decision exactly once", async () => {
    await request(app).post(url("/tap")).send({ trackId: "A", frame: 20, name: "Mohammed" });
    await request(app).post(url("/confirm")).send({ frame: CROSS });
    await request(app).post(url("/not-me")).send({ frame: 250 });
    await request(app).delete(url("/last"));

    const labels = await db.select().from(claimChainLabelsTable)
      .where(eq(claimChainLabelsTable.recordingId, recordingId));
    // The undo writes nothing on purpose: a mis-tap is not evidence about the
    // tracker, and training on it would teach the wrong thing.
    expect(labels.map((row) => row.kind).sort()).toEqual(["confirm", "confirm", "lost"]);
    expect(labels.every((row) => row.userId === playerId)).toBe(true);
    expect(new Set(labels.map((row) => row.bundleFingerprint)).size).toBe(1);
  });
});
