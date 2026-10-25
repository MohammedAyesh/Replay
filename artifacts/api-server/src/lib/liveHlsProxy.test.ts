import { describe, expect, it } from "vitest";
import { liveSegmentNames, rewriteLivePlaylist } from "./liveHlsProxy";

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

  it("rejects a trim request when segment wall-clock timestamps are absent", () => {
    expect(rewriteLivePlaylist("#EXTM3U\n#EXTINF:4,\nseg/old.ts\n", "/api/live/seg/", new Date())).toBeNull();
  });

  it("rejects unproxied absolute segment URLs", () => {
    expect(rewriteLivePlaylist("#EXTM3U\nhttps://example.com/seg/a.ts\n", "/api/live/seg/")).toBeNull();
  });

  it("advances the media sequence by the number of segments dropped before the booking start", () => {
    const upstream = [
      "#EXTM3U",
      "#EXT-X-TARGETDURATION:4",
      "#EXT-X-MEDIA-SEQUENCE:40",
      "#EXT-X-PROGRAM-DATE-TIME:2026-10-13T09:59:56.000Z",
      "#EXTINF:4.0,",
      "seg/s40.ts",
      "#EXT-X-PROGRAM-DATE-TIME:2026-10-13T10:00:00.000Z",
      "#EXTINF:4.0,",
      "seg/s41.ts",
      "#EXT-X-PROGRAM-DATE-TIME:2026-10-13T10:00:04.000Z",
      "#EXTINF:4.0,",
      "seg/s42.ts",
      "",
    ].join("\n");
    const result = rewriteLivePlaylist(upstream, "/api/live/seg/", new Date("2026-10-13T10:00:04.000Z"))!;
    expect(result.split("\n")).toEqual([
      "#EXTM3U",
      "#EXT-X-TARGETDURATION:4",
      "#EXT-X-MEDIA-SEQUENCE:42",
      "#EXT-X-PROGRAM-DATE-TIME:2026-10-13T10:00:04.000Z",
      "#EXTINF:4.0,",
      "/api/live/seg/s42.ts",
    ]);
    // A later reload where vps1 has rolled s40 out keeps s42 at sequence 42.
    const reloaded = upstream.replace("#EXT-X-MEDIA-SEQUENCE:40", "#EXT-X-MEDIA-SEQUENCE:41")
      .replace("#EXT-X-PROGRAM-DATE-TIME:2026-10-13T09:59:56.000Z\n#EXTINF:4.0,\nseg/s40.ts\n", "");
    expect(rewriteLivePlaylist(reloaded, "/api/live/seg/", new Date("2026-10-13T10:00:04.000Z")))
      .toContain("#EXT-X-MEDIA-SEQUENCE:42");
  });

  it("adds the sequence tags when absent and counts dropped discontinuities", () => {
    const upstream = [
      "#EXTM3U",
      "#EXT-X-TARGETDURATION:4",
      "#EXT-X-DISCONTINUITY",
      "#EXT-X-PROGRAM-DATE-TIME:2026-10-13T09:59:00.000Z",
      "#EXTINF:4.0,",
      "seg/a.ts",
      "#EXT-X-DISCONTINUITY",
      "#EXT-X-PROGRAM-DATE-TIME:2026-10-13T09:59:30.000Z",
      "#EXTINF:4.0,",
      "seg/b.ts",
      "#EXT-X-DISCONTINUITY",
      "#EXT-X-PROGRAM-DATE-TIME:2026-10-13T10:00:00.000Z",
      "#EXTINF:4.0,",
      "seg/c.ts",
    ].join("\n");
    const result = rewriteLivePlaylist(upstream, "/p/", new Date("2026-10-13T10:00:00.000Z"))!;
    expect(result.split("\n")).toEqual([
      "#EXTM3U",
      "#EXT-X-TARGETDURATION:4",
      "#EXT-X-MEDIA-SEQUENCE:2",
      "#EXT-X-DISCONTINUITY-SEQUENCE:2",
      "#EXT-X-DISCONTINUITY",
      "#EXT-X-PROGRAM-DATE-TIME:2026-10-13T10:00:00.000Z",
      "#EXTINF:4.0,",
      "/p/c.ts",
    ]);
    const withTag = upstream.replace("#EXT-X-TARGETDURATION:4", "#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:7\n#EXT-X-DISCONTINUITY-SEQUENCE:3");
    const bumped = rewriteLivePlaylist(withTag, "/p/", new Date("2026-10-13T10:00:00.000Z"))!;
    expect(bumped).toContain("#EXT-X-MEDIA-SEQUENCE:9");
    expect(bumped).toContain("#EXT-X-DISCONTINUITY-SEQUENCE:5");
  });

  it("leaves the sequence untouched when nothing is dropped", () => {
    const upstream = playlist.replace("#EXT-X-TARGETDURATION:4", "#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:12");
    expect(rewriteLivePlaylist(upstream, "/p/", new Date("2026-10-13T09:00:00.000Z"))).toContain("#EXT-X-MEDIA-SEQUENCE:12");
  });
});

describe("liveSegmentNames", () => {
  it("lists only the segments the trimmed playlist would serve", () => {
    expect([...liveSegmentNames(playlist, new Date("2026-10-13T10:00:04.000Z"))!]).toEqual(["new.ts"]);
    expect([...liveSegmentNames(playlist)!]).toEqual(["old.ts", "new.ts"]);
    expect(liveSegmentNames("#EXTM3U\n#EXTINF:4,\nseg/old.ts\n", new Date())).toBeNull();
  });
});
