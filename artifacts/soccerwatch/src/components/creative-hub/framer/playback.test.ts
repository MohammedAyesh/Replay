import { describe, expect, it } from "vitest";
import { playbackSecondsAt } from "@/lib/creative-framing";
import { framerPlaybackEngine, framerSourceKey, initialSeekAction, resolveFramerPlaybackSource } from "./playback";

const camera = {
  kind: "camera-4k" as const,
  url: "/api/hls-proxy/uhd/camera.m3u8?fromMs=2700000&toMs=2715000",
  fullUrl: "/api/hls-proxy/uhd/camera.m3u8",
};

describe("Creative framer HLS source selection", () => {
  it("identifies native HLS, hls.js, and ManagedMediaSource engines", () => {
    expect(framerPlaybackEngine(false, false)).toBe("native-hls");
    expect(framerPlaybackEngine(true, false)).toBe("hls.js");
    expect(framerPlaybackEngine(true, true)).toBe("mms");
  });

  it("uses the full recording playlist for native HLS, not a window with an unreadable offset header", () => {
    expect(resolveFramerPlaybackSource(camera, "native-hls")).toEqual({
      url: camera.fullUrl,
      sourceType: "camera-4k-full",
    });
  });

  it("does not change a native source key when only the bounded window changes", () => {
    const first = resolveFramerPlaybackSource(camera, "native-hls")!;
    const second = resolveFramerPlaybackSource({
      ...camera,
      url: "/api/hls-proxy/uhd/camera.m3u8?fromMs=2705000&toMs=2715000",
    }, "native-hls")!;
    expect(framerSourceKey("native-hls", first.sourceType, first.url))
      .toBe(framerSourceKey("native-hls", second.sourceType, second.url));
    expect(framerSourceKey("hls.js", "camera-4k-window", camera.url))
      .not.toBe(framerSourceKey("hls.js", "camera-4k-window", second.url));
  });

  it("uses the bounded playlist for hls.js and ManagedMediaSource", () => {
    for (const engine of ["hls.js", "mms"] as const) {
      expect(resolveFramerPlaybackSource(camera, engine)).toEqual({
        url: camera.url,
        sourceType: "camera-4k-window",
      });
    }
  });

  it("maps the same recording seek to absolute time for native HLS and local time for a window", () => {
    const recordingStartMs = 2_700_000;
    const windowStartMs = 2_695_000;
    expect(playbackSecondsAt(recordingStartMs, 0)).toBe(2700);
    expect(playbackSecondsAt(recordingStartMs, windowStartMs)).toBe(5);
  });

  it("does not try a windowed camera playlist on native HLS without its full source", () => {
    expect(resolveFramerPlaybackSource({ ...camera, fullUrl: undefined }, "native-hls")).toBeNull();
  });

  it("keeps Stream source selection the same for each engine", () => {
    const stream = { kind: "stream" as const, url: "/api/hls-proxy/manifest?url=stream" };
    for (const engine of ["native-hls", "hls.js", "mms"] as const) {
      expect(resolveFramerPlaybackSource(stream, engine)).toEqual({
        url: stream.url,
        sourceType: "stream",
      });
    }
  });

  it("waits for a valid timeline, seeks once, then never seeks the opening frame again", () => {
    const base = {
      sourceKey: "native-hls|camera-4k-full|/full.m3u8",
      offsetReady: true,
      duration: 5400,
      target: 2700,
      currentTime: 0,
      seeking: false,
    };
    expect(initialSeekAction({ ...base, completedSourceKey: null })).toBe("seek");
    expect(initialSeekAction({ ...base, duration: 8, completedSourceKey: null })).toBe("wait");
    expect(initialSeekAction({ ...base, offsetReady: false, completedSourceKey: null })).toBe("wait");
    expect(initialSeekAction({ ...base, completedSourceKey: base.sourceKey })).toBe("ready");
    expect(initialSeekAction({ ...base, completedSourceKey: base.sourceKey, seeking: true })).toBe("wait");
  });
});
