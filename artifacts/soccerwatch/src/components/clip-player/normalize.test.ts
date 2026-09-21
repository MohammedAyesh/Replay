import { describe, expect, it } from "vitest";
import { normalizeClipKeyframes } from "./normalize";

describe("normalizeClipKeyframes", () => {
  it("uses the actual clip duration, matching the export timeline", () => {
    const path = normalizeClipKeyframes([
      { t: 2, x: 0.1, y: 0.2, w: 0.5, h: 0.3 },
      { t: 6, x: 0.2, y: 0.2, w: 0.5, h: 0.3 },
    ], 8);

    expect(path.map((keyframe) => keyframe.t)).toEqual([0.25, 0.75]);
  });

  it("clamps stalled or late samples to the supported range", () => {
    const path = normalizeClipKeyframes([
      { t: -1, x: 0, y: 0, w: 1, h: 1 },
      { t: 4, x: 0, y: 0, w: 1, h: 1 },
    ], 2);

    expect(path.map((keyframe) => keyframe.t)).toEqual([0, 1]);
  });
});