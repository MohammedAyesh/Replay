import { describe, expect, it } from "vitest";
import type { ClaimChain } from "@workspace/api-client-react";
import type { ClaimBundle } from "./claim-match-engine";
import {
  candidatesAtFrame,
  canConfirmAtStop,
  chainEndFrame,
  chainSpans,
  chainStartFrame,
  followedTrack,
  partAtFrame,
  questionFor,
  reachedStop,
  resumeSecondsAfter,
  stageFor,
  stopFrame,
  stopSeconds,
} from "./claim-chain-flow";

const FPS = 25;

function boxes(from: number, to: number, x0: number) {
  return Array.from({ length: to - from + 1 }, (_, i) => ({
    frame: from + i,
    x: x0 + i,
    y: 100,
    w: 20,
    h: 40,
  }));
}

const bundle = {
  version: 1,
  label: "flow",
  width: 1920,
  height: 1080,
  frameRate: FPS,
  frameCount: 200,
  duration: 8,
  matchOffset: 0,
  videoStartSeconds: 0,
  tracks: [
    { id: "t1", label: null, startFrame: 0, endFrame: 99, boxes: boxes(0, 99, 500) },
    { id: "t2", label: null, startFrame: 0, endFrame: 199, boxes: boxes(0, 199, 100) },
    { id: "t3", label: "Keeper", startFrame: 100, endFrame: 199, boxes: boxes(100, 199, 900) },
  ],
  crossings: [],
  inPlaySpans: [],
  events: [],
} as ClaimBundle;

function chainOf(overrides: Partial<ClaimChain> = {}): ClaimChain {
  return {
    recordingId: 1,
    identityId: "claim:abc",
    name: "Mohammed",
    bundleFingerprint: "fp",
    frameRate: FPS,
    chain: [{ trackId: "t1", fromFrame: 10, toFrame: 99 }],
    coverageSeconds: 3.6,
    coveragePercent: 45,
    nextUncertainty: null,
    labelRecorded: null,
    ...overrides,
  } as ClaimChain;
}

const trackEnd = {
  kind: "track-end" as const,
  frame: 99,
  trackId: "t1",
  confidence: 1,
  reason: "We lost you here — the tracker stopped following this player.",
};

const swap = {
  kind: "swap" as const,
  frame: 50,
  trackId: "t1",
  otherTrackId: "t2",
  confidence: 0.7,
  reason: "Another player crossed here and the movement afterwards fits them better than you.",
};

describe("where the chain is", () => {
  it("finds the part covering a frame, and nothing outside it", () => {
    const parts = chainOf().chain;
    expect(partAtFrame(parts, 50)?.trackId).toBe("t1");
    expect(partAtFrame(parts, 5)).toBeNull();
    expect(partAtFrame(parts, 120)).toBeNull();
  });

  it("reports its ends", () => {
    const parts = [
      { trackId: "t1", fromFrame: 10, toFrame: 99 },
      { trackId: "t3", fromFrame: 100, toFrame: 150 },
    ];
    expect(chainStartFrame(parts)).toBe(10);
    expect(chainEndFrame(parts)).toBe(150);
    expect(chainStartFrame([])).toBeNull();
    expect(chainEndFrame([])).toBeNull();
  });
});

describe("the stop", () => {
  it("has none when there is nothing left to ask — that is a finished claim", () => {
    const chain = chainOf();
    expect(stopFrame(chain)).toBeNull();
    expect(stopSeconds(chain)).toBeNull();
    expect(reachedStop(chain, 999)).toBe(false);
  });

  it("converts the uncertainty frame to tracking seconds", () => {
    expect(stopSeconds(chainOf({ nextUncertainty: swap }))).toBeCloseTo(2);
  });

  it("triggers on reaching it and on sailing past it", () => {
    // timeupdate fires every ~250ms and a seek jumps outright, so an exact
    // comparison would let playback run on past the question.
    const chain = chainOf({ nextUncertainty: swap });
    expect(reachedStop(chain, 1.9)).toBe(false);
    expect(reachedStop(chain, 2)).toBe(true);
    expect(reachedStop(chain, 7.5)).toBe(true);
  });

  it("resumes one frame past the stop so the same question cannot repeat", () => {
    const chain = chainOf({ nextUncertainty: swap });
    const resume = resumeSecondsAfter(chain, swap.frame);
    expect(resume).toBeCloseTo(51 / FPS);
    expect(reachedStop(chain, resume)).toBe(true); // still past THIS stop...
    expect(resume).toBeGreaterThan(stopSeconds(chain)!); // ...but strictly beyond it
  });
});

