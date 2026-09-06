import { describe, expect, it } from "vitest";
import {
  CLAIM_ANCHOR_MATCH_TOLERANCE_SECONDS,
  CLAIM_DETECTION_SNAP_MAX_SECONDS,
  buildClaimAnchors,
  claimAnswerMoment,
  claimCompletionThreshold,
  coverageSeconds,
  mergeCoverageIntervals,
  nearestAnchorIndex,
  nextUnansweredAnchor,
} from "./claim-match-anchors";

describe("claim match anchors", () => {
  it("merges accepted track coverage before calculating person-seconds", () => {
    expect(mergeCoverageIntervals([
      { startSeconds: 0, endSeconds: 10 },
      { startSeconds: 8, endSeconds: 20 },
      { startSeconds: 30, endSeconds: 40 },
    ], 60)).toEqual([
      { startSeconds: 0, endSeconds: 20 },
      { startSeconds: 30, endSeconds: 40 },
    ]);
    expect(coverageSeconds([
      { startSeconds: 0, endSeconds: 10 },
      { startSeconds: 8, endSeconds: 20 },
    ], 60)).toBe(20);
  });

  it("spreads questions independently through a match", () => {
    const anchors = buildClaimAnchors(600, [15, 300, 590], 6);
    expect(anchors.length).toBeGreaterThanOrEqual(6);
    expect(anchors[0].momentSeconds).toBeLessThan(anchors.at(-1)!.momentSeconds);
    expect(new Set(anchors.map((anchor) => anchor.id)).size).toBe(anchors.length);
  });

  it("uses tracking timestamps for stable anchor identity", () => {
    const original = buildClaimAnchors(100, [12.345, 45.678], 2);
    const rebuilt = buildClaimAnchors(100, [45.678, 12.345], 2);

    expect(rebuilt.map((anchor) => anchor.id)).toEqual(original.map((anchor) => anchor.id));
  });

  it("finds the next unanswered anchor", () => {
    const anchors = buildClaimAnchors(100, [], 4);
    expect(nextUnansweredAnchor(anchors, [])).toBe(0);
    expect(nextUnansweredAnchor(anchors, [anchors[0].momentSeconds])).toBe(1);
    expect(nextUnansweredAnchor(anchors, anchors.map((anchor) => anchor.momentSeconds))).toBe(-1);
  });

  it("matches saved moments only within the bounded anchor tolerance", () => {
    const anchors = buildClaimAnchors(100, [20], 1);

    expect(nearestAnchorIndex(anchors, 20.999)).toBe(0);
    expect(nearestAnchorIndex(anchors, 21.001)).toBe(-1);
  });

  it("keeps an answer at the checkpoint when no nearby detection exists", () => {
    expect(claimAnswerMoment(37.5, null)).toBe(37.5);
    expect(claimAnswerMoment(37.5, 0)).toBe(37.5);
    // Within tolerance: snapping to a real detection keeps exports aligned.
    expect(claimAnswerMoment(37.5, 38.2)).toBe(38.2);
    // Beyond it: this used to return 39.5. A 2 s snap against a 1 s match
    // tolerance stored the answer where nextUnansweredAnchor could no longer
    // match it to its own anchor, so the checkpoint stayed unanswered forever.
    expect(claimAnswerMoment(37.5, 39.5)).toBe(37.5);
  });

  it("never snaps an answer further than an anchor can be matched", () => {
    // The whole class of "the same checkpoint is asked again on every pass"
    // bugs comes from these two drifting apart. An answer that cannot be
    // matched back to its anchor is an answer that was never recorded.
    expect(CLAIM_DETECTION_SNAP_MAX_SECONDS)
      .toBeLessThanOrEqual(CLAIM_ANCHOR_MATCH_TOLERANCE_SECONDS);

    const anchors = buildClaimAnchors(600, [], 8);
    for (const anchor of anchors) {
      for (const drift of [-CLAIM_DETECTION_SNAP_MAX_SECONDS, 0, CLAIM_DETECTION_SNAP_MAX_SECONDS]) {
        const stored = claimAnswerMoment(anchor.momentSeconds, anchor.momentSeconds + drift);
        expect(nearestAnchorIndex(anchors, stored)).toBe(anchors.indexOf(anchor));
      }
    }
  });

  it("uses a reachable threshold for short and long recordings", () => {
    expect(claimCompletionThreshold(90)).toEqual({ coveragePercent: 55, acceptedAnchors: 1 });
    expect(claimCompletionThreshold(600)).toEqual({ coveragePercent: 60, acceptedAnchors: 3 });
  });
});