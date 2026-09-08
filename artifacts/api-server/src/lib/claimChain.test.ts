/**
 * The interrupt rule is the whole feature, so it is tested against geometry
 * that is constructed to have one right answer rather than against a fixture
 * whose behaviour we inferred.
 *
 * The recurring scene: two players approaching each other along y = 500, one
 * moving right at 5 px/frame and one moving left at 5 px/frame, meeting at
 * frame 30. What differs between tests is only what happens AFTER frame 30 —
 * which is exactly the question a swap detector has to answer.
 */
import { describe, expect, it } from "vitest";
import type { TrackingSegmentPayload } from "@workspace/db";

import {
  CHAIN_TUNING,
  chainIntervals,
  cutChain,
  dropLastDecision,
  dropLastPart,
  extendChain,
  identityOwning,
  isStruckOff,
  markAnswered,
  nextUncertainty,
  normaliseChain,
  openUncertainties,
  scanFloor,
  survivingRanges,
  swapEvidence,
  truncateChain,
  totalSeconds,
  withMarks,
  type ChainIdentity,
  type ChainPart,
  type IdentityDecision,
} from "./claimChain";

type Track = TrackingSegmentPayload["tracks"][number];

/** A track whose box at each frame is produced by `at`. */
function track(
  id: string,
  fromFrame: number,
  toFrame: number,
  at: (frame: number) => { x: number; y: number; w?: number; h?: number },
  step = 1,
): Track {
  const boxes = [];
  for (let f = fromFrame; f <= toFrame; f += step) {
    const p = at(f);
    boxes.push({ frame: f, x: p.x, y: p.y, w: p.w ?? 30, h: p.h ?? 80 });
  }
  return { id, startFrame: fromFrame, endFrame: boxes[boxes.length - 1].frame, boxes };
}

const CROSS = 30;

/** Rightward mover; after the crossing it either continues or takes B's path. */
function playerA(swapped: boolean, height = 80): Track {
  return track("A", 0, 60, (f) =>
    f <= CROSS
      ? { x: 100 + 5 * f, y: 500, h: height }
      : swapped
        ? { x: 250 - 5 * (f - CROSS), y: 500, h: height }
        : { x: 250 + 5 * (f - CROSS), y: 500, h: height });
}

/** Leftward mover; the mirror image. */
function playerB(swapped: boolean, height = 80): Track {
  return track("B", 0, 60, (f) =>
    f <= CROSS
      ? { x: 400 - 5 * f, y: 500, h: height }
      : swapped
        ? { x: 250 + 5 * (f - CROSS), y: 500, h: height }
        : { x: 250 - 5 * (f - CROSS), y: 500, h: height });
}

function byId(...tracks: Track[]) {
  return new Map(tracks.map((t) => [t.id, t]));
}

/**
 * A part as a tap at `tap` writes it: stamped, and answered through the tap
 * itself (a tap answers its own frame, nothing past it).
 */
function claimed(trackId: string, fromFrame: number, toFrame: number, tap: number): ChainPart {
  return {
    trackId, fromFrame, toFrame, tapFrame: tap,
    reviewedThrough: Math.min(Math.max(tap + 1, fromFrame), toFrame + 1),
  };
}

const crossing = (confidence?: number) => ([{
  frame: CROSS, trackId: "A", otherTrackId: "B", ...(confidence === undefined ? {} : { confidence }),
}] as TrackingSegmentPayload["crossings"]);

const manifest = { frameRate: 20, duration: 10 };

/* ================================================================== */

describe("swapEvidence", () => {
  it("is strongly negative when both players continue straight through", () => {
    const evidence = swapEvidence(playerA(false), playerB(false), CROSS);
    expect(evidence).not.toBeNull();
    expect(evidence!).toBeLessThan(0);
  });

  it("is strongly positive when the two trajectories are exchanged", () => {
    const evidence = swapEvidence(playerA(true), playerB(true), CROSS);
    expect(evidence).not.toBeNull();
    expect(evidence!).toBeGreaterThan(CHAIN_TUNING.swapMarginPx);
  });

  it("cancels a shared wobble instead of reading it as a swap", () => {
    // Both players slow down through the crossing — every track does this.
    // It raises both hypotheses equally, so the difference must stay negative.
    const slowA = track("A", 0, 60, (f) =>
      f <= CROSS ? { x: 100 + 5 * f, y: 500 } : { x: 250 + 2 * (f - CROSS), y: 500 });
    const slowB = track("B", 0, 60, (f) =>
      f <= CROSS ? { x: 400 - 5 * f, y: 500 } : { x: 250 - 2 * (f - CROSS), y: 500 });
    expect(swapEvidence(slowA, slowB, CROSS)!).toBeLessThan(0);
  });

  it("returns null rather than guessing when a trajectory cannot be measured", () => {
    const stub = track("B", CROSS, CROSS, () => ({ x: 250, y: 500 }));
    expect(swapEvidence(playerA(false), stub, CROSS)).toBeNull();
  });

  it("counts a sudden change in apparent height as evidence", () => {
    // Same paths, but the box that leaves is a different size from the one
    // that arrived — a depth and build proxy for "different person".
    const shrink = track("A", 0, 60, (f) =>
      f <= CROSS ? { x: 100 + 5 * f, y: 500, h: 120 } : { x: 250 + 5 * (f - CROSS), y: 500, h: 60 });
    const grow = track("B", 0, 60, (f) =>
      f <= CROSS ? { x: 400 - 5 * f, y: 500, h: 60 } : { x: 250 - 5 * (f - CROSS), y: 500, h: 120 });
    const withHeights = swapEvidence(shrink, grow, CROSS)!;
    const withoutHeights = swapEvidence(playerA(false), playerB(false), CROSS)!;
    expect(withHeights).toBeGreaterThan(withoutHeights);
  });
});

