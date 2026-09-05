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

    expect(rewriteLiveManifest(manifest, "camera1", "hls")).toBe([
      "#EXTM3U",
      "#EXT-X-VERSION:3",
      "#EXT-X-PROGRAM-DATE-TIME:2026-08-23T11:00:00.000Z",
      "#EXTINF:2.000,",
      "/api/live/camera1/s_000954.ts?variant=hls",
      "#EXT-X-DISCONTINUITY",
      "#EXTINF:2.000,",
      "/api/live/camera1/custom-prefix.ts?variant=hls",
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

    expect(rewriteLiveManifest(manifest, "camera2", "hls")).toBe(manifest);
  });

  it("preserves CRLF line endings", () => {
    expect(rewriteLiveManifest("#EXTM3U\r\ns_000001.ts\r\n", "camera2", "hls"))
      .toBe("#EXTM3U\r\n/api/live/camera2/s_000001.ts?variant=hls\r\n");
  });
});

/**
 * The segment shape the rewriter accepts.
 *
 * The `hevc` rendition is fragmented MP4, not MPEG-TS, so a rewriter that only
 * knew `.ts` silently left every hevc segment as a bare relative name — which
 * the browser then resolved against the app's own origin and 404'd.
 */
describe("both renditions", () => {
  it("rewrites fMP4 segment names as well as transport-stream ones", () => {
    expect(rewriteLiveManifest("#EXTINF:4.000,\nseg_1.m4s\n", "camera1", "hevc"))
      .toBe("#EXTINF:4.000,\n/api/live/camera1/seg_1.m4s?variant=hevc\n");
    expect(rewriteLiveManifest("#EXTINF:4.000,\ninit.mp4\n", "camera1", "hevc"))
      .toBe("#EXTINF:4.000,\n/api/live/camera1/init.mp4?variant=hevc\n");
  });
});
