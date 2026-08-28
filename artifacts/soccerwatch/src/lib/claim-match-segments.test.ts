import { describe, expect, it } from "vitest";
import {
  crossedSegmentBoundary,
  retainNearbySegments,
  segmentIndexAtTime,
} from "./claim-match-segments";

const manifest = {
  version: 1,
  label: "hour",
  width: 1920,
  height: 1080,
  frameRate: 25,
  frameCount: 90000,
  duration: 3600,
  matchOffset: 0,
  segmentCount: 3,
  segments: [
    { index: 0, name: "one", startFrame: 0, endFrame: 29999, startSeconds: 0, endSeconds: 1200, objectPath: "/objects/one" },
    { index: 1, name: "two", startFrame: 30000, endFrame: 59999, startSeconds: 1200.04, endSeconds: 2400, objectPath: "/objects/two" },
    { index: 2, name: "three", startFrame: 60000, endFrame: 89999, startSeconds: 2400.04, endSeconds: 3600, objectPath: "/objects/three" },
  ],
};

describe("claim match segments", () => {
  it("selects the segment containing the playback time", () => {
    expect(segmentIndexAtTime(manifest, 1)).toBe(0);
    expect(segmentIndexAtTime(manifest, 1201)).toBe(1);
    expect(segmentIndexAtTime(manifest, 3599)).toBe(2);
  });

  it("keeps only current, previous, and next cache entries", () => {
    const cache = {
      0: { segmentIndex: 0 },
      1: { segmentIndex: 1 },
      2: { segmentIndex: 2 },
      3: { segmentIndex: 3 },
    } as never;
    expect(Object.keys(retainNearbySegments(cache, 2)).sort()).toEqual(["1", "2", "3"]);
  });

  it("treats a changed segment as a boundary requiring a re-pick", () => {
    expect(crossedSegmentBoundary(null, 0)).toBe(false);
    expect(crossedSegmentBoundary(0, 1)).toBe(true);
    expect(crossedSegmentBoundary(1, 1)).toBe(false);
  });
});