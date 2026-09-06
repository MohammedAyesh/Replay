/**
 * The claim chain, end to end over HTTP.
 *
 * claimChain.test.ts in lib/ pins the algebra; this file pins the things only
 * a real request can break: the row lock, the label write, the refusals, and
 * above all the requirement that the video and the identity board are ONE map
 * rather than two that agree most of the time.
 *
 * The bugs being guarded against here are all silent ones. A lost identity, a
 * stale provenance fingerprint, a frame sitting under two people -- none of
 * them raise an error, and the only symptom is a claim that quietly does
 * nothing. That is the exact failure mode of the read/write asymmetry fixed on
 * 2026-09-06, which shipped and went unnoticed for weeks.
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
import {
  ConfirmClaimChainAtResponse,
  GetClaimChainResponse,
  RejectClaimChainFromResponse,
  TapClaimChainResponse,
  UndoClaimChainLastResponse,
} from "@workspace/api-zod";
import { readClaimSegment } from "../lib/claimMatchStorage";
import { getLocalAccountUserId, getLocalUserId } from "../lib/clerkUserBridge";

const mockedReadClaimSegment = vi.mocked(readClaimSegment);
const mockedAccountUser = vi.mocked(getLocalAccountUserId);
const mockedLocalUser = vi.mocked(getLocalUserId);

const TAG = `claim-chain-${Date.now()}`;
const OBJECT_PATH = `${TAG}/segment-0.json`;
const FPS = 25;

let app: Express;
let claimIdentityId: (userId: number, recordingId: number) => string;
let fieldId: number;
let adminId: number;
let playerId: number;
let rivalId: number;
let recordingId: number;
let bundleId: number;

/** A straight run of boxes, one per frame. */
function boxes(from: number, to: number, x0: number, dx: number, y: number, h: number) {
  const out = [];
  for (let frame = from; frame <= to; frame++) {
    out.push({ frame, x: x0 + dx * (frame - from), y, w: 20, h });
  }
  return out;
}

/**
 * Three tracks. t1 hands over to t2 at frame 100 (the board's merge case), and
 * t3 runs the whole time as a second candidate so `offeredCount` in the
 * captured geometry is a real number rather than always one.
 */
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
  crossings: [],
  inPlaySpans: [],
  events: [],
} as never;

const manifest: TrackingManifest = {
  version: 1,
  label: "claim chain test",
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

/**
 * Put the bundle back to its pristine manifest.
 *
 * Every write in this suite goes through the real endpoint, which rewrites
 * `identities` AND `provenance`. Patching from whatever the last test left
 * behind would let one test's provenance silently decide another's outcome,
 * and provenance is exactly the field whose staleness is invisible.
 */
async function resetManifest(patch: Partial<TrackingManifest> = {}) {
  await db.update(recordingTrackingBundlesTable)
    .set({ manifest: { ...manifest, ...patch } as TrackingManifest })
    .where(eq(recordingTrackingBundlesTable.id, bundleId));
}

async function setIdentities(identities: TrackingIdentity[]) {
  await resetManifest({ identities } as Partial<TrackingManifest>);
}

async function labels() {
  return db.select().from(claimChainLabelsTable)
    .where(eq(claimChainLabelsTable.recordingId, recordingId));
}

const url = (suffix = "") => `/api/recordings/${recordingId}/claim-match/chain${suffix}`;

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
    { name: "Mohammed", email: `${TAG}-player@test.local`, isGuest: false, profileComplete: true, isAdmin: false },
    { name: `${TAG} rival`, email: `${TAG}-rival@test.local`, isGuest: false, profileComplete: true, isAdmin: false },
  ]).returning({ id: usersTable.id });
  [adminId, playerId, rivalId] = made.map((row) => row.id);

  const [recording] = await db.insert(recordingsTable).values({
    fieldId,
    court: "1",
    date: "2026-09-06",
    timeSlot: "18:00",
    duration: "00:00:08",
    videoUrl: "https://example.test/chain.m3u8",
    isVisible: true,
  }).returning({ id: recordingsTable.id });
  recordingId = recording.id;

  // Visible to ordinary accounts: this suite is about the chain, not access.
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
    crossingCount: 0,
  });
});

