import { describe, expect, it, vi } from "vitest";
import {
  canDecodeUhd,
  canUseUhdPlayback,
  createUhdStallGuard,
  isUhdPlaylistAvailable,
  readUhdPlaybackPreference,
  RECORDED_PLAYBACK_STAGE_ORDER,
  stageAfterUhd,
  uhdPlaybackUrlForGuid,
  uhdPlaybackUrlForStreamUrl,
  uhdPlaybackUrlForSource,
  UHD_HEVC_CODEC,
  UHD_PLAYBACK_PREFERENCE_KEY,
  writeUhdPlaybackPreference,
} from "./uhdPlayback";
import { decidePlaybackRecovery } from "../components/clip-player/playbackRecovery";

describe("recorded UHD playback eligibility and fallback", () => {
  it("uses native HLS codec support when the browser owns HLS playback", async () => {
    const canPlayType = vi.fn((type: string) =>
      type.includes(UHD_HEVC_CODEC) ? "probably" : type === "application/vnd.apple.mpegurl" ? "maybe" : "");
    expect(await canDecodeUhd({ canPlayType })).toBe(true);
    expect(canPlayType).toHaveBeenCalledWith(expect.stringContaining(UHD_HEVC_CODEC));

    expect(await canDecodeUhd({
      canPlayType: (type: string) => type === "application/vnd.apple.mpegurl" ? "maybe" : "",
    })).toBe(false);
  });

  it("requires MediaCapabilities to confirm smooth HEVC decoding for MSE", async () => {
    const decodingInfo = vi.fn().mockResolvedValue({ supported: true, smooth: true });
    expect(await canDecodeUhd({ canPlayType: () => "" }, { decodingInfo })).toBe(true);
    expect(decodingInfo).toHaveBeenCalledWith({
      type: "media-source",
      video: {
        contentType: expect.stringContaining(UHD_HEVC_CODEC),
        width: 4096,
        height: 1152,
        bitrate: 10_000_000,
        framerate: 20,
      },
    });
    expect(await canDecodeUhd(
      { canPlayType: () => "" },
      { decodingInfo: vi.fn().mockResolvedValue({ supported: true, smooth: false }) },
    )).toBe(false);
  });

  it("uses MediaCapabilities when generic HLS support does not confirm HEVC", async () => {
    const decodingInfo = vi.fn().mockResolvedValue({ supported: true, smooth: true });
    const canPlayType = vi.fn((type: string) => type === "application/vnd.apple.mpegurl" ? "maybe" : "");
    expect(await canDecodeUhd({ canPlayType }, { decodingInfo })).toBe(true);
    expect(decodingInfo).toHaveBeenCalledOnce();
  });

  it("does not treat a codec hint as smooth when MediaCapabilities disagrees", async () => {
    expect(await canDecodeUhd(
      { canPlayType: (type: string) => type.includes(UHD_HEVC_CODEC) ? "probably" : "" },
      { decodingInfo: vi.fn().mockResolvedValue({ supported: true, smooth: false }) },
    )).toBe(false);
  });

  it("rejects thrown capability checks rather than risking a broken 4K start", async () => {
    expect(await canDecodeUhd(
      { canPlayType: () => "" },
      { decodingInfo: vi.fn().mockRejectedValue(new Error("unsupported")) },
    )).toBe(false);
  });

  it("checks playlist availability without retaining the response body", async () => {
    const body = { cancel: vi.fn().mockResolvedValue(undefined) };
    const fetcher = vi.fn().mockResolvedValue({ ok: true, body });
    expect(await isUhdPlaylistAvailable("/api/hls-proxy/uhd/example.m3u8", fetcher)).toBe(true);
    expect(fetcher).toHaveBeenCalledWith("/api/hls-proxy/uhd/example.m3u8", {
      credentials: "include",
      cache: "no-store",
    });
    expect(body.cancel).toHaveBeenCalledOnce();
  });

  it("allows a smooth 4K H.264 source when HEVC is unavailable", async () => {
    const capabilities = {
      decodingInfo: vi.fn(async (configuration: MediaDecodingConfiguration) => ({
        supported: configuration.video.contentType.includes("avc1."),
        smooth: true,
        powerEfficient: true,
      })),
    };
    const fetcher = vi.fn().mockResolvedValue({ ok: true, body: { cancel: vi.fn() } });
    expect(await canUseUhdPlayback(
      { canPlayType: () => "" },
      "/api/hls-proxy/uhd/example.m3u8",
      capabilities,
      fetcher,
    )).toBe(true);
    expect(capabilities.decodingInfo).toHaveBeenCalledTimes(2);
    expect(capabilities.decodingInfo.mock.calls[1]?.[0].video).toMatchObject({
      width: 3840,
      height: 1080,
    });
  });

  it("keeps the preference across player instances and builds only valid recorded routes", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    };
    expect(readUhdPlaybackPreference(storage)).toBe("4k");
    writeUhdPlaybackPreference("hd", storage);
    expect(values.get(UHD_PLAYBACK_PREFERENCE_KEY)).toBe("hd");
    expect(readUhdPlaybackPreference(storage)).toBe("hd");
    expect(uhdPlaybackUrlForGuid("123e4567-e89b-12d3-a456-426614174000"))
      .toBe("/api/hls-proxy/uhd/123e4567-e89b-12d3-a456-426614174000.m3u8");
    expect(uhdPlaybackUrlForGuid("live:camera-1")).toBeNull();
    expect(uhdPlaybackUrlForStreamUrl(
      "/api/hls-proxy/manifest?url=https%3A%2F%2Fvz-123.b-cdn.net%2F123e4567-e89b-12d3-a456-426614174000%2Fplaylist.m3u8",
    )).toBe("/api/hls-proxy/uhd/123e4567-e89b-12d3-a456-426614174000.m3u8");
    expect(uhdPlaybackUrlForSource({ kind: "ownerShare", token: "a".repeat(32) }))
      .toBe(`/w/${"a".repeat(32)}/4k.m3u8`);
    expect(uhdPlaybackUrlForSource({ kind: "ownerShare", token: "bad-token" })).toBeNull();
  });

  it("tries UHD before Stream and falls directly back to the Stream CDN stage", async () => {
    expect(RECORDED_PLAYBACK_STAGE_ORDER).toEqual(["uhd", "cdn", "proxy", "fallback"]);
    expect(stageAfterUhd(true, true)).toBe("cdn");
    expect(stageAfterUhd(false, true)).toBe("proxy");
    expect(await decidePlaybackRecovery({
      currentStage: "uhd",
      hasCdn: true,
      hasProxy: true,
      currentRetryAttempted: false,
    })).toEqual({ type: "switch-source", stage: "cdn" });
  });

  it("switches only after two separate rebuffer stalls longer than two seconds", () => {
    let now = 0;
    let timerId = 0;
    const timers = new Map<number, () => void>();
    const onRepeatedStall = vi.fn();
    const guard = createUhdStallGuard({
      onRepeatedStall,
      now: () => now,
      setTimer: (callback) => {
        timerId += 1;
        timers.set(timerId, callback);
        return timerId;
      },
      clearTimer: (id) => { timers.delete(Number(id)); },
    });
    const finishCurrentStall = () => {
      const [id, callback] = [...timers.entries()][0];
      timers.delete(id);
      callback();
    };

    guard.waiting();
    now = 2_001;
    finishCurrentStall();
    guard.recovered();
    now = 10_000;
    guard.waiting();
    now = 12_001;
    finishCurrentStall();
    expect(onRepeatedStall).toHaveBeenCalledOnce();
    guard.dispose();
  });
});
