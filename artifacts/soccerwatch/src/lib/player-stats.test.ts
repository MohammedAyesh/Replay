import { describe, expect, it } from "vitest";
import { aggregatePitchHeatmaps, formatDistance, shouldShowPerMatchHeatmaps } from "./player-stats";

const pitch = (weight: number) => ({
  coordinateSpace: "pitch" as const,
  cells: [{ x: 0.5, y: 0.5, weight }],
});

describe("player stats heatmaps", () => {
  it("aggregates heatmaps when every match uses pitch coordinates", () => {
    const result = aggregatePitchHeatmaps([{ heatmap: pitch(0.25) }, { heatmap: pitch(0.75) }]);

    expect(result?.coordinateSpace).toBe("pitch");
    expect(result?.cells).toEqual([{ x: 0.5, y: 0.5, weight: 1 }]);
    expect(shouldShowPerMatchHeatmaps([{ heatmap: pitch(0.25) }, { heatmap: pitch(0.75) }])).toBe(false);
  });

  it("falls back to per-match heatmaps when any match is camera-space", () => {
    const camera = {
      coordinateSpace: "camera" as const,
      cells: [{ x: 0.2, y: 0.3, weight: 1 }],
    };
    expect(aggregatePitchHeatmaps([{ heatmap: pitch(1) }, { heatmap: camera }])).toBeNull();
    expect(shouldShowPerMatchHeatmaps([{ heatmap: pitch(1) }, { heatmap: camera }])).toBe(true);
  });

  it("renders unavailable instead of zero when distance has no pitch model", () => {
    expect(formatDistance(null, "Unavailable")).toBe("Unavailable");
    expect(formatDistance(0, "Unavailable")).toBe("0 m");
  });
});