/**
 * A claim save racing a re-analysis. The request reads the bundle, a new
 * analysis replaces it, then the save takes its row lock: without a check
 * inside the lock, the old bundle's track ids land in the new manifest.
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

vi.mock("../lib/matchStatsCacheJobs", () => ({
  queueMatchStatsCacheForMatch: vi.fn(),
  queueMatchStatsCacheForRecording: vi.fn(),
}));

// PUT /game reads the "Is this you?" answers after building its context and
// before saving: the seam where a re-analysis can land.
vi.mock("../lib/momentChecks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/momentChecks")>();
  return { ...actual, momentChecksFor: vi.fn(actual.momentChecksFor) };
});

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
  type TrackingSegmentPayload,
} from "@workspace/db";
import { readClaimSegment } from "../lib/claimMatchStorage";
import { getLocalAccountUserId, getLocalUserId } from "../lib/clerkUserBridge";
import { momentChecksFor } from "../lib/momentChecks";
import { ClaimBundleChangedError, claimBundleChangedErrorHandler } from "../lib/claimBundleChanged";

const TAG = `bundle-race-${Date.now()}`;
const FPS = 25;
let app: Express;
let fieldId: number;
let adminId: number;
let playerId: number;
let recordingId: number;
let bundleId: number;

function boxes(from: number, to: number) {
  const out = [];
  for (let frame = from; frame <= to; frame++) out.push({ frame, x: 100 + frame, y: 200, w: 20, h: 40 });
  return out;
}

function analysis(prefix: string): { manifest: TrackingManifest; segment: TrackingSegmentPayload } {
  const segment = {
    segmentIndex: 0, name: "only", startFrame: 0, endFrame: 199, startSeconds: 0, endSeconds: 8,
    tracks: [
      { id: `${prefix}1`, startFrame: 0, endFrame: 99, boxes: boxes(0, 99) },
      { id: `${prefix}2`, startFrame: 100, endFrame: 199, boxes: boxes(100, 199) },
    ],
    crossings: [], inPlaySpans: [], events: [],
  } as never as TrackingSegmentPayload;
  const manifest = {
    version: 1, label: `race ${prefix}`, width: 1920, height: 1080, frameRate: FPS,
    frameCount: 200, duration: 8, matchOffset: 0, videoStartSeconds: 0, segmentCount: 1,
    segments: [{ index: 0, name: "only", startFrame: 0, endFrame: 199, startSeconds: 0, endSeconds: 8, objectPath: `${TAG}/${prefix}.json` }],
    summary: { segments: [{ segmentIndex: 0, startFrame: 0, endFrame: 199, startSeconds: 0, endSeconds: 8,
      tracks: segment.tracks.map((t) => ({ id: t.id, startFrame: t.startFrame, endFrame: t.endFrame })), events: [] }] },
  } as never as TrackingManifest;
  return { manifest, segment };
}

const OLD = analysis("t");
const NEW = analysis("n");

function actAs(userId: number) {
  vi.mocked(getLocalAccountUserId).mockResolvedValue(userId);
  vi.mocked(getLocalUserId).mockResolvedValue(userId);
}

/** What the pipeline's replacement does to the bundle row, in short. */
async function reanalyse() {
  await db.update(recordingTrackingBundlesTable).set({ manifest: NEW.manifest, updatedAt: new Date() })
    .where(eq(recordingTrackingBundlesTable.id, bundleId));
}

async function storedIdentities() {
  const [row] = await db.select({ manifest: recordingTrackingBundlesTable.manifest })
    .from(recordingTrackingBundlesTable).where(eq(recordingTrackingBundlesTable.id, bundleId));
  return row.manifest.identities ?? [];
}

const gameUrl = () => `/api/recordings/${recordingId}/claim-match/game`;

beforeAll(async () => {
  const { default: claimGameRouter } = await import("./claimGame");
  app = express();
  app.use(express.json());
  app.use("/api", claimGameRouter);
  const [field] = await db.insert(fieldsTable).values({ name: `${TAG} field`, location: "Test" }).returning({ id: fieldsTable.id });
  fieldId = field.id;
  const made = await db.insert(usersTable).values([
    { name: `${TAG} admin`, email: `${TAG}-admin@test.local`, isGuest: false, profileComplete: true, isAdmin: true },
    { name: "Mohammed", email: `${TAG}-player@test.local`, isGuest: false, profileComplete: true, isAdmin: false },
  ]).returning({ id: usersTable.id });
  [adminId, playerId] = made.map((row) => row.id);
  const [recording] = await db.insert(recordingsTable).values({
    fieldId, court: "1", date: "2026-09-06", timeSlot: "18:00", duration: "00:00:08",
    videoUrl: "https://example.test/race.m3u8", isVisible: true,
  }).returning({ id: recordingsTable.id });
  recordingId = recording.id;
  await db.insert(recordingSchedulesTable).values({
    fieldId, allowedDate: "2026-09-06", startTime: "00:00", endTime: "23:59", label: `${TAG} visibility`,
  });
  const [bundle] = await db.insert(recordingTrackingBundlesTable).values({ recordingId, uploadedBy: adminId, manifest: OLD.manifest })
    .returning({ id: recordingTrackingBundlesTable.id });
  bundleId = bundle.id;
  await db.insert(recordingTrackingSegmentsTable).values({
    bundleId, segmentIndex: 0, name: "only", startFrame: 0, endFrame: 199, startSeconds: 0, endSeconds: 8,
    objectPath: `${TAG}/t.json`, trackCount: 2, crossingCount: 0,
  });
});