describe("nextUncertainty", () => {
  const chain: ChainPart[] = [{ trackId: "A", fromFrame: 0, toFrame: 60 }];

  it("does NOT interrupt at a clean crossing", () => {
    // The whole point. A crossing is common; an interruption is expensive.
    const found = nextUncertainty(chain, byId(playerA(false), playerB(false)), crossing(0.9), 0);
    expect(found?.kind).toBe("track-end");
    expect(found?.frame).toBe(60);
  });

  it("interrupts at a crossing whose geometry says the identities were exchanged", () => {
    const found = nextUncertainty(chain, byId(playerA(true), playerB(true)), crossing(0.9), 0);
    expect(found?.kind).toBe("swap");
    expect(found?.frame).toBe(CROSS);
    expect(found?.otherTrackId).toBe("B");
    expect(found?.reason).toMatch(/fits them better/);
  });

  it("interrupts when the tracker itself reported low confidence, even on clean geometry", () => {
    const found = nextUncertainty(chain, byId(playerA(false), playerB(false)), crossing(0.1), 0);
    expect(found?.kind).toBe("swap");
    expect(found?.reason).toMatch(/unsure/);
  });

  it("reports the end of the chain when nothing continues it", () => {
    const found = nextUncertainty(chain, byId(playerA(false)), [], 0);
    expect(found).toEqual(expect.objectContaining({ kind: "track-end", frame: 60, confidence: 1 }));
  });

  it("does not report an end where the next part picks up", () => {
    const linked: ChainPart[] = [
      { trackId: "A", fromFrame: 0, toFrame: 30 },
      { trackId: "B", fromFrame: 31, toFrame: 60 },
    ];
    const found = nextUncertainty(linked, byId(playerA(false), playerB(false)), [], 0);
    expect(found?.frame).toBe(60);
    expect(found?.trackId).toBe("B");
  });

  it("returns the earliest uncertainty, never a later one", () => {
    const found = nextUncertainty(chain, byId(playerA(true), playerB(true)), crossing(0.9), 0);
    expect(found?.frame).toBe(CROSS);   // the swap at 30, not the end at 60
  });

  it("skips uncertainties already behind the playhead", () => {
    const found = nextUncertainty(chain, byId(playerA(true), playerB(true)), crossing(0.9), CROSS + 1);
    expect(found?.kind).toBe("track-end");
  });

  it("ignores a crossing with a player struck off on the board", () => {
    // Removing someone on the board removes them from the video — including
    // from the reasons we interrupt a claimant.
    const decisions: IdentityDecision[] = [{ trackId: "B", fromFrame: 0, toFrame: 60, action: "deleted" }];
    const found = nextUncertainty(
      chain, byId(playerA(true), playerB(true)), crossing(0.9), 0, decisions);
    expect(found?.kind).toBe("track-end");
  });
});

describe("board decisions reach the video", () => {
  it("strikes off a frame inside a decision range", () => {
    const d: IdentityDecision[] = [{ trackId: "A", fromFrame: 10, toFrame: 20, action: "deleted" }];
    expect(isStruckOff(d, "A", 15)).toBe(true);
    expect(isStruckOff(d, "A", 21)).toBe(false);
    expect(isStruckOff(d, "B", 15)).toBe(false);
    expect(isStruckOff(undefined, "A", 15)).toBe(false);
  });

  it("treats parked the same as deleted — neither is a person to claim", () => {
    const d: IdentityDecision[] = [{ trackId: "A", fromFrame: 0, toFrame: 5, action: "parked" }];
    expect(isStruckOff(d, "A", 3)).toBe(true);
  });

  it("splits a track around a decision that removes its middle", () => {
    const d: IdentityDecision[] = [{ trackId: "A", fromFrame: 20, toFrame: 29, action: "deleted" }];
    expect(survivingRanges(d, { id: "A", startFrame: 0, endFrame: 60 })).toEqual([
      { fromFrame: 0, toFrame: 19 },
      { fromFrame: 30, toFrame: 60 },
    ]);
  });

  it("returns nothing when the whole track is struck off", () => {
    const d: IdentityDecision[] = [{ trackId: "A", fromFrame: 0, toFrame: 60, action: "deleted" }];
    expect(survivingRanges(d, { id: "A", startFrame: 0, endFrame: 60 })).toEqual([]);
  });
});

