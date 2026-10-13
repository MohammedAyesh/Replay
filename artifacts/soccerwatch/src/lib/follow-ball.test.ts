import { describe, expect, it } from "vitest";
import {
  cameraAt, cleanSamples, FOLLOW_MAX_SPEED, FOLLOW_GRID_SECONDS, smoothPath, targetSeries,
} from "./follow-ball";

describe("recorded follow-ball camera", () => {
  it("rejects isolated jumps but accepts a persistent new position", () => {
    const input: [number, number, number][] = [[0, .2, .5], [.1, .8, .5], [.2, .2, .5],
      [.3, .8, .5], [.4, .8, .5], [.5, .8, .5], [.6, .8, .5], [.7, .8, .5], [.8, .8, .5], [.9, .8, .5]];
    const clean = cleanSamples(input);
    expect(clean[1][1]).toBe(.8);
    expect(clean.length).toBeGreaterThan(2);
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

  it("respects the speed limit and dead zone", () => {
    const targets = Array.from({ length: 101 }, (_, i): [number, number, number] => [i / 10, i < 50 ? .2 : .9, .5]);
    const path = smoothPath(targets);
    for (let i = 1; i < path.length; i++) {
      expect(Math.abs(path[i][1] - path[i - 1][1])).toBeLessThanOrEqual(FOLLOW_MAX_SPEED * FOLLOW_GRID_SECONDS + 1e-8);
    }
    const wiggles = smoothPath(Array.from({ length: 20 }, (_, i): [number, number, number] => [i / 10, .5 + (i % 2 ? .02 : -.02), .5]));
    expect(new Set(wiggles.map((p) => p[1])).size).toBe(1);
  });
});
