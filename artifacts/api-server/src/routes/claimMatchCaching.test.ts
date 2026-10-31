/**
 * The per-segment tracking files (/find, the identity board) are fetched by
 * segment index, so the URL does not change when a recording is re-analysed.
 * With max-age caching a browser kept drawing the old tracking for up to a
 * day. They must revalidate every time, cheaply: a strong ETag tied to the
 * stored object, and a 304 that does not read storage at all.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express, { type Express } from "express";
import { gzipSync } from "node:zlib";
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
  fieldsTable,
  recordingSchedulesTable,
  recordingTrackingBundlesTable,
  recordingsTable,
  usersTable,
  type TrackingManifest,
} from "@workspace/db";
import { readClaimSegment, readCompressedClaimSegment } from "../lib/claimMatchStorage";
import { getLocalAccountUserId, getLocalUserId } from "../lib/clerkUserBridge";

const TAG = `claim-cache-${Date.now()}`;
let app: Express;
let fieldId: number;
let adminId: number;
let playerId: number;
let recordingId: number;
let bundleId: number;

/** Storage as a map from object path to the JSON stored there. */
const stored = new Map<string, unknown>();

function manifestFor(version: string): TrackingManifest {
  return {
    version: 1, label: "cache", width: 1920, height: 1080, frameRate: 25,
    frameCount: 200, duration: 8, matchOffset: 0, videoStartSeconds: 0, segmentCount: 1,
    segments: [{
      index: 0, name: "only", startFrame: 0, endFrame: 199, startSeconds: 0, endSeconds: 8,
      objectPath: `${TAG}/${version}-0.json.gz`,
      ballPath: `${TAG}/${version}-0-ball.json.gz`,
      peoplePath: `${TAG}/${version}-0-people.json.gz`,
      jerseyPath: `${TAG}/${version}-0-jersey.json.gz`,
      spritesPath: `${TAG}/${version}-0-sprites.json.gz`,
    }],
    matchRosterPath: `${TAG}/${version}-match-roster.json.gz`,
  } as never;
}

function store(version: string) {
  for (const kind of ["", "-ball", "-people", "-jersey", "-sprites"]) {
    stored.set(`${TAG}/${version}-0${kind}.json.gz`, { version, kind });
  }
  stored.set(`${TAG}/${version}-match-roster.json.gz`, {
    players: [{
      id: `player-${version}`, name: `Sam ${version}`, number: "12", minutes: 1,
      parts: [{ segmentIndex: 0, segmentName: "only", trackId: "t1", fromFrame: 0, toFrame: 10 }],
    }],
  });
}

async function setManifest(version: string) {
  store(version);
  await db.update(recordingTrackingBundlesTable).set({ manifest: manifestFor(version), updatedAt: new Date() })
    .where(eq(recordingTrackingBundlesTable.id, bundleId));
}

beforeAll(async () => {
  const { default: claimMatchRouter } = await import("./claimMatch");
  app = express();
  app.use(express.json());
  app.use("/api", claimMatchRouter);
  const [field] = await db.insert(fieldsTable).values({ name: `${TAG} field`, location: "Test" }).returning({ id: fieldsTable.id });
  fieldId = field.id;
  const made = await db.insert(usersTable).values([
    { name: `${TAG} admin`, email: `${TAG}-admin@test.local`, isGuest: false, profileComplete: true, isAdmin: true },
    { name: `${TAG} player`, email: `${TAG}-player@test.local`, isGuest: false, profileComplete: true, isAdmin: false },
  ]).returning({ id: usersTable.id });
  [adminId, playerId] = made.map((row) => row.id);
  const [recording] = await db.insert(recordingsTable).values({
    fieldId, court: "1", date: "2026-09-06", timeSlot: "18:00", duration: "00:00:08",
    videoUrl: "https://example.test/cache.m3u8", isVisible: true,
  }).returning({ id: recordingsTable.id });
  recordingId = recording.id;
  await db.insert(recordingSchedulesTable).values({
    fieldId, allowedDate: "2026-09-06", startTime: "00:00", endTime: "23:59", label: `${TAG} visibility`,
  });
  store("v1");
  const [bundle] = await db.insert(recordingTrackingBundlesTable).values({ recordingId, uploadedBy: adminId, manifest: manifestFor("v1") })
    .returning({ id: recordingTrackingBundlesTable.id });
  bundleId = bundle.id;
});

