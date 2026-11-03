import { describe, expect, it } from "vitest";
import { framingCentre, framingSize, framingWindow, PANORAMA_ASPECT } from "@workspace/api-zod";
import { ballKeys, cropPathFraming, centreFraming, DEFAULT_ZOOM, STEP_MS } from "./framing";
import { spanOf } from "./clipSpan";
import { piecewise, thinKeys } from "./renderVideo";

describe("following the ball", () => {
  // The ball runs from the left (x 0.2) at 100 s to the right (x 0.8) at 110 s of the video, seen every 0.25 s.
  const samples = Array.from({ length: 41 }, (_, i) => [100 + i * 0.25, 0.2 + (0.6 * i) / 40, 0.6] as [number, number, number]);

  it("keys the window every step, relative to its start, and glides with the ball", () => {
    const out = ballKeys(samples, 100_000, 110_000)!;
    expect(out.coverage).toBe(1);
    expect(out.framing.mode).toBe("ball");
    expect(out.framing.zoom).toBe(DEFAULT_ZOOM);
    expect(out.framing.keys[0][0]).toBe(0);
    expect(out.framing.keys[1][0]).toBe(STEP_MS);
    expect(out.framing.keys.at(-1)![0]).toBe(10_000);
    const xs = out.framing.keys.map((k) => k[1]);
    for (let i = 1; i < xs.length; i++) expect(xs[i]).toBeGreaterThanOrEqual(xs[i - 1] - 1e-9);
    expect(xs[0]).toBeLessThan(0.3);
    expect(xs.at(-1)!).toBeGreaterThan(0.7);
    // Height is damped towards the middle band: the ball at 0.6 puts the camera between 0.52 and 0.6.
    expect(out.framing.keys[10][2]).toBeGreaterThan(0.52);
    expect(out.framing.keys[10][2]).toBeLessThan(0.6);
  });

  it("holds the last place seen through a gap, and the first place before the ball appears", () => {
    const gappy = samples.filter(([t]) => t < 102 || t > 106);
    const out = ballKeys(gappy, 99_000, 110_000)!;
    expect(out.coverage).toBeLessThan(1);
    // Before the ball appears (99–100 s) the camera waits where it is first seen.
    expect(Math.abs(out.framing.keys[0][1] - 0.2)).toBeLessThan(0.02);
    // Through the gap (102–106 s) it holds near the last place seen (x ≈ 0.32), not drifting on to 0.56.
    const inGap = out.framing.keys.filter(([ms]) => ms >= 4_000 && ms <= 6_000).map((k) => k[1]);
    for (const x of inGap) expect(x).toBeLessThan(0.4);
  });

  it("has nothing to follow when the ball is never seen in the window", () => {
    expect(ballKeys(samples, 200_000, 210_000)).toBeNull();
    expect(ballKeys([], 0, 1000)).toBeNull();
  });

  it("turns a clip's own camera path (shares of the clip and of the frame) into framing", () => {
    const f = cropPathFraming([{ t: 0, x: 0.1, y: 0.1, w: 0.34, h: 0.68 }, { t: 1, x: 0.5, y: 0.1, w: 0.34, h: 0.68 }], 16)!;
    expect(f.zoom).toBeCloseTo(0.34);
    expect(f.keys).toEqual([[0, 0.27, 0.44], [16_000, 0.67, 0.44]]);
    expect(cropPathFraming([], 16)).toBeNull();
    expect(centreFraming().keys).toEqual([[0, 0.5, 0.52]]);
  });
});

describe("framing maths", () => {
  it("sizes a 16:9 window on the 32:9 panorama and keeps it inside the frame", () => {
    expect(framingSize(0.5, PANORAMA_ASPECT, 16 / 9)).toEqual({ w: 0.5, h: 1 });
    // Too tall: shrunk to full height.
    expect(framingSize(0.9, PANORAMA_ASPECT, 16 / 9)).toEqual({ w: 0.5, h: 1 });
    const story = framingSize(0.2, PANORAMA_ASPECT, 9 / 16);
    expect(story.h).toBe(1);
    expect(story.w).toBeCloseTo((9 / 16) / PANORAMA_ASPECT);
    const win = framingWindow({ zoom: 0.4, keys: [[0, 0.02, 0.5]] }, 0, PANORAMA_ASPECT, 16 / 9);
    expect(win.x).toBe(0);
    expect(win.w).toBeCloseTo(0.4);
    expect(framingCentre({ keys: [[0, 0.2, 0.5], [1000, 0.6, 0.5]] }, 250)).toEqual([0.3, 0.5]);
    expect(framingCentre({ keys: [[500, 0.2, 0.5], [1000, 0.6, 0.5]] }, 0)).toEqual([0.2, 0.5]);
  });

  it("writes keys as one piecewise ffmpeg expression, thinned to a nesting ffmpeg handles", () => {
    expect(piecewise([[1, 0.5]])).toBe("0.5000");
    expect(piecewise([[1, 0.2], [2, 0.6]])).toBe("if(lt(t,1.000),0.2000,if(lt(t,2.000),0.2000+(0.4000)*(t-1.000)/1.000,0.6000))");
    const many = Array.from({ length: 300 }, (_, i) => [i * 100, i / 300, 0.5] as [number, number, number]);
    const thin = thinKeys(many);
    expect(thin.length).toBe(48);
    expect(thin[0]).toEqual(many[0]);
    expect(thin.at(-1)).toEqual(many.at(-1));
  });
});

describe("clip times", () => {
  it("reads start and end as shares of the video, thumbnails as seconds", () => {
    expect(spanOf(0.5, 0.51, 3610, 7200)).toEqual({ startSec: 3600, endSec: 3672, thumbSec: 3610, videoSeconds: 7200 });
    // A thumbnail outside the clip is ignored.
    expect(spanOf(0.5, 0.51, 10, 7200)?.thumbSec).toBeNull();
    // Without the video's length a share means nothing.
    expect(spanOf(0.5, 0.51, null, null)).toBeNull();
    // Seconds stay seconds.
    expect(spanOf(600, 620, null, null)).toMatchObject({ startSec: 600, endSec: 620 });
  });
});