beforeEach(async () => {
  await db.delete(claimChainLabelsTable).where(eq(claimChainLabelsTable.recordingId, recordingId));
  await db.delete(claimMatchIdentityBindingsTable)
    .where(eq(claimMatchIdentityBindingsTable.recordingId, recordingId));
  vi.clearAllMocks();
  mockedReadClaimSegment.mockResolvedValue(Buffer.from(JSON.stringify(segment), "utf8") as never);
  await resetManifest();
  actAs(playerId);
});

afterAll(async () => {
  await db.delete(recordingSchedulesTable).where(eq(recordingSchedulesTable.fieldId, fieldId));
  await db.delete(recordingsTable).where(eq(recordingsTable.id, recordingId));
  for (const id of [adminId, playerId, rivalId]) {
    await db.delete(usersTable).where(eq(usersTable.id, id));
  }
  await db.delete(fieldsTable).where(eq(fieldsTable.id, fieldId));
});

describe("GET the chain", () => {
  it("starts empty, and says where playback should stop (nowhere, yet)", async () => {
    const res = await request(app).get(url());
    expect(res.status).toBe(200);
    expect(res.body.chain).toEqual([]);
    expect(res.body.coverageSeconds).toBe(0);
    expect(res.body.nextUncertainty).toBeNull();
    expect(typeof res.body.bundleFingerprint).toBe("string");
    expect(res.body.frameRate).toBe(FPS);
  });

  it("refuses an unauthenticated caller", async () => {
    mockedAccountUser.mockResolvedValue(null);
    mockedLocalUser.mockResolvedValue(null);
    expect((await request(app).get(url())).status).toBe(401);
  });
});

describe("tap — the only way a chain grows", () => {
  it("claims the track from the tap forward and stops at its end", async () => {
    const res = await request(app).post(url("/tap")).send({ trackId: "t1", frame: 10 });
    expect(res.status).toBe(200);
    expect(res.body.chain).toEqual([{ trackId: "t1", fromFrame: 10, toFrame: 99 }]);
    // (99 + 1 - 10) frames at 25fps.
    expect(res.body.coverageSeconds).toBe(3.6);
    expect(res.body.nextUncertainty).toMatchObject({ kind: "track-end", frame: 99, trackId: "t1" });
  });

  it("names the person by their account when they give no name", async () => {
    await request(app).post(url("/tap")).send({ trackId: "t1", frame: 10 });
    const identities = (await storedManifest()).identities ?? [];
    expect(identities).toHaveLength(1);
    expect(identities[0].id).toBe(claimIdentityId(playerId, recordingId));
    expect(identities[0].name).toBe("Mohammed");
  });

  it("takes the name the person gives themselves, and it lands on the board", async () => {
    await request(app).post(url("/tap")).send({ trackId: "t1", frame: 10, name: "  Ayesh  " });
    const identities = (await storedManifest()).identities ?? [];
    expect(identities[0].name).toBe("Ayesh");
  });

  it("marks the identity map as belonging to THIS bundle", async () => {
    // Start from a manifest whose provenance points at an OLDER bundle. Left
    // in place, it makes usableIdentityMap return nothing and the claimant's
    // work becomes invisible with no error raised anywhere.
    await resetManifest({ provenance: { bundleFingerprint: "an-older-bundle" } } as Partial<TrackingManifest>);
    // usableIdentityMap returns nothing unless these two agree, so getting
    // this wrong makes the claimant's work invisible with no error anywhere.
    const before = await request(app).get(url());
    await request(app).post(url("/tap")).send({ trackId: "t1", frame: 10 });
    const provenance = (await storedManifest()).provenance ?? {};
    expect(provenance.identityMapBundleFingerprint).toBe(before.body.bundleFingerprint);
    expect(provenance.bundleFingerprint).toBe(before.body.bundleFingerprint);
  });

  it("is idempotent — the same tap twice leaves one identity, not two", async () => {
    await request(app).post(url("/tap")).send({ trackId: "t1", frame: 10 });
    await request(app).post(url("/tap")).send({ trackId: "t1", frame: 10 });
    expect((await storedManifest()).identities).toHaveLength(1);
  });

  it("extends across a hand-over when the person taps again", async () => {
    await request(app).post(url("/tap")).send({ trackId: "t1", frame: 10 });
    const res = await request(app).post(url("/tap"))
      .send({ trackId: "t2", frame: 100, rejectedTrackId: "t1" });
    expect(res.body.chain).toEqual([
      { trackId: "t1", fromFrame: 10, toFrame: 99 },
      { trackId: "t2", fromFrame: 100, toFrame: 199 },
    ]);
  });

  it("refuses a track that is not in the recording", async () => {
    const res = await request(app).post(url("/tap")).send({ trackId: "ghost", frame: 10 });
    expect(res.status).toBe(400);
    expect((await storedManifest()).identities ?? []).toEqual([]);
  });

  it("refuses a piece the board has struck off", async () => {
    // identityDecisions has been written and validated since it was
    // introduced and read by nothing, so deleting a player on the board left
    // them fully claimable in the video.
    await resetManifest({
      identityDecisions: [{ trackId: "t1", fromFrame: 0, toFrame: 99, action: "deleted" }],
    } as Partial<TrackingManifest>);
    const res = await request(app).post(url("/tap")).send({ trackId: "t1", frame: 10 });
    expect(res.status).toBe(400);
    expect((await storedManifest()).identities ?? []).toEqual([]);
  });

  it("refuses a client working from a replaced bundle rather than merging blindly", async () => {
    const res = await request(app).post(url("/tap"))
      .send({ trackId: "t1", frame: 10, bundleFingerprint: "from-some-older-bundle" });
    expect(res.status).toBe(409);
    expect(res.body.currentBundleFingerprint).toEqual(expect.any(String));
    expect((await storedManifest()).identities ?? []).toEqual([]);
  });
});

