import { describe, expect, it } from "vitest";
import { rewriteLiveManifest } from "./live";

describe("live manifest rewriting", () => {
  it("rewrites bare ts segment names and preserves every HLS tag", () => {
    const manifest = [
      "#EXTM3U",
      "#EXT-X-VERSION:3",
      "#EXT-X-PROGRAM-DATE-TIME:2026-08-23T11:00:00.000Z",
      "#EXTINF:2.000,",
      "s_000954.ts",
      "#EXT-X-DISCONTINUITY",
      "#EXTINF:2.000,",
      "custom-prefix.ts",
      "",
    ].join("\n");

    expect(rewriteLiveManifest(manifest, "camera1")).toBe([
      "#EXTM3U",
      "#EXT-X-VERSION:3",
      "#EXT-X-PROGRAM-DATE-TIME:2026-08-23T11:00:00.000Z",
      "#EXTINF:2.000,",
      "/api/live/camera1/s_000954.ts",
      "#EXT-X-DISCONTINUITY",
      "#EXTINF:2.000,",
      "/api/live/camera1/custom-prefix.ts",
      "",
    ].join("\n"));
  });

  it("does not rewrite non-bare paths or comments containing ts names", () => {
    const manifest = [
      "#EXT-X-MEDIA:URI=\"s_000001.ts\"",
      "nested/s_000002.ts",
      "../s_000003.ts",
      "s_000004.ts?token=abc",
    ].join("\n");

    expect(rewriteLiveManifest(manifest, "camera2")).toBe(manifest);
  });

  it("preserves CRLF line endings", () => {
    expect(rewriteLiveManifest("#EXTM3U\r\ns_000001.ts\r\n", "camera2"))
      .toBe("#EXTM3U\r\n/api/live/camera2/s_000001.ts\r\n");
  });
});