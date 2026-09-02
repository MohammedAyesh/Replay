import { describe, expect, it } from "vitest";
import {
  boxAtFrame,
  boxesOverlap,
  findHitTracks,
  formatClaimTime,
  positionAtFrame,
  type ClaimBundle,
  type ClaimTrack,
} from "./claim-match-engine";

const track = (id: string, boxes: ClaimTrack["boxes"]): ClaimTrack => ({
  id,
  startFrame: boxes[0]?.frame ?? 0,
  endFrame: boxes.at(-1)?.frame ?? 0,
  boxes,
});

const bundle: ClaimBundle = {
  version: 1,
  label: "test",
  width: 1000,
  height: 500,
  frameRate: 10,
  frameCount: 100,
  duration: 10,
  matchOffset: 0,
  videoStartSeconds: 0,
  tracks: [],
  crossings: [],
  inPlaySpans: [],
  events: [],
};

describe("claim match frame utilities", () => {
  it("returns the nearest available detection box", () => {
    const player = track("player-1", [
      { frame: 10, x: 10, y: 20, w: 30, h: 50 },
      { frame: 20, x: 30, y: 20, w: 30, h: 50 },
    ]);

    expect(boxAtFrame(player, 14)?.frame).toBe(10);
    expect(boxAtFrame(player, 17)?.frame).toBe(20);
    expect(boxAtFrame(player, 5)).toBeNull();
  });

  it("interpolates short internal gaps without extending the track", () => {
    const player = track("player-1", [
      { frame: 10, x: 10, y: 20, w: 30, h: 50 },
      { frame: 30, x: 30, y: 40, w: 30, h: 50 },
    ]);
    const result = positionAtFrame(player, 20, bundle);

    expect(result?.interpolated).toBe(true);
    expect(result?.x).toBe(20);
    expect(positionAtFrame(player, 40, bundle)).toBeNull();
  });

  it("finds tracks hit by a point and recognizes meaningful overlap", () => {
    const first = track("one", [{ frame: 10, x: 10, y: 10, w: 30, h: 40 }]);
    const second = track("two", [{ frame: 10, x: 25, y: 10, w: 30, h: 40 }]);
    const withTracks = { ...bundle, tracks: [first, second] };

    expect(findHitTracks(withTracks, 10, 15, 20).map(({ track: item }) => item.id)).toEqual(["one"]);
    expect(boxesOverlap(first.boxes[0], second.boxes[0])).toBe(true);
  });

  it("formats tracking durations for the player-facing UI", () => {
    expect(formatClaimTime(7)).toBe("0:07");
    expect(formatClaimTime(3661)).toBe("1:01:01");
  });
});