describe("normaliseChain", () => {
  const tracks = byId(playerA(false), playerB(false));

  it("clamps a part to the track's real extent", () => {
    expect(normaliseChain([{ trackId: "A", fromFrame: -50, toFrame: 9999 }], tracks))
      .toEqual([{ trackId: "A", fromFrame: 0, toFrame: 60 }]);
  });

  it("drops a part whose track does not exist", () => {
    expect(normaliseChain([{ trackId: "ghost", fromFrame: 0, toFrame: 10 }], tracks)).toEqual([]);
  });

  it("merges touching parts of the same track", () => {
    expect(normaliseChain([
      { trackId: "A", fromFrame: 0, toFrame: 20 },
      { trackId: "A", fromFrame: 21, toFrame: 40 },
    ], tracks)).toEqual([{ trackId: "A", fromFrame: 0, toFrame: 40 }]);
  });

  it("keeps two different tracks separate even when they touch", () => {
    expect(normaliseChain([
      { trackId: "A", fromFrame: 0, toFrame: 20 },
      { trackId: "B", fromFrame: 21, toFrame: 40 },
    ], tracks)).toHaveLength(2);
  });
});

describe("extendChain", () => {
  const tracks = byId(playerA(false), playerB(false));

  it("claims from the tapped frame to the end of the track", () => {
    expect(extendChain([], tracks, "A", 10)).toEqual([claimed("A", 10, 60, 10)]);
  });

  it("cuts the part being corrected at the tap — a correction replaces, never doubles up", () => {
    const before: ChainPart[] = [{ trackId: "A", fromFrame: 0, toFrame: 60 }];
    expect(extendChain(before, tracks, "B", 30)).toEqual([
      // Answered up to the cut: the person has just said what happens from 30.
      { trackId: "A", fromFrame: 0, toFrame: 29, reviewedThrough: 30 },
      claimed("B", 30, 60, 30),
    ]);
  });

  it("splits at a detection gap instead of claiming across it — but claims both sides", () => {
    /*
     * The gap itself is never claimed: that is the invariant, and it is why
     * these are two parts rather than one span from 0 to 60.
     *
     * But the far side IS claimed, by this same tap. Stopping dead at the
     * first hole meant that on floodlit footage -- where the detector loses a
     * player for a second constantly -- a tap could claim a SINGLE FRAME and
     * then report "nothing left to check", while a refetch asked about the
     * very frame just tapped. Both sides carry one track id: the tracker is
     * asserting this is the same person across the hole, which is a stronger
     * claim than the two-different-tracks join `successorGapFrames` already
     * forgives. Being stricter here than there was incoherent.
     */
    const gappy = track("G", 0, 60, (f) => ({ x: f, y: 0 }), 1);
    gappy.boxes = gappy.boxes.filter((b) => b.frame <= 20 || b.frame >= 45);
    const result = extendChain([], byId(gappy), "G", 0);
    expect(result).toEqual([
      claimed("G", 0, 20, 0),
      claimed("G", 45, 60, 0),
    ]);
    // 21..44 belongs to nobody.
    const covered = chainIntervals(result, { frameRate: 1, duration: 61 });
    expect(covered).toEqual([
      { startSeconds: 0, endSeconds: 21 },
      { startSeconds: 45, endSeconds: 61 },
    ]);
  });

  it("collapses to one span when a track is too fragmented to itemise", () => {
    // Past maxPartsPerTap the split costs more than it is worth: parts live in
    // a jsonb blob rewritten under a row lock on every tap.
    const shredded = track("S", 0, 4000, (f) => ({ x: f, y: 0 }), 1);
    shredded.boxes = shredded.boxes.filter((b) => b.frame % 20 === 0);
    const result = extendChain([], byId(shredded), "S", 0);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ trackId: "S", fromFrame: 0, tapFrame: 0 });
  });

  it("stops where the board struck the track off", () => {
    const d: IdentityDecision[] = [{ trackId: "A", fromFrame: 40, toFrame: 60, action: "deleted" }];
    expect(extendChain([], tracks, "A", 0, { decisions: d })).toEqual([claimed("A", 0, 39, 0)]);
  });

  it("refuses to start on a track struck off at that frame", () => {
    const d: IdentityDecision[] = [{ trackId: "A", fromFrame: 0, toFrame: 60, action: "deleted" }];
    expect(extendChain([], tracks, "A", 10, { decisions: d })).toEqual([]);
  });

  it("ignores a tap on a track that does not exist", () => {
    expect(extendChain([], tracks, "ghost", 10)).toEqual([]);
  });

  it("drops the last link on undo", () => {
    const chain: ChainPart[] = [
      { trackId: "A", fromFrame: 0, toFrame: 29 },
      { trackId: "B", fromFrame: 30, toFrame: 60 },
    ];
    expect(dropLastPart(chain)).toEqual([{ trackId: "A", fromFrame: 0, toFrame: 29 }]);
  });

  /*
   * The bug this pins: a tap on a board-merged person adds every part of that
   * person from the tap forward, and undo removed one of them. The rest stayed
   * claimed while subtractParts had already taken those frames off whoever
   * held them, so the mis-tap was unrecoverable from the UI.
   */
  it("a board-merged tap adds many parts, so undoing one part is not enough", () => {
    const tracks = new Map([
      ["A", track("A", 0, 100, (f) => ({ x: f, y: 100 }))],
      ["B", track("B", 130, 240, (f) => ({ x: f, y: 100 }))],
      ["C", track("C", 260, 400, (f) => ({ x: f, y: 100 }))],
    ]);
    const identities = [{ id: "board:1", parts: [
      { trackId: "A", fromFrame: 0, toFrame: 100 },
      { trackId: "B", fromFrame: 130, toFrame: 240 },
      { trackId: "C", fromFrame: 260, toFrame: 400 },
    ] }];

    const after = extendChain([], tracks, "A", 10, { identities });
    expect(after.length).toBe(3);

    // Every part carries the frame of the decision that claimed it.
    expect(after.every((part) => part.tapFrame === 10)).toBe(true);

    // What undo used to do: leave two thirds of a merged person claimed.
    expect(dropLastPart(after).length).toBe(2);

    // What it does now.
    expect(dropLastDecision(after)).toEqual([]);
  });
});