describe("the board and the video are one map", () => {
  it("a tap claims the whole PERSON the board already merged", async () => {
    await setIdentities([{
      id: "person-x",
      name: "tracker guess",
      parts: [
        { trackId: "t1", fromFrame: 0, toFrame: 99 },
        { trackId: "t2", fromFrame: 100, toFrame: 199 },
      ],
    }] as never);

    const res = await request(app).post(url("/tap")).send({ trackId: "t1", frame: 20 });
    // t2 comes along without a second tap: the board already said it is the
    // same player, and asking again would be asking twice about one person.
    expect(res.body.chain).toEqual([
      { trackId: "t1", fromFrame: 20, toFrame: 99 },
      { trackId: "t2", fromFrame: 100, toFrame: 199 },
    ]);
  });

  it("moves those frames off the row that held them — never two people on one frame", async () => {
    await setIdentities([{
      id: "person-x",
      name: "tracker guess",
      parts: [
        { trackId: "t1", fromFrame: 0, toFrame: 99 },
        { trackId: "t2", fromFrame: 100, toFrame: 199 },
      ],
    }] as never);
    await request(app).post(url("/tap")).send({ trackId: "t1", frame: 20 });

    const identities = (await storedManifest()).identities ?? [];
    const other = identities.find((item) => item.id === "person-x");
    const mine = identities.find((item) => item.id === claimIdentityId(playerId, recordingId));
    // Everything from the tap forward moved to the claimant; only the stretch
    // before the tap, which nobody has contradicted, stays where it was.
    expect(other?.parts).toEqual([{ trackId: "t1", fromFrame: 0, toFrame: 19 }]);
    expect(mine?.parts).toHaveLength(2);
  });

  it("leaves other people's rows alone when they share no frames", async () => {
    await setIdentities([{
      id: "person-y",
      name: "someone else",
      parts: [{ trackId: "t3", fromFrame: 0, toFrame: 199 }],
    }] as never);
    await request(app).post(url("/tap")).send({ trackId: "t1", frame: 10 });

    const identities = (await storedManifest()).identities ?? [];
    expect(identities.find((item) => item.id === "person-y")?.parts)
      .toEqual([{ trackId: "t3", fromFrame: 0, toFrame: 199 }]);
    expect(identities).toHaveLength(2);
  });

  it("drops a row entirely once the claim has taken all of it", async () => {
    await setIdentities([{
      id: "person-z",
      name: "tracker guess",
      parts: [{ trackId: "t1", fromFrame: 0, toFrame: 99 }],
    }] as never);
    await request(app).post(url("/tap")).send({ trackId: "t1", frame: 0 });

    const identities = (await storedManifest()).identities ?? [];
    expect(identities.map((item) => item.id)).toEqual([claimIdentityId(playerId, recordingId)]);
  });
});

