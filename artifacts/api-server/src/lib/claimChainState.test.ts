import { describe, expect, it } from "vitest";
import {
  CHAIN_COMPLETION,
  clipsForIntervals,
  deriveChainClaimState,
  type ChainClaimSegment,
} from "./claimChainState";
import type { ChainPart } from "./claimChain";

const manifest = { frameRate: 25, duration: 600 };

const segments: ChainClaimSegment[] = [{
  tracks: [{ id: "A" }, { id: "B" }, { id: "C" }],
  events: [
    { type: "kickoff", time: 0, label: "Kick off" },
    { type: "goal", time: 100, label: "Goal" },
    { type: "shot", time: 250 },
    { type: "goal", time: 500, label: "Late goal" },
    { type: "corner", time: 120 },
  ],
}];

/** Frames 0..N at 25fps: part {0, 2499} is 0-100s. */
function part(trackId: string, fromSeconds: number, toSeconds: number): ChainPart {
  return {
    trackId,
    fromFrame: Math.round(fromSeconds * 25),
    toFrame: Math.round(toSeconds * 25) - 1,
  };
}

describe("what a chain earns", () => {
  it("awards a clip for every scoreable event inside the claimed stretch", () => {
    const state = deriveChainClaimState(manifest, segments, [part("A", 0, 300)], {
      hasOpenQuestion: false,
    });
    // The 500s goal is outside; the corner is not a clip event at all.
    expect(state.earnedClips.map((clip) => clip.momentSeconds)).toEqual([0, 100, 250]);
  });

  it("awards a goal that falls nowhere near a checkpoint", () => {
    // The whole point of the change: the anchor flow needed the event within
    // twelve seconds of an answered checkpoint, so a goal between checkpoints
    // earned nothing however plainly the player was on the pitch for it.
    const state = deriveChainClaimState(manifest, segments, [part("A", 95, 110)], {
      hasOpenQuestion: false,
    });
    expect(state.earnedClips.map((clip) => clip.kind)).toEqual(["goal"]);
  });

  it("awards nothing for a stretch the person did not claim", () => {
    const state = deriveChainClaimState(manifest, segments, [part("A", 300, 400)], {
      hasOpenQuestion: false,
    });
    expect(state.earnedClips).toEqual([]);
  });

  it("keeps the anchor flow's clip ids so a re-claim does not duplicate them", () => {
    expect(clipsForIntervals(segments, [{ startSeconds: 0, endSeconds: 600 }])
      .map((clip) => clip.id))
      .toEqual(["claim-kickoff-0", "claim-goal-100", "claim-shot-250", "claim-goal-500"]);
  });

  it("prefers a real clip id when the event carries one", () => {
    const withClipId: ChainClaimSegment[] = [{
      tracks: [{ id: "A" }],
      events: [{ type: "goal", time: 10, clipId: "bunny-guid-1" }],
    }];
    expect(clipsForIntervals(withClipId, [{ startSeconds: 0, endSeconds: 600 }])[0].id)
      .toBe("bunny-guid-1");
  });
});

describe("coverage", () => {
  it("counts only the seconds actually claimed", () => {
    const state = deriveChainClaimState(manifest, segments, [part("A", 0, 300)], {
      hasOpenQuestion: false,
    });
    expect(state.coverageSeconds).toBeCloseTo(300, 1);
    expect(state.coveragePercent).toBeCloseTo(50, 1);
  });

  it("removes declared off-pitch time from both the claim and the denominator", () => {
    // Otherwise a substitute is permanently punished for the half they were
    // not playing in.
    const state = deriveChainClaimState(manifest, segments, [part("A", 0, 300)], {
      hasOpenQuestion: false,
      offPitch: [{ fromSeconds: 300, toSeconds: 600 }],
    });
    expect(state.coverageSeconds).toBeCloseTo(300, 1);
    expect(state.coveragePercent).toBeCloseTo(100, 1);
  });

  it("treats every claimed second as vouched, because it was watched", () => {
    const chain = [part("A", 0, 100), part("B", 100, 300)];
    const state = deriveChainClaimState(manifest, segments, chain, { hasOpenQuestion: false });
    expect(state.vouchedFragments).toEqual(chain);
  });
});

describe("completion", () => {
  it("completes once enough of the match is claimed and nothing is outstanding", () => {
    const state = deriveChainClaimState(manifest, segments, [part("A", 0, 400)], {
      hasOpenQuestion: false,
    });
    expect(state.coveragePercent).toBeGreaterThanOrEqual(CHAIN_COMPLETION.requiredCoveragePercent);
    expect(state.completed).toBe(true);
  });

  it("refuses while a question is still waiting for an answer", () => {
    // Awarding the match on the strength of a claim we are actively querying
    // would settle the question by ignoring it.
    const state = deriveChainClaimState(manifest, segments, [part("A", 0, 400)], {
      hasOpenQuestion: true,
    });
    expect(state.completed).toBe(false);
    expect(state.completionReason).toContain("waiting for an answer");
  });

  it("refuses below the bar, and says what the bar is", () => {
    const state = deriveChainClaimState(manifest, segments, [part("A", 0, 100)], {
      hasOpenQuestion: false,
    });
    expect(state.completed).toBe(false);
    expect(state.completionReason).toContain("60%");
  });

  it("uses the gentler bar on a short recording", () => {
    const short = { frameRate: 25, duration: 100 };
    const state = deriveChainClaimState(short, segments, [part("A", 0, 56)], {
      hasOpenQuestion: false,
    });
    expect(state.completed).toBe(true);
  });

  it("is not complete with nothing claimed", () => {
    const state = deriveChainClaimState(manifest, segments, [], { hasOpenQuestion: false });
    expect(state.completed).toBe(false);
    expect(state.coveragePercent).toBe(0);
  });
});

describe("segment and event counts", () => {
  it("counts the segments the claimed tracks appear in", () => {
    expect(deriveChainClaimState(manifest, segments, [part("A", 0, 300)], {
      hasOpenQuestion: false,
    }).trackedSegments).toBe(1);
    expect(deriveChainClaimState(manifest, segments, [part("ghost", 0, 300)], {
      hasOpenQuestion: false,
    }).trackedSegments).toBe(0);
  });

  it("counts every event inside the claim, not only the scoreable ones", () => {
    const state = deriveChainClaimState(manifest, segments, [part("A", 0, 300)], {
      hasOpenQuestion: false,
    });
    // kickoff, goal, corner, shot — the corner counts here but earns no clip.
    expect(state.matchedEvents).toBe(4);
    expect(state.earnedClips).toHaveLength(3);
  });
});
