import { describe, expect, it } from "vitest";
import { claimHasPicks, newState, resumableSavedClaim, startClaimWithWindows, type ClaimState, type Ctx } from "./claim";
import type { Game } from "./model";

// Recording 403: twelve 10-minute blocks, 7202.85 s of tracking.
const game: Game = {
  chunks: Array.from({ length: 12 }, (_, k) => ({ k, start: k * 600, dur: k === 11 ? 602.85 : 599.95 })),
  total: 7202.85,
  srcW: 3840,
  srcH: 1080,
  frameRate: 20,
  videoStartSeconds: 0,
  matchOffset: 0,
  outOfPlay: [[0, 1514]],
  inplay: [[1514, 7202.85]],
  pitch: null,
};

const ctx = (): Ctx => ({ game, CH: {}, S: newState(game) });

describe("a game with no block to claim (recording 403, booking DWLMTD)", () => {
  it("the 0.9 s window leaves nothing to visit", () => {
    // The page's Start checks this on a copy and stays on the first screen.
    expect(startClaimWithWindows(ctx(), [[7200, 7200.9]])).toBe("done");
  });

  it("the booking the recording is for has blocks", () => {
    expect(startClaimWithWindows(ctx(), [[0, 7200]])).toBe("kit");
  });

  it("an end-screen save with nobody picked is not offered as saved progress", () => {
    const c = ctx();
    startClaimWithWindows(c, [[7200, 7200.9]]);
    const saved: ClaimState = { ...c.S, step: "done" };
    expect(claimHasPicks(saved)).toBe(false);
    expect(resumableSavedClaim(saved)).toBeNull();
  });

  it("a finished claim with a pick is still offered", () => {
    const saved: ClaimState = {
      ...newState(game),
      step: "done",
      you: { "3": { cid: "g1", out: [], added: [], dropped: [], extra: [], seen: [], manual: [], rosterParts: [], skipped: false } },
    };
    expect(resumableSavedClaim(saved)).toBe(saved);
  });

  it("an unfinished claim is offered even before a pick", () => {
    const saved: ClaimState = { ...newState(game), step: "roster" };
    expect(resumableSavedClaim(saved)).toBe(saved);
  });
});