beforeEach(async () => {
  vi.clearAllMocks();
  vi.mocked(getLocalAccountUserId).mockResolvedValue(playerId);
  vi.mocked(getLocalUserId).mockResolvedValue(playerId);
  vi.mocked(readCompressedClaimSegment).mockImplementation(async (path: string) => {
    if (!stored.has(path)) throw new Error("missing");
    return gzipSync(Buffer.from(JSON.stringify(stored.get(path)), "utf8")) as never;
  });
  vi.mocked(readClaimSegment).mockImplementation(async (path: string) => {
    if (!stored.has(path)) throw new Error("missing");
    return Buffer.from(JSON.stringify(stored.get(path)), "utf8") as never;
  });
  await setManifest("v1");
});

afterAll(async () => {
  await db.delete(recordingSchedulesTable).where(eq(recordingSchedulesTable.fieldId, fieldId));
  await db.delete(recordingsTable).where(eq(recordingsTable.id, recordingId));
  for (const id of [adminId, playerId]) await db.delete(usersTable).where(eq(usersTable.id, id));
  await db.delete(fieldsTable).where(eq(fieldsTable.id, fieldId));
});

const sidecars = ["segments", "ball", "people", "jersey", "sprites"] as const;

describe("tracking files revalidate, so a re-analysis is seen at once", () => {
  for (const kind of sidecars) {
    it(`/${kind}/:index: no-cache with a strong ETag, 304 on a match, new ETag after a re-analysis`, async () => {
      const url = `/api/recordings/${recordingId}/claim-match/${kind}/0`;
      const first = await request(app).get(url);
      expect(first.status).toBe(200);
      expect(first.headers["cache-control"]).toBe("private, no-cache");
      const etag = first.headers.etag as string;
      expect(etag).toMatch(/^"[^"]+"$/);
      expect(first.body).toEqual(expect.objectContaining({ version: "v1" }));

      vi.mocked(readCompressedClaimSegment).mockClear();
      const again = await request(app).get(url).set("If-None-Match", etag);
      expect(again.status).toBe(304);
      expect(again.headers.etag).toBe(etag);
      expect(again.headers["cache-control"]).toBe("private, no-cache");
      // Revalidation is cheap: storage is not read for a 304.
      expect(readCompressedClaimSegment).not.toHaveBeenCalled();

      await setManifest("v2");
      const after = await request(app).get(url).set("If-None-Match", etag);
      expect(after.status).toBe(200);
      expect(after.headers.etag).not.toBe(etag);
      expect(after.body).toEqual(expect.objectContaining({ version: "v2" }));
    });
  }

  it("/roster: no-cache with a strong ETag, 304 on a match, new ETag after a re-analysis", async () => {
    const url = `/api/recordings/${recordingId}/claim-match/roster`;
    const first = await request(app).get(url);
    expect(first.status).toBe(200);
    expect(first.headers["cache-control"]).toBe("private, no-cache");
    const etag = first.headers.etag as string;
    expect(etag).toMatch(/^"[^"]+"$/);

    const again = await request(app).get(url).set("If-None-Match", etag);
    expect(again.status).toBe(304);

    await setManifest("v2");
    const after = await request(app).get(url).set("If-None-Match", etag);
    expect(after.status).toBe(200);
    expect(after.headers.etag).not.toBe(etag);
    expect(after.body.players[0].name).toBe("Sam v2");
  });
});