beforeEach(async () => {
  await db.delete(claimMatchIdentityBindingsTable).where(eq(claimMatchIdentityBindingsTable.recordingId, recordingId));
  await db.delete(claimMatchProgressTable).where(eq(claimMatchProgressTable.recordingId, recordingId));
  await db.update(recordingTrackingBundlesTable).set({ manifest: OLD.manifest }).where(eq(recordingTrackingBundlesTable.id, bundleId));
  vi.clearAllMocks();
  vi.mocked(readClaimSegment).mockImplementation(async (path: string) => Buffer.from(JSON.stringify(
    path.endsWith("/n.json") ? NEW.segment : OLD.segment,
  ), "utf8") as never);
  actAs(playerId);
});

afterAll(async () => {
  await db.delete(recordingSchedulesTable).where(eq(recordingSchedulesTable.fieldId, fieldId));
  await db.delete(recordingsTable).where(eq(recordingsTable.id, recordingId));
  for (const id of [adminId, playerId]) await db.delete(usersTable).where(eq(usersTable.id, id));
  await db.delete(fieldsTable).where(eq(fieldsTable.id, fieldId));
});

describe("a claim save racing a re-analysis", () => {
  it("persistChain refuses inside the lock and leaves the new manifest without old track ids", async () => {
    const { loadContext, persistChain, claimIdentityId } = await import("./claimChain");
    const { trackingBundleFingerprint } = await import("./claimMatch");
    const loaded = await loadContext({} as never, recordingId, playerId);
    expect(loaded.ctx).toBeTruthy();
    const ctx = loaded.ctx!;

    await reanalyse();

    const write = persistChain(ctx, [{ trackId: "t1", fromFrame: 0, toFrame: 99 }] as never,
      { chosen: null }, { kind: "decision", answeredFrame: null });
    await expect(write).rejects.toBeInstanceOf(ClaimBundleChangedError);
    await expect(write).rejects.toMatchObject({
      currentBundleFingerprint: trackingBundleFingerprint(NEW.manifest, NEW.manifest.summary!.segments),
    });
    const mine = (await storedIdentities()).find((identity) => identity.id === claimIdentityId(playerId, recordingId));
    expect(mine).toBeUndefined();
  });

  it("PUT /game answers 409 in the fingerprint shape when the bundle changes under it", async () => {
    const { trackingBundleFingerprint } = await import("./claimMatch");
    const fingerprint = (await request(app).get(gameUrl())).body.bundleFingerprint as string;
    vi.mocked(momentChecksFor).mockImplementationOnce(async () => {
      await reanalyse();
      return new Map();
    });
    const save = await request(app).put(gameUrl()).send({
      state: { step: "follow" },
      parts: [{ trackId: "t1", fromFrame: 0, toFrame: 99 }],
      bench: [],
      done: false,
      bundleFingerprint: fingerprint,
    });
    expect(save.status).toBe(409);
    expect(save.body).toEqual({
      error: "This recording's tracking has been replaced. Reload before continuing your claim.",
      currentBundleFingerprint: trackingBundleFingerprint(NEW.manifest, NEW.manifest.summary!.segments),
    });
    expect((await storedIdentities()).flatMap((identity) => identity.parts.map((p) => p.trackId))).not.toContain("t1");
  });

  it("PUT /game with parts must say which bundle they were built on", async () => {
    const save = await request(app).put(gameUrl()).send({
      state: { step: "follow" },
      parts: [{ trackId: "t1", fromFrame: 0, toFrame: 99 }],
      bench: [],
      done: false,
    });
    expect(save.status).toBe(400);
    expect(await storedIdentities()).toEqual([]);
  });

  it("a state-only autosave still needs no fingerprint", async () => {
    const save = await request(app).put(gameUrl()).send({ state: { step: "intro" }, bench: [], done: false });
    expect(save.status).toBe(200);
  });

  it("the shared error handler turns the typed error into the same 409", async () => {
    const tiny = express();
    tiny.get("/x", () => { throw new ClaimBundleChangedError("fp-new"); });
    tiny.use(claimBundleChangedErrorHandler);
    const res = await request(tiny).get("/x");
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: "This recording's tracking has been replaced. Reload before continuing your claim.",
      currentBundleFingerprint: "fp-new",
    });
  });
});