describe("stages", () => {
  it("starts at identify with no chain at all", () => {
    expect(stageFor(null, true)).toBe("identify");
    expect(stageFor(chainOf({ chain: [] }), true)).toBe("identify");
  });

  it("follows once something is claimed and the question is answered", () => {
    expect(stageFor(chainOf(), true)).toBe("following");
  });

  it("asks while a question is outstanding", () => {
    expect(stageFor(chainOf({ nextUncertainty: swap }), false)).toBe("asking");
  });
});

describe("what we may ask at the stop", () => {
  it("offers 'still me' at a swap, where there is something to confirm", () => {
    expect(canConfirmAtStop(chainOf({ nextUncertainty: swap }))).toBe(true);
  });

  it("does not at a track end — the person we were following is gone", () => {
    // A confirm on a track with no future is a label that teaches nothing.
    expect(canConfirmAtStop(chainOf({ nextUncertainty: trackEnd }))).toBe(false);
    expect(canConfirmAtStop(chainOf())).toBe(false);
  });

  it("gives the server's plain sentence, never a code", () => {
    expect(questionFor(chainOf({ nextUncertainty: trackEnd }))).toContain("We lost you here");
    expect(questionFor(chainOf())).toBeNull();
  });
});

describe("candidates", () => {
  it("offers every player detected at the frame, left to right", () => {
    const found = candidatesAtFrame(bundle, chainOf(), 50);
    expect(found.map((candidate) => candidate.id)).toEqual(["t2", "t1"]);
  });

  it("marks the one the chain is following, by the claimant's own name", () => {
    const found = candidatesAtFrame(bundle, chainOf(), 50);
    expect(found.find((candidate) => candidate.mine)?.id).toBe("t1");
    expect(found.find((candidate) => candidate.mine)?.label).toBe("Mohammed");
  });

  it("marks the other party to the crossing that stopped us", () => {
    const found = candidatesAtFrame(bundle, chainOf({ nextUncertainty: swap }), 50);
    expect(found.find((candidate) => candidate.suspect)?.id).toBe("t2");
  });

  it("offers everyone, not just the detector's two — its misses must be recoverable", () => {
    const found = candidatesAtFrame(bundle, chainOf({ nextUncertainty: swap }), 120);
    expect(found.map((candidate) => candidate.id)).toEqual(["t2", "t3"]);
  });

  it("marks nobody as mine outside the claimed stretch", () => {
    expect(candidatesAtFrame(bundle, chainOf(), 5).some((candidate) => candidate.mine)).toBe(false);
  });

  it("copes with no chain at all, which is the first thing it is asked to do", () => {
    const found = candidatesAtFrame(bundle, null, 50);
    expect(found).toHaveLength(2);
    expect(found.every((candidate) => !candidate.mine && !candidate.suspect)).toBe(true);
  });
});

describe("following the right track", () => {
  it("resolves the chain part to a real track", () => {
    expect(followedTrack(bundle, chainOf().chain, 50)?.id).toBe("t1");
  });

  it("is null outside the chain, and for a track the bundle does not have", () => {
    expect(followedTrack(bundle, chainOf().chain, 5)).toBeNull();
    expect(followedTrack(bundle, [{ trackId: "gone", fromFrame: 0, toFrame: 99 }], 5)).toBeNull();
  });
});

describe("claimed stretches on the seek bar", () => {
  it("merges touching parts into one band", () => {
    expect(chainSpans([
      { trackId: "t1", fromFrame: 0, toFrame: 49 },
      { trackId: "t2", fromFrame: 50, toFrame: 99 },
    ], FPS)).toEqual([{ fromSeconds: 0, toSeconds: 4 }]);
  });

  it("keeps a real gap visible", () => {
    const spans = chainSpans([
      { trackId: "t1", fromFrame: 0, toFrame: 24 },
      { trackId: "t2", fromFrame: 75, toFrame: 99 },
    ], FPS);
    expect(spans).toHaveLength(2);
    expect(spans[1].fromSeconds).toBe(3);
  });

  it("is empty for an empty chain", () => {
    expect(chainSpans([], FPS)).toEqual([]);
  });
});
