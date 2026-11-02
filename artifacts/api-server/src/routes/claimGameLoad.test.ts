import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The /find page used to wait 7-9 s on "Loading the game..." because GET /game
 * read every segment of the game (88 MB on a 2-hour recording) for one list of
 * in-play spans, and every autosave read them again. These pin the routes to
 * the bundle summary where it is enough.
 */

const mocks = vi.hoisted(() => ({
  db: {
    transaction: vi.fn(),
    insert: vi.fn(),
    select: vi.fn(),
    execute: vi.fn(),
  },
  begin: vi.fn(),
  withSegments: vi.fn(),
  persistChain: vi.fn(),
  syncChainClaim: vi.fn(),
}));

vi.mock("@workspace/db", () => ({
  db: mocks.db,
  claimMatchOffPitchSpansTable: { userId: "o.userId", recordingId: "o.recordingId" },
  claimMatchProgressTable: {
    userId: "p.userId",
    recordingId: "p.recordingId",
    gameState: "p.gameState",
    updatedAt: "p.updatedAt",
    claimedPercent: "p.claimedPercent",
    completed: "p.completed",
  },
  recordingTrackingBundlesTable: { id: "b.id", manifest: "b.manifest" },
}));

vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => args,
  eq: (...args: unknown[]) => args,
  sql: (...args: unknown[]) => ({ sql: args }),
}));

vi.mock("./claimChain", () => ({
  begin: mocks.begin,
  claimIdentityId: vi.fn(),
  loadContext: vi.fn(),
  persistChain: mocks.persistChain,
  recordFindDecisionLabel: vi.fn(),
  syncChainClaim: mocks.syncChainClaim,
  withSegments: mocks.withSegments,
}));

vi.mock("./claimMatch", () => ({
  getClaimMatchWritableBundle: vi.fn(),
  requireAccountUser: vi.fn(),
}));

vi.mock("../lib/matchPlayLoad", () => ({ loadRecordingPlay: vi.fn() }));
vi.mock("../lib/matchFeed", () => ({ joinMatchesFromClaim: vi.fn(), recordingWindow: vi.fn() }));
vi.mock("../lib/momentChecks", () => ({ momentChecksFor: vi.fn(async () => new Map()), clearMomentChecks: vi.fn() }));

import claimGameRouter, { summaryInPlaySpans } from "./claimGame";

function appFor() {
  const app = express();
  app.use(express.json());
  app.use("/api", claimGameRouter);
  return app;
}

const segmentMeta = (index: number) => ({ index, name: `c${index}`, startFrame: index * 100, endFrame: index * 100 + 99, startSeconds: index * 5, endSeconds: index * 5 + 5, objectPath: `/objects/s${index}` });
const summarySegment = (index: number, spans?: Array<{ start: number; end: number }>) => ({
  segmentIndex: index,
  startFrame: index * 100,
  endFrame: index * 100 + 99,
  startSeconds: index * 5,
  endSeconds: index * 5 + 5,
  tracks: [],
  events: [],
  ...(spans ? { inPlaySpans: spans } : {}),
});

function context(summary: unknown) {
  return {
    userId: 7,
    recordingId: 42,
    bundleId: 3,
    manifest: { duration: 10, frameRate: 20, segments: [segmentMeta(0), segmentMeta(1)], identities: [], summary },
    segments: [],
    tracksById: new Map(),
    segmentsLoaded: false,
    segmentsCacheKey: "3:t:f",
    fingerprint: "bundle-a",
    identityId: "claim:test",
    answeredFrames: new Set(),
    offPitch: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.db.select.mockReturnValue({ from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([]) });
  mocks.db.insert.mockReturnValue({ values: vi.fn().mockReturnThis(), onConflictDoUpdate: vi.fn().mockResolvedValue(undefined) });
  mocks.db.execute.mockResolvedValue(undefined);
});

describe("summaryInPlaySpans", () => {
  it("reads the spans of every summarised segment, sorted", () => {
    const manifest = context({ segments: [summarySegment(1, [{ start: 6, end: 9 }]), summarySegment(0, [{ start: 1, end: 4 }, { start: 3, end: 3 }])] }).manifest;
    expect(summaryInPlaySpans(manifest as never)).toEqual([[1, 4], [6, 9]]);
  });

  it("is null when any segment was summarised before the spans were", () => {
    const manifest = context({ segments: [summarySegment(0, [{ start: 1, end: 4 }]), summarySegment(1)] }).manifest;
    expect(summaryInPlaySpans(manifest as never)).toBeNull();
    expect(summaryInPlaySpans(context(undefined).manifest as never)).toBeNull();
  });
});

describe("GET /claim-match/game", () => {
  it("answers from the summary without waiting for the segments", async () => {
    mocks.begin.mockResolvedValue(context({ segments: [summarySegment(0, [{ start: 1, end: 4 }]), summarySegment(1, [])] }));
    // The background prefetch never finishes: the response must not wait on it.
    mocks.withSegments.mockReturnValue(new Promise(() => {}));
    const response = await request(appFor()).get("/api/recordings/42/claim-match/game");
    expect(response.status).toBe(200);
    expect(response.body.inPlaySpans).toEqual([[1, 4]]);
    expect(mocks.begin.mock.calls[0][2]).toEqual({ includeSegments: false });
    expect(mocks.db.execute).not.toHaveBeenCalled();
  });

  it("reads the segments once for an older bundle and copies its spans into the summary", async () => {
    const ctx = context({ segments: [summarySegment(0), summarySegment(1)] });
    mocks.begin.mockResolvedValue(ctx);
    mocks.withSegments.mockResolvedValue({
      ...ctx,
      segmentsLoaded: true,
      segments: [
        { segmentIndex: 0, inPlaySpans: [{ start: 2, end: 3 }] },
        { segmentIndex: 1, inPlaySpans: [{ start: 7, end: 8 }] },
      ],
    });
    const response = await request(appFor()).get("/api/recordings/42/claim-match/game");
    expect(response.status).toBe(200);
    expect(response.body.inPlaySpans).toEqual([[2, 3], [7, 8]]);
    await vi.waitFor(() => expect(mocks.db.execute).toHaveBeenCalledTimes(1));
  });
});

describe("PUT /claim-match/game", () => {
  it("stores a save without parts without reading the tracking", async () => {
    mocks.begin.mockResolvedValue(context({ segments: [] }));
    const response = await request(appFor())
      .put("/api/recordings/42/claim-match/game")
      .send({ state: { step: "kit" }, bench: [], done: false, bundleFingerprint: "bundle-a" });
    expect(response.status).toBe(200);
    expect(mocks.begin.mock.calls[0][2]).toEqual({ includeSegments: false });
  });

  it("still loads the tracking for a save with parts", async () => {
    mocks.begin.mockResolvedValue({ ...context({ segments: [] }), segmentsLoaded: true });
    mocks.db.transaction.mockImplementation(async (callback: unknown) =>
      (callback as (tx: unknown) => Promise<unknown>)({
        delete: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
        insert: vi.fn(() => ({ values: vi.fn().mockResolvedValue(undefined) })),
      }));
    await request(appFor())
      .put("/api/recordings/42/claim-match/game")
      .send({ state: { step: "review" }, parts: [], bench: [], done: false, bundleFingerprint: "bundle-a" });
    expect(mocks.begin.mock.calls[0][2]).toEqual({ includeSegments: true });
  });
});
