/**
 * "Is this you?" answers through the real endpoint, on a real database.
 *
 * A "Not me" cuts ±5 s of that track off the claim. On a claim that only just
 * counted (61% against a 60% bar), three of them took it under the bar, the
 * re-sync judged it incomplete and the player lost every clip of the match
 * for having been honest about three moments. A claim that counted before a
 * deck "no" keeps counting; the cut still takes those frames (and so the cut
 * moment's clip) away.
 *
 * What the deck reads off the ball data (his moments, which of them are
 * unsure) is stubbed: those rules have their own tests (lib/checkDeck.test,
 * personalMoments.test). Everything from the answer to the stored claim is
 * the real code.
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
  unauthenticatedResponse: vi.fn((res: any, _req: any, error = "Unauthenticated") => {
    res.status(401).json({ error });
  }),
}));

const FPS = 10;
const DURATION = 100;
/** his moments: one the tracker is sure of, three it is not */
const MOMENTS = [
  { id: "sure-shot", kind: "your-shot", title: "Shot on target", momentSeconds: 5, status: "ready" },
  { id: "unsure-1", kind: "dribble", title: "Dribble", momentSeconds: 20, status: "ready" },
  { id: "unsure-2", kind: "dribble", title: "Dribble", momentSeconds: 35, status: "ready" },
  { id: "unsure-3", kind: "dribble", title: "Dribble", momentSeconds: 50, status: "ready" },
];
type Part = { trackId: string; fromFrame: number; toFrame: number };
const inParts = (parts: Part[], t: number) => parts.find((p) => p.fromFrame <= t * FPS && p.toFrame >= t * FPS);

vi.mock("../lib/matchPlayLoad", () => ({
  loadRecordingPlay: vi.fn(async (recordingId: number) => ({
    recordingId, hasBall: true, hasPitch: false, hasKits: false, fps: FPS,
    manifest: { frameRate: FPS, duration: DURATION, width: 1920, height: 1080 },
    sidecars: [], touches: [], rejected: { noTrack: 0, tooFar: 0 }, kitOptions: [], bib: null,
    segments: null, kits: new Map(), events: [], dribbles: [], teleports: 0, inPlay: null, phases: null,
  })),
  playCache: new Map(),
}));

vi.mock("../lib/personalMoments", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/personalMoments")>();
  return {
    ...actual,
    // only moments on his claimed frames are his: a cut takes its moment away
    personalMoments: vi.fn((_play: unknown, parts: Part[]) => MOMENTS.filter((m) => inParts(parts, m.momentSeconds)).map((m) => ({ ...m }))),
    teamGoalMoments: vi.fn(() => []),
  };
});

vi.mock("../lib/checkDeck", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/checkDeck")>();
  return {
    ...actual,
    unsureMoments: vi.fn((mine: Array<{ id: string; momentSeconds: number }>, parts: Part[]) => mine
      .filter((m) => m.id.startsWith("unsure-"))
      .flatMap((m) => {
        const part = inParts(parts, m.momentSeconds);
        return part ? [{ moment: m, part, frame: Math.round(m.momentSeconds * FPS), reasons: ["teammate"] }] : [];
      })),
  };
});

// A clip of a moment is a user_clips row; the export queue is not under test.
vi.mock("./userClips", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./userClips")>();
  const { db: database, userClipsTable: clips } = await import("@workspace/db");
  return {
    ...actual,
    ensureClaimMomentUserClip: vi.fn(async ({ userId, moment }: { userId: number; moment: { id: string; title: string; momentSeconds: number } }) => {
      const videoId = `deck-test-${moment.id}`;
      const [existing] = await database.select().from(clips).where(and(eq(clips.userId, userId), eq(clips.videoId, videoId)));
      if (existing) return { userClipId: existing.id, exportStatus: null };
      const [made] = await database.insert(clips).values({
        userId, videoId, title: moment.title,
        startTime: String((moment.momentSeconds - 8) / DURATION), endTime: String((moment.momentSeconds + 8) / DURATION),
        visibility: "private", aspectRatio: "16:9",
      }).returning({ id: clips.id });
      return { userClipId: made.id, exportStatus: null };
    }),
  };
});

