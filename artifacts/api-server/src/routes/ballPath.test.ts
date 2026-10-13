import { describe, expect, it } from "vitest";
import type { TrackingManifest } from "@workspace/db";
import { buildBallPath, selectNewestBundle } from "./ballPath";

const manifest = {
  width: 3840,
  height: 1080,
  frameRate: 20,
  duration: 60,
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
      cameraSpans: [[15, 25]],
      coverage: 0,
    });
  });

  it("uses merged in-play spans when provenance has no phases and merges short camera gaps", () => {
    const withoutPhases = {
      ...manifest,
      provenance: { source: "legacy-bundle" },
    } as unknown as TrackingManifest;
    const result = buildBallPath(withoutPhases, [{ ball: [[2000, 960, 540], [4000, 1920, 270]] }], [
      [100, 120],
      [130, 140],
      [160, 180],
    ]);
    expect(result).toEqual({
      v: 1,
      samples: [[105, .25, .5], [205, .5, .25]],
      gameSpans: [[105, 125], [135, 145], [165, 185]],
      cameraSpans: [[105, 145], [165, 185]],
      coverage: 0.01,
    });
  });

  it("falls back to the whole recording when neither phases nor in-play spans exist", () => {
    const withoutPhases = { ...manifest, provenance: { source: "legacy-bundle" } } as unknown as TrackingManifest;
    const result = buildBallPath(withoutPhases, [{ ball: [[200, 960, 540]] }], null);
    expect(result?.gameSpans).toEqual([[5, 65]]);
  });

  it("returns no path when the bundle has no ball rows", () => {
    expect(buildBallPath(manifest, [null, { ball: [] }])).toBeNull();
  });
});
