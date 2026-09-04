import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// getBunnyPlaybackUrl reads BUNNY_CDN_HOSTNAME at module load, so the env has
// to be set before the dynamic import below.
process.env.BUNNY_CDN_HOSTNAME = "vz-03425ccd-3d0.b-cdn.net";

const {
  selectExportSource,
  parseMasterPlaylist,
  ExportSourceUnavailableError,
  EXPORT_SOURCE_WIDTH,
  EXPORT_SOURCE_HEIGHT,
} = await import("./exportSource");

/**
 * Both playlist bodies below are RECORDED, not invented — captured from
 * library 694315 on 2026-09-04 via
 *   curl -H "Referer: https://vz-03425ccd-3d0.b-cdn.net/" \
 *        https://vz-03425ccd-3d0.b-cdn.net/<guid>/playlist.m3u8
 *
 * They are the whole reason this module matches on RESOLUTION instead of on a
 * rendition name: note that "1080p/video.m3u8" is 3840x1080 in the first and
 * 1920x540 in the second.
 */

/** cam1_2026-08-31_22:00, guid aede2d5f-7a10-42fa-b72d-abffd609ec84 */
const MASTER_SINGLE_RUNG = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:BANDWIDTH=7942818,AVERAGE-BANDWIDTH=7564800,RESOLUTION=3840x1080,CODECS="avc1.640032,mp4a.40.2"
1080p/video.m3u8
`;

/** cam1_2026-08-22_01:00, guid da6b484a-8677-458c-934b-8a1e079fdb39 */
const MASTER_TWO_RUNGS = `#EXTM3U
#EXT-X-VERSION:3

#EXT-X-STREAM-INF:BANDWIDTH=7749701,AVERAGE-BANDWIDTH=7357552,CODECS="avc1.640020,mp4a.40.2",RESOLUTION=1920x540,CLOSED-CAPTIONS=NONE
1080p/video.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=27036736,AVERAGE-BANDWIDTH=25745384,CODECS="avc1.640032,mp4a.40.2",RESOLUTION=3840x1080,CLOSED-CAPTIONS=NONE
2160p/video.m3u8
`;

/** What the ladder looks like after A2 adds a 480p rung to a two-rung video. */
const MASTER_THREE_RUNGS = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:BANDWIDTH=1500000,RESOLUTION=854x240,CODECS="avc1.64001f,mp4a.40.2"
480p/video.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=7749701,RESOLUTION=1920x540,CODECS="avc1.640020,mp4a.40.2"
1080p/video.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=27036736,RESOLUTION=3840x1080,CODECS="avc1.640032,mp4a.40.2"
2160p/video.m3u8
`;

const MEDIA_PLAYLIST = "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:4\n";

const REFERER = "https://vz-03425ccd-3d0.b-cdn.net/";

let fetchSpy: ReturnType<typeof vi.spyOn>;

/** Serve a scripted body per URL suffix; anything unmatched is a 404. */
function mockCdn(routes: Record<string, { status?: number; body: string }>) {
  fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any) => {
    const url = typeof input === "string" ? input : input.url;
    for (const [suffix, r] of Object.entries(routes)) {
      if (url.endsWith(suffix)) {
        return new Response(r.body, { status: r.status ?? 200 });
      }
    }
    return new Response("not found", { status: 404 });
  }) as any;
}

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { fetchSpy?.mockRestore(); });

describe("parseMasterPlaylist", () => {
  it("reads RESOLUTION when it is the last attribute", () => {
    expect(parseMasterPlaylist(MASTER_SINGLE_RUNG)).toEqual([
      { width: 3840, height: 1080, uri: "1080p/video.m3u8", label: "1080p", bandwidth: 7942818 },
    ]);
  });

  it("reads RESOLUTION when it is mid-list and a blank line precedes the tags", () => {
    const v = parseMasterPlaylist(MASTER_TWO_RUNGS);
    expect(v).toHaveLength(2);
    expect(v[0]).toMatchObject({ width: 1920, height: 540, label: "1080p" });
    expect(v[1]).toMatchObject({ width: 3840, height: 1080, label: "2160p" });
  });

  it("ignores a stream tag with no RESOLUTION rather than guessing", () => {
    expect(parseMasterPlaylist("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nfoo.m3u8\n")).toEqual([]);
  });
});

