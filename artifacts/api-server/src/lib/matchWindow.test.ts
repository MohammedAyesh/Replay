/**
 * The match window: where the match is on a recording (recording 392: the
 * previous booking's game until 10:58, kick-off at 24:20 = 1460 s).
 *
 * Pure rules here; the endpoint and the places it is applied are exercised
 * against a database in routes/matchWindow.test.ts.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("./claimMatchStorage", () => ({
  deleteClaimSegment: vi.fn(),
  readClaimSegment: vi.fn(),
  readCompressedClaimSegment: vi.fn(),
  writeClaimSegment: vi.fn(),
}));

vi.mock("./clerkUserBridge", () => ({
  getLocalAccountUserId: vi.fn(),
  getLocalUserId: vi.fn(),
  unauthenticatedResponse: vi.fn(),
}));

import {
  clipPartsToMatchWindow,
  clipRangeToMatchWindow,
  framesTouchMatchWindow,
  matchWindowSeconds,
  offPitchWithMatchWindow,
  outsideMatchWindowSpans,
  readMatchWindow,
} from "./matchWindow";
import { deriveChainClaimState, type ChainClaimSegment } from "./claimChainState";
import { matchWindowForReplacement, rosterInsideMatchWindow, sanitizeUploadedProvenance } from "../routes/claimMatch";

const FPS = 10;
const plain = { frameRate: FPS, duration: 7200 };
const withWindow = (startSeconds: number, endSeconds: number | null = null, source = "admin") => ({
  ...plain,
  provenance: { bundleFingerprint: "abc", matchWindow: { startSeconds, endSeconds, source } },
});

describe("reading the window", () => {
  it("is null when none is set, so every existing recording behaves as before", () => {
    expect(readMatchWindow(plain)).toBeNull();
    expect(matchWindowSeconds(plain)).toBe(7200);
    expect(outsideMatchWindowSpans(plain)).toEqual([]);
    expect(clipRangeToMatchWindow(10, 20, plain)).toEqual({ fromSeconds: 10, toSeconds: 20 });
  });

  it("resolves an open end to the end of the recording", () => {
    expect(readMatchWindow(withWindow(1460))).toMatchObject({ startSeconds: 1460, endSeconds: 7200, source: "admin" });
    expect(matchWindowSeconds(withWindow(1460))).toBe(7200 - 1460);
  });

  it("ignores a malformed or impossible window rather than hiding the whole match", () => {
    for (const bad of [
      { startSeconds: -1 },
      { startSeconds: "1460" },
      { startSeconds: 100, endSeconds: 50 },
      { startSeconds: 8000 },
      "1460",
    ]) {
      expect(readMatchWindow({ ...plain, provenance: { matchWindow: bad } }), JSON.stringify(bad)).toBeNull();
    }
  });

  it("clamps an end past the footage to the footage", () => {
    expect(readMatchWindow(withWindow(100, 9000))?.endSeconds).toBe(7200);
  });

  it("treats a window covering the whole recording as no window", () => {
    expect(readMatchWindow(withWindow(0, 7200))).toBeNull();
  });
});

describe("clipping", () => {
  const m = withWindow(1460, 6000);

  it("clips a booking's share, and drops one that lies outside the window", () => {
    expect(clipRangeToMatchWindow(0, 3600, m)).toEqual({ fromSeconds: 1460, toSeconds: 3600 });
    expect(clipRangeToMatchWindow(0, 600, m)).toBeNull();
    expect(clipRangeToMatchWindow(6500, 7200, m)).toBeNull();
  });

  it("clips claimed parts to the window's frames", () => {
    const parts = [
      { trackId: "warmup", fromFrame: 0, toFrame: 10_000 },
      { trackId: "straddle", fromFrame: 14_000, toFrame: 15_000 },
      { trackId: "after", fromFrame: 61_000, toFrame: 62_000 },
    ];
    expect(clipPartsToMatchWindow(parts, m)).toEqual([
      { trackId: "straddle", fromFrame: 14_600, toFrame: 15_000 },
    ]);
    expect(clipPartsToMatchWindow(parts, plain)).toEqual(parts);
  });

  it("keeps a track that straddles the start, drops one wholly before it", () => {
    expect(framesTouchMatchWindow(14_000, 15_000, m)).toBe(true);
    expect(framesTouchMatchWindow(0, 10_000, m)).toBe(false);
  });

  it("adds the outside of the window to off-pitch time without double counting", () => {
    const offPitch = [{ fromSeconds: 1000, toSeconds: 2000 }, { fromSeconds: 3000, toSeconds: 3100 }];
    const merged = offPitchWithMatchWindow(offPitch, m);
    expect(merged).toEqual([
      { fromSeconds: 0, toSeconds: 2000 },
      { fromSeconds: 3000, toSeconds: 3100 },
      { fromSeconds: 6000, toSeconds: 7200 },
    ]);
    // Idempotent: the route applies it, then deriveChainClaimState applies it again.
    expect(offPitchWithMatchWindow(merged, m)).toEqual(merged);
    // Without a window the claimant's own spans pass through untouched.
    expect(offPitchWithMatchWindow(offPitch, plain)).toEqual(offPitch);
  });
});

describe("what a claim is worth inside a window", () => {
  const segments: ChainClaimSegment[] = [{
    tracks: [{ id: "A" }],
    events: [
      { type: "goal", time: 600, label: "the other group's goal" },
      { type: "shot", time: 1000 },
      { type: "goal", time: 3000, label: "a goal in this match" },
    ],
  }];
  const part = (fromSeconds: number, toSeconds: number) => ({
    trackId: "A",
    fromFrame: Math.round(fromSeconds * FPS),
    toFrame: Math.round(toSeconds * FPS) - 1,
  });

  it("earns no clip for an event outside the window, even while claimed", () => {
    const chain = [part(0, 7200)];
    const before = deriveChainClaimState(plain, segments, chain, { hasOpenQuestion: false });
    expect(before.earnedClips.map((clip) => clip.momentSeconds)).toEqual([600, 1000, 3000]);
    const after = deriveChainClaimState(withWindow(1460), segments, chain, { hasOpenQuestion: false });
    expect(after.earnedClips.map((clip) => clip.momentSeconds)).toEqual([3000]);
    expect(after.matchedEvents).toBe(1);
    // Followed for the whole window: all of the match, none of the overrun.
    expect(after.coverageSeconds).toBeCloseTo(7200 - 1460, 0);
    expect(after.coveragePercent).toBe(100);
  });

  it("measures coverage against the window, so a 95-minute match in 2 hours can complete", () => {
    // Played the whole 95-minute match: 5700 s of a 7200 s recording is 79%,
    // but a chain that covered 60 of the 95 minutes (63% of the window) is
    // only 50% of the recording and could never reach the 60% bar.
    const m = withWindow(1500);
    const sixtyMinutes = [part(1500, 1500 + 3600)];
    const without = deriveChainClaimState(plain, segments, sixtyMinutes, { hasOpenQuestion: false });
    expect(without.coveragePercent).toBe(50);
    expect(without.completed).toBe(false);
    const inside = deriveChainClaimState(m, segments, sixtyMinutes, { hasOpenQuestion: false });
    expect(inside.coveragePercent).toBeCloseTo((3600 / 5700) * 100, 1);
    expect(inside.completed).toBe(true);
  });

  it("counts a claimant's declared bench time inside the window once", () => {
    const m = withWindow(1460);
    const state = deriveChainClaimState(m, segments, [part(1460, 7200)], {
      // Declared off-pitch through the warm-up and ten minutes of the match.
      offPitch: [{ fromSeconds: 1000, toSeconds: 2060 }],
      hasOpenQuestion: false,
    });
    // Denominator: the window less the 600 s of bench inside it.
    expect(state.coveragePercent).toBe(100);
    expect(state.coverageSeconds).toBeCloseTo(7200 - 2060, 0);
  });
});

describe("bundle upload and replacement", () => {
  it("carries a detector window through upload sanitising, tagged as the detector's", () => {
    expect(sanitizeUploadedProvenance({
      linker: "relink2.py",
      matchWindow: { startSeconds: 1460, endSeconds: null, source: "admin", setBy: 1, why: "kick-off burst" },
    })).toEqual({
      linker: "relink2.py",
      matchWindow: { startSeconds: 1460, endSeconds: null, source: "detector", why: "kick-off burst" },
    });
    // A malformed one is dropped like any other nested structure.
    expect(sanitizeUploadedProvenance({ linker: "x", matchWindow: { startSeconds: "soon" } })).toEqual({ linker: "x" });
  });

  it("keeps the new bundle's own window over the old one", () => {
    expect(matchWindowForReplacement(
      { startSeconds: 1200, source: "detector" },
      { startSeconds: 1460, source: "admin", setBy: 7 },
      7200,
    )).toMatchObject({ startSeconds: 1200, source: "detector" });
  });

  it("carries an admin window over when the new bundle has none", () => {
    expect(matchWindowForReplacement(undefined, { startSeconds: 1460, endSeconds: null, source: "admin", setBy: 7 }, 7200))
      .toMatchObject({ startSeconds: 1460, source: "admin", setBy: 7 });
  });

  it("does not carry an old detector window, or one the new footage is too short for", () => {
    expect(matchWindowForReplacement(undefined, { startSeconds: 1460, source: "detector" }, 7200)).toBeNull();
    expect(matchWindowForReplacement(undefined, { startSeconds: 1460, source: "admin" }, 1000)).toBeNull();
    expect(matchWindowForReplacement(undefined, { startSeconds: 100, endSeconds: 5000, source: "admin" }, 3000))
      .toMatchObject({ startSeconds: 100, endSeconds: 3000 });
  });
});

describe("the claim flow's roster", () => {
  const part = (trackId: string, fromFrame: number, toFrame: number) => ({ segmentIndex: 0, segmentName: "s", trackId, fromFrame, toFrame });
  const roster = {
    v: 1 as const,
    players: [
      { id: "overrun", name: null, number: "7", minutes: 15, parts: [part("a", 0, 10_000)] },
      { id: "straddles", name: null, number: "9", minutes: 40, parts: [part("b", 0, 10_000), part("c", 14_000, 40_000)] },
      { id: "ours", name: null, number: "4", minutes: 60, parts: [part("d", 20_000, 60_000)] },
    ],
  };

  it("does not offer tracks that lie entirely outside the window", () => {
    const kept = rosterInsideMatchWindow(roster, withWindow(1460) as never);
    expect(kept.players.map((p) => [p.id, p.parts.map((x) => x.trackId)])).toEqual([
      ["straddles", ["c"]],
      ["ours", ["d"]],
    ]);
  });

  it("is the roster unchanged without a window", () => {
    expect(rosterInsideMatchWindow(roster, plain as never)).toBe(roster);
  });
});
