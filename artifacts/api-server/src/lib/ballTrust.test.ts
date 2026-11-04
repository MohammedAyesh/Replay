import { describe, expect, it } from "vitest";
import { trustedBall, type BallRow } from "./ballTrust";
import { ballFocus } from "./checkDeck";

const manifest = { frameRate: 20, width: 3840, height: 1080 };
const row = (t: number, x: number, y: number): BallRow => [Math.round(t * 20), x * 3840, y * 1080];

// Rec 410 (job 34, c3_bp.json), the 35' shot at 2098 s = frame 41960 (c3 local 5960):
// the final ball path, every 5th frame as logged on vps1 (20261104-0900-j34-shot35-path).
// The shot is at x 2,560-2,900; the path breaks onto a still object at (692, 428)
// by the far goal at frames 5880, 5909 and 5960.
const C3 = 36000; // chunk c3 starts at 1800 s
const bp = (f: number, x: number, y: number): BallRow => [C3 + f, x, y];
const rec410: BallRow[] = [
  bp(5861, 2714.5, 348.2), bp(5866, 2674.0, 340.5), bp(5871, 2622.4, 371.8), bp(5876, 2558.0, 388.8),
  bp(5881, 692.5, 428.5), bp(5886, 692.5, 428.5), bp(5891, 692.5, 428.5), bp(5896, 692.5, 428.5), bp(5901, 692.6, 428.5), bp(5906, 692.6, 428.5),
  bp(5912, 2733.8, 342.0), bp(5921, 2783.0, 378.5), bp(5926, 2795.6, 338.8), bp(5931, 2790.0, 380.0), bp(5942, 2851.0, 368.2), bp(5952, 2809.0, 303.5),
  bp(5961, 692.6, 428.5), bp(5966, 692.6, 428.5), bp(5971, 692.6, 428.5), bp(5976, 692.6, 428.5), bp(5992, 692.2, 428.5),
  bp(6016, 693.0, 428.0), bp(6021, 693.5, 427.5), bp(6026, 693.2, 427.5), bp(6031, 694.0, 427.5), bp(6036, 693.8, 427.5),
];
// The same stretch from pass 1 (c3_bp1.json, before the colour and shoe gates): on the still object throughout.
const rec410pass1: BallRow[] = Array.from({ length: 36 }, (_, i) => bp(5860 + 5 * i, 692.5, 428.6));

describe("trustedBall", () => {
  it("keeps the shot and drops the still object at the far goal the path broke onto (rec 410, 35')", () => {
    const kept = trustedBall(rec410, manifest, 2093 * 20, 2102 * 20, 2098 * 20);
    expect(kept.map((r) => r[0] - C3)).toEqual([5861, 5866, 5871, 5876, 5912, 5921, 5926, 5931, 5942, 5952]);
  });

  it("a path that is only the still object is all there is, so it stays (pass 1 of the same shot)", () => {
    expect(trustedBall(rec410pass1, manifest, 2093 * 20, 2102 * 20, 2098 * 20)).toHaveLength(rec410pass1.length);
  });

  it("the card's ring stays on the right goal for the whole card", () => {
    const focus = ballFocus(rec410, manifest, 2094, 2101, 0, 2098);
    expect(focus.length).toBeGreaterThan(20);
    expect(focus.every((f) => f[1] > 0.6)).toBe(true);
  });

  it("keeps a ball that really travels, and re-finds it after a gap it could cover", () => {
    const pass: BallRow[] = [];
    for (let t = 0; t <= 3; t += 0.25) pass.push(row(100 + t, 0.3 + 0.12 * t, 0.5)); // ~5 m/s across
    pass.push(row(104.5, 0.7, 0.45)); // 1.25 s gap, 0.06 further on
    expect(trustedBall(pass, manifest, 0, 1e9, 101 * 20)).toHaveLength(pass.length);
  });

  it("keeps a ball resting near where play was", () => {
    const rest: BallRow[] = [row(50, 0.5, 0.5), row(50.25, 0.52, 0.5), ...[51, 51.5, 52, 52.5, 53].map((t) => row(t, 0.53, 0.5))];
    expect(trustedBall(rest, manifest, 0, 1e9, 50 * 20)).toHaveLength(rest.length);
  });
});