describe("chainIntervals", () => {
  it("converts frames to seconds and merges what touches", () => {
    const spans = chainIntervals([
      { trackId: "A", fromFrame: 0, toFrame: 19 },
      { trackId: "B", fromFrame: 20, toFrame: 39 },
    ], manifest);
    expect(spans).toEqual([{ startSeconds: 0, endSeconds: 2 }]);
    expect(totalSeconds(spans)).toBe(2);
  });

  it("subtracts an off-pitch span from the middle of a chain", () => {
    const spans = chainIntervals(
      [{ trackId: "A", fromFrame: 0, toFrame: 199 }],
      manifest,
      [{ fromSeconds: 3, toSeconds: 5 }],
    );
    expect(spans).toEqual([
      { startSeconds: 0, endSeconds: 3 },
      { startSeconds: 5, endSeconds: 10 },
    ]);
    expect(totalSeconds(spans)).toBe(8);
  });

  it("never exceeds the recording duration", () => {
    const spans = chainIntervals([{ trackId: "A", fromFrame: 0, toFrame: 99999 }], manifest);
    expect(spans[0].endSeconds).toBe(10);
  });

  it("cannot be inflated by one tap the way the vote model could", () => {
    // A single tap covers only what it claims, not a whole track's extent
    // multiplied by every answer that voted for the same person.
    const one = chainIntervals([{ trackId: "A", fromFrame: 0, toFrame: 19 }], manifest);
    expect(totalSeconds(one)).toBe(1);
  });

  it("is empty for an empty chain", () => {
    expect(chainIntervals([], manifest)).toEqual([]);
    expect(totalSeconds([])).toBe(0);
  });
});

describe("the board's merges reach the video", () => {
  const tracks = byId(playerA(false), playerB(false));
  // The board has already decided A and B are one player.
  const identities: ChainIdentity[] = [{
    id: "person-1",
    parts: [
      { trackId: "A", fromFrame: 0, toFrame: 60 },
      { trackId: "B", fromFrame: 0, toFrame: 60 },
    ],
  }];

  it("finds the identity that owns a track at a frame", () => {
    expect(identityOwning(identities, "A", 10)?.id).toBe("person-1");
    expect(identityOwning(identities, "ghost", 10)).toBeNull();
    expect(identityOwning(undefined, "A", 10)).toBeNull();
  });

  it("a tap claims the whole PERSON, not just the piece under the cursor", () => {
    // Without this, the viewer is interrupted at the end of track A and asked
    // to identify a player the board had already joined to track B.
    const result = extendChain([], tracks, "A", 10, { identities });
    expect(result).toEqual([
      claimed("A", 10, 60, 10),
      claimed("B", 10, 60, 10),
    ]);
  });

  it("takes only the parts from the tap forward, never backwards", () => {
    const late: ChainIdentity[] = [{
      id: "person-1",
      parts: [
        { trackId: "A", fromFrame: 0, toFrame: 20 },
        { trackId: "B", fromFrame: 40, toFrame: 60 },
      ],
    }];
    // Tap while A is the visible piece; the person continues on B later.
    expect(extendChain([], tracks, "A", 10, { identities: late })).toEqual([
      claimed("A", 10, 20, 10),
      claimed("B", 40, 60, 10),
    ]);
  });

  it("drops a part of the person the board has struck off", () => {
    const decisions: IdentityDecision[] = [{ trackId: "B", fromFrame: 0, toFrame: 60, action: "deleted" }];
    expect(extendChain([], tracks, "A", 10, { identities, decisions }))
      .toEqual([claimed("A", 10, 60, 10)]);
  });

  it("falls back to the single track when no identity owns it", () => {
    expect(extendChain([], tracks, "A", 10, { identities: [] }))
      .toEqual([claimed("A", 10, 60, 10)]);
  });
});

