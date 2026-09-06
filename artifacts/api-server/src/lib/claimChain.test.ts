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
  dropLastPart,
  extendChain,
  identityOwning,
  isStruckOff,
  nextUncertainty,
  normaliseChain,
  survivingRanges,
  swapEvidence,
  truncateChain,
  totalSeconds,
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
    expect(extendChain([], tracks, "A", 10)).toEqual([{ trackId: "A", fromFrame: 10, toFrame: 60 }]);
  });

  it("truncates everything after the tap — a correction replaces, never doubles up", () => {
    const before: ChainPart[] = [{ trackId: "A", fromFrame: 0, toFrame: 60 }];
    expect(extendChain(before, tracks, "B", 30)).toEqual([
      { trackId: "A", fromFrame: 0, toFrame: 29 },
      { trackId: "B", fromFrame: 30, toFrame: 60 },
    ]);
  });

  it("stops at a detection gap rather than claiming across it", () => {
    const gappy = track("G", 0, 60, (f) => ({ x: f, y: 0 }), 1);
    gappy.boxes = gappy.boxes.filter((b) => b.frame <= 20 || b.frame >= 45);
    const result = extendChain([], byId(gappy), "G", 0);
    expect(result).toEqual([{ trackId: "G", fromFrame: 0, toFrame: 20 }]);
  });

  it("stops where the board struck the track off", () => {
    const d: IdentityDecision[] = [{ trackId: "A", fromFrame: 40, toFrame: 60, action: "deleted" }];
    expect(extendChain([], tracks, "A", 0, { decisions: d })).toEqual([{ trackId: "A", fromFrame: 0, toFrame: 39 }]);
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
      { trackId: "A", fromFrame: 10, toFrame: 60 },
      { trackId: "B", fromFrame: 10, toFrame: 60 },
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
      { trackId: "A", fromFrame: 10, toFrame: 20 },
      { trackId: "B", fromFrame: 40, toFrame: 60 },
    ]);
  });

  it("drops a part of the person the board has struck off", () => {
    const decisions: IdentityDecision[] = [{ trackId: "B", fromFrame: 0, toFrame: 60, action: "deleted" }];
    expect(extendChain([], tracks, "A", 10, { identities, decisions }))
      .toEqual([{ trackId: "A", fromFrame: 10, toFrame: 60 }]);
  });

  it("falls back to the single track when no identity owns it", () => {
    expect(extendChain([], tracks, "A", 10, { identities: [] }))
      .toEqual([{ trackId: "A", fromFrame: 10, toFrame: 60 }]);
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
      .toEqual([{ trackId: "A", fromFrame: 50, toFrame: 60 }]);
  });
});
