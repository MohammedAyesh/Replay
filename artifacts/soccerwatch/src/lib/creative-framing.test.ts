import { describe, expect, it } from "vitest";
import { sceneSchema, framingWindow } from "@workspace/api-zod";
import { absPlaybackTimeMs, clipVideoScene, footageBox, framedVideoStyle, playbackSecondsAt, thin, zoomRange } from "./creative-framing";
import { changeFormat } from "./creative-editor-state";
import { framerStartFor } from "@/components/creative-hub/library";
import type { LibraryClip } from "./creative-hub-library-api";

const clip = (over: Partial<LibraryClip> = {}): LibraryClip => ({
  clipId: 7, title: "Top corner", status: "ready", aspectRatio: "16:9", createdAt: "", date: "2026-11-02", durationMs: 54_000, sessionId: null,
  source: { type: "clip", clipId: 7 }, window: { recordingId: 3, fromMs: 2_160_000, toMs: 2_214_000 }, still: null, thumbnailUrl: null, videoUrl: null, ...over,
} as LibraryClip);

describe("picking a clip opens the framer on it", () => {
  it("opens a clip on its own stretch of its recording", () => {
    expect(framerStartFor({ kind: "clip", clip: clip() })).toEqual({ type: "recording", recordingId: 3, fromMs: 2_160_000, toMs: 2_214_000 });
  });
  it("frames a clip with no recording behind it as it is", () => {
    expect(framerStartFor({ kind: "clip", clip: clip({ window: null }) })).toEqual({ type: "clip", clipId: 7, durationMs: 54_000 });
    expect(framerStartFor({ kind: "clip", clip: clip({ window: null, status: "processing" }) })).toBeNull();
  });
});

describe("absolute recording playback time", () => {
  it("keeps follow-ball drag keys on the full recording timeline", () => {
    const playheadSeconds = 45 * 60 + 5;
    const absMs = absPlaybackTimeMs(playheadSeconds, 0);
    expect(absMs).toBe(2_705_000);
    expect(playbackSecondsAt(absMs, 0)).toBe(playheadSeconds);
  });

  it("preserves an offset for clip files that use a local timeline", () => {
    expect(absPlaybackTimeMs(5, 12_000)).toBe(17_000);
    expect(playbackSecondsAt(17_000, 12_000)).toBe(5);
  });
});

describe("Make a 16:9 video", () => {
  const framed = {
    src: { type: "recording" as const, recordingId: 3, fromMs: 2_155_000, toMs: 2_219_000 },
    durationMs: 64_000,
    framing: { zoom: 0.45, keys: [[0, 0.2, 0.5], [64_000, 0.8, 0.5]] as [number, number, number][], mode: "ball" as const },
    branding: { overlay: false, endCard: true },
    shape: "wide" as const,
  };
  it("makes a valid wide scene of exactly the chosen footage, camera and branding", () => {
    const scene = clipVideoScene(framed, "en");
    expect(sceneSchema.parse(scene)).toBeTruthy();
    expect(scene).toMatchObject({ format: "wide", durationMs: 64_000, branding: { overlay: false, endCard: true } });
    expect(scene.layers[0]).toMatchObject({ kind: "video", src: framed.src, trimInMs: 0, trimOutMs: 64_000, w: 1920, h: 1080, framing: framed.framing });
  });
  it("shows the whole pitch uncut: a full-width band, black above and below", () => {
    const layer = clipVideoScene({ ...framed, framing: null }, "en").layers[0];
    expect(layer).not.toHaveProperty("framing");
    expect(layer).toMatchObject({ x: 0, y: 270, w: 1920, h: 540 });
  });
  it("makes a full-screen 9:16 video with a vertical camera", () => {
    const scene = clipVideoScene({ ...framed, shape: "tall" }, "en");
    expect(sceneSchema.parse(scene)).toBeTruthy();
    expect(scene.format).toBe("story");
    expect(scene.layers[0]).toMatchObject({ x: 0, y: 0, w: 1080, h: 1920, framing: framed.framing });
  });
  it("makes a 9:16 video with bars: a 16:9 band, or the whole panorama, across the middle", () => {
    expect(clipVideoScene({ ...framed, shape: "bars" }, "en").layers[0]).toMatchObject({ x: 0, y: 656, w: 1080, h: 608 });
    expect(clipVideoScene({ ...framed, shape: "bars", framing: null }, "en").layers[0]).toMatchObject({ x: 0, y: 808, w: 1080, h: 304 });
    expect(footageBox("bars", true).h / footageBox("tall", true).h).toBeLessThan(0.33);
  });
  it("zooms between the widest window that fills the frame and twice as close", () => {
    expect(zoomRange(16 / 9)).toEqual({ min: 0.25, max: 0.5 });
    const tall = zoomRange(9 / 16);
    expect(tall.max).toBeCloseTo(0.158, 3);
    const w = framingWindow({ zoom: tall.max, keys: [[0, 0.5, 0.5]] }, 0, 32 / 9, 9 / 16);
    expect(w.h).toBeCloseTo(1, 6);
  });
});

describe("the camera window", () => {
  it("is 16:9, inside the panorama, and moves with the keys", () => {
    const f = { zoom: 0.45, keys: [[0, 0.1, 0.5], [10_000, 0.9, 0.5]] as [number, number, number][] };
    const a = framingWindow(f, 0, 32 / 9, 16 / 9);
    const b = framingWindow(f, 10_000, 32 / 9, 16 / 9);
    expect(a.x).toBe(0);
    expect(b.x + b.w).toBeCloseTo(1, 6);
    expect((a.w * 32) / (a.h * 9)).toBeCloseTo(16 / 9, 3);
    const style = framedVideoStyle({ x: 0.25, y: 0, w: 0.5, h: 1 });
    expect(style).toMatchObject({ width: "200%", height: "100%", left: "-50%" });
  });
  it("thins long recordings and keeps both ends", () => {
    const xs = Array.from({ length: 1000 }, (_, i) => i);
    const t = thin(xs, 600);
    expect(t).toHaveLength(600);
    expect(t[0]).toBe(0);
    expect(t.at(-1)).toBe(999);
  });
});

describe("switching a design to 16:9 and back", () => {
  it("keeps full-frame footage full-frame", () => {
    const wide = clipVideoScene({ src: { type: "clip", clipId: 7 }, durationMs: 10_000, framing: { zoom: 0.45, keys: [[0, 0.5, 0.5]] }, branding: { overlay: true, endCard: true }, shape: "wide" }, "en");
    const post = changeFormat(wide, "post");
    const back = changeFormat(post, "wide");
    expect(back.format).toBe("wide");
    expect(back.layers[0]).toMatchObject({ x: 0, w: 1920 });
  });
});
