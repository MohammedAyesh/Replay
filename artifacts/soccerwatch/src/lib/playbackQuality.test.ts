import { describe, expect, it } from "vitest";
import { getPlaybackQualityCapIndex } from "./playbackQuality";

describe("getPlaybackQualityCapIndex", () => {
  it("does not cap a single 3840x1080 level when no level fits", () => {
    expect(getPlaybackQualityCapIndex([{ width: 3840 }])).toBe(-1);
  });

  it("selects the 1920x540 level from a three-level ladder", () => {
    expect(getPlaybackQualityCapIndex([
      { width: 854 },
      { width: 1920 },
      { width: 3840 },
    ])).toBe(1);
  });

  it("selects the lower level from a two-level ladder", () => {
    expect(getPlaybackQualityCapIndex([
      { width: 1920 },
      { width: 3840 },
    ])).toBe(0);
  });

  it("selects the highest level when every level is within the ceiling", () => {
    expect(getPlaybackQualityCapIndex([
      { width: 854 },
      { width: 1280 },
      { width: 1920 },
    ])).toBe(2);
  });

  it("does not let an unknown-width level raise the ceiling", () => {
    expect(getPlaybackQualityCapIndex([
      { width: 854 },
      {},
      { width: 3840 },
    ])).toBe(0);
    expect(getPlaybackQualityCapIndex([{ width: 1920 }, { width: 0 }])).toBe(0);
  });

  it("leaves an empty ladder uncapped without crashing", () => {
    expect(getPlaybackQualityCapIndex([])).toBe(-1);
  });
});