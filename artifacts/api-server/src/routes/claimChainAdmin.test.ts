/**
 * POST /admin/recordings/:id/claim-match/chain-for-user -- an admin sets a
 * player's chain through the same persist/sync path the player's own taps use.
 *
 * Same fixture shape as claimChain.test.ts: a real database, the segment read
 * stubbed, and the account bridge mocked so a test can act as anyone.
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
  claimMatchIdentityBindingsTable,
  claimMatchOffPitchSpansTable,
  claimMatchProgressTable,
  fieldsTable,
  recordingSchedulesTable,
  recordingTrackingBundlesTable,
  recordingTrackingSegmentsTable,
  recordingsTable,
  usersTable,
  type TrackingIdentity,
  type TrackingManifest,
  type TrackingSegmentPayload,
} from "@workspace/db";
import { SetClaimChainForUserResponse } from "@workspace/api-zod";
import { readClaimSegment } from "../lib/claimMatchStorage";
import { getLocalAccountUserId, getLocalUserId } from "../lib/clerkUserBridge";

const mockedReadClaimSegment = vi.mocked(readClaimSegment);
const mockedAccountUser = vi.mocked(getLocalAccountUserId);
const mockedLocalUser = vi.mocked(getLocalUserId);

const TAG = `claim-chain-admin-${Date.now()}`;
const OBJECT_PATH = `${TAG}/segment-0.json`;
const FPS = 25;

let app: Express;
let claimIdentityId: (userId: number, recordingId: number) => string;
let fieldId: number;
let adminId: number;
let playerId: number;
let recordingId: number;
let bundleId: number;
let fingerprint: string;

function boxes(from: number, to: number, x0: number, dx: number, y: number, h: number) {
  const out = [];
  for (let frame = from; frame <= to; frame++) {
    out.push({ frame, x: x0 + dx * (frame - from), y, w: 20, h });
  }
  return out;
}

/** t1 hands over to t2 at frame 100; t3 runs the whole recording. */
const segment: TrackingSegmentPayload = {
  segmentIndex: 0,
  name: "only",
  startFrame: 0,
  endFrame: 199,
  startSeconds: 0,
  endSeconds: 8,
  tracks: [
    { id: "t1", startFrame: 0, endFrame: 99, boxes: boxes(0, 99, 100, 2, 200, 40) },
    { id: "t2", startFrame: 100, endFrame: 199, boxes: boxes(100, 199, 300, 2, 200, 40) },
    { id: "t3", startFrame: 0, endFrame: 199, boxes: boxes(0, 199, 900, -2, 400, 44) },
  ],
  // A low-confidence crossing inside t2: a player tapping through t2 would be
  // stopped here. An admin-set chain must not be.
  crossings: [{ frame: 150, trackId: "t2", otherTrackId: "t3", confidence: 0.1 }],
  inPlaySpans: [],
  events: [],
} as never;

const manifest: TrackingManifest = {
  version: 1,
  label: "claim chain admin test",
  width: 1920,
  height: 1080,
  frameRate: FPS,
  frameCount: 200,
  duration: 8,
  matchOffset: 0,
  videoStartSeconds: 0,
  segmentCount: 1,
  segments: [{
    index: 0,
    name: "only",
    startFrame: 0,
    endFrame: 199,
    startSeconds: 0,
    endSeconds: 8,
    objectPath: OBJECT_PATH,
  }],
  summary: {
    segments: [{
      segmentIndex: 0,
      startFrame: 0,
      endFrame: 199,
      startSeconds: 0,
      endSeconds: 8,
      tracks: segment.tracks.map((t) => ({ id: t.id, startFrame: t.startFrame, endFrame: t.endFrame })),
      events: [],
    }],
  },
} as never;

function actAs(userId: number) {
  mockedAccountUser.mockResolvedValue(userId);
  mockedLocalUser.mockResolvedValue(userId);
}

async function storedManifest(): Promise<TrackingManifest> {
  const [row] = await db
    .select({ manifest: recordingTrackingBundlesTable.manifest })
    .from(recordingTrackingBundlesTable)
    .where(eq(recordingTrackingBundlesTable.id, bundleId));
  return row.manifest;
}