describe("selectExportSource", () => {
  it("resolves the single 3840x1080 rung when the label happens to be 1080p", async () => {
    mockCdn({
      "/playlist.m3u8": { body: MASTER_SINGLE_RUNG },
      "/1080p/video.m3u8": { body: MEDIA_PLAYLIST },
    });

    const source = await selectExportSource({
      videoId: "aede2d5f-7a10-42fa-b72d-abffd609ec84",
      hasMP4Fallback: false,
      availableResolutions: "1080p",
      referer: REFERER,
    });

    expect(source.width).toBe(EXPORT_SOURCE_WIDTH);
    expect(source.height).toBe(EXPORT_SOURCE_HEIGHT);
    expect(source.renditionLabel).toBe("1080p");
    expect(source.url).toBe(
      "https://vz-03425ccd-3d0.b-cdn.net/aede2d5f-7a10-42fa-b72d-abffd609ec84/1080p/video.m3u8",
    );
    expect(source.path).toBe("resolution-matched HLS variant");
  });

  it("picks the 3840x1080 rung and NOT the 1920x540 one listed first", async () => {
    mockCdn({
      "/playlist.m3u8": { body: MASTER_TWO_RUNGS },
      "/2160p/video.m3u8": { body: MEDIA_PLAYLIST },
      "/1080p/video.m3u8": { body: MEDIA_PLAYLIST },
    });

    const source = await selectExportSource({
      videoId: "da6b484a-8677-458c-934b-8a1e079fdb39",
      hasMP4Fallback: false,
      availableResolutions: "1080p,2160p",
      referer: REFERER,
    });

    // FFmpeg's own default stream selection on this master picks 1920x540 —
    // measured. Selecting by declared resolution is what avoids that.
    expect(source.url).toContain("/2160p/video.m3u8");
    expect([source.width, source.height]).toEqual([3840, 1080]);
  });

  it("still picks 3840x1080 once a 480p rung is added by A2", async () => {
    mockCdn({
      "/playlist.m3u8": { body: MASTER_THREE_RUNGS },
      "/2160p/video.m3u8": { body: MEDIA_PLAYLIST },
    });

    const source = await selectExportSource({
      videoId: "v", hasMP4Fallback: false,
      availableResolutions: "480p,1080p,2160p", referer: REFERER,
    });
    expect(source.url).toContain("/2160p/video.m3u8");
    expect([source.width, source.height]).toEqual([3840, 1080]);
  });

  it("throws instead of falling back when no variant declares 3840x1080", async () => {
    const halfScaleOnly = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:BANDWIDTH=7749701,RESOLUTION=1920x540,CODECS="avc1.640020"
1080p/video.m3u8
`;
    mockCdn({
      "/playlist.m3u8": { body: halfScaleOnly },
      "/1080p/video.m3u8": { body: MEDIA_PLAYLIST },
    });

    await expect(
      selectExportSource({
        videoId: "half-scale", hasMP4Fallback: false,
        availableResolutions: "1080p", referer: REFERER,
      }),
    ).rejects.toBeInstanceOf(ExportSourceUnavailableError);
  });

  it("never returns the master playlist URL", async () => {
    mockCdn({ "/playlist.m3u8": { body: MASTER_TWO_RUNGS } }); // variants 404

    const err = await selectExportSource({
      videoId: "v", hasMP4Fallback: false,
      availableResolutions: "1080p,2160p", referer: REFERER,
    }).catch((e) => e);

    expect(err).toBeInstanceOf(ExportSourceUnavailableError);
    expect(String(err.message)).not.toContain("playlist.m3u8\"");
    expect(String(err.message)).toContain("3840x1080");
  });

  it("reports the variants it saw, so a ladder change is diagnosable from one log line", async () => {
    mockCdn({
      "/playlist.m3u8": {
        body: `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1920x540\n1080p/video.m3u8\n`,
      },
    });
    const err: any = await selectExportSource({
      videoId: "v", hasMP4Fallback: false, availableResolutions: "1080p", referer: REFERER,
    }).catch((e) => e);
    expect(err.message).toContain("1920x540");
    expect(err.variantsSeen).toHaveLength(1);
  });

  it("sends the Referer on every request (the pull zone 403s without one)", async () => {
    mockCdn({
      "/playlist.m3u8": { body: MASTER_SINGLE_RUNG },
      "/1080p/video.m3u8": { body: MEDIA_PLAYLIST },
    });
    await selectExportSource({
      videoId: "v", hasMP4Fallback: false, availableResolutions: "1080p", referer: REFERER,
    });
    for (const call of fetchSpy.mock.calls) {
      expect((call[1] as RequestInit)?.headers).toMatchObject({ Referer: REFERER });
    }
  });

  it("prefers a HEAD-verified direct MP4 named after the matched rung", async () => {
    mockCdn({
      "/playlist.m3u8": { body: MASTER_TWO_RUNGS },
      "/play_2160p.mp4": { status: 206, body: "" },
      "/2160p/video.m3u8": { body: MEDIA_PLAYLIST },
    });

    const source = await selectExportSource({
      videoId: "v", hasMP4Fallback: true,
      availableResolutions: "1080p,2160p", referer: REFERER,
    });
    expect(source.path).toBe("HEAD-verified direct MP4");
    expect(source.url).toContain("/play_2160p.mp4");
    expect([source.width, source.height]).toEqual([3840, 1080]);
  });

  it("falls through to the HLS variant when the direct MP4 is missing", async () => {
    mockCdn({
      "/playlist.m3u8": { body: MASTER_TWO_RUNGS },
      "/2160p/video.m3u8": { body: MEDIA_PLAYLIST },
      // play_2160p.mp4 unmatched -> 404
    });
    const source = await selectExportSource({
      videoId: "v", hasMP4Fallback: true,
      availableResolutions: "1080p,2160p", referer: REFERER,
    });
    expect(source.path).toBe("resolution-matched HLS variant");
  });
});
