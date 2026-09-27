import { describe, expect, it } from "vitest";
import { getBunnyMp4FallbackSource } from "./bunnyPlayback";

describe("getBunnyMp4FallbackSource", () => {
  it("returns the proxied Bunny MP4 fallback for a matching playlist", () => {
    const source = getBunnyMp4FallbackSource(
      "https://vz-test.b-cdn.net/video-123/playlist.m3u8",
      "video-123",
    );

    expect(source).not.toBeNull();
    const requestUrl = new URL(source!, "https://replay.example");
    expect(requestUrl.pathname).toBe("/api/hls-proxy/segment");
    expect(requestUrl.searchParams.get("url"))
      .toBe("https://vz-test.b-cdn.net/video-123/play_720p.mp4");
  });

  it("rejects non-Bunny URLs and mismatched video IDs", () => {
    expect(getBunnyMp4FallbackSource("https://evil.example/video-123/playlist.m3u8", "video-123"))
      .toBeNull();
    expect(getBunnyMp4FallbackSource("https://vz-test.b-cdn.net/video-123/playlist.m3u8", "other"))
      .toBeNull();
  });
});