import {
  db,
  claimChainLabelsTable,
  claimMatchIdentityBindingsTable,
  claimMatchProgressTable,
  claimMomentChecksTable,
  fieldsTable,
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
import { claimIdentityId, chainOf, loadContext, resyncChainClaimsForRecording, syncChainClaim } from "./claimChain";

const TAG = `deck-answer-${Date.now()}`;
const OBJECT_PATH = `${TAG}/segment-0.json`;
const FRAMES = DURATION * FPS;

let app: Express;
let fieldId: number;
let adminId: number;
let playerId: number;
let recordingId: number;
let bundleId: number;

const segment: TrackingSegmentPayload = {
  segmentIndex: 0, name: "only", startFrame: 0, endFrame: FRAMES - 1, startSeconds: 0, endSeconds: DURATION,
  tracks: [{
    id: "A", startFrame: 0, endFrame: FRAMES - 1,
    boxes: Array.from({ length: FRAMES }, (_, f) => ({ frame: f, x: 100 + f, y: 400, w: 20, h: 40 })),
  }],
  crossings: [],
  inPlaySpans: [],
  events: [],
} as never;

const baseManifest = {
  version: 1, label: "deck", width: 1920, height: 1080, frameRate: FPS, frameCount: FRAMES,
  duration: DURATION, matchOffset: 0, videoStartSeconds: 0, segmentCount: 1,
  segments: [{ index: 0, name: "only", startFrame: 0, endFrame: FRAMES - 1, startSeconds: 0, endSeconds: DURATION, objectPath: OBJECT_PATH }],
  summary: {
    segments: [{
      segmentIndex: 0, startFrame: 0, endFrame: FRAMES - 1, startSeconds: 0, endSeconds: DURATION,
      tracks: [{ id: "A", startFrame: 0, endFrame: FRAMES - 1 }], events: [],
    }],
  },
} as unknown as TrackingManifest;

/** His claim: track A from the kick-off to 61 s, 61% of the match, just over the 60% bar. */
const manifestWithClaim = (): TrackingManifest => ({
  ...baseManifest,
  identities: [{
    id: claimIdentityId(playerId, recordingId),
    name: "Mohammed",
    parts: [{ trackId: "A", fromFrame: 0, toFrame: 609, reviewedThrough: 610 }],
    reviewedThroughFrame: 610,
  }],
});

const answer = (cardId: string, verdict: "yes" | "no" | "skip") =>
  request(app).post(`/api/recordings/${recordingId}/claim-match/check-deck/answer`).send({ cardId, verdict });

const progress = async () => (await db.select().from(claimMatchProgressTable).where(and(
  eq(claimMatchProgressTable.userId, playerId),
  eq(claimMatchProgressTable.recordingId, recordingId),
)))[0];

/** The claim as the claim page settles it: nothing left to ask, so it is judged on coverage. */
async function settleClaim(hasOpenQuestion = false) {
  const loaded = await loadContext({} as never, recordingId, playerId);
  if (!loaded.ctx) throw new Error(`no context: ${loaded.error}`);
  await syncChainClaim(loaded.ctx, chainOf(loaded.ctx.manifest, loaded.ctx.identityId), hasOpenQuestion);
}

beforeAll(async () => {
  const { default: checkDeckRouter } = await import("./checkDeck");
  app = express();
  app.use(express.json());
  app.use("/api", checkDeckRouter);

  const [field] = await db.insert(fieldsTable).values({ name: `${TAG} field`, location: "Test" }).returning({ id: fieldsTable.id });
  fieldId = field.id;
  const made = await db.insert(usersTable).values([
    { name: `${TAG} admin`, email: `${TAG}-a@test.local`, isGuest: false, profileComplete: true, isAdmin: true },
    { name: "Mohammed", email: `${TAG}-p@test.local`, isGuest: false, profileComplete: true, isAdmin: false },
  ]).returning({ id: usersTable.id });
  [adminId, playerId] = made.map((row) => row.id);

  const [recording] = await db.insert(recordingsTable).values({
    fieldId, court: "1", date: "2026-10-30", timeSlot: "18:00",
    duration: "00:01:40", videoUrl: "https://example.test/deck.m3u8", isVisible: true,
  }).returning({ id: recordingsTable.id });
  recordingId = recording.id;
  await db.insert(recordingSchedulesTable).values({
    fieldId, allowedDate: "2026-10-30", startTime: "00:00", endTime: "23:59", label: `${TAG} vis`,
  });
  const [bundle] = await db.insert(recordingTrackingBundlesTable)
    .values({ recordingId, uploadedBy: adminId, manifest: baseManifest })
    .returning({ id: recordingTrackingBundlesTable.id });
  bundleId = bundle.id;
  await db.insert(recordingTrackingSegmentsTable).values({
    bundleId, segmentIndex: 0, name: "only", startFrame: 0, endFrame: FRAMES - 1,
    startSeconds: 0, endSeconds: DURATION, objectPath: OBJECT_PATH, trackCount: 1, crossingCount: 0,
  });
});

beforeEach(async () => {
  vi.mocked(readClaimSegment).mockResolvedValue(Buffer.from(JSON.stringify(segment), "utf8") as never);
  vi.mocked(getLocalAccountUserId).mockResolvedValue(playerId);
  vi.mocked(getLocalUserId).mockResolvedValue(playerId);
  await db.delete(claimMomentChecksTable).where(eq(claimMomentChecksTable.recordingId, recordingId));
  await db.delete(claimMatchProgressTable).where(eq(claimMatchProgressTable.recordingId, recordingId));
  await db.delete(claimMatchIdentityBindingsTable).where(eq(claimMatchIdentityBindingsTable.recordingId, recordingId));
  await db.delete(claimChainLabelsTable).where(eq(claimChainLabelsTable.recordingId, recordingId));
  await db.delete(userClipsTable).where(eq(userClipsTable.userId, playerId));
  await db.update(recordingTrackingBundlesTable).set({ manifest: manifestWithClaim(), updatedAt: new Date() })
    .where(eq(recordingTrackingBundlesTable.id, bundleId));
});

afterAll(async () => {
  await db.delete(userClipsTable).where(eq(userClipsTable.userId, playerId));
  await db.delete(recordingSchedulesTable).where(eq(recordingSchedulesTable.fieldId, fieldId));
  await db.delete(recordingsTable).where(eq(recordingsTable.id, recordingId));
  await db.delete(usersTable).where(inArray(usersTable.id, [adminId, playerId]));
  await db.delete(fieldsTable).where(eq(fieldsTable.id, fieldId));
});

describe("a deck 'Not me' never costs a claim that counted", () => {
  it("keeps a 61% claim complete, and its clips, through three 'no' answers", async () => {
    await settleClaim();
    const before = await progress();
    expect(before?.completed).toBe(true);
    expect(Number(before?.claimedPercent)).toBeCloseTo(61, 0);
    const sure = (before?.earnedClips ?? []).find((c) => c.id === "sure-shot");
    expect(sure?.userClipId).toBeTruthy();

    for (const id of ["unsure-1", "unsure-2", "unsure-3"]) {
      const res = await answer(`you:${id}`, "no");
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ ok: true, clip: false });
    }

    const after = await progress();
    // the cuts are real: ~30 s of the claim is gone, far under the 60% bar...
    expect(Number(after?.claimedPercent)).toBeLessThan(40);
    // ...and the claim still counts, with the clip it had
    expect(after?.completed).toBe(true);
    const kept = (after?.earnedClips ?? []).find((c) => c.id === "sure-shot");
    expect(kept?.userClipId).toBe(sure?.userClipId);
    const [row] = await db.select().from(userClipsTable).where(eq(userClipsTable.id, sure!.userClipId!));
    expect(row?.isHidden).toBe(false);
    // no clip for a moment he said was not him
    expect((after?.earnedClips ?? []).some((c) => c.id.startsWith("unsure-"))).toBe(false);
  });

  it("stays complete when a goal vote re-syncs every claim on the recording", async () => {
    await settleClaim();
    for (const id of ["unsure-1", "unsure-2", "unsure-3"]) expect((await answer(`you:${id}`, "no")).status).toBe(200);
    expect((await progress())?.completed).toBe(true);

    await resyncChainClaimsForRecording({} as never, recordingId);
    const after = await progress();
    expect(after?.completed).toBe(true);
    expect((after?.earnedClips ?? []).find((c) => c.id === "sure-shot")?.userClipId).toBeTruthy();
  });

  it("does not complete a claim that had not counted before the 'no'", async () => {
    await settleClaim(true); // a question still open: not complete
    expect((await progress())?.completed).toBe(false);
    expect((await answer("you:unsure-1", "no")).status).toBe(200);
    expect((await progress())?.completed).toBe(false);
  });
});

describe("the answer says whether a clip comes of it", () => {
  it("a 'yes' on a claim that counts makes a clip and says so", async () => {
    await settleClaim();
    const res = await answer("you:unsure-1", "yes");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, clip: true, completed: true });
    expect(res.body.userClipId).toBeTruthy();
  });

  it("a 'yes' on a claim that does not count yet is kept, with no clip", async () => {
    await settleClaim(true);
    const res = await answer("you:unsure-1", "yes");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, clip: false, completed: false, userClipId: null });
  });
});
