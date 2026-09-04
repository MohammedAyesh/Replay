import { describe, expect, it, vi } from "vitest";

vi.mock("./bunny", () => ({
  getBunnyPlaybackUrl: (videoId: string) => `https://cdn.example/${videoId}/playlist.m3u8`,
  getBunnyDirectMp4Url: (videoId: string, folder: string | number) => {
    const renditionFolder = typeof folder === "number" ? `${folder}p` : folder;
    return `https://cdn.example/${videoId}/play_${renditionFolder}.mp4`;
  },
}));

import {
  ExportSourceResolutionError,
  parseHlsMasterVariants,
  selectExportSource,
} from "./exportSource";

const REFERER = "https://app.example/";

function mockFetch(...responses: Response[]) {
  const fetchSpy = vi.spyOn(globalThis, "fetch");
  for (const response of responses) {
    fetchSpy.mockResolvedValueOnce(response);
  }
  return fetchSpy;
}

function expectRefererOnEveryRequest(fetchSpy: ReturnType<typeof vi.spyOn>) {
  expect(fetchSpy.mock.calls.length).toBeGreaterThan(0);
  for (const [, init] of fetchSpy.mock.calls) {
    expect(init).toEqual(expect.objectContaining({
      headers: { Referer: REFERER },
    }));
  }
}

describe("export source selection", () => {
  it("selects a single 3840x1080 variant even when its folder is named 1080p", async () => {
    const fetchSpy = mockFetch(
      new Response(
        "#EXTM3U\n" +
        "#EXT-X-STREAM-INF:BANDWIDTH=100,RESOLUTION=3840x1080\n" +
        "1080p/video.m3u8\n",
        { status: 200 },
      ),
      new Response("#EXTM3U\n#EXT-X-TARGETDURATION:4\n", { status: 200 }),
    );

    try {
      const source = await selectExportSource({
        videoId: "video-id",
        hasMP4Fallback: false,
        referer: REFERER,
      });

      expect(source).toEqual({
        url: "https://cdn.example/video-id/1080p/video.m3u8",
        path: "verified HLS variant playlist",
        variant: {
          url: "https://cdn.example/video-id/1080p/video.m3u8",
          folder: "1080p",
          width: 3840,
          height: 1080,
        },
      });
      expectRefererOnEveryRequest(fetchSpy);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("chooses the exact geometry after a lower-resolution rung", async () => {
    const fetchSpy = mockFetch(
      new Response(
        "#EXTM3U\n" +
        "#EXT-X-STREAM-INF:BANDWIDTH=100,RESOLUTION=1920x540\n" +
        "1080p/video.m3u8\n" +
        "#EXT-X-STREAM-INF:BANDWIDTH=200,RESOLUTION=3840x1080\n" +
        "2160p/video.m3u8\n",
        { status: 200 },
      ),
      new Response("#EXTM3U\n#EXT-X-TARGETDURATION:4\n", { status: 200 }),
    );

    try {
      const source = await selectExportSource({
        videoId: "video-id",
        hasMP4Fallback: false,
        referer: REFERER,
      });

      expect(source.variant).toMatchObject({
        url: "https://cdn.example/video-id/2160p/video.m3u8",
        folder: "2160p",
        width: 3840,
        height: 1080,
      });
      expect(source.path).toBe("verified HLS variant playlist");
      expectRefererOnEveryRequest(fetchSpy);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("prefers a HEAD-verified direct MP4 from the matched variant folder", async () => {
    const fetchSpy = mockFetch(
      new Response(
        "#EXTM3U\n" +
        "#EXT-X-STREAM-INF:BANDWIDTH=100,RESOLUTION=3840x1080\n" +
        "2160p/video.m3u8\n",
        { status: 200 },
      ),
      new Response(null, { status: 206 }),
    );

    try {
      const source = await selectExportSource({
        videoId: "video-id",
        hasMP4Fallback: true,
        referer: REFERER,
      });

      expect(source).toEqual({
        url: "https://cdn.example/video-id/play_2160p.mp4",
        path: "HEAD-verified direct MP4",
        variant: {
          url: "https://cdn.example/video-id/2160p/video.m3u8",
          folder: "2160p",
          width: 3840,
          height: 1080,
        },
      });
      expect(fetchSpy).toHaveBeenCalledWith(
        "https://cdn.example/video-id/play_2160p.mp4",
        expect.objectContaining({ method: "HEAD" }),
      );
      expectRefererOnEveryRequest(fetchSpy);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("skips malformed entries and retains valid variants", () => {
    expect(parseHlsMasterVariants(
      "#EXTM3U\n" +
      "#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=3840x1080\n" +
      "not a URL\n" +
      "#EXT-X-STREAM-INF:BANDWIDTH=2,RESOLUTION=3840x1080\n" +
      "1080p/video.m3u8\n",
      "https://cdn.example/video-id/playlist.m3u8",
    )).toEqual([{
      url: "https://cdn.example/video-id/1080p/video.m3u8",
      folder: "1080p",
      width: 3840,
      height: 1080,
    }]);
  });

  it("throws with the required and observed geometries when no exact rung exists", async () => {
    const fetchSpy = mockFetch(
      new Response(
        "#EXTM3U\n" +
        "#EXT-X-STREAM-INF:BANDWIDTH=100,RESOLUTION=1920x540\n" +
        "1080p/video.m3u8\n",
        { status: 200 },
      ),
    );

    try {
      const rejection = selectExportSource({
        videoId: "video-id",
        hasMP4Fallback: false,
        referer: REFERER,
      });

      await expect(rejection).rejects.toBeInstanceOf(ExportSourceResolutionError);
      await expect(rejection).rejects.toThrow(
        "required 3840x1080 geometry; variants seen: 1920x540",
      );
      expectRefererOnEveryRequest(fetchSpy);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});