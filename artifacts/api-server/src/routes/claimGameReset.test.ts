import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  db: { delete: vi.fn(), select: vi.fn(), update: vi.fn(), insert: vi.fn(), transaction: vi.fn() },
  begin: vi.fn(),
  persistChain: vi.fn(),
  syncIdentityBinding: vi.fn(),
  clearMomentChecks: vi.fn(),
}));

vi.mock("@workspace/db", () => {
  const table = (name: string) => new Proxy({}, { get: (_t, key) => `${name}.${String(key)}` });
  return {
  db: mocks.db,
  claimChainLabelsTable: table("labels"),
  claimMatchIdentityBindingsTable: table("bindings"),
  claimMatchOffPitchSpansTable: table("offPitch"),
  claimMatchProgressTable: table("progress"),
  matchPlayersTable: table("matchPlayers"),
  matchRoomsTable: table("matchRooms"),
  matchTeamSpansTable: table("teamSpans"),
  recordingTrackingBundlesTable: table("bundles"),
  claimMomentChecksTable: table("momentChecks"),
  userClipsTable: table("userClips"),
  userReelsTable: table("userReels"),
};
});
vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => args,
  eq: (...args: unknown[]) => args,
  inArray: (...args: unknown[]) => args,
  isNull: (...args: unknown[]) => args,
  notInArray: (...args: unknown[]) => args,
}));
vi.mock("../lib/matchStatsCacheJobs", () => ({ queueMatchStatsCacheForRecording: vi.fn() }));
vi.mock("./claimChain", () => ({
  begin: mocks.begin,
  claimIdentityId: vi.fn(),
  loadContext: vi.fn(),
  persistChain: mocks.persistChain,
  recordFindDecisionLabel: vi.fn(),
  syncChainClaim: vi.fn(),
}));
vi.mock("./claimMatch", () => ({
  getClaimMatchWritableBundle: vi.fn(),
  requireAccountUser: vi.fn(),
  syncIdentityBinding: mocks.syncIdentityBinding,
}));
vi.mock("../lib/matchStatsCache", () => ({ invalidateMatchStatsCacheForRecording: vi.fn(async () => undefined) }));
vi.mock("../lib/matchPlayLoad", () => ({ loadRecordingPlay: vi.fn() }));
vi.mock("../lib/matchFeed", () => ({ joinMatchesFromClaim: vi.fn(), recordingWindow: vi.fn() }));
vi.mock("../lib/momentChecks", () => ({
  momentChecksFor: vi.fn(async () => new Map()),
  clearMomentChecks: mocks.clearMomentChecks,
}));

import claimGameRouter from "./claimGame";

function appFor() {
  const app = express();
  app.use(express.json());
  app.use("/api", claimGameRouter);
  return app;
}

/** A query builder that accepts any chain of calls and resolves to no rows. */
function query(): any {
  const builder: any = new Proxy(() => builder, {
    get: (_target, key) => (key === "then" ? (resolve: (rows: unknown[]) => void) => resolve([]) : () => builder),
    apply: () => builder,
  });
  return builder;
}

describe("Start over", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.begin.mockResolvedValue({ userId: 7, recordingId: 42, bundleId: 3, manifest: { duration: 60, frameRate: 25, identities: [] } });
    mocks.persistChain.mockResolvedValue(undefined);
    mocks.syncIdentityBinding.mockResolvedValue(null);
    mocks.clearMomentChecks.mockResolvedValue(undefined);
    const tx: any = { delete: query, select: query, update: query, transaction: async (fn: (t: unknown) => unknown) => fn(tx) };
    mocks.db.delete.mockImplementation(query);
    mocks.db.select.mockImplementation(query);
    mocks.db.update.mockImplementation(query);
    mocks.db.transaction.mockImplementation(async (fn: (t: unknown) => unknown) => fn(tx));
  });

  it("forgets this player's 'Is this you?' answers, so an old 'Not me' cannot cut the new claim", async () => {
    const response = await request(appFor()).delete("/api/recordings/42/claim-match/game");
    expect(response.status).toBe(200);
    expect(mocks.clearMomentChecks).toHaveBeenCalledWith(7, 42);
  });
});
