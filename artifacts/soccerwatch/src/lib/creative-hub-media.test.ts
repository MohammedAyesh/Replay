import { describe, expect, it } from "vitest";
import { withCreativePlaybackWindow } from "./creative-hub-media";

describe("creative playback windows", () => {
  it("updates only bounded UHD HLS URLs", () => {
    expect(withCreativePlaybackWindow(
      "/api/hls-proxy/uhd/123e4567-e89b-12d3-a456-426614174000.m3u8?fromMs=10000&toMs=12000",
      20_000,
      28_000,
    )).toBe("/api/hls-proxy/uhd/123e4567-e89b-12d3-a456-426614174000.m3u8?fromMs=20000&toMs=28000");
    expect(withCreativePlaybackWindow("/api/hls-proxy/manifest?url=stream.m3u8", 20_000, 28_000))
      .toBe("/api/hls-proxy/manifest?url=stream.m3u8");
  });
});
