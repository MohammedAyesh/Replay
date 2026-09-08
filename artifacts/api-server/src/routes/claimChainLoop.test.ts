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
  const { default: board } = await import("./claimMatch");
  app = express(); app.use(express.json()); app.use("/api", r); app.use("/api", board);
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

    // A refetch must not hand back a moment already dealt with. If it does,
    // reachedStop (>=) fires at once on a stop behind the playhead and the
    // page wedges into play-pause-play-pause. Every answer is written into the
    // chain itself, so the write and the read see the same questions.
    expect(afterRefetch).toBe(afterAnswering);
    expect(reread.body.openQuestions).toEqual(res.body.openQuestions);
    for (const frame of answers) expect(reread.body.openQuestions.map((q: any) => q.frame)).not.toContain(frame);
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
    // Nothing may be asked AT the tapped frame, on either request shape. The
    // crossing at 700 that this jump skipped over is still open -- it was
    // never answered, and it is reported behind the playhead rather than
    // silently settled by a tap made far past it.
    for (const body of [write.body, reread.body]) {
      expect(body.openQuestions.map((q: any) => q.frame)).not.toContain(last);
    }
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

  /**
   * The identity board and the claim page edit the same rows. The board
   * loads a row as {id, name, parts} and saves it back the same way, and the
   * server replaced identities wholesale -- so every board save silently
   * reset every claimant's reviewedThroughFrame. On a database without the
   * labels table that put the "yes, still me" loop straight back.
   */
  it("an identity-board save does not erase what the claimant has answered", async () => {
    await request(app).post(url("/tap")).send({ trackId: "ME", frame: 10, name: "Mohammed" });
    const confirmed = await request(app).post(url("/confirm")).send({ frame: 700 });
    expect(confirmed.body.nextUncertainty?.frame).not.toBe(700);
    const chain = (await request(app).get(url())).body;

    // The board, as an admin, saving the map exactly as it loaded it.
    vi.mocked(getLocalUserId).mockResolvedValue(adminId);
    const [stored] = await db.select({ manifest: recordingTrackingBundlesTable.manifest })
      .from(recordingTrackingBundlesTable).where(eq(recordingTrackingBundlesTable.id, bundleId));
    const asTheBoardSendsIt = (stored.manifest.identities ?? []).map((i: any) => ({
      id: i.id, name: i.name ?? null,
      parts: i.parts.map((p: any) => ({ trackId: p.trackId, fromFrame: p.fromFrame, toFrame: p.toFrame })),
    }));
    const saved = await request(app)
      .put(`/api/admin/recordings/${recordingId}/identities`)
      .send({ bundleFingerprint: chain.bundleFingerprint, identities: asTheBoardSendsIt });
    expect(saved.status).toBe(200);
    vi.mocked(getLocalUserId).mockResolvedValue(playerId);

    const [after] = await db.select({ manifest: recordingTrackingBundlesTable.manifest })
      .from(recordingTrackingBundlesTable).where(eq(recordingTrackingBundlesTable.id, bundleId));
    // Both fields the board never sends have to survive its save.
    expect(after.manifest.identities?.[0]?.reviewedThroughFrame).toBe(701);
    expect(after.manifest.identities?.[0]?.parts.every((p: any) => typeof p.tapFrame === "number")).toBe(true);
    const reread = await request(app).get(url());
    expect(reread.body.chain.length).toBeGreaterThan(0);
    expect(reread.body.nextUncertainty?.frame ?? null).not.toBe(700);
  });

  /**
   * The board's only protection against overwriting a claim was the
   * vouched-fragment binding -- written by a fire-and-forget sync. This is
   * the guard that does not depend on it: the board echoes a digest of the
   * identities it loaded, and a save against a different map is refused.
   */
  it("a board opened before a claim cannot save over it, and reloading clears the refusal", async () => {
    vi.mocked(getLocalUserId).mockResolvedValue(adminId);
    const loaded = await request(app).get(`/api/recordings/${recordingId}/claim-match`);
    expect(loaded.status).toBe(200);
    const stale = loaded.body.identitiesFingerprint;
    expect(typeof stale).toBe("string");
    const fp = loaded.body.manifest.provenance.bundleFingerprint;

    // A player claims themselves after the board was opened.
    vi.mocked(getLocalUserId).mockResolvedValue(playerId);
    await request(app).post(url("/tap")).send({ trackId: "ME", frame: 10, name: "Mohammed" });

    // The board saves what it loaded: an empty map.
    vi.mocked(getLocalUserId).mockResolvedValue(adminId);
    const refused = await request(app).put(`/api/admin/recordings/${recordingId}/identities`)
      .send({ bundleFingerprint: fp, identitiesFingerprint: stale, identities: [] });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("identities_changed");

    // The claim is untouched.
    vi.mocked(getLocalUserId).mockResolvedValue(playerId);
    expect((await request(app).get(url())).body.chain.length).toBeGreaterThan(0);

    // Reload, save the map as it now is, and the next save carries on.
    vi.mocked(getLocalUserId).mockResolvedValue(adminId);
    const fresh = await request(app).get(`/api/recordings/${recordingId}/claim-match`);
    const saved = await request(app).put(`/api/admin/recordings/${recordingId}/identities`)
      .send({
        bundleFingerprint: fp,
        identitiesFingerprint: fresh.body.identitiesFingerprint,
        identities: fresh.body.manifest.identities.map((i: any) => ({ id: i.id, name: i.name ?? null, parts: i.parts })),
      });
    expect(saved.status).toBe(200);
    expect(typeof saved.body.identitiesFingerprint).toBe("string");
    const again = await request(app).put(`/api/admin/recordings/${recordingId}/identities`)
      .send({
        bundleFingerprint: fp,
        identitiesFingerprint: saved.body.identitiesFingerprint,
        identities: fresh.body.manifest.identities.map((i: any) => ({ id: i.id, name: i.name ?? null, parts: i.parts })),
      });
    expect(again.status).toBe(200);
    vi.mocked(getLocalUserId).mockResolvedValue(playerId);
  });

  /**
   * Release, then delete the row: the claimant's next load found no chain and
   * looked like a fresh page, coverage silently at zero. Now it says so.
   */
  it("tells the claimant when an administrator removed their claim", async () => {
    await request(app).post(url("/tap")).send({ trackId: "ME", frame: 10, name: "Mohammed" });
    const before = (await request(app).get(url())).body;
    expect(before.resetByAdmin).toBe(false);

    vi.mocked(getLocalUserId).mockResolvedValue(adminId);
    const bindings = await request(app).get(`/api/admin/recordings/${recordingId}/claim-match/bindings`);
    expect(bindings.status).toBe(200);
    const mine = bindings.body.find((b: any) => b.personId === before.identityId);
    expect(mine).toBeTruthy();
    const released = await request(app).post(`/api/admin/claim-match/bindings/${mine.id}/release`).send({});
    expect(released.status).toBe(200);

    const loaded = await request(app).get(`/api/recordings/${recordingId}/claim-match`);
    const fp = loaded.body.manifest.provenance.bundleFingerprint;
    const wiped = await request(app).put(`/api/admin/recordings/${recordingId}/identities`)
      .send({ bundleFingerprint: fp, identitiesFingerprint: loaded.body.identitiesFingerprint, identities: [] });
    expect(wiped.status).toBe(200);

    vi.mocked(getLocalUserId).mockResolvedValue(playerId);
    const after = (await request(app).get(url())).body;
    expect(after.chain).toEqual([]);
    expect(after.resetByAdmin).toBe(true);

    // Claiming again clears it.
    const retapped = await request(app).post(url("/tap")).send({ trackId: "ME", frame: 10 });
    expect(retapped.status).toBe(200);
    expect((await request(app).get(url())).body.resetByAdmin).toBe(false);
  });

  /*
   * ------------------------------------------------------------------
   * Going back to fill a gap.
   *
   * "Look at the timeline, there are gaps, I want to be able to go back and
   * fill these gaps" -- and, once tried: "when I go back in time and pick
   * myself, sometimes it erases everything in front. That should never
   * happen." Every tap truncated the chain from the tapped frame on.
   * ------------------------------------------------------------------
   */
  describe("going back to fill a gap", () => {
    const extent = (chain: any[]) => chain.map((p) => [p.fromFrame, p.toFrame]);

    it("keeps everything claimed after the gap", async () => {
      // Claimed from 1500 to the end first; then scrub back and tap at 10.
      const late = await request(app).post(url("/tap")).send({ trackId: "ME", frame: 1500, name: "Mohammed" });
      const afterLate = late.body.chain;
      expect(afterLate.length).toBeGreaterThan(0);

      const fill = await request(app).post(url("/tap")).send({ trackId: "ME", frame: 10 });
      expect(fill.status).toBe(200);
      // Every part claimed at 1500 is still there, untouched.
      for (const part of afterLate) expect(fill.body.chain).toContainEqual(part);
      // And the fill runs from the tap up to where the earlier claim begins.
      const filled = fill.body.chain.filter((p: any) => p.toFrame < 1500);
      expect(filled[0]).toMatchObject({ fromFrame: 10 });
      expect(Math.max(...filled.map((p: any) => p.toFrame))).toBe(1499);
      expect(fill.body.coveragePercent).toBeGreaterThan(late.body.coveragePercent);
    });

    it("asks about the crossing inside the fill, even though the later stretch was already reviewed", async () => {
      await request(app).post(url("/tap")).send({ trackId: "ME", frame: 1500, name: "Mohammed" });
      const fill = await request(app).post(url("/tap")).send({ trackId: "ME", frame: 10 });
      expect(fill.body.nextUncertainty).toMatchObject({ kind: "swap", frame: 700 });
      // ...and the refetch agrees.
      expect((await request(app).get(url())).body.nextUncertainty).toMatchObject({ kind: "swap", frame: 700 });
    });

    it("undo after a fill undoes the fill, not the earlier tap that has the larger frame", async () => {
      const late = await request(app).post(url("/tap")).send({ trackId: "ME", frame: 1500, name: "Mohammed" });
      await request(app).post(url("/tap")).send({ trackId: "ME", frame: 10 });
      const undone = await request(app).delete(url("/last"));
      expect(undone.status).toBe(200);
      expect(extent(undone.body.chain)).toEqual(extent(late.body.chain));
    });

    it("giving up inside a fill keeps the stretch claimed after it", async () => {
      const late = await request(app).post(url("/tap")).send({ trackId: "ME", frame: 1500, name: "Mohammed" });
      await request(app).post(url("/tap")).send({ trackId: "ME", frame: 10 });
      const cut = await request(app).post(url("/not-me")).send({ frame: 300 });
      expect(cut.status).toBe(200);
      for (const part of late.body.chain) expect(cut.body.chain).toContainEqual(part);
      expect(cut.body.chain.some((p: any) => p.fromFrame <= 299 && p.toFrame >= 299)).toBe(true);
      expect(cut.body.chain.some((p: any) => p.fromFrame >= 300 && p.toFrame < 1500)).toBe(false);
    });

    it("a fill stops just short of the next claimed part, whatever the track does", async () => {
      // SPARSE has a box every 20 frames from 100 to 2300. Claim it from 2000
      // first, then fill from 100: the fill must end before 2000.
      await request(app).post(url("/tap")).send({ trackId: "SPARSE", frame: 2000, name: "Mohammed" });
      const fill = await request(app).post(url("/tap")).send({ trackId: "SPARSE", frame: 100 });
      const parts = fill.body.chain.filter((p: any) => p.trackId === "SPARSE");
      expect(parts.some((p: any) => p.fromFrame === 2000)).toBe(true);
      const before = parts.filter((p: any) => p.fromFrame < 2000);
      expect(before.length).toBeGreaterThan(0);
      expect(Math.max(...before.map((p: any) => p.toFrame))).toBeLessThan(2000);
    });
  });

  /*
   * ------------------------------------------------------------------
   * The end of the recording.
   *
   * "I finished the segment and nothing happened. What should happen?" Two
   * things were wrong: the chain asked "we lost you here" on the recording's
   * last frame, a question with no possible answer, and nothing ever said
   * whether the claim counted.
   * ------------------------------------------------------------------
   */
  describe("reaching the end of the recording", () => {
    it("does not ask where you went when the recording simply ended", async () => {
      const me = segment.tracks[0];
      let res = await request(app).post(url("/tap")).send({ trackId: "ME", frame: 10, name: "Mohammed" });
      for (let i = 0; i < 20 && res.body.nextUncertainty; i++) {
        const u = res.body.nextUncertainty;
        if (u.kind === "swap") {
          res = await request(app).post(url("/confirm")).send({ frame: u.frame });
        } else {
          const next = me.boxes.find((b: any) => b.frame > u.frame);
          if (!next) break;
          res = await request(app).post(url("/tap")).send({ trackId: "ME", frame: next.frame });
        }
      }
      // ME's last box is on frame 2399, the last frame there is.
      expect(res.body.nextUncertainty).toBeNull();
      expect(res.body.openQuestions).toEqual([]);
      expect(res.body.completed).toBe(true);
      expect(res.body.requiredCoveragePercent).toBe(60);
      expect(res.body.coveragePercent).toBeGreaterThanOrEqual(60);
      // The same is true on a refetch.
      const reread = await request(app).get(url());
      expect(reread.body.completed).toBe(true);
      expect(reread.body.nextUncertainty).toBeNull();
    });

    it("is not complete while a question is still open, however much is claimed", async () => {
      const res = await request(app).post(url("/tap")).send({ trackId: "ME", frame: 10, name: "Mohammed" });
      expect(res.body.coveragePercent).toBeGreaterThanOrEqual(60);
      expect(res.body.nextUncertainty).toMatchObject({ frame: 700 });
      expect(res.body.completed).toBe(false);
    });

    it("lists the questions left behind by a jump, rather than settling them silently", async () => {
      await request(app).post(url("/tap")).send({ trackId: "ME", frame: 10, name: "Mohammed" });
      // Jump straight to the end and tap there, never answering the crossing.
      const jumped = await request(app).post(url("/tap")).send({ trackId: "ME", frame: 2300 });
      expect(jumped.body.openQuestions.map((q: any) => q.frame)).toContain(700);
      expect(jumped.body.completed).toBe(false);
      // Answering it finishes the claim.
      const done = await request(app).post(url("/confirm")).send({ frame: 700 });
      expect(done.body.openQuestions).toEqual([]);
      expect(done.body.completed).toBe(true);
    });
  });

  it("an identity-board save keeps each part's answered frontier and the undo history", async () => {
    await request(app).post(url("/tap")).send({ trackId: "ME", frame: 10, name: "Mohammed" });
    await request(app).post(url("/confirm")).send({ frame: 700 });
    const chain = (await request(app).get(url())).body;

    vi.mocked(getLocalUserId).mockResolvedValue(adminId);
    const loaded = await request(app).get(`/api/recordings/${recordingId}/claim-match`);
    const saved = await request(app)
      .put(`/api/admin/recordings/${recordingId}/identities`)
      .send({
        bundleFingerprint: chain.bundleFingerprint,
        identitiesFingerprint: loaded.body.identitiesFingerprint,
        // The board sends parts exactly as it loaded them -- which, through
        // the generated contract, includes the per-part mark.
        identities: loaded.body.manifest.identities.map((i: any) => ({ id: i.id, name: i.name ?? null, parts: i.parts })),
      });
    expect(saved.status).toBe(200);
    vi.mocked(getLocalUserId).mockResolvedValue(playerId);

    const [after] = await db.select({ manifest: recordingTrackingBundlesTable.manifest })
      .from(recordingTrackingBundlesTable).where(eq(recordingTrackingBundlesTable.id, bundleId));
    const mine = after.manifest.identities?.find((i: any) => i.id === chain.identityId) as any;
    expect(mine.parts.find((p: any) => p.fromFrame <= 700 && p.toFrame >= 700).reviewedThrough).toBe(701);
    expect(mine.history?.length).toBe(2);

    // The confirm survived the board, and so did undo: the chain goes back to
    // how it was before the confirm. (Whether the crossing is then ASKED again
    // depends on the labels table, which remembers the confirm independently
    // when it exists -- so the stored mark is what is checked, not the
    // question.)
    expect((await request(app).get(url())).body.openQuestions.map((q: any) => q.frame)).not.toContain(700);
    const undone = await request(app).delete(url("/last"));
    expect(undone.status).toBe(200);
    const [rewound] = await db.select({ manifest: recordingTrackingBundlesTable.manifest })
      .from(recordingTrackingBundlesTable).where(eq(recordingTrackingBundlesTable.id, bundleId));
    const restored = rewound.manifest.identities?.find((i: any) => i.id === chain.identityId) as any;
    // Back to unreviewed from the part's own start.
    expect(restored.parts.find((p: any) => p.fromFrame <= 700 && p.toFrame >= 700).reviewedThrough).toBe(630);
  });

  /*
   * Chains already stored on Replit predate per-part marks and the undo
   * history. They have to keep behaving as they did until their next write.
   */
  describe("a chain stored by the previous build", () => {
    const legacy = async () => {
      const identityId = (await request(app).get(url())).body.identityId;
      await db.update(recordingTrackingBundlesTable).set({
        manifest: {
          ...manifest,
          identities: [{
            id: identityId, name: "Mohammed",
            parts: [
              { trackId: "ME", fromFrame: 10, toFrame: 199, tapFrame: 10 },
              { trackId: "ME", fromFrame: 230, toFrame: 599, tapFrame: 10 },
              { trackId: "ME", fromFrame: 630, toFrame: 999, tapFrame: 10 },
              { trackId: "ME", fromFrame: 1030, toFrame: 1399, tapFrame: 1030 },
            ],
            // The old single mark: the crossing at 700 was confirmed.
            reviewedThroughFrame: 1031,
          }],
          provenance: { bundleFingerprint: "x", identityMapBundleFingerprint: "x" },
        } as never,
      }).where(eq(recordingTrackingBundlesTable.id, bundleId));
    };

    it("reads the old single mark the way the old build did", async () => {
      await legacy();
      const res = await request(app).get(url());
      expect(res.status).toBe(200);
      // Everything before 1031 is settled, so the crossing at 700 stays
      // answered; what is left is the track end at 1399.
      expect(res.body.openQuestions.map((q: any) => q.frame)).toEqual([1399]);
    });

    it("makes the marks explicit on its next write, and undoes by stamp until there is history", async () => {
      await legacy();
      const undone = await request(app).delete(url("/last"));
      expect(undone.status).toBe(200);
      // No history yet: the old grouping undo drops the newest stamp.
      expect(undone.body.chain.map((p: any) => p.fromFrame)).toEqual([10, 230, 630]);
      const [row] = await db.select({ manifest: recordingTrackingBundlesTable.manifest })
        .from(recordingTrackingBundlesTable).where(eq(recordingTrackingBundlesTable.id, bundleId));
      expect(row.manifest.identities?.[0]?.parts.every((p: any) => typeof p.reviewedThrough === "number")).toBe(true);
    });
  });
});
