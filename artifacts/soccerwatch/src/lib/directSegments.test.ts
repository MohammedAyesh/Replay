import { describe, expect, it } from "vitest";
import { canPlayDirect, withDirectSegments, withoutDirectSegments } from "./directSegments";

describe("direct Bunny segments", () => {
  it("asks the HLS proxy and owner share playlists for direct segments", () => {
    expect(withDirectSegments("/api/hls-proxy/manifest?url=x")).toBe("/api/hls-proxy/manifest?url=x&direct=1");
    expect(withDirectSegments("/base/api/hls-proxy/manifest?url=x")).toBe("/base/api/hls-proxy/manifest?url=x&direct=1");
    expect(withDirectSegments("/w/abc/manifest.m3u8")).toBe("/w/abc/manifest.m3u8?direct=1");
    expect(withDirectSegments("/api/w/abc/manifest.m3u8")).toBe("/api/w/abc/manifest.m3u8?direct=1");
  });

  it("leaves every other URL alone, and never adds the flag twice", () => {
    expect(withDirectSegments("https://vz-1.b-cdn.net/a/playlist.m3u8")).toBe("https://vz-1.b-cdn.net/a/playlist.m3u8");
    expect(withDirectSegments("/api/user-clips/4/playback")).toBe("/api/user-clips/4/playback");
    expect(withDirectSegments("/api/hls-proxy/manifest?url=x&direct=1")).toBe("/api/hls-proxy/manifest?url=x&direct=1");
    expect(withDirectSegments(null)).toBeNull();
    expect(canPlayDirect("/api/hls-proxy/segment?url=x")).toBe(false);
  });

  it("strips the flag for the relayed fallback", () => {
    expect(withoutDirectSegments("/api/hls-proxy/manifest?url=x&direct=1")).toBe("/api/hls-proxy/manifest?url=x");
    expect(withoutDirectSegments("/w/abc/manifest.m3u8?direct=1")).toBe("/w/abc/manifest.m3u8");
    expect(withoutDirectSegments("/api/hls-proxy/manifest?direct=1&url=x")).toBe("/api/hls-proxy/manifest?url=x");
  });
});