describe("truncateChain — the human override", () => {
  const chain: ChainPart[] = [
    { trackId: "A", fromFrame: 0, toFrame: 29 },
    { trackId: "B", fromFrame: 30, toFrame: 60 },
  ];

  it("gives up everything from the stated frame onward", () => {
    // "That is not me, and has not been since here" — always available, never
    // requiring the detector to have noticed first.
    expect(truncateChain(chain, 40)).toEqual([
      { trackId: "A", fromFrame: 0, toFrame: 29 },
      { trackId: "B", fromFrame: 30, toFrame: 39 },
    ]);
  });

  it("can empty the chain entirely", () => {
    expect(truncateChain(chain, 0)).toEqual([]);
  });

  it("leaves a chain that ends before the frame alone", () => {
    expect(truncateChain(chain, 999)).toEqual(chain);
  });
});

describe("a tap on a track the person does not own at that frame", () => {
  it("claims the track alone rather than pulling in an unrelated person", () => {
    const tracks = byId(playerA(false), playerB(false));
    const elsewhere: ChainIdentity[] = [{
      id: "person-1",
      parts: [{ trackId: "A", fromFrame: 0, toFrame: 20 }],
    }];
    // Frame 50 is outside the identity's part, so the board has said nothing
    // about who this is. Claim only what was tapped.
    expect(extendChain([], tracks, "A", 50, { identities: elsewhere }))
      .toEqual([claimed("A", 50, 60, 50)]);
  });
});

describe("a board join suppresses the stop it was made to remove", () => {
  /*
   * The board joins pieces across gaps up to 8 s; the stop rule wanted a
   * successor within 1 frame. So merging two pieces over a duel still stopped
   * the claimant at the join — while the page told them stopping meant the map
   * was not joining them.
   */
  const tracks = new Map([
    ["A", track("A", 0, 100, (f) => ({ x: f, y: 100 }))],
    ["B", track("B", 130, 300, (f) => ({ x: f, y: 100 }))],
  ]);

  it("does not raise a track end at a gap the board bridged", () => {
    const chain = [
      { trackId: "A", fromFrame: 0, toFrame: 100 },
      { trackId: "B", fromFrame: 130, toFrame: 300 },
    ];
    const at = nextUncertainty(chain, tracks, [], 0);
    expect(at?.frame).not.toBe(100);
  });

  it("still raises one where nothing follows at all", () => {
    const chain = [{ trackId: "A", fromFrame: 0, toFrame: 100 }];
    expect(nextUncertainty(chain, tracks, [], 0)).toMatchObject({ kind: "track-end", frame: 100 });
  });

  it("still raises one when the next part is beyond the board's reach", () => {
    const far = new Map(tracks);
    far.set("C", track("C", 900, 1000, (f) => ({ x: f, y: 100 })));
    const chain = [
      { trackId: "A", fromFrame: 0, toFrame: 100 },
      { trackId: "C", fromFrame: 900, toFrame: 1000 },
    ];
    expect(nextUncertainty(chain, far, [], 0)).toMatchObject({ kind: "track-end", frame: 100 });
  });
});

/**
 * The bug this exists to stop coming back.
 *
 * A track ends, the person cannot see themselves for a second or two, scrubs
 * forward and taps the track they are on now. Nothing about that is unusual --
 * it is what a track end IS -- and it wedged the whole flow: the scan started
 * at the chain's beginning, found the old track's end still unanswered (the
 * answer was recorded at the tap, not at the end), and returned a stop BEHIND
 * the playhead. `reachedStop` is `>=`, so it fired on the next frame, every
 * time, for the rest of the claim.
 *
 * The journey test never caught it because every scenario there is a swap
 * between two full-length tracks that touch: the successor rule sees the join
 * and the tap lands exactly on the crossing frame. A real handoff is neither.
 */
describe("scanFloor — where the next question is looked for", () => {
  const tapped = (trackId: string, fromFrame: number, toFrame: number, tapFrame: number) =>
    ({ trackId, fromFrame, toFrame, tapFrame });

  it("starts at the newest decision, not at the start of the chain", () => {
    const chain = [tapped("A", 20, 99, 20), tapped("B", 400, 900, 400)];
    // 401, not 400: a tap answers its own frame, so the floor sits past it.
    // Without the +1 a GET (which carries no afterFrame) handed back a stop AT
    // the frame just tapped, while the write that created it did not.
    expect(scanFloor(chain, null)).toBe(401);
  });

  it("takes the frame just answered when that is later still", () => {
    const chain = [tapped("A", 20, 99, 20)];
    expect(scanFloor(chain, 250)).toBe(251);
  });

  it("falls back to the chain start for parts with no stamp", () => {
    // Parts the identity board wrote, and chains stored before tapFrame
    // existed. The old behaviour exactly -- no worse, and no crash.
    const chain = [{ trackId: "A", fromFrame: 20, toFrame: 99 }];
    expect(scanFloor(chain, null)).toBe(20);
  });

  it("is zero for an empty chain", () => {
    expect(scanFloor([], null)).toBe(0);
  });

  it("does not re-raise a track end the person answered by tapping past it", () => {
    // A ran out at 99. The person found themselves again at 400 and tapped B,
    // which is a gap of 301 frames -- beyond successorGapFrames, so the
    // successor rule cannot rescue this one and the floor has to.
    const tracks = new Map<string, any>([
      ["A", { id: "A", startFrame: 0, endFrame: 99, boxes: [{ frame: 99, x: 0, y: 0, w: 10, h: 20 }] }],
      ["B", { id: "B", startFrame: 400, endFrame: 900, boxes: [{ frame: 400, x: 0, y: 0, w: 10, h: 20 }] }],
    ]);
    const chain = [tapped("A", 20, 99, 20), tapped("B", 400, 900, 400)];

    const fromChainStart = nextUncertainty(chain, tracks, [], 20, undefined, new Set([400]));
    expect(fromChainStart).toMatchObject({ kind: "track-end", frame: 99 });

    const fromFloor = nextUncertainty(
      chain, tracks, [], scanFloor(chain, 400), undefined, new Set([400]),
    );
    // Still asks about where B runs out -- that question is real and ahead.
    expect(fromFloor).toMatchObject({ kind: "track-end", frame: 900 });
    expect(fromFloor!.frame).toBeGreaterThan(400);
  });
});

