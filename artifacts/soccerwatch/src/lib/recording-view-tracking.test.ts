import { describe, expect, it, vi } from "vitest";
import {
  createRecordingViewCallbacks,
  getRecordingViewInput,
} from "./recording-view-tracking";

const videoUrl = "https://vz-test.b-cdn.net/1e69d9ea-e5ef-4c20-990d-a4fd678f7ace/playlist.m3u8";

describe("recording playback view tracking inputs", () => {
  it("tracks a real family-session recording", () => {
    expect(getRecordingViewInput({
      id: 41,
      fieldId: 7,
      videoUrl,
    })).toEqual({ fieldId: 7, videoId: "1e69d9ea-e5ef-4c20-990d-a4fd678f7ace" });
  });

  it("tracks a recording opened from the public academies list", () => {
    expect(getRecordingViewInput({
      id: 42,
      fieldId: 8,
      videoUrl,
    })).toEqual({ fieldId: 8, videoId: "1e69d9ea-e5ef-4c20-990d-a4fd678f7ace" });
  });

  it("tracks a recording opened from the academy console", () => {
    expect(getRecordingViewInput({
      id: 43,
      fieldId: 9,
      videoUrl,
    })).toEqual({ fieldId: 9, videoId: "1e69d9ea-e5ef-4c20-990d-a4fd678f7ace" });
  });

  it("rejects missing recording identity and live media", () => {
    expect(getRecordingViewInput(null)).toBeNull();
    expect(getRecordingViewInput({ id: 0, fieldId: 9, videoUrl })).toBeNull();
    expect(getRecordingViewInput({ id: 45, fieldId: 0, videoUrl })).toBeNull();
    expect(getRecordingViewInput({ id: 46, fieldId: 9, videoUrl: "https://example.test/clip-export.mp4" })).toBeNull();
    expect(getRecordingViewInput({
      id: 47,
      fieldId: 9,
      videoUrl: "https://example.test/live:camera-1/index.m3u8",
    })).toBeNull();
    expect(getRecordingViewInput({
      id: 48,
      fieldId: 9,
      videoUrl: "not-a-url",
    })).toBeNull();
  });
});

describe("recording playback view callbacks", () => {
  it("records starts, batches watch time, and flushes a short remainder", () => {
    const recordView = vi.fn();
    const recordWatchTime = vi.fn();
    const callbacks = createRecordingViewCallbacks(
      { fieldId: 12, videoId: "recording-guid" },
      recordView,
      recordWatchTime,
    );

    callbacks.onPlaybackStart();
    callbacks.onPlaybackProgress(8.5);
    callbacks.onPlaybackProgress(4);
    callbacks.flush();

    expect(recordView).toHaveBeenCalledWith({ fieldId: 12, videoId: "recording-guid" });
    expect(recordWatchTime.mock.calls.map(([data]) => data)).toEqual([
      { fieldId: 12, videoId: "recording-guid", seconds: 12 },
    ]);
  });

  it("does not report starts or watch time for an untracked source", () => {
    const recordView = vi.fn();
    const recordWatchTime = vi.fn();
    const callbacks = createRecordingViewCallbacks(null, recordView, recordWatchTime);
    callbacks.onPlaybackStart();
    callbacks.onPlaybackProgress(20);
    callbacks.flush();

    expect(recordView).not.toHaveBeenCalled();
    expect(recordWatchTime).not.toHaveBeenCalled();
  });

  it("splits long watch-time updates into the server's 30-second limit", () => {
    const recordWatchTime = vi.fn();
    const callbacks = createRecordingViewCallbacks(
      { fieldId: 12, videoId: "recording-guid" },
      vi.fn(),
      recordWatchTime,
    );
    callbacks.onPlaybackProgress(38);
    callbacks.flush();

    expect(recordWatchTime.mock.calls.map(([data]) => data.seconds)).toEqual([30, 8]);
  });
});