async function resetManifest(patch: Partial<TrackingManifest> = {}) {
  await db.update(recordingTrackingBundlesTable)
    .set({ manifest: { ...manifest, ...patch } as TrackingManifest })
    .where(eq(recordingTrackingBundlesTable.id, bundleId));
}

const adminUrl = () => `/api/admin/recordings/${recordingId}/claim-match/chain-for-user`;
const playerUrl = () => `/api/recordings/${recordingId}/claim-match/chain`;
const wholeMatch = [
  { trackId: "t1", fromFrame: 0, toFrame: 99 },
  { trackId: "t2", fromFrame: 100, toFrame: 199 },
];

beforeAll(async () => {
  const { default: claimChainRouter, claimIdentityId: identityIdFor } = await import("./claimChain");
  claimIdentityId = identityIdFor;
  app = express();
  app.use(express.json());
  app.use("/api", claimChainRouter);

  const [field] = await db.insert(fieldsTable).values({ name: `${TAG} field`, location: "Test" })
    .returning({ id: fieldsTable.id });
  fieldId = field.id;

  const made = await db.insert(usersTable).values([
    { name: `${TAG} admin`, email: `${TAG}-admin@test.local`, isGuest: false, profileComplete: true, isAdmin: true },
    { name: "Basel", email: `${TAG}-player@test.local`, isGuest: false, profileComplete: true, isAdmin: false },
  ]).returning({ id: usersTable.id });
  [adminId, playerId] = made.map((row) => row.id);

  const [recording] = await db.insert(recordingsTable).values({
    fieldId,
    court: "1",
    date: "2026-09-06",
    timeSlot: "18:00",
    duration: "00:00:08",
    videoUrl: "https://example.test/chain-admin.m3u8",
    isVisible: true,
  }).returning({ id: recordingsTable.id });
  recordingId = recording.id;

  await db.insert(recordingSchedulesTable).values({
    fieldId,
    allowedDate: "2026-09-06",
    startTime: "00:00",
    endTime: "23:59",
    label: `${TAG} visibility`,
  });

  const [bundle] = await db.insert(recordingTrackingBundlesTable).values({
    recordingId,
    uploadedBy: adminId,
    manifest,
  }).returning({ id: recordingTrackingBundlesTable.id });
  bundleId = bundle.id;

  await db.insert(recordingTrackingSegmentsTable).values({
    bundleId,
    segmentIndex: 0,
    name: "only",
    startFrame: 0,
    endFrame: 199,
    startSeconds: 0,
    endSeconds: 8,
    objectPath: OBJECT_PATH,
    trackCount: segment.tracks.length,
    crossingCount: 1,
  });

  mockedReadClaimSegment.mockResolvedValue(Buffer.from(JSON.stringify(segment), "utf8") as never);
  actAs(playerId);
  const read = await request(app).get(playerUrl());
  fingerprint = read.body.bundleFingerprint;
});

beforeEach(async () => {
  await db.delete(claimChainLabelsTable).where(eq(claimChainLabelsTable.recordingId, recordingId));
  await db.delete(claimMatchIdentityBindingsTable)
    .where(eq(claimMatchIdentityBindingsTable.recordingId, recordingId));
  await db.delete(claimMatchOffPitchSpansTable).where(eq(claimMatchOffPitchSpansTable.recordingId, recordingId));
  await db.delete(claimMatchProgressTable).where(eq(claimMatchProgressTable.recordingId, recordingId));
  vi.clearAllMocks();
  mockedReadClaimSegment.mockResolvedValue(Buffer.from(JSON.stringify(segment), "utf8") as never);
  await resetManifest();
  actAs(adminId);
});

afterAll(async () => {
  await db.delete(claimMatchIdentityBindingsTable)
    .where(eq(claimMatchIdentityBindingsTable.recordingId, recordingId));
  await db.delete(claimMatchProgressTable).where(eq(claimMatchProgressTable.recordingId, recordingId));
  await db.delete(recordingSchedulesTable).where(eq(recordingSchedulesTable.fieldId, fieldId));
  await db.delete(recordingsTable).where(eq(recordingsTable.id, recordingId));
  for (const id of [adminId, playerId]) {
    await db.delete(usersTable).where(eq(usersTable.id, id));
  }
  await db.delete(fieldsTable).where(eq(fieldsTable.id, fieldId));
});

