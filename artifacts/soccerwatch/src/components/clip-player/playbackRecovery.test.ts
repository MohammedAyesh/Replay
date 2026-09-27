import { afterEach, describe, expect, it, vi } from "vitest";
import {
  beginSeekDrag,
  changeSeekValue,
  clampPlaybackPosition,
  createPlaybackWatchdog,
  createSeekDragState,
  decidePlaybackRecovery,
  endSeekDrag,
  initialPlaybackSourceStage,
  isFallbackSourceAvailable,
  playbackPositionForRestore,
} from "./playbackRecovery";

afterEach(() => {
  vi.useRealTimers();
});

describe("ClipPlayer playback recovery", () => {
  it("commits a pointer drag seek once, at pointer release", () => {
    const state = createSeekDragState();
    const seek = vi.fn();

    beginSeekDrag(state, 10);
    for (const time of [14, 25, 48, 67, 100]) {
      const change = changeSeekValue(state, time);
      if (change.seekValue != null) seek(change.seekValue);
    }

    expect(seek).not.toHaveBeenCalled();
    const releasedAt = endSeekDrag(state);
    if (releasedAt != null) seek(releasedAt);

    expect(seek).toHaveBeenCalledTimes(1);
    expect(seek).toHaveBeenCalledWith(100);
  });

  it("ignores the trailing range change event after pointer release", () => {
    const state = createSeekDragState();
    const seek = vi.fn();

    beginSeekDrag(state, 10);
    changeSeekValue(state, 20);
    const releasedAt = endSeekDrag(state);
    if (releasedAt != null) seek(releasedAt);
    const trailingChange = changeSeekValue(state, 20);
    if (trailingChange.seekValue != null) seek(trailingChange.seekValue);

    expect(seek).toHaveBeenCalledTimes(1);
    expect(seek).toHaveBeenCalledWith(20);
  });

  it("keeps keyboard slider seeking immediate", () => {
    const state = createSeekDragState();
    const change = changeSeekValue(state, 42);
    expect(change.seekValue).toBe(42);
  });

  it("clears a buffering timeout when playback advances", () => {
    vi.useFakeTimers();
    let currentTime = 8;
    const onStalled = vi.fn();
    const onProgress = vi.fn();
    const watchdog = createPlaybackWatchdog({
      getSnapshot: () => ({ paused: false, currentTime, seeking: false }),
      onStalled,
      onProgress,
    });

    watchdog.waiting();
    currentTime = 8.5;
    watchdog.progress();
    vi.advanceTimersByTime(25_000);

    expect(onStalled).not.toHaveBeenCalled();
    expect(onProgress).toHaveBeenCalledTimes(1);
    watchdog.dispose();
  });

  it("waits 20 seconds without progress and does not count paused time", () => {
    vi.useFakeTimers();
    let paused = false;
    const onStalled = vi.fn();
    const watchdog = createPlaybackWatchdog({
      getSnapshot: () => ({ paused, currentTime: 8, seeking: false }),
      onStalled,
      onProgress: vi.fn(),
    });

    watchdog.waiting();
    vi.advanceTimersByTime(10_000);
    paused = true;
    watchdog.pause();
    vi.advanceTimersByTime(25_000);
    expect(onStalled).not.toHaveBeenCalled();

    paused = false;
    watchdog.resume();
    vi.advanceTimersByTime(19_999);
    expect(onStalled).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onStalled).toHaveBeenCalledTimes(1);
    watchdog.dispose();
  });

  it("allows a 30-second seek to finish within the 45-second seek window", () => {
    vi.useFakeTimers();
    let currentTime = 120;
    let seeking = true;
    const onStalled = vi.fn();
    const watchdog = createPlaybackWatchdog({
      getSnapshot: () => ({ paused: false, currentTime, seeking }),
      onStalled,
      onProgress: vi.fn(),
    });

    watchdog.seeking();
    vi.advanceTimersByTime(30_000);
    expect(onStalled).not.toHaveBeenCalled();

    currentTime = 150;
    seeking = false;
    watchdog.progress();
    vi.advanceTimersByTime(20_000);
    expect(onStalled).not.toHaveBeenCalled();
    watchdog.dispose();
  });

  it("switches a failed direct source to the proxy and preserves its playhead", async () => {
    const decision = await decidePlaybackRecovery({
      currentStage: "direct",
      hasProxy: true,
      fallbackSrc: "https://cdn.example.test/video.mp4",
      currentRetryAttempted: false,
      isFallbackAvailable: vi.fn(),
    });

    expect(decision).toEqual({ type: "switch-source", stage: "proxy" });
    expect(playbackPositionForRestore(2_530, 2_520)).toBe(2_530);
    expect(playbackPositionForRestore(0, 2_530)).toBe(2_530);
    expect(clampPlaybackPosition(2_530, 3_600)).toBe(2_530);
  });

  it("starts with the proxy on browsers that only support native HLS", () => {
    expect(initialPlaybackSourceStage({
      hlsSupported: false,
      nativeHlsSupported: true,
      isLive: false,
      proxySrc: "/api/hls-proxy/manifest?url=encoded",
    })).toBe("proxy");
  });

  it("checks an MP4 fallback with a one-byte range request", async () => {
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("Range")).toBe("bytes=0-0");
      return new Response(null, { status: 206 });
    }) as unknown as typeof fetch;

    await expect(isFallbackSourceAvailable("https://cdn.example.test/video.mp4", fetcher))
      .resolves.toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("treats a missing MP4 response as unavailable", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 404 })) as unknown as typeof fetch;
    await expect(isFallbackSourceAvailable("https://cdn.example.test/missing.mp4", fetcher))
      .resolves.toBe(false);
  });

  it("retries the current source when the fallback is missing, then errors after that retry fails", async () => {
    const options = {
      currentStage: "proxy" as const,
      hasProxy: true,
      fallbackSrc: "https://cdn.example.test/missing.mp4",
      isFallbackAvailable: vi.fn(async () => false),
    };

    await expect(decidePlaybackRecovery({
      ...options,
      currentRetryAttempted: false,
    })).resolves.toEqual({ type: "retry-current" });

    await expect(decidePlaybackRecovery({
      ...options,
      currentRetryAttempted: true,
    })).resolves.toEqual({ type: "error" });
  });
});