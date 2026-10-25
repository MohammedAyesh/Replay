import { describe, expect, it } from "vitest";
import { rewriteLivePlaylist } from "./liveHlsProxy";

const playlist = [
  "#EXTM3U",
  "#EXT-X-TARGETDURATION:4",
  "#EXT-X-PROGRAM-DATE-TIME:2026-10-13T10:00:00.000Z",
  "#EXTINF:4.0,",
  "seg/old.ts",
  "#EXT-X-PROGRAM-DATE-TIME:2026-10-13T10:00:04.000Z",
  "#EXTINF:4.0,",
  "seg/new.ts",
  "",
].join("\n");

describe("rewriteLivePlaylist", () => {
  it("rewrites relative segment URLs to the same-origin proxy", () => {
    expect(rewriteLivePlaylist(playlist, "/api/live/seg/")).toContain("/api/live/seg/old.ts");
  });

  it("drops segments before the booking's start instant", () => {
    const result = rewriteLivePlaylist(playlist, "/api/live/seg/", new Date("2026-10-13T10:00:04.000Z"));
    expect(result).not.toContain("old.ts");
    expect(result).toContain("/api/live/seg/new.ts");
  });

  it("advances the media sequence when trimming earlier segments", () => {
    const source = playlist.replace("#EXT-X-TARGETDURATION:4", "#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:40");
    const result = rewriteLivePlaylist(source, "/api/live/seg/", new Date("2026-10-13T10:00:04.000Z"));
    expect(result).toContain("#EXT-X-MEDIA-SEQUENCE:41");
    expect(result).not.toContain("old.ts");
  });

  it("rejects a trim request when segment wall-clock timestamps are absent", () => {
    expect(rewriteLivePlaylist("#EXTM3U\n#EXTINF:4,\nseg/old.ts\n", "/api/live/seg/", new Date())).toBeNull();
  });

  it("rejects unproxied absolute segment URLs", () => {
    expect(rewriteLivePlaylist("#EXTM3U\nhttps://example.com/seg/a.ts\n", "/api/live/seg/")).toBeNull();
  });
});
