import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  db: {
    transaction: vi.fn(),
    insert: vi.fn(),
    select: vi.fn(),
  },
  begin: vi.fn(),
  persistChain: vi.fn(),
  recordFindDecisionLabel: vi.fn(),
  syncChainClaim: vi.fn(),
  labelRows: [] as unknown[][],
}));

vi.mock("@workspace/db", () => ({
  db: mocks.db,
  claimMatchOffPitchSpansTable: {
    userId: "offPitch.userId",
    recordingId: "offPitch.recordingId",
    clientId: "offPitch.clientId",
    fromSeconds: "offPitch.fromSeconds",
    toSeconds: "offPitch.toSeconds",
  },
  claimMatchProgressTable: {
    userId: "progress.userId",
    recordingId: "progress.recordingId",
    gameState: "progress.gameState",
    updatedAt: "progress.updatedAt",
    claimedPercent: "progress.claimedPercent",
    completed: "progress.completed",
  },
}));

vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => args,
  eq: (...args: unknown[]) => args,
}));

vi.mock("./claimChain", () => ({
  begin: mocks.begin,
  claimIdentityId: vi.fn(),
  persistChain: mocks.persistChain,
  recordFindDecisionLabel: mocks.recordFindDecisionLabel,
  syncChainClaim: mocks.syncChainClaim,
}));

vi.mock("./claimMatch", () => ({
  getClaimMatchWritableBundle: vi.fn(),
  requireAccountUser: vi.fn(),
}));

vi.mock("../lib/matchPlayLoad", () => ({ loadRecordingPlay: vi.fn() }));
vi.mock("../lib/matchFeed", () => ({ joinMatchesFromClaim: vi.fn() }));
// "Is this you?" answers: none saved for this claim
vi.mock("../lib/momentChecks", () => ({ momentChecksFor: vi.fn(async () => new Map()) }));

import claimGameRouter from "./claimGame";

function appFor() {
  const app = express();
  app.use(express.json());
  app.use("/api", claimGameRouter);
  return app;
}

describe("whole-game claim saves: one person, one track at a time", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const track = (id: string) => ({ id, startFrame: 0, endFrame: 1499 });
    mocks.begin.mockResolvedValue({
      userId: 7,
      recordingId: 42,
      bundleId: 3,
      // The identity board struck track Z (say, the referee) off the whole game.
      manifest: { duration: 60, frameRate: 25, identities: [], identityDecisions: [{ trackId: "Z", fromFrame: 0, toFrame: 1499, action: "deleted" }] },
      segments: [],
      tracksById: new Map([["X", track("X")], ["Y", track("Y")], ["Z", track("Z")]]),
      fingerprint: "bundle-a",
      identityId: "claim:test",
      answeredFrames: new Set(),
      offPitch: [],
    });
    mocks.persistChain.mockResolvedValue(undefined);
    mocks.syncChainClaim.mockResolvedValue(undefined);
    mocks.db.transaction.mockImplementation(async (callback: unknown) =>
      (callback as (tx: unknown) => Promise<unknown>)({
        delete: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
        insert: vi.fn(() => ({ values: vi.fn().mockResolvedValue(undefined) })),
      }));
    mocks.db.insert.mockReturnValue({ values: vi.fn().mockReturnThis(), onConflictDoUpdate: vi.fn().mockResolvedValue(undefined) });
    mocks.db.select.mockReturnValue({ from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([]) });
  });

  it("never credits two tracks for the same frame", async () => {
    const response = await request(appFor())
      .put("/api/recordings/42/claim-match/game")
      .send({
        state: { step: "review" },
        // Two different people over the same 40 s: only one of them can be this player.
        parts: [
          { trackId: "X", fromFrame: 0, toFrame: 999 },
          { trackId: "Y", fromFrame: 0, toFrame: 999 },
        ],
        bench: [],
        done: false,
        bundleFingerprint: "bundle-a",
      });
    expect(response.status).toBe(200);
    const chain = mocks.persistChain.mock.calls[0][1] as Array<{ trackId: string; fromFrame: number; toFrame: number }>;
    const credited = new Map<number, number>();
    for (const part of chain) {
      for (let f = part.fromFrame; f <= part.toFrame; f++) credited.set(f, (credited.get(f) ?? 0) + 1);
    }
    expect(Math.max(...credited.values())).toBe(1);
    expect(credited.size).toBe(1000);
  });

  it("never credits a track the identity board struck off", async () => {
    await request(appFor())
      .put("/api/recordings/42/claim-match/game")
      .send({
        state: { step: "review" },
        parts: [{ trackId: "Z", fromFrame: 0, toFrame: 999 }],
        bench: [],
        done: false,
        bundleFingerprint: "bundle-a",
      });
    const chain = mocks.persistChain.mock.calls[0][1] as Array<{ trackId: string }>;
    expect(chain).toEqual([]);
  });

  it("keeps a claim complete when the deck's \"Not me\" cuts are what pushed it under the bar", async () => {
    await request(appFor())
      .put("/api/recordings/42/claim-match/game")
      .send({
        state: { step: "done" },
        parts: [{ trackId: "X", fromFrame: 0, toFrame: 999 }],
        bench: [],
        done: true,
        bundleFingerprint: "bundle-a",
      });
    // Same rule as the deck route: completion is judged with the deck's cuts counted back in.
    expect(mocks.syncChainClaim.mock.calls[0][3]).toEqual({ creditDeckCuts: true });
  });
});
