import { describe, expect, it } from "vitest";
import {
  buildClaimAnchors,
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

  it("uses a reachable threshold for short and long recordings", () => {
    expect(claimCompletionThreshold(90)).toEqual({ coveragePercent: 55, acceptedAnchors: 1 });
    expect(claimCompletionThreshold(600)).toEqual({ coveragePercent: 60, acceptedAnchors: 3 });
  });
});