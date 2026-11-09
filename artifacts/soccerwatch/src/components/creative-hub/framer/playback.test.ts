import { describe, expect, it } from "vitest";
import { framerPlaybackEngine, framerSourceKey, initialSeekAction } from "./playback";

describe("Creative framer playback guards", () => {
  it("identifies native HLS, hls.js, and ManagedMediaSource engines", () => {
    expect(framerPlaybackEngine(false, false)).toBe("native-hls");
    expect(framerPlaybackEngine(true, false)).toBe("hls.js");
    expect(framerPlaybackEngine(true, true)).toBe("mms");
  });

  it("keys a load by engine, source kind, and exact URL", () => {
    expect(framerSourceKey("native-hls", "camera-4k", "/camera.m3u8"))
      .toBe(framerSourceKey("native-hls", "camera-4k", "/camera.m3u8"));
    expect(framerSourceKey("hls.js", "camera-4k", "/camera-window.m3u8"))
      .not.toBe(framerSourceKey("hls.js", "stream", "/stream.m3u8"));
  });

  it("waits for duration metadata, seeks once, then never repeats the opening seek", () => {
    const base = {
      sourceKey: "native-hls|camera-4k|/camera.m3u8",
      duration: 5400,
      target: 2700,
      currentTime: 0,
      seeking: false,
    };
    expect(initialSeekAction({ ...base, completedSourceKey: null })).toBe("seek");
    expect(initialSeekAction({ ...base, duration: 0, completedSourceKey: null })).toBe("wait");
    expect(initialSeekAction({ ...base, completedSourceKey: base.sourceKey })).toBe("ready");
    expect(initialSeekAction({ ...base, completedSourceKey: base.sourceKey, seeking: true })).toBe("wait");
  });
});
