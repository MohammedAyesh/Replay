import { describe, expect, it, vi } from "vitest";
import { Camera4kNotReadyError, waitForCamera4kSource } from "./clipExportSource";

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
      path: "camera-original-4k HLS",
      duration: 6,
      renditionLabel: null,
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

  it("fails immediately for a permanent 4K access error rather than selecting Stream", async () => {
    const getPlaylist = vi.fn().mockRejectedValue(new Error("HTTP 403"));
    await expect(waitForCamera4kSource(guid, {
      getPlaylist,
      timeoutMs: 45_000,
      sleep: vi.fn(),
    })).rejects.toThrow("HTTP 403");
    expect(getPlaylist).toHaveBeenCalledTimes(1);
  });
});