describe("refusals", () => {
  it("refuses a non-admin, even for their own account", async () => {
    actAs(playerId);
    const res = await request(app).post(adminUrl())
      .send({ userId: playerId, parts: wholeMatch, bundleFingerprint: fingerprint });
    expect(res.status).toBe(403);
  });

  it("refuses an unauthenticated caller", async () => {
    mockedAccountUser.mockResolvedValue(null);
    mockedLocalUser.mockResolvedValue(null);
    const res = await request(app).post(adminUrl())
      .send({ userId: playerId, parts: wholeMatch, bundleFingerprint: fingerprint });
    expect(res.status).toBe(401);
  });

  it("requires a body with userId, parts and the bundle fingerprint", async () => {
    for (const body of [
      { parts: wholeMatch, bundleFingerprint: fingerprint },
      { userId: playerId, parts: [], bundleFingerprint: fingerprint },
      { userId: playerId, parts: wholeMatch },
      { userId: playerId, parts: [{ trackId: "t1", fromFrame: -1, toFrame: 5 }], bundleFingerprint: fingerprint },
      { userId: playerId, parts: [{ trackId: "t1", fromFrame: 1.5, toFrame: 5 }], bundleFingerprint: fingerprint },
    ]) {
      expect((await request(app).post(adminUrl()).send(body)).status).toBe(400);
    }
  });

  it("is a 409 when the parts were built against another bundle", async () => {
    const res = await request(app).post(adminUrl())
      .send({ userId: playerId, parts: wholeMatch, bundleFingerprint: "an-older-bundle" });
    expect(res.status).toBe(409);
    expect(res.body.currentBundleFingerprint).toBe(fingerprint);
  });

  it("is a 404 for a user that does not exist", async () => {
    const res = await request(app).post(adminUrl())
      .send({ userId: 2_000_000_000, parts: wholeMatch, bundleFingerprint: fingerprint });
    expect(res.status).toBe(404);
  });

  it("refuses unknown tracks, frames outside the track, reversed parts and overlapping tracks", async () => {
    for (const parts of [
      [{ trackId: "nope", fromFrame: 0, toFrame: 10 }],
      [{ trackId: "t1", fromFrame: 0, toFrame: 120 }],
      [{ trackId: "t2", fromFrame: 50, toFrame: 150 }],
      [{ trackId: "t1", fromFrame: 40, toFrame: 20 }],
      [{ trackId: "t1", fromFrame: 0, toFrame: 99 }, { trackId: "t3", fromFrame: 90, toFrame: 199 }],
    ]) {
      const res = await request(app).post(adminUrl())
        .send({ userId: playerId, parts, bundleFingerprint: fingerprint });
      expect(res.status, JSON.stringify(parts)).toBe(400);
    }
    // Nothing was written by any of them.
    expect((await storedManifest()).identities ?? []).toEqual([]);
  });
});

describe("dry run", () => {
  it("returns the state the chain would have and writes nothing", async () => {
    const res = await request(app).post(adminUrl())
      .send({ userId: playerId, parts: wholeMatch, bundleFingerprint: fingerprint, dryRun: true });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      dryRun: true,
      userId: playerId,
      coveragePercent: 100,
      completed: true,
      nextUncertainty: null,
      binding: null,
      progress: null,
    });
    expect(SetClaimChainForUserResponse.safeParse(res.body).success).toBe(true);
    expect(res.body.chain).toEqual(wholeMatch);
    expect((await storedManifest()).identities ?? []).toEqual([]);
    expect(await db.select().from(claimMatchProgressTable)
      .where(eq(claimMatchProgressTable.recordingId, recordingId))).toEqual([]);
  });
});

