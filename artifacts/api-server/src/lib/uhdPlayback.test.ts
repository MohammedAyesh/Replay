import { afterEach, describe, expect, it, vi } from "vitest";
import {
  storageH264Or4kPlaylistUrl,
  streamlessStoragePlaylistUrl,
} from "./uhdPlayback";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("streamless Storage playback playlist selection", () => {
  it("uses H.264 directly when that playlist exists", async () => {
    const guid = "123e4567-e89b-12d3-a456-426614174001";
    const fetcher = vi.fn(async (_input: string | URL) => new Response("#EXTM3U\n#EXT-X-ENDLIST", { status: 200 }));
    vi.stubGlobal("fetch", fetcher);

    await expect(storageH264Or4kPlaylistUrl(guid)).resolves.toMatch(/\/vod\/123e4567-e89b-12d3-a456-426614174001\/h264\.m3u8$/);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]?.[0])).toMatch(/\/h264\.m3u8$/);
  });

  it("falls back to 4K only when H.264 is missing and never checks 8K", async () => {
    const guid = "123e4567-e89b-12d3-a456-426614174002";
    const calls: string[] = [];
    const fetcher = vi.fn(async (input: string | URL) => {
      const url = String(input);
      calls.push(url);
      return url.endsWith("/h264.m3u8")
        ? new Response(null, { status: 404 })
        : new Response("#EXTM3U\n#EXT-X-ENDLIST", { status: 200 });
    });
    vi.stubGlobal("fetch", fetcher);

    await expect(streamlessStoragePlaylistUrl(`https://replayjo.b-cdn.net/vod/${guid}/8k.m3u8`))
      .resolves.toMatch(new RegExp(`/vod/${guid}/4k\\.m3u8$`));
    expect(calls.map((url) => url.slice(url.lastIndexOf("/") + 1))).toEqual(["h264.m3u8", "4k.m3u8"]);
    expect(calls.every((url) => !url.endsWith("/8k.m3u8"))).toBe(true);
  });

  it("does not treat a failed H.264 request as a missing rendition", async () => {
    const guid = "123e4567-e89b-12d3-a456-426614174003";
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
      calls.push(String(input));
      return new Response("temporary error", { status: 503 });
    }));

    await expect(storageH264Or4kPlaylistUrl(guid)).resolves.toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/\/h264\.m3u8$/);
  });

  it("does not resolve non-Storage URLs or malformed identifiers", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await expect(streamlessStoragePlaylistUrl("https://cdn.example/video.m3u8")).resolves.toBeNull();
    await expect(storageH264Or4kPlaylistUrl("not-a-guid")).resolves.toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
