import { describe, expect, it } from "vitest";
import { getBunnyMp4FallbackSource } from "./bunnyPlayback";

describe("getBunnyMp4FallbackSource", () => {
  it("builds the same-origin 720p fallback route for Bunny HLS", () => {
    const result = getBunnyMp4FallbackSource(
      "https://vz-123.b-cdn.net/abc-123/playlist.m3u8",
    );

    expect(result).toBe(
      `/api/hls-proxy/mp4?url=${encodeURIComponent(
        "https://vz-123.b-cdn.net/abc-123/play_720p.mp4",
      )}`,
    );
  });

  it("does not create a Bunny fallback for untrusted or malformed URLs", () => {
    expect(getBunnyMp4FallbackSource("https://example.com/abc/playlist.m3u8")).toBeUndefined();
    expect(getBunnyMp4FallbackSource("not a URL")).toBeUndefined();
  });
});
