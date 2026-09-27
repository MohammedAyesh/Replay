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

import claimGameRouter from "./claimGame";

function appFor() {
  const app = express();
  app.use(express.json());
  app.use("/api", claimGameRouter);
  return app;
}

describe("whole-game state saves", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.labelRows.length = 0;

    const context = {
      userId: 7,
      recordingId: 42,
      bundleId: 3,
      manifest: { duration: 10, frameRate: 25, identities: [] },
      segments: [],
      tracksById: new Map(),
      fingerprint: "bundle-a",
      identityId: "claim:test",
      answeredFrames: new Set(),
      offPitch: [],
    };
    mocks.begin.mockResolvedValue(context);
    mocks.persistChain.mockResolvedValue(undefined);
    mocks.syncChainClaim.mockResolvedValue(undefined);
    mocks.recordFindDecisionLabel.mockImplementation(async (...args: unknown[]) => {
      mocks.labelRows.push(args);
      return true;
    });

    const transaction = {
      delete: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
      insert: vi.fn(() => ({ values: vi.fn().mockResolvedValue(undefined) })),
    };
    mocks.db.transaction.mockImplementation(async (callback: unknown) =>
      (callback as (tx: typeof transaction) => Promise<unknown>)(transaction));

    const progressInsert = {
      values: vi.fn().mockReturnThis(),
      onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
    };
    mocks.db.insert.mockReturnValue(progressInsert);

    const progressSelect = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([]),
    };
    mocks.db.select.mockReturnValue(progressSelect);
  });

  it("does not write training labels when the whole claim state is saved", async () => {
    const response = await request(appFor())
      .put("/api/recordings/42/claim-match/game")
      .send({
        state: { step: "review" },
        parts: [],
        bench: [],
        done: false,
        bundleFingerprint: "bundle-a",
      });

    expect(response.status).toBe(200);
    expect(mocks.persistChain).toHaveBeenCalledOnce();
    expect(mocks.db.insert).toHaveBeenCalledOnce();
    expect(mocks.recordFindDecisionLabel).not.toHaveBeenCalled();
    expect(mocks.labelRows).toEqual([]);
  });
});