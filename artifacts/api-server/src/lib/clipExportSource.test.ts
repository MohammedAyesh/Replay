import { describe, expect, it, vi } from "vitest";
import { Camera4kNotReadyError, waitForCamera4kSource } from "./clipExportSource";
import { UhdPlaylistRequestError } from "./uhdPlayback";

const guid = "4c4b0afb-5e0f-4e15-8745-aef9e9a1497e";
const playlist = `#EXTM3U
#EXT-X-TARGETDURATION:6
#EXT-X-MAP:URI="4k.mp4",BYTERANGE="900@0"
#EXTINF:6.0,
#EXT-X-BYTERANGE:5000@900
4k.mp4
#EXT-X-ENDLIST`;
const playlistUrl = `https://storage.example/vod/${guid}/4k.m3u8`;

describe("waiting for a 4K-only clip export source", () => {
  it("returns the original playlist and its duration once a valid ranged source appears", async () => {
    let now = 0;
    const getPlaylist = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(playlist);
    const sleep = vi.fn(async (ms: number) => { now += ms; });
    const onWaiting = vi.fn();

    await expect(waitForCamera4kSource(guid, {
      getPlaylist,
      buildPlaylistUrl: () => playlistUrl,
      timeoutMs: 45_000,
      pollIntervalMs: 30_000,
      now: () => now,
      sleep,
      onWaiting,
    })).resolves.toMatchObject({
      kind: "camera-4k",
      url: playlistUrl,
      playlist,
      path: "camera-original-H.264-or-4K HLS",
      duration: 6,
      renditionLabel: null,
      rendition: "4k",
    });
    expect(getPlaylist).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(30_000);
    expect(onWaiting).toHaveBeenCalledWith(0, 45_000);
  });

  it("keeps retrying at 30-second intervals until the 45-minute deadline", async () => {
    let now = 0;
    const getPlaylist = vi.fn().mockResolvedValue(null);
    const sleep = vi.fn(async (ms: number) => { now += ms; });

    await expect(waitForCamera4kSource(guid, {
      getPlaylist,
      timeoutMs: 65_000,
      pollIntervalMs: 30_000,
      now: () => now,
      sleep,
    })).rejects.toBeInstanceOf(Camera4kNotReadyError);
    expect(getPlaylist).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([30_000, 30_000, 5_000]);
  });

  it("does not wait for IDs that cannot address the camera-original path", async () => {
    const getPlaylist = vi.fn();
    await expect(waitForCamera4kSource("live:camera-1", { getPlaylist }))
      .rejects.toThrow("No camera 4K source");
    expect(getPlaylist).not.toHaveBeenCalled();
  });

  it("returns the selected H.264 playlist without changing the camera clock", async () => {
    const h264Url = `https://storage.example/vod/${guid}/h264.m3u8`;
    const getSource = vi.fn().mockResolvedValue({
      videoGuid: guid,
      rendition: "h264",
      url: h264Url,
      playlist,
    });

    await expect(waitForCamera4kSource(guid, { getSource, timeoutMs: 1 }))
      .resolves.toMatchObject({ url: h264Url, playlist, rendition: "h264", duration: 6 });
    expect(getSource).toHaveBeenCalledWith(guid);
  });

  it("chooses the H.264 Storage playlist for an export and never requests 8K", async () => {
    const requests: string[] = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      requests.push(String(input));
      return new Response(playlist, { status: 200 });
    });
    try {
      const source = await waitForCamera4kSource(guid, { timeoutMs: 1 });
      expect(source.rendition).toBe("h264");
      expect(source.url).toMatch(new RegExp(`/vod/${guid}/h264\\.m3u8$`));
      expect(requests.map((url) => url.slice(url.lastIndexOf("/") + 1))).toEqual(["h264.m3u8"]);
      expect(requests.every((url) => !url.endsWith("/8k.m3u8"))).toBe(true);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("uses 4K only when H.264 is missing and still never requests 8K", async () => {
    const fallbackGuid = "a1d64853-8136-49d9-b973-87ee88a13837";
    const requests: string[] = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      requests.push(url);
      return url.endsWith("/h264.m3u8")
        ? new Response(null, { status: 404 })
        : new Response(playlist, { status: 200 });
    });
    try {
      const source = await waitForCamera4kSource(fallbackGuid, { timeoutMs: 1 });
      expect(source.rendition).toBe("4k");
      expect(source.url).toMatch(new RegExp(`/vod/${fallbackGuid}/4k\\.m3u8$`));
      expect(requests.map((url) => url.slice(url.lastIndexOf("/") + 1))).toEqual(["h264.m3u8", "4k.m3u8"]);
      expect(requests.every((url) => !url.endsWith("/8k.m3u8"))).toBe(true);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("fails immediately for a permanent 4K access error rather than selecting Stream", async () => {
    const getPlaylist = vi.fn().mockRejectedValue(new UhdPlaylistRequestError(403));
    await expect(waitForCamera4kSource(guid, {
      getPlaylist,
      timeoutMs: 45_000,
      sleep: vi.fn(),
    })).rejects.toThrow("HTTP 403");
    expect(getPlaylist).toHaveBeenCalledTimes(1);
  });
});
