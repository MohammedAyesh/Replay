import { describe, expect, it } from "vitest";
import {
  FRAME_DURATION_SECONDS,
  PLAYBACK_SPEEDS,
  playbackSpeedForKey,
  playbackStepForKey,
} from "./playbackControls";

describe("VAR playback controls", () => {
  it("uses 20 fps and exposes slow-motion speeds on the number keys", () => {
    expect(FRAME_DURATION_SECONDS).toBe(0.05);
    expect(PLAYBACK_SPEEDS).toEqual([0.25, 0.5, 1]);
    expect(playbackSpeedForKey("1")).toBe(0.25);
    expect(playbackSpeedForKey("2")).toBe(0.5);
    expect(playbackSpeedForKey("3")).toBe(1);
    expect(playbackSpeedForKey("4")).toBeNull();
  });

  it("maps arrows, shifted arrows and comma/period to the requested steps", () => {
    expect(playbackStepForKey("ArrowLeft", false)).toBe(-0.05);
    expect(playbackStepForKey("ArrowRight", false)).toBe(0.05);
    expect(playbackStepForKey("ArrowLeft", true)).toBe(-1);
    expect(playbackStepForKey("ArrowRight", true)).toBe(1);
    expect(playbackStepForKey(",", false)).toBe(-0.1);
    expect(playbackStepForKey(".", false)).toBe(0.1);
    expect(playbackStepForKey("j", false)).toBeNull();
    expect(playbackStepForKey("l", false)).toBeNull();
  });
});