/*
 * ------------------------------------------------------------------
 * Filling a gap must never erase what follows it.
 *
 * Reported as: "when I go back in time and pick myself, sometimes it erases
 * everything in front. That should never happen." Every tap used to truncate
 * the chain from the tapped frame on, which is right for a correction made
 * while following forward and wrong for the other thing a tap does -- scrub
 * back into a hole in the timeline and fill it.
 * ------------------------------------------------------------------
 */
describe("a tap into a gap fills it and touches nothing else", () => {
  const flat = (id: string, from: number, to: number) => track(id, from, to, (f) => ({ x: f, y: 0 }));
  const tracks = byId(flat("A", 0, 150), flat("B", 250, 900), flat("C", 180, 500));
  const chain: ChainPart[] = [
    claimed("A", 10, 150, 10),
    claimed("B", 300, 900, 300),
  ];

  it("keeps every part after the gap", () => {
    const after = extendChain(chain, tracks, "C", 200);
    expect(after.find((p) => p.trackId === "B")).toEqual(claimed("B", 300, 900, 300));
    expect(after.find((p) => p.trackId === "A")).toMatchObject({ fromFrame: 10, toFrame: 150 });
  });

  it("stops the fill just before the next part, however far the track runs", () => {
    // C runs to 500; the person's own claim resumes at 300 on B.
    const after = extendChain(chain, tracks, "C", 200);
    expect(after.find((p) => p.trackId === "C")).toEqual(claimed("C", 200, 299, 200));
  });

  it("answers the stretch that led to the tap, and only that stretch", () => {
    const after = extendChain(chain, tracks, "C", 200);
    // A ran out at 150 and the person found themselves again at 200: that
    // tap answers A's track end.
    expect(after.find((p) => p.trackId === "A")?.reviewedThrough).toBe(151);
    // B was not passed by this tap; whatever it still has to ask, it keeps.
    expect(after.find((p) => p.trackId === "B")?.reviewedThrough).toBe(301);
  });

  it("does not settle a part on the far side of a later stretch", () => {
    const far = byId(flat("A", 0, 150), flat("B", 500, 900), flat("D", 1200, 1500), flat("E", 950, 1300));
    const before: ChainPart[] = [
      { ...claimed("A", 10, 150, 10) },          // its track end at 150 is still open
      claimed("B", 500, 900, 500),
      claimed("D", 1200, 1500, 1200),
    ];
    const after = extendChain(before, far, "E", 1000);
    expect(after.find((p) => p.trackId === "E")).toEqual(claimed("E", 1000, 1199, 1000));
    // B led straight to the tap: answered. A did not: B stands between.
    expect(after.find((p) => p.trackId === "B")?.reviewedThrough).toBe(901);
    expect(after.find((p) => p.trackId === "A")?.reviewedThrough).toBe(11);
  });

  it("a fill whose track starts inside the gap claims from the tap, not from the track start", () => {
    const after = extendChain(chain, tracks, "C", 220);
    expect(after.find((p) => p.trackId === "C")).toEqual(claimed("C", 220, 299, 220));
  });
});