describe("setting the chain", () => {
  it("stores the chain on the player's own row, fully reviewed, and completes the claim", async () => {
    // The board holds t1 on a row of its own: claiming it moves it off.
    await resetManifest({
      identities: [{ id: "board:a", name: "A", parts: [{ trackId: "t1", fromFrame: 0, toFrame: 99 }] }] as TrackingIdentity[],
    } as Partial<TrackingManifest>);

    const res = await request(app).post(adminUrl())
      .send({ userId: playerId, parts: wholeMatch, name: "Basel A.", bundleFingerprint: fingerprint });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      dryRun: false,
      userId: playerId,
      identityId: claimIdentityId(playerId, recordingId),
      name: "Basel A.",
      coveragePercent: 100,
      completed: true,
      nextUncertainty: null,
      openQuestions: [],
      binding: { state: "confirmed", personId: claimIdentityId(playerId, recordingId) },
      progress: { completed: true, stage: "done" },
    });
    expect(SetClaimChainForUserResponse.safeParse(res.body).success).toBe(true);

    const identities = (await storedManifest()).identities ?? [];
    expect(identities.find((item) => item.id === "board:a")).toBeUndefined();
    const mine = identities.find((item) => item.id === claimIdentityId(playerId, recordingId));
    expect(mine?.parts).toEqual([
      { trackId: "t1", fromFrame: 0, toFrame: 99, reviewedThrough: 100 },
      { trackId: "t2", fromFrame: 100, toFrame: 199, reviewedThrough: 200 },
    ]);
    // The previous (empty) chain is on the history, so the player can undo it.
    expect(mine?.history).toEqual([{ parts: [] }]);

    // No training label: an admin's assembly is not a decision at a frame.
    expect(await db.select().from(claimChainLabelsTable)
      .where(eq(claimChainLabelsTable.recordingId, recordingId))).toEqual([]);

    // The player's own page sees the same chain and is not asked anything.
    actAs(playerId);
    const mine_ = await request(app).get(playerUrl());
    expect(mine_.body.chain).toEqual(wholeMatch);
    expect(mine_.body.nextUncertainty).toBeNull();
    expect(mine_.body.completed).toBe(true);
  });

  it("a player tapping through the same stretch is stopped at the crossing (the contrast)", async () => {
    actAs(playerId);
    const tap = await request(app).post(`${playerUrl()}/tap`).send({ trackId: "t2", frame: 100 });
    expect(tap.status).toBe(200);
    expect(tap.body.nextUncertainty).toMatchObject({ kind: "swap", frame: 150 });
  });
});

describe("a claim left needs_resolution by a re-analysis", () => {
  async function staleBinding() {
    await db.insert(claimMatchIdentityBindingsTable).values({
      userId: playerId,
      recordingId,
      personId: claimIdentityId(playerId, recordingId),
      trackingBundleId: bundleId,
      bundleFingerprint: "the-previous-bundle",
      personParts: [],
      vouchedFragments: [{ trackId: "gone", fromFrame: 0, toFrame: 50 }],
      resolutionMethod: "chain",
      state: "needs_resolution",
    });
  }

  it("is confirmed again by an admin-set chain on the current bundle", async () => {
    await staleBinding();
    const res = await request(app).post(adminUrl())
      .send({ userId: playerId, parts: wholeMatch, bundleFingerprint: fingerprint });
    expect(res.status).toBe(200);
    expect(res.body.binding).toMatchObject({ state: "confirmed", personId: claimIdentityId(playerId, recordingId) });
    const [row] = await db.select().from(claimMatchIdentityBindingsTable)
      .where(eq(claimMatchIdentityBindingsTable.userId, playerId));
    expect(row.bundleFingerprint).not.toBe("the-previous-bundle");
    expect(row.vouchedFragments).not.toContainEqual({ trackId: "gone", fromFrame: 0, toFrame: 50 });
  });

  it("is confirmed again when the player re-claims themselves", async () => {
    await staleBinding();
    actAs(playerId);
    const tap = await request(app).post(`${playerUrl()}/tap`).send({ trackId: "t1", frame: 0 });
    expect(tap.status).toBe(200);
    const [row] = await db.select().from(claimMatchIdentityBindingsTable)
      .where(eq(claimMatchIdentityBindingsTable.userId, playerId));
    expect(row.state).toBe("confirmed");
  });

  it("stays needs_resolution while the player has no chain on the current bundle", async () => {
    await staleBinding();
    actAs(playerId);
    expect((await request(app).get(playerUrl())).status).toBe(200);
    const [row] = await db.select().from(claimMatchIdentityBindingsTable)
      .where(eq(claimMatchIdentityBindingsTable.userId, playerId));
    expect(row.state).toBe("needs_resolution");
  });
});
