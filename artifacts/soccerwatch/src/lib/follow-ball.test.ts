import { describe, expect, it } from "vitest";
import {
  cameraAt, cleanSamples, FOLLOW_MAX_SPEED, FOLLOW_GRID_SECONDS, smoothPath, targetSeries,
} from "./follow-ball";

describe("recorded follow-ball camera", () => {
  it("rejects isolated jumps but accepts a persistent new position", () => {
    const input: [number, number, number][] = [[0, .2, .5], [.03, .8, .5], [.06, .8, .5],
      [.09, .8, .5], [.12, .8, .5], [.15, .8, .5], [.18, .8, .5], [.21, .8, .5]];
    const clean = cleanSamples(input);
    expect(clean).toHaveLength(2);
    expect(clean[1][0]).toBe(.21);
  });

  it("interpolates a gap toward the known future ball position", () => {
    const targets = targetSeries([[1, .2, .5], [3, .8, .5]], [[0, 4]], 4);
    expect(targets.find(([t]) => t === 2)?.[1]).toBeCloseTo(.5);
  });

  it("smooths a step without a one-sided lag", () => {
    const targets = Array.from({ length: 101 }, (_, i): [number, number, number] => [i / 10, i < 50 ? .2 : .8, .5]);
    const path = smoothPath(targets);
    expect(cameraAt(path, 4.5)).toBeCloseTo(1 - cameraAt(path, 5.5), 1);
  });

  it("respects the speed limit and holds a small detector wiggle still", () => {
    const targets = Array.from({ length: 101 }, (_, i): [number, number, number] => [i / 10, i < 50 ? .2 : .9, .5]);
    const path = smoothPath(targets);
    for (let i = 1; i < path.length; i++) {
      expect(Math.abs(path[i][1] - path[i - 1][1])).toBeLessThanOrEqual(FOLLOW_MAX_SPEED * FOLLOW_GRID_SECONDS + 1e-8);
    }
    const wiggles = smoothPath(Array.from({ length: 201 }, (_, i): [number, number, number] => [i / 10, .5 + (i % 2 ? .04 : -.04), .5]));
    expect(Math.max(...wiggles.map((p) => Math.abs(p[1] - .5)))).toBeLessThanOrEqual(.005);
  });

  it("follows a large move while keeping the zero-lag dead zone", () => {
    const move = smoothPath(Array.from({ length: 201 }, (_, i): [number, number, number] => [i / 10, i < 100 ? .3 : .7, .5]));
    expect(cameraAt(move, 19.5)).toBeGreaterThan(.6);
  });
});
