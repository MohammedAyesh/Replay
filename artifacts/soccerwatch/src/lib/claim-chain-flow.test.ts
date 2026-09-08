import { describe, expect, it } from "vitest";
import type { ClaimChain } from "@workspace/api-client-react";
import type { ClaimBundle } from "./claim-match-engine";
import {
  candidatesAtFrame,
  canConfirmAtStop,
  chainEndFrame,
  chainSpans,
  chainStartFrame,
  crossedStop,
  followedTrack,
  gapsIn,
  leadInSeconds,
  nextQuestionAfter,
  openQuestions,
  partAtFrame,
  questionFor,
  questionsBehind,
  approachSeconds,
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
  const nextUncertainty = overrides.nextUncertainty ?? null;
  return {
    recordingId: 1,
    identityId: "claim:abc",
    name: "Mohammed",
    bundleFingerprint: "fp",
    frameRate: FPS,
    chain: [{ trackId: "t1", fromFrame: 10, toFrame: 99 }],
    coverageSeconds: 3.6,
    coveragePercent: 45,
    nextUncertainty,
    // The server sends the whole list; the earliest is also `nextUncertainty`.
    openQuestions: nextUncertainty ? [nextUncertainty] : [],
    completed: false,
    requiredCoveragePercent: 60,
    labelRecorded: null,
    resetByAdmin: false,
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
    expect(crossedStop(chain, 0, 999)).toBeNull();
  });

  it("converts the uncertainty frame to tracking seconds", () => {
    expect(stopSeconds(chainOf({ nextUncertainty: swap }))).toBeCloseTo(2);
  });

  it("fires when playback crosses it, wherever the next frame report lands", () => {
    // Frame reports can land anywhere past the question, so the test is
    // "was it before, is it at or past now" -- never equality.
    const chain = chainOf({ nextUncertainty: swap });
    expect(crossedStop(chain, 48, 49)).toBeNull();
    expect(crossedStop(chain, 49, 50)).toEqual(swap);
    expect(crossedStop(chain, 40, 70)).toEqual(swap);
  });

  it("does NOT fire on a question already behind the playhead", () => {
    // A seek that lands past the question, a refetch that returns a moment
    // already dealt with, an undo that reopens one, a fill that leaves one
    // behind: all of these used to fire instantly and wedge the page into
    // play-pause-play-pause on a moment minutes back.
    const chain = chainOf({ nextUncertainty: swap });
    expect(crossedStop(chain, 60, 61)).toBeNull();
    expect(crossedStop(chain, 50, 51)).toBeNull();
    // Nor when playback is not moving forward at all.
    expect(crossedStop(chain, 70, 40)).toBeNull();
    expect(crossedStop(chain, 50, 50)).toBeNull();
  });

  it("stops at the next question AHEAD, not the earliest one", () => {
    const later = { ...trackEnd, frame: 99 };
    const chain = chainOf({ nextUncertainty: swap, openQuestions: [swap, later] });
    expect(nextQuestionAfter(chain, 50)?.frame).toBe(99);
    expect(nextQuestionAfter(chain, 10)?.frame).toBe(50);
    expect(nextQuestionAfter(chain, 99)).toBeNull();
    expect(questionsBehind(chain, 50).map((q) => q.frame)).toEqual([50]);
    expect(questionsBehind(chain, 120).map((q) => q.frame)).toEqual([50, 99]);
    expect(crossedStop(chain, 60, 100)).toEqual(later);
    expect(stopFrame(chain, 50)).toBe(99);
  });

  it("reads a server that sends only nextUncertainty as a list of one", () => {
    const old = chainOf({ nextUncertainty: swap });
    delete (old as Partial<ClaimChain>).openQuestions;
    expect(openQuestions(old)).toEqual([swap]);
    expect(openQuestions(null)).toEqual([]);
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
    expect(stageFor(null, 50, true)).toBe("identify");
    expect(stageFor(chainOf({ chain: [] }), 50, true)).toBe("identify");
  });

  it("follows once something is claimed and the question is answered", () => {
    expect(stageFor(chainOf(), 50, true)).toBe("following");
  });

  it("asks while a question is outstanding", () => {
    expect(stageFor(chainOf({ nextUncertainty: swap }), 50, false)).toBe("asking");
  });

  it("goes back to looking for you wherever the chain does not reach", () => {
    // The state right after "not me from here", after an undo, and any time
    // the person scrubs back to a stretch they never claimed. Deciding this
    // from a flag left the panel saying "following you" over footage nobody
    // was following anyone in.
    expect(stageFor(chainOf(), 5, true)).toBe("identify");
    expect(stageFor(chainOf(), 150, true)).toBe("identify");
  });

  it("still asks an outstanding question even outside the chain", () => {
    // The question is about the stretch just left behind; losing it because
    // playback drifted a frame past the part would drop the answer silently.
    expect(stageFor(chainOf({ nextUncertainty: swap }), 5, false)).toBe("asking");
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
    // The page asks about the question it stopped on, which need not be the
    // earliest one once a fill has left questions behind.
    expect(questionFor(swap)).toContain("crossed here");
    expect(canConfirmAtStop(swap)).toBe(true);
    expect(canConfirmAtStop(trackEnd)).toBe(false);
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
    // ...for the question actually being asked, not always the earliest.
    const byQuestion = candidatesAtFrame(bundle, chainOf({ nextUncertainty: trackEnd }), 50, 2, swap);
    expect(byQuestion.find((candidate) => candidate.suspect)?.id).toBe("t2");
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

describe("the next check is always ahead, never behind", () => {
  it("jumps to just before the next question ahead of the playhead", () => {
    const later = { ...trackEnd, frame: 99 };
    const chain = chainOf({ nextUncertainty: swap, openQuestions: [swap, later] });
    // At 0 s the next question is the swap at frame 50 (2 s): inside the
    // run-up, so nothing to jump to. Past it, the track end at 99 (3.96 s) is
    // next -- and still inside the run-up from 2.1 s.
    expect(approachSeconds(chain, 0)).toBeNull();
    expect(approachSeconds(chain, 2.1)).toBeNull();
    const far = { ...trackEnd, frame: 175 };
    const long = chainOf({ nextUncertainty: swap, openQuestions: [swap, far] });
    expect(approachSeconds(long, 2.1)).toBeCloseTo(175 / FPS - 4, 5);
  });

  it("never seeks backwards to a question behind the playhead", () => {
    // Those are listed and gone to on purpose, with the same run-up.
    const chain = chainOf({ nextUncertainty: swap });
    expect(approachSeconds(chain, 100)).toBeNull();
    expect(leadInSeconds(chain, swap.frame)).toBeCloseTo(50 / FPS - 4 < 0 ? 0 : 50 / FPS - 4, 5);
    expect(leadInSeconds(chain, 175)).toBeCloseTo(175 / FPS - 4, 5);
  });
});

describe("the holes in the claim", () => {
  it("lists every unclaimed stretch, including before the first tap and after the last part", () => {
    const parts = [
      { trackId: "t1", fromFrame: 50, toFrame: 99 },   // 2 s .. 4 s
      { trackId: "t2", fromFrame: 150, toFrame: 174 }, // 6 s .. 7 s
    ];
    expect(gapsIn(parts, FPS, 8)).toEqual([
      { fromSeconds: 0, toSeconds: 2 },
      { fromSeconds: 4, toSeconds: 6 },
      { fromSeconds: 7, toSeconds: 8 },
    ]);
  });

  it("ignores holes too short to be worth a trip", () => {
    const parts = [
      { trackId: "t1", fromFrame: 0, toFrame: 99 },
      { trackId: "t1", fromFrame: 110, toFrame: 199 }, // 0.4 s hole: a detection drop-out
    ];
    expect(gapsIn(parts, FPS, 8)).toEqual([]);
  });

  it("is the whole recording for an empty chain, and nothing for a full one", () => {
    expect(gapsIn([], FPS, 8)).toEqual([{ fromSeconds: 0, toSeconds: 8 }]);
    expect(gapsIn([{ trackId: "t1", fromFrame: 0, toFrame: 199 }], FPS, 8)).toEqual([]);
  });
});
