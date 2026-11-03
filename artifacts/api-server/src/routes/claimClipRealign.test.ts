import { describe, expect, it } from "vitest";
import { claimMomentClipWindow, planClaimClipRealign } from "./claimMatch";

// Rec 410 (2026-11-03): the GPU worker sent Bunny's interim Early Play start
// (5.404 s), so its moment clips were cut 5.4 s late. These are its real
// numbers: a 7199 s recording and the pass at tracking second 3323.8.
const duration = 7199;
const aspect = 3840 / 1080;
const follow: Array<[number, number, number]> = [[3316, 0.5, 0.3], [3323, 0.6, 0.3], [3331, 0.7, 0.3]];

function madeWith(vs: number) {
  const w = claimMomentClipWindow(3323.8, follow, vs, duration, aspect)!;
  return { startTime: String(w.startTime), endTime: String(w.endTime) };
}

describe("claim clip realign", () => {
  it("moves a clip cut under the wrong start onto the corrected window", () => {
    const plan = planClaimClipRealign({
      links: [{ userId: 7, clip: { id: "me-pass-3323", momentSeconds: 3323.8, follow, userClipId: 1239 } }],
      clips: [{ id: 1239, ...madeWith(5.404), hiddenReason: null }],
      duration, aspect, fromVideoStart: 5.404, toVideoStart: 0,
    });
    expect(plan.skipped).toEqual([]);
    expect(plan.moves).toHaveLength(1);
    const [move] = plan.moves;
    expect(move.to[0] * duration).toBeCloseTo(3315.8, 3);
    expect(move.to[1] * duration).toBeCloseTo(3331.8, 3);
    expect(move.from[0] * duration).toBeCloseTo(3321.204, 3);
    expect(move.cropPath.length).toBeGreaterThan(0);
  });

  it("leaves clips that are already aligned, re-cut by hand, or deleted", () => {
    const plan = planClaimClipRealign({
      links: [
        { userId: 1, clip: { id: "a", momentSeconds: 3323.8, follow, userClipId: 1 } },
        { userId: 1, clip: { id: "b", momentSeconds: 3323.8, follow, userClipId: 2 } },
        { userId: 1, clip: { id: "c", momentSeconds: 3323.8, follow, userClipId: 3 } },
        { userId: 1, clip: { id: "d", momentSeconds: 3323.8, follow } },
      ],
      clips: [
        { id: 1, ...madeWith(0) },
        { id: 2, startTime: "0.4", endTime: "0.41" },
        { id: 3, ...madeWith(5.404), hiddenReason: "deleted" },
      ],
      duration, aspect, fromVideoStart: 5.404, toVideoStart: 0,
    });
    expect(plan.moves).toEqual([]);
    expect(plan.skipped.map((s) => s.reason)).toEqual(["already aligned", "window changed by hand", "deleted"]);
  });
});