describe("a correction replaces one decision, not the future", () => {
  const flat = (id: string, from: number, to: number) => track(id, from, to, (f) => ({ x: f, y: 0 }));

  it("cuts the part under the tap and keeps decisions made further on", () => {
    const tracks = byId(flat("A", 0, 500), flat("B", 600, 900), flat("C", 200, 800));
    const chain: ChainPart[] = [claimed("A", 10, 500, 10), claimed("B", 600, 900, 600)];
    const after = extendChain(chain, tracks, "C", 250);
    expect(after).toEqual([
      { ...claimed("A", 10, 249, 10), reviewedThrough: 250 },
      claimed("C", 250, 599, 250),
      claimed("B", 600, 900, 600),
    ]);
  });

  it("removes the later runs of the decision being corrected -- the same wrong track continued", () => {
    const gappy = flat("A", 100, 500);
    gappy.boxes = gappy.boxes.filter((b) => b.frame <= 200 || (b.frame >= 213 && b.frame <= 300) || b.frame >= 320);
    const tracks = byId(gappy, flat("C", 200, 800));
    const chain = extendChain([], tracks, "A", 100);
    expect(chain.map((p) => [p.fromFrame, p.toFrame])).toEqual([[100, 200], [213, 300], [320, 500]]);

    const after = extendChain(chain, tracks, "C", 250);
    expect(after.filter((p) => p.trackId === "A").map((p) => [p.fromFrame, p.toFrame]))
      .toEqual([[100, 200], [213, 249]]);
    expect(after.find((p) => p.trackId === "C")).toEqual(claimed("C", 250, 800, 250));
  });

  it("re-tapping the same track inside its own part keeps what is ahead and re-asks where it ends", () => {
    // B starts well past successorGapFrames from A's end, so A's end is a
    // real question whenever it is unanswered.
    const tracks = byId(flat("A", 0, 150), flat("B", 400, 900));
    const chain: ChainPart[] = [
      { ...claimed("A", 10, 150, 10), reviewedThrough: 151 },   // its end was answered once
      claimed("B", 400, 900, 400),
    ];
    const after = extendChain(chain, tracks, "A", 140);
    expect(after.find((p) => p.trackId === "B")).toEqual(claimed("B", 400, 900, 400));
    // Two decisions on one track stay two parts: merged, a later correction
    // of one would take the other's frames with it.
    expect(after.filter((p) => p.trackId === "A")).toEqual([
      { ...claimed("A", 10, 139, 10), reviewedThrough: 140 },
      claimed("A", 140, 150, 140),
    ]);
    // The tap at 140 says nothing about what happens after 150, so the end
    // is a question again -- exactly as it was the first time round.
    expect(nextUncertainty(after, tracks, [], 0)).toMatchObject({ kind: "track-end", frame: 150 });
  });

  it("board-written parts each count as their own decision", () => {
    // No stamps: the board grouped A, B and C into this person. Correcting A
    // at 50 says nothing about B and C, which the admin joined deliberately.
    const tracks = byId(flat("A", 0, 100), flat("B", 130, 240), flat("C", 260, 400), flat("D", 40, 300));
    const chain: ChainPart[] = [
      { trackId: "A", fromFrame: 0, toFrame: 100 },
      { trackId: "B", fromFrame: 130, toFrame: 240 },
      { trackId: "C", fromFrame: 260, toFrame: 400 },
    ];
    const after = extendChain(chain, tracks, "D", 50);
    expect(after).toEqual([
      { trackId: "A", fromFrame: 0, toFrame: 49, reviewedThrough: 50 },
      claimed("D", 50, 129, 50),
      { trackId: "B", fromFrame: 130, toFrame: 240 },
      { trackId: "C", fromFrame: 260, toFrame: 400 },
    ]);
  });
});

describe("'not me from here' and 'yes, still me' write into the part they answer", () => {
  const flat = (id: string, from: number, to: number) => track(id, from, to, (f) => ({ x: f, y: 0 }));
  const tracks = byId(flat("A", 0, 150), flat("C", 180, 500), flat("B", 250, 900));

  it("giving up inside a fill keeps the stretch claimed after it", () => {
    const chain: ChainPart[] = [claimed("A", 10, 150, 10), claimed("C", 200, 299, 200), claimed("B", 300, 900, 300)];
    expect(cutChain(chain, 250)).toEqual([
      claimed("A", 10, 150, 10),
      { ...claimed("C", 200, 249, 200), reviewedThrough: 250 },
      claimed("B", 300, 900, 300),
    ]);
  });

  it("giving up at the first frame of a part removes it", () => {
    const chain: ChainPart[] = [claimed("A", 10, 150, 10), claimed("B", 300, 900, 300)];
    expect(cutChain(chain, 300)).toEqual([claimed("A", 10, 150, 10)]);
  });

  it("a cut part does not ask about the end it was cut to", () => {
    const chain = cutChain([claimed("A", 10, 150, 10)], 100);
    expect(chain).toEqual([{ ...claimed("A", 10, 99, 10), reviewedThrough: 100 }]);
    expect(nextUncertainty(chain, tracks, [], 0)).toBeNull();
  });

  it("a confirm advances only the part that was asked", () => {
    const chain: ChainPart[] = [claimed("A", 10, 150, 10), claimed("B", 300, 900, 300)];
    const after = markAnswered(chain, 500);
    expect(after[0].reviewedThrough).toBe(11);
    expect(after[1].reviewedThrough).toBe(501);
    // Never backwards.
    expect(markAnswered(after, 400)[1].reviewedThrough).toBe(501);
  });
});

