import { describe, expect, it } from "vitest";
import type { PublicPlayerMeasuredMatch } from "@workspace/api-client-react";
import {
  aggregatePitchHeatmaps,
  attachMeasured,
  formatDistance,
  measuredTiles,
  shouldShowEmptyStatsCta,
  shouldShowPerMatchHeatmaps,
} from "./player-stats";

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

  it("shows the empty-state claim CTA only to the profile owner", () => {
    expect(shouldShowEmptyStatsCta(18, 18, false)).toBe(true);
    expect(shouldShowEmptyStatsCta(18, 23, false)).toBe(false);
    expect(shouldShowEmptyStatsCta(18, 18, true)).toBe(false);
  });
});

describe("measured figures on the profile", () => {
  const measured = (matchId: number, recordingIds: number[], patch: Partial<PublicPlayerMeasuredMatch> = {}): PublicPlayerMeasuredMatch => ({
    matchId,
    recordingIds,
    date: "2026-09-30",
    startLocal: "2026-09-30 22:00",
    fieldName: "Galaxy",
    minutes: 60,
    distanceKm: 3.2,
    topSpeedKmh: 24.3,
    touches: 41,
    passesTried: 16,
    passesCompleted: 12,
    shots: 4,
    goals: 2,
    dribbles: 5,
    dribblesWon: 3,
    dribblesLost: 2,
    ...patch,
  });

  it("puts a match beside its claimed recording once, even across two recordings", () => {
    const { byRecording, unattached } = attachMeasured(
      [{ recordingId: 11 }, { recordingId: 12 }, { recordingId: 20 }],
      [measured(1, [11, 12]), measured(2, [30])],
    );
    expect(byRecording.get(11)?.matchId).toBe(1);
    expect(byRecording.has(12)).toBe(false);
    expect(byRecording.has(20)).toBe(false);
    expect(unattached.map((m) => m.matchId)).toEqual([2]);
  });

  it("shows what was measured and leaves out what wasn't -- never an 'Unavailable' tile", () => {
    expect(measuredTiles(measured(1, [1])).map((tile) => tile.key)).toEqual(["topSpeed", "goals", "shots", "passes", "touches", "dribbles"]);
    const partial = measuredTiles(measured(1, [1], { shots: null, touches: null, topSpeedKmh: null }));
    expect(partial.map((tile) => tile.key)).toEqual(["goals", "passes", "dribbles"]);
    expect(measuredTiles(measured(1, [1]), { distance: true })[1]).toEqual({ key: "distance", value: 3.2 });
    expect(measuredTiles(null)).toEqual([]);
  });
});