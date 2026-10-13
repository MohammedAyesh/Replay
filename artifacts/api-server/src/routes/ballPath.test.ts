import { describe, expect, it } from "vitest";
import type { TrackingManifest } from "@workspace/db";
import { buildBallPath, selectNewestBundle } from "./ballPath";

const manifest = {
  width: 3840,
  height: 1080,
  frameRate: 20,
  videoStartSeconds: 5,
  provenance: { phases: { phases: [{ kind: "game", start: 10, end: 20 }] } },
} as unknown as TrackingManifest;

describe("ball path response", () => {
  it("looks up the Bunny guid and converts sidecar timing to video seconds", () => {
    const row = { videoUrl: "https://vz-123.b-cdn.net/abc123/playlist.m3u8", id: 2, manifest, updatedAt: new Date() };
    expect(selectNewestBundle([row], "abc123")).toBe(row);
    expect(selectNewestBundle([], "abc123")).toBeNull();
    expect(buildBallPath(manifest, [{ ball: [[100, 960, 540], [120, 1920, 270]] }])).toEqual({
      v: 1,
      samples: [[10, .25, .5], [11, .5, .25]],
      gameSpans: [[15, 25]],
      coverage: 0,
    });
  });

  it("returns no path when the bundle has no ball rows", () => {
    expect(buildBallPath(manifest, [null, { ball: [] }])).toBeNull();
  });
});