describe("questions are scanned per part, from each part's own answered frontier", () => {
  const flat = (id: string, from: number, to: number) => track(id, from, to, (f) => ({ x: f, y: 0 }));
  // Every claimed stretch here is more than successorGapFrames from the next,
  // so each track end is a real question unless it has been answered.
  const tracks = byId(flat("A", 0, 150), flat("C", 180, 260), flat("B", 250, 900), flat("X", 0, 900));
  const crossings = [
    { frame: 230, trackId: "C", otherTrackId: "X", confidence: 0.1 },
    { frame: 600, trackId: "B", otherTrackId: "X", confidence: 0.1 },
  ] as TrackingSegmentPayload["crossings"];

  it("raises a question inside a fill even though everything after it was answered", () => {
    const chain: ChainPart[] = [
      { ...claimed("A", 10, 150, 10), reviewedThrough: 151 },
      claimed("C", 200, 260, 200),
      { ...claimed("B", 500, 900, 500), reviewedThrough: 901 },
    ];
    const open = openUncertainties(chain, tracks, crossings, 0);
    expect(open.map((q) => [q.kind, q.frame])).toEqual([["swap", 230], ["track-end", 260]]);
  });

  it("does not re-raise a question a later part already answered", () => {
    const chain: ChainPart[] = [
      claimed("A", 10, 150, 10),
      { ...claimed("B", 500, 900, 500), reviewedThrough: 601 },
    ];
    expect(openUncertainties(chain, tracks, crossings, 0).map((q) => q.frame)).toEqual([150, 900]);
  });

  it("lists every open question, earliest first, one per frame", () => {
    const chain: ChainPart[] = [claimed("A", 10, 150, 10), claimed("B", 500, 900, 500)];
    const open = openUncertainties(chain, tracks, crossings, 0);
    expect(open.map((q) => q.frame)).toEqual([150, 600, 900]);
    expect(nextUncertainty(chain, tracks, crossings, 0)?.frame).toBe(150);
  });

  it("a fill's end is not a question when the next part picks up within reach", () => {
    // C ends at 260 and B resumes at 300: the join is the successor rule's to
    // forgive, exactly as it would be for two parts claimed forwards.
    const chain: ChainPart[] = [claimed("C", 200, 260, 200), { ...claimed("B", 300, 900, 300), reviewedThrough: 901 }];
    expect(openUncertainties(chain, tracks, crossings, 0).map((q) => q.frame)).toEqual([230]);
  });

  it("does not ask 'we lost you' where the recording itself ends", () => {
    const chain: ChainPart[] = [claimed("B", 300, 900, 300)];
    expect(nextUncertainty(chain, tracks, [], 0, undefined, undefined, 905)).toBeNull();
    expect(nextUncertainty(chain, tracks, [], 0, undefined, undefined, 2000)).toMatchObject({ frame: 900 });
  });

  it("a tap past a track end answers it, however far past", () => {
    const chain = extendChain([claimed("A", 10, 150, 10)], tracks, "B", 500);
    // 500 - 150 is well past successorGapFrames, so only the mark can save this.
    expect(openUncertainties(chain, tracks, [], 0).map((q) => q.frame)).toEqual([900]);
  });
});

describe("marks survive normalisation and are filled in for old chains", () => {
  const flat = (id: string, from: number, to: number) => track(id, from, to, (f) => ({ x: f, y: 0 }));
  const tracks = byId(flat("A", 0, 900));

  it("merging a fully reviewed piece with the next carries the next piece's frontier", () => {
    const merged = normaliseChain([
      { trackId: "A", fromFrame: 10, toFrame: 99, reviewedThrough: 100 },
      { trackId: "A", fromFrame: 100, toFrame: 300, reviewedThrough: 120 },
    ], tracks);
    expect(merged).toEqual([{ trackId: "A", fromFrame: 10, toFrame: 300, reviewedThrough: 120 }]);
  });

  it("merging an unfinished piece with the next keeps the earlier frontier -- re-ask, never skip", () => {
    const merged = normaliseChain([
      { trackId: "A", fromFrame: 10, toFrame: 99, reviewedThrough: 50 },
      { trackId: "A", fromFrame: 100, toFrame: 300, reviewedThrough: 301 },
    ], tracks);
    expect(merged[0].reviewedThrough).toBe(50);
  });

  it("clamps a mark to what the part can express", () => {
    expect(normaliseChain([{ trackId: "A", fromFrame: 100, toFrame: 300, reviewedThrough: 5 }], tracks)[0].reviewedThrough).toBe(100);
    expect(normaliseChain([{ trackId: "A", fromFrame: 100, toFrame: 300, reviewedThrough: 999 }], tracks)[0].reviewedThrough).toBe(301);
  });

  it("upgrades an unmarked chain from the legacy single floor exactly", () => {
    const chain: ChainPart[] = [
      { trackId: "A", fromFrame: 10, toFrame: 99, tapFrame: 10 },
      { trackId: "A", fromFrame: 200, toFrame: 300, tapFrame: 200 },
      { trackId: "A", fromFrame: 500, toFrame: 600 },
    ];
    const floor = scanFloor(chain, null, 250);   // newest tap 200 -> 201; identity mark 250
    expect(floor).toBe(250);
    expect(withMarks(chain, floor).map((p) => p.reviewedThrough)).toEqual([100, 250, 500]);
    // Already-marked parts are left alone.
    expect(withMarks([{ ...chain[0], reviewedThrough: 42 }], floor)[0].reviewedThrough).toBe(42);
  });
});