describe("not-me — the human override", () => {
  beforeEach(async () => {
    await request(app).post(url("/tap")).send({ trackId: "t1", frame: 0 });
    await request(app).post(url("/tap")).send({ trackId: "t2", frame: 100 });
    await db.delete(claimChainLabelsTable).where(eq(claimChainLabelsTable.recordingId, recordingId));
  });

  it("gives up everything from the stated frame onward", async () => {
    const res = await request(app).post(url("/not-me")).send({ frame: 150 });
    expect(res.status).toBe(200);
    expect(res.body.chain).toEqual([
      { trackId: "t1", fromFrame: 0, toFrame: 99 },
      { trackId: "t2", fromFrame: 100, toFrame: 149 },
    ]);
    expect((await storedManifest()).identities?.[0].parts).toHaveLength(2);
  });

  it("records it as a lost label naming the track that was wrong", async () => {
    await request(app).post(url("/not-me")).send({ frame: 150, decisionMs: 2400 });
    const [label] = await labels();
    expect(label).toMatchObject({
      kind: "lost",
      atFrame: 150,
      wrongTrackId: "t2",
      rightTrackId: null,
      decisionMs: 2400,
      userId: playerId,
    });
  });

  it("can empty the chain, which removes the person from the board too", async () => {
    const res = await request(app).post(url("/not-me")).send({ frame: 0 });
    expect(res.body.chain).toEqual([]);
    expect((await storedManifest()).identities ?? []).toEqual([]);
  });
});

describe("confirm — because silence is not a label", () => {
  it("writes the label without touching the chain", async () => {
    await request(app).post(url("/tap")).send({ trackId: "t1", frame: 0 });
    await db.delete(claimChainLabelsTable).where(eq(claimChainLabelsTable.recordingId, recordingId));

    const before = await storedManifest();
    const res = await request(app).post(url("/confirm")).send({ frame: 50, decisionMs: 900 });
    expect(res.status).toBe(200);
    expect(res.body.chain).toEqual([{ trackId: "t1", fromFrame: 0, toFrame: 99 }]);
    expect((await storedManifest()).identities).toEqual(before.identities);

    const [label] = await labels();
    expect(label).toMatchObject({ kind: "confirm", atFrame: 50, rightTrackId: "t1", decisionMs: 900 });
  });
});

describe("undo", () => {
  it("drops the last link and deliberately writes no label", async () => {
    await request(app).post(url("/tap")).send({ trackId: "t1", frame: 0 });
    await request(app).post(url("/tap")).send({ trackId: "t2", frame: 100 });
    await db.delete(claimChainLabelsTable).where(eq(claimChainLabelsTable.recordingId, recordingId));

    const res = await request(app).delete(url("/last"));
    expect(res.status).toBe(200);
    expect(res.body.chain).toEqual([{ trackId: "t1", fromFrame: 0, toFrame: 99 }]);
    // A mis-tap is not evidence about the tracker.
    expect(await labels()).toHaveLength(0);
  });
});

describe("another player has already vouched for that stretch", () => {
  it("refuses the tap and changes nothing", async () => {
    await db.insert(claimMatchIdentityBindingsTable).values({
      userId: rivalId,
      recordingId,
      personId: "person-rival",
      trackingBundleId: bundleId,
      bundleFingerprint: "any",
      personParts: [],
      vouchedFragments: [{ trackId: "t1", fromFrame: 40, toFrame: 60 }],
      resolutionMethod: "identity-map",
      state: "confirmed",
    });

    const res = await request(app).post(url("/tap")).send({ trackId: "t1", frame: 10 });
    expect(res.status).toBe(409);
    expect(res.body.conflict).toEqual({ trackId: "t1", fromFrame: 40, toFrame: 60 });
    expect((await storedManifest()).identities ?? []).toEqual([]);
  });

  it("ignores a released binding, which is what release is for", async () => {
    await db.insert(claimMatchIdentityBindingsTable).values({
      userId: rivalId,
      recordingId,
      personId: "person-rival",
      trackingBundleId: bundleId,
      bundleFingerprint: "any",
      personParts: [],
      vouchedFragments: [{ trackId: "t1", fromFrame: 40, toFrame: 60 }],
      resolutionMethod: "identity-map",
      state: "released",
    });
    expect((await request(app).post(url("/tap")).send({ trackId: "t1", frame: 10 })).status).toBe(200);
  });

  it("does not block the claimant with their own vouched fragment", async () => {
    await db.insert(claimMatchIdentityBindingsTable).values({
      userId: playerId,
      recordingId,
      personId: "person-mine",
      trackingBundleId: bundleId,
      bundleFingerprint: "any",
      personParts: [],
      vouchedFragments: [{ trackId: "t1", fromFrame: 40, toFrame: 60 }],
      resolutionMethod: "identity-map",
      state: "confirmed",
    });
    expect((await request(app).post(url("/tap")).send({ trackId: "t1", frame: 10 })).status).toBe(200);
  });
});

describe("the label carries the geometry that produced it", () => {
  it("freezes the boxes and trajectories, because the bundle will be gone in 14 days", async () => {
    await request(app).post(url("/tap")).send({ trackId: "t1", frame: 0 });
    await db.delete(claimChainLabelsTable).where(eq(claimChainLabelsTable.recordingId, recordingId));

    await request(app).post(url("/tap"))
      .send({ trackId: "t2", frame: 100, rejectedTrackId: "t1", decisionMs: 3100 });

    const [label] = await labels();
    expect(label.kind).toBe("switch");
    expect(label.wrongTrackId).toBe("t1");
    expect(label.rightTrackId).toBe("t2");

    const geom = label.geom as any;
    expect(geom.frame).toBe(100);
    expect(geom.frameRate).toBe(FPS);
    // t2 and t3 both have boxes at frame 100; t1 ends at 99 but is inside the
    // +/-2 frame tolerance, so all three were genuinely on offer.
    expect(geom.offeredCount).toBe(3);
    expect(geom.chosen.trackId).toBe("t2");
    expect(geom.chosen.box).not.toBeNull();
    expect(geom.rejected.trackId).toBe("t1");
    // What a model learns the association cost from: what was passed over.
    expect(geom.alternatives.map((a: any) => a.trackId)).toEqual(["t3"]);
    expect(geom.chosen.after).not.toBeNull();
    expect(label.bundleFingerprint).toEqual(expect.any(String));
  });
});

describe("the training-set export", () => {
  it("is admin-only", async () => {
    await request(app).post(url("/tap")).send({ trackId: "t1", frame: 10 });
    const denied = await request(app).get(`/api/admin/recordings/${recordingId}/claim-chain-labels`);
    expect(denied.status).toBe(403);
  });

  it("returns the labels, and can be scoped to one bundle", async () => {
    await request(app).post(url("/tap")).send({ trackId: "t1", frame: 10 });
    const fingerprint = (await request(app).get(url())).body.bundleFingerprint;

    actAs(adminId);
    const all = await request(app).get(`/api/admin/recordings/${recordingId}/claim-chain-labels`);
    expect(all.status).toBe(200);
    expect(all.body.count).toBeGreaterThan(0);

    // Track ids are bundle-relative, so a scoring run must never mix bundles.
    const scoped = await request(app)
      .get(`/api/admin/recordings/${recordingId}/claim-chain-labels`)
      .query({ bundleFingerprint: fingerprint });
    expect(scoped.body.count).toBe(all.body.count);

    const other = await request(app)
      .get(`/api/admin/recordings/${recordingId}/claim-chain-labels`)
      .query({ bundleFingerprint: "a-different-bundle" });
    expect(other.body.count).toBe(0);
  });
});

describe("a failed label write never costs the person their claim", () => {
  it("still saves the chain when the label insert throws", async () => {
    const insert = vi.spyOn(db, "insert").mockImplementationOnce(() => {
      throw new Error("labels table is on fire");
    });
    try {
      const res = await request(app).post(url("/tap")).send({ trackId: "t1", frame: 10 });
      expect(res.status).toBe(200);
      expect(res.body.chain).toEqual([{ trackId: "t1", fromFrame: 10, toFrame: 99 }]);
      expect(await labels()).toHaveLength(0);
    } finally {
      insert.mockRestore();
    }
  });
});

describe("the endpoint says whether the label landed", () => {
  it("reports true on a real write and false when the corpus write fails", async () => {
    // A label failing silently would leave the corpus empty while every claim
    // looked healthy -- exactly the shape of identityDecisions being written
    // and read by nobody.
    const good = await request(app).post(url("/tap")).send({ trackId: "t1", frame: 10 });
    expect(good.body.labelRecorded).toBe(true);

    const insert = vi.spyOn(db, "insert").mockImplementationOnce(() => {
      throw new Error("no such table");
    });
    try {
      const bad = await request(app).post(url("/not-me")).send({ frame: 50 });
      expect(bad.status).toBe(200);
      expect(bad.body.labelRecorded).toBe(false);
    } finally {
      insert.mockRestore();
    }
  });

  it("is null on a read, which records nothing", async () => {
    expect((await request(app).get(url())).body.labelRecorded).toBeNull();
  });
});

/**
 * The spec and the server, checked against each other.
 *
 * The client's hooks and types are generated from openapi.yaml, so a response
 * that does not match the spec is a lie the compiler cannot see: the client
 * gets types that typecheck perfectly and describe a shape the server never
 * sends. Parsing real responses through the generated Zod is the only place
 * that gap shows up.
 */
describe("responses match the generated contract", () => {
  it("every chain endpoint returns exactly what the spec promises", async () => {
    expect(GetClaimChainResponse.parse((await request(app).get(url())).body)).toBeTruthy();

    const tapped = await request(app).post(url("/tap"))
      .send({ trackId: "t1", frame: 10, name: "Ayesh", decisionMs: 1200 });
    expect(TapClaimChainResponse.parse(tapped.body).nextUncertainty?.kind).toBe("track-end");

    const confirmed = await request(app).post(url("/confirm")).send({ frame: 50 });
    expect(ConfirmClaimChainAtResponse.parse(confirmed.body).labelRecorded).toBe(true);

    const rejected = await request(app).post(url("/not-me")).send({ frame: 80 });
    expect(RejectClaimChainFromResponse.parse(rejected.body).chain).toHaveLength(1);

    const undone = await request(app).delete(url("/last"));
    expect(UndoClaimChainLastResponse.parse(undone.body).chain).toEqual([]);
  });

  it("accepts the bodies the spec says clients may send", async () => {
    const full = await request(app).post(url("/tap")).send({
      trackId: "t2",
      frame: 120,
      rejectedTrackId: "t1",
      name: "Ayesh",
      decisionMs: 4200,
      bundleFingerprint: (await request(app).get(url())).body.bundleFingerprint,
    });
    expect(full.status).toBe(200);
    expect(TapClaimChainResponse.parse(full.body).coverageSeconds).toBeGreaterThan(0);
  });
});
