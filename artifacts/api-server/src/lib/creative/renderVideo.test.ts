import { afterAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import {
  PUSH_MS, blurAt, buildTemplateScene, entranceAt, sceneForData, slowZoomAt, slowZoomsLayer, templateSampleData, SLOW_ZOOM_TO, type CreativeBrand, type Scene, type SceneLayer,
} from "@workspace/api-zod";
import { renderSceneCanvas } from "./render";
import {
  DUCK, atempoChain, audioMixFilters, blurFilter, buildFfmpegArgs, entranceXY, musicFilters, musicMixFor, overlayIntervals, photoVideoMaxrateKbps, planStack,
  renderSceneMp4, slowZoomFilter, type MusicMix,
} from "./renderVideo";

const work = fs.mkdtempSync(path.join(os.tmpdir(), "creative-video-test-"));
afterAll(() => fs.rmSync(work, { recursive: true, force: true }));

const BRAND: CreativeBrand = { primary: "#F4CF1F", accent: "#D4FF4F", ink: "#0B0F1A", paper: "#FFFFFF", muted: "#8A93A6", nameEn: "GALAXY", nameAr: null };

const rect = (id: string, extra: Partial<SceneLayer> = {}): SceneLayer =>
  ({ id, kind: "shape", shape: "rect", x: 0, y: 0, w: 100, h: 100, fill: "#FFFFFF", ...extra }) as SceneLayer;

describe("video overlay intervals", () => {
  it("one interval per change in which layers show, merged and without gaps", () => {
    const layers = [
      rect("all"),
      rect("intro", { endMs: 2000 }),
      rect("mid", { startMs: 1000, endMs: 3000 }),
      rect("outro", { startMs: 4000 }),
    ];
    expect(overlayIntervals(layers, 5000)).toEqual([
      { fromMs: 0, toMs: 1000, ids: ["all", "intro"] },
      { fromMs: 1000, toMs: 2000, ids: ["all", "intro", "mid"] },
      { fromMs: 2000, toMs: 3000, ids: ["all", "mid"] },
      { fromMs: 3000, toMs: 4000, ids: ["all"] },
      { fromMs: 4000, toMs: 5000, ids: ["all", "outro"] },
    ]);
  });

  it("leaves out stretches where nothing shows and merges identical neighbours", () => {
    expect(overlayIntervals([rect("a", { startMs: 1000, endMs: 2000 })], 5000)).toEqual([{ fromMs: 1000, toMs: 2000, ids: ["a"] }]);
    // A layer that starts and ends inside another's window adds cuts, not extra PNGs when it is hidden from the run.
    expect(overlayIntervals([rect("a"), rect("b", { startMs: 9000 })], 5000)).toEqual([{ fromMs: 0, toMs: 5000, ids: ["a"] }]);
  });

  it("stacks footage, animated layers and plain runs in scene order", () => {
    const scene: Scene = {
      v: 1, format: "story", durationMs: 3000, background: "#000000", locale: "en",
      layers: [
        rect("bg"),
        { id: "vid", kind: "video", src: { type: "clip", clipId: 1 }, x: 0, y: 0, w: 1080, h: 1920, fit: "cover", trimInMs: 0, speed: 1, muted: false },
        rect("bar"),
        rect("title", { enter: "fade", startMs: 500 }),
        rect("logo"),
        rect("gone", { hidden: true }),
      ],
    };
    const stack = planStack(scene, (l) => l.id === "vid");
    expect(stack.map((s) => (s.type === "stills" || s.type === "zoom" ? s.layers.map((l) => l.id).join("+") : `${s.type}:${s.layer.id}`)))
      .toEqual(["bg", "video:vid", "bar", "animated:title", "logo"]);
    // Footage that could not be loaded is drawn as a still with its neighbours.
    expect(planStack(scene, () => false)[0]).toMatchObject({ type: "stills" });
  });

  it("chains atempo for speeds outside 0.5–2", () => {
    expect(atempoChain(1)).toEqual([]);
    expect(atempoChain(0.25)).toEqual(["atempo=0.5", "atempo=0.500000"]);
    expect(atempoChain(3)).toEqual(["atempo=2", "atempo=1.500000"]);
  });

  it("silent scenes still get an AAC track", () => {
    const scene: Scene = { v: 1, format: "square", durationMs: 1000, background: "#000000", locale: "en", layers: [] };
    const args = buildFfmpegArgs({ scene, backgroundHex: "#000000", tracks: [], out: "/tmp/x.mp4" });
    expect(args.join(" ")).toContain("anullsrc");
    expect(args).toContain("aac");
    expect(args).toContain("libx264");
  });
});

describe("soundtrack filter graph", () => {
  const mix = (extra: Partial<MusicMix> = {}): MusicMix => ({ path: "/m.m4a", loudnessLufs: -14, volume: 0.6, startMs: 0, fadeInMs: 0, fadeOutMs: 0, duck: false, ...extra });
  const video = (music: Scene["music"], durationMs = 15000): Scene => ({ v: 1, format: "story", durationMs, background: "#000000", locale: "en", layers: [], music });

  it("cuts the looped track from its start point, gains it to -16 LUFS, then volume and fades", () => {
    const [chain] = musicFilters(3, mix({ startMs: 12500, fadeInMs: 500, fadeOutMs: 1500 }), 15000);
    expect(chain).toBe("[3:a]atrim=start=12.500:end=27.500,asetpts=PTS-STARTPTS,aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,"
      + "volume=-2.00dB,volume=0.600,afade=t=in:st=0:d=0.500,afade=t=out:st=13.500:d=1.500[am]");
  });

  it("measures loudness while mixing when the track was never measured, and skips a gain it doesn't need", () => {
    expect(musicFilters(1, mix({ loudnessLufs: null }), 5000)[0]).toContain("loudnorm=I=-16:TP=-1.5:LRA=11,aresample=44100,volume=0.600");
    const quiet = musicFilters(1, mix({ loudnessLufs: -16 }), 5000)[0];
    expect(quiet).not.toContain("dB");
    expect(quiet).not.toContain("afade");
    // A very quiet upload is lifted at most 12 dB.
    expect(musicFilters(1, mix({ loudnessLufs: -50 }), 5000)[0]).toContain("volume=12.00dB");
  });

  it("takes the scene's settings, fitting fades into the scene and clamping volume", () => {
    const m = musicMixFor(video({ trackId: 4, volume: 0.3, startMs: 2000, fadeInMs: 4000, fadeOutMs: 4000, duck: true }, 6000), { path: "/x.m4a", loudnessLufs: -12 });
    expect(m).toEqual({ path: "/x.m4a", loudnessLufs: -12, volume: 0.3, startMs: 2000, fadeInMs: 3000, fadeOutMs: 3000, duck: true });
    expect(musicMixFor(video({ volume: 0.6 }), { path: "/x.m4a", loudnessLufs: null })).toBeNull();
    expect(musicMixFor(video({ trackId: 1, volume: 0.6 }), null)).toBeNull();
  });

  it("sums footage and music, or ducks the music under the footage with a sidechain", () => {
    expect(audioMixFilters([], null, false, 5000)).toEqual([]);
    expect(audioMixFilters(["a0"], null, false, 5000)).toEqual(["[a0]amix=inputs=1:duration=longest:normalize=0,apad[aout]"]);
    expect(audioMixFilters(["a0"], "am", false, 5000)).toEqual(["[a0][am]amix=inputs=2:duration=longest:normalize=0,apad,alimiter=limit=0.891:level=false[aout]"]);
    // Nothing to duck under: duck is ignored.
    expect(audioMixFilters([], "am", true, 5000)).toEqual(["[am]amix=inputs=1:duration=longest:normalize=0,apad,alimiter=limit=0.891:level=false[aout]"]);
    const ducked = audioMixFilters(["a0", "a2"], "am", true, 5000);
    expect(ducked).toEqual([
      "[a0][a2]amix=inputs=2:duration=longest:normalize=0,apad=whole_dur=5.000[voice]",
      "[voice]asplit=2[voicemix][voicekey]",
      `[am][voicekey]sidechaincompress=threshold=${DUCK.threshold}:ratio=${DUCK.ratio}:attack=${DUCK.attackMs}:release=${DUCK.releaseMs}[amd]`,
      "[voicemix][amd]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.891:level=false[aout]",
    ]);
    expect(audioMixFilters(["a0"], "am", true, 5000)[0]).toBe("[a0]apad=whole_dur=5.000[voice]");
  });

  it("opens the track looping and maps the mix; a scene without music keeps the silent track", () => {
    const scene = video({ trackId: 9, volume: 0.5 }, 4000);
    const args = buildFfmpegArgs({ scene, backgroundHex: "#000000", tracks: [], music: musicMixFor(scene, { path: "/song.m4a", loudnessLufs: -16 }), out: "/tmp/x.mp4" });
    const at = args.indexOf("/song.m4a");
    expect(args.slice(at - 3, at + 1)).toEqual(["-stream_loop", "-1", "-i", "/song.m4a"]);
    expect(args.join(" ")).toContain("[1:a]atrim=start=0.000:end=4.000");
    expect(args[args.indexOf("-map", args.indexOf("[vout]")) + 1]).toBe("[aout]");
    expect(args.join(" ")).not.toContain("anullsrc");
    // The older form (a file path, no measurement) still mixes, measured on the fly.
    const legacy = buildFfmpegArgs({ scene: video({ trackKey: "old", volume: 0.4 }, 4000), backgroundHex: "#000000", tracks: [], musicPath: "/old.m4a", out: "/tmp/x.mp4" });
    expect(legacy.join(" ")).toContain("loudnorm=I=-16");
    expect(legacy.join(" ")).toContain("volume=0.400");
  });
});

function probe(file: string) {
  const out = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height:format=duration", "-of", "json", file]).toString();
  return JSON.parse(out) as { streams: Array<{ codec_type: string; codec_name: string; width?: number; height?: number }>; format: { duration: string } };
}

function frameAt(file: string, t: number, x: number, y: number): number[] {
  const raw = execFileSync("ffmpeg", ["-nostdin", "-loglevel", "error", "-ss", String(t), "-i", file, "-frames:v", "1",
    "-vf", `crop=2:2:${x}:${y}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
  return [...raw.subarray(0, 3)];
}

describe("video renderer", () => {
  it("renders footage, timed overlays and an entrance into a 1080-wide H.264 + AAC MP4", async () => {
    const src = path.join(work, "src.mp4");
    // 6 s of solid red with a tone: easy to find in the output.
    execFileSync("ffmpeg", ["-nostdin", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "color=c=red:s=640x360:r=30:d=6", "-f", "lavfi", "-i", "sine=frequency=440:duration=6",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", src]);
    const scene: Scene = {
      v: 1, format: "post", durationMs: 2500, background: "#0B0F1A", locale: "en",
      layers: [
        { id: "vid", kind: "video", src: { type: "binding", path: "media" }, x: 0, y: 200, w: 1080, h: 600, fit: "cover",
          trimInMs: 500, speed: 1.5, slowMo: { fromMs: 1000, toMs: 1500, speed: 0.5 }, muted: false, rotation: 0 },
        { id: "bar", kind: "shape", shape: "rect", x: 0, y: 1250, w: 1080, h: 100, fill: "@primary", startMs: 1000 },
        { id: "title", kind: "text", text: "GOAL", font: "display", size: 140, weight: 700, color: "#FFFFFF", align: "center", dir: "auto",
          x: 0, y: 900, w: 1080, h: 200, enter: "fade", startMs: 500 },
      ],
    };
    const out = path.join(work, "out.mp4");
    let asked: unknown = null;
    await renderSceneMp4({
      scene, brand: BRAND, data: { media: { type: "clip", clipId: 7 } },
      videos: async (_layer, s, need) => { asked = { s, need }; return { path: src, zeroAtSec: 0, durationMs: 6000, hasAudio: true }; },
      workDir: work, out,
    });
    expect(asked).toMatchObject({ s: { type: "clip", clipId: 7 }, need: { fromMs: 500 } });
    const info = probe(out);
    const v = info.streams.find((s) => s.codec_type === "video");
    const a = info.streams.find((s) => s.codec_type === "audio");
    expect(v).toMatchObject({ codec_name: "h264", width: 1080, height: 1350 });
    expect(a?.codec_name).toBe("aac");
    expect(Number(info.format.duration)).toBeGreaterThan(2.3);
    expect(Number(info.format.duration)).toBeLessThan(2.7);
    // Footage in its box, background outside it.
    const inBox = frameAt(out, 0.3, 540, 500);
    expect(inBox[0]).toBeGreaterThan(180);
    expect(inBox[1]).toBeLessThan(80);
    const outside = frameAt(out, 0.3, 540, 100);
    expect(outside[0]).toBeLessThan(40);
    // The bar appears at 1 s, not before.
    expect(frameAt(out, 0.5, 540, 1300)[0]).toBeLessThan(40);
    expect(frameAt(out, 1.5, 540, 1300)[0]).toBeGreaterThan(200);
  }, 60_000);

  it("frames panoramic footage with a moving 16:9 camera (framing keys), in the 1920×1080 wide format", async () => {
    // A 32:9 "panorama": red left third, green middle third, blue right third. Source time 0 is 1 s into the file.
    const pano = path.join(work, "pano.mp4");
    execFileSync("ffmpeg", ["-nostdin", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "color=c=green:s=1920x540:r=30:d=5",
      "-vf", "drawbox=x=0:y=0:w=640:h=540:color=red:t=fill,drawbox=x=1280:y=0:w=640:h=540:color=blue:t=fill",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", pano]);
    const scene: Scene = {
      v: 1, format: "wide", durationMs: 3000, background: "#000000", locale: "en",
      layers: [{
        id: "vid", kind: "video", src: { type: "recording", recordingId: 1, fromMs: 0, toMs: 3000 }, x: 0, y: 0, w: 1920, h: 1080, fit: "cover",
        trimInMs: 0, speed: 1, muted: true,
        framing: { zoom: 0.3, keys: [[0, 0.15, 0.5], [600, 0.15, 0.5], [2400, 0.85, 0.5]], mode: "ball" },
      }],
    };
    const out = path.join(work, "framed.mp4");
    await renderSceneMp4({
      scene, brand: BRAND, data: {},
      videos: async () => ({ path: pano, zeroAtSec: 1, durationMs: 3000, hasAudio: false }),
      workDir: work, out,
    });
    const v = probe(out).streams.find((s) => s.codec_type === "video");
    expect(v).toMatchObject({ width: 1920, height: 1080 });
    // At the start the camera is on the red third (no green anywhere across the frame), at the end on the blue one.
    const start = [frameAt(out, 0.2, 100, 540), frameAt(out, 0.2, 960, 540), frameAt(out, 0.2, 1800, 540)];
    for (const px of start) expect(px[0]).toBeGreaterThan(180);
    const end = [frameAt(out, 2.8, 100, 540), frameAt(out, 2.8, 960, 540), frameAt(out, 2.8, 1800, 540)];
    for (const px of end) expect(px[2]).toBeGreaterThan(180);
    // Halfway the window straddles the middle third.
    expect(frameAt(out, 1.5, 960, 540)[1]).toBeGreaterThan(90);
  }, 60_000);

  it("makes 9:16 videos: a vertical camera filling the frame, or a 16:9 band between black bars", async () => {
    const pano = path.join(work, "pano916.mp4");
    execFileSync("ffmpeg", ["-nostdin", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "color=c=green:s=1920x540:r=30:d=4",
      "-vf", "drawbox=x=0:y=0:w=640:h=540:color=red:t=fill,drawbox=x=1280:y=0:w=640:h=540:color=blue:t=fill",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", pano]);
    const videos = async () => ({ path: pano, zeroAtSec: 0, durationMs: 2000, hasAudio: false });
    const layer = { id: "vid", kind: "video" as const, src: { type: "recording" as const, recordingId: 1, fromMs: 0, toMs: 2000 }, fit: "cover" as const, trimInMs: 0, speed: 1, muted: true };
    // Full-screen vertical: a narrow window on the red third fills the whole 1080×1920 frame.
    const tall = path.join(work, "tall.mp4");
    await renderSceneMp4({
      scene: { v: 1, format: "story", durationMs: 1500, background: "#000000", locale: "en",
        layers: [{ ...layer, x: 0, y: 0, w: 1080, h: 1920, framing: { zoom: 0.158, keys: [[0, 0.12, 0.5]] } }] },
      brand: BRAND, data: {}, videos, workDir: work, out: tall,
    });
    expect(probe(tall).streams.find((s) => s.codec_type === "video")).toMatchObject({ width: 1080, height: 1920 });
    for (const [x, y] of [[60, 60], [540, 960], [1020, 1860]]) expect(frameAt(tall, 0.5, x, y)[0]).toBeGreaterThan(180);
    // With bars: the 16:9 camera as a 1080×608 band across the middle, black above and below.
    const bars = path.join(work, "bars.mp4");
    await renderSceneMp4({
      scene: { v: 1, format: "story", durationMs: 1500, background: "#000000", locale: "en",
        layers: [{ ...layer, x: 0, y: 656, w: 1080, h: 608, framing: { zoom: 0.5, keys: [[0, 0.5, 0.5]] } }] },
      brand: BRAND, data: {}, videos, workDir: work, out: bars,
    });
    expect(Math.max(...frameAt(bars, 0.5, 540, 200))).toBeLessThan(30);
    expect(Math.max(...frameAt(bars, 0.5, 540, 1750))).toBeLessThan(30);
    // The band shows half the panorama: red, green and blue thirds' edges — green in the middle, red/blue at the sides.
    expect(frameAt(bars, 0.5, 540, 960)[1]).toBeGreaterThan(90);
    expect(frameAt(bars, 0.5, 30, 960)[0]).toBeGreaterThan(180);
    expect(frameAt(bars, 0.5, 1050, 960)[2]).toBeGreaterThan(180);
  }, 60_000);

  it("puts the venue's mark over the video and its sign-off card after it", async () => {
    const src = path.join(work, "plain.mp4");
    execFileSync("ffmpeg", ["-nostdin", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=green:s=640x360:r=30:d=3",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", src]);
    // The "mark": a white square in the top-left corner of an otherwise clear 1920×1080 PNG.
    const mark = path.join(work, "mark.png");
    execFileSync("ffmpeg", ["-nostdin", "-loglevel", "error", "-y",
      "-filter_complex", "color=c=black@0.0:s=1920x1080,format=rgba[b];color=c=white:s=200x200,format=rgba[w];[b][w]overlay=40:40:format=auto,format=rgba",
      "-frames:v", "1", mark]);
    const scene: Scene = {
      v: 1, format: "wide", durationMs: 2000, background: "#000000", locale: "en",
      layers: [{ id: "vid", kind: "video", src: { type: "clip", clipId: 1 }, x: 0, y: 0, w: 1920, h: 1080, fit: "cover", trimInMs: 0, speed: 1, muted: true }],
    };
    const out = path.join(work, "branded.mp4");
    const look = { nameEn: "Jordan Galaxy", nameAr: null, taglineAr: null, primaryColor: "#F4CF1F", accentColor: null, bookingPhone: null, instagram: null, crest: null, isAcademy: false };
    const done = await renderSceneMp4({
      scene, brand: BRAND, data: {},
      videos: async () => ({ path: src, zeroAtSec: 0, durationMs: 3000, hasAudio: false }),
      workDir: work, out,
      branding: { overlayPath: mark, endScreen: { spec: { kind: "signOff", look, dateLabel: null, link: "https://replayjo.com/v/galaxy" }, seconds: 2.5, blur: 14, dim: 0.45 } },
    });
    expect(done.durationMs).toBe(4500);
    const duration = Number(probe(out).format.duration);
    expect(duration).toBeGreaterThan(4.3);
    expect(duration).toBeLessThan(4.7);
    // The mark over the footage; the footage itself elsewhere.
    expect(Math.min(...frameAt(out, 1, 100, 100))).toBeGreaterThan(200);
    expect(frameAt(out, 1, 960, 900)[1]).toBeGreaterThan(90);
    // The card after it is not the plain green footage any more.
    const card = frameAt(out, 4.0, 960, 540);
    expect(card[1] > 90 && card[0] < 60 && card[2] < 60).toBe(false);
  }, 90_000);

  it("renders a scene with a soundtrack: looped from its start point, faded, ducked under the footage, at the scene's length", async () => {
    // 3 s of "music" (a 220 Hz tone) so a 7 s scene has to loop it; footage: 2 s of a 1 kHz tone from 2 s to 4 s.
    const song = path.join(work, "song.m4a");
    execFileSync("ffmpeg", ["-nostdin", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=220:duration=3", "-c:a", "aac", "-ac", "2", song]);
    const src = path.join(work, "talk.mp4");
    execFileSync("ffmpeg", ["-nostdin", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "color=c=blue:s=320x240:r=30:d=2", "-f", "lavfi", "-i", "sine=frequency=1000:duration=2",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", src]);
    const scene: Scene = {
      v: 1, format: "square", durationMs: 7000, background: "#000000", locale: "en",
      music: { trackId: 1, volume: 0.8, startMs: 1000, fadeInMs: 500, fadeOutMs: 1000, duck: true },
      layers: [
        { id: "vid", kind: "video", src: { type: "clip", clipId: 1 }, x: 0, y: 0, w: 1080, h: 1080, fit: "cover", trimInMs: 0, speed: 1, muted: false, startMs: 2000, endMs: 4000 },
      ],
    };
    const out = path.join(work, "music.mp4");
    await renderSceneMp4({
      scene, brand: BRAND, data: {},
      videos: async () => ({ path: src, zeroAtSec: 0, durationMs: 2000, hasAudio: true }),
      music: { path: song, loudnessLufs: null },
      workDir: work, out,
    });
    const info = probe(out);
    expect(info.streams.find((s) => s.codec_type === "audio")?.codec_name).toBe("aac");
    expect(Number(info.format.duration)).toBeGreaterThan(6.9);
    expect(Number(info.format.duration)).toBeLessThan(7.1);
    const level = (from: number, len: number, filter = "") => {
      const err = spawnSync("ffmpeg", ["-nostdin", "-hide_banner", "-ss", String(from), "-t", String(len), "-i", out, "-vn",
        "-af", `${filter}volumedetect`, "-f", "null", "-"], { encoding: "utf8" }).stderr;
      return Number(/mean_volume: (-?[\d.]+) dB/.exec(err)?.[1] ?? -99);
    };
    // Music plays where there is no footage, including after the track looped (5–6 s).
    const lowpass = "lowpass=f=400,";
    expect(level(1, 0.8, lowpass)).toBeGreaterThan(-40);
    expect(level(5, 0.8, lowpass)).toBeGreaterThan(-40);
    // Under the footage (2–4 s) the music is ducked by several dB.
    expect(level(1, 0.8, lowpass) - level(2.6, 0.8, lowpass)).toBeGreaterThan(5);
    // The fade-out takes it near silence at the very end; the fade-in starts from silence.
    expect(level(6.85, 0.12)).toBeLessThan(level(5, 0.5) - 10);
    expect(level(0, 0.05)).toBeLessThan(level(1, 0.5) - 10);
  }, 60_000);
});

describe("slow zoom (a photo turned into a video)", () => {
  const img = (id: string, extra: Partial<SceneLayer> = {}): SceneLayer =>
    ({ id, kind: "image", src: { type: "artwork", key: "bg/broadcast/1" }, fit: "cover", x: 0, y: 0, w: 1080, h: 1350, ...extra }) as SceneLayer;

  it("zooms only the background and full-bleed photos, 1 → 1.06 over the scene", () => {
    const art = { type: "artwork", key: "bg/broadcast/1" } as const;
    expect(slowZoomsLayer(img("plate"), art, "post")).toBe(true);
    expect(slowZoomsLayer(img("card", { x: 100, w: 400, h: 400 }), art, "post")).toBe(false);
    expect(slowZoomsLayer(img("crest"), { type: "crest" }, "post")).toBe(false);
    expect(slowZoomsLayer(img("fig", { fit: "contain" }), art, "post")).toBe(false);
    expect(slowZoomsLayer(img("cut"), { type: "player", playerId: 1, cutout: true }, "post")).toBe(false);
    expect(slowZoomsLayer(img("tilt", { rotation: 3 }), art, "post")).toBe(false);
    expect(slowZoomsLayer(img("in", { enter: "fade" }), art, "post")).toBe(false);
    expect(slowZoomsLayer(rect("shape", { w: 1080, h: 1350 }), art, "post")).toBe(false);
    const scene = { durationMs: 10_000, slowZoom: true };
    expect(slowZoomAt(scene, 0)).toBe(1);
    expect(slowZoomAt(scene, 5_000)).toBeCloseTo(1.03, 6);
    expect(slowZoomAt(scene, 99_000)).toBeCloseTo(SLOW_ZOOM_TO, 6);
    expect(slowZoomAt({ durationMs: 10_000 }, 5_000)).toBe(1);
  });

  it("gives zooming neighbours one overlay and caps the bitrate of a scene without footage", () => {
    const scene: Scene = { v: 1, format: "post", durationMs: 15_000, background: "#000000", locale: "en", slowZoom: true,
      layers: [img("plate"), img("photo"), rect("bar"), img("card", { x: 100, w: 300, h: 300 })] };
    const stack = planStack(scene, () => false, (l) => l.id === "plate" || l.id === "photo");
    expect(stack.map((s) => s.type)).toEqual(["zoom", "stills"]);
    expect(stack[0]).toMatchObject({ layers: [{ id: "plate" }, { id: "photo" }], origin: { x: 540, y: 675 } });
    expect(slowZoomFilter({ x: 540, y: 675 }, 15_000, { w: 1080, h: 1350 }))
      .toBe("zoompan=z='1+0.0600*min(1,on/450)':x='540.00*(1-1/zoom)':y='675.00*(1-1/zoom)':d=1:s=1080x1350:fps=30");
    const args = buildFfmpegArgs({ scene, backgroundHex: "#000000", tracks: [{ type: "png", path: "/a.png", fromMs: 0, toMs: 15_000, zoom: { x: 540, y: 675 } }], out: "/x.mp4" });
    expect(args.join(" ")).toContain("format=rgba,zoompan=");
    expect(args.join(" ")).toContain(`-maxrate ${photoVideoMaxrateKbps(15_000)}k`);
    // 10–15 s stay at 4 Mbit/s; 30 s comes down so the file stays under the target.
    expect(photoVideoMaxrateKbps(10_000)).toBe(4000);
    expect(photoVideoMaxrateKbps(30_000)).toBeLessThan(2100);
  });

  /** Raw RGB of a whole frame at t seconds. */
  const frameRgb = (file: string, t: number) =>
    execFileSync("ffmpeg", ["-nostdin", "-loglevel", "error", "-ss", t.toFixed(3), "-i", file, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: 64 * 1024 * 1024 });
  /** Mean absolute difference between an RGB frame and a canvas (RGBA). */
  const meanDiff = (rgb: Buffer, rgba: Uint8ClampedArray) => {
    let sum = 0;
    const n = rgb.length / 3;
    for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) sum += Math.abs(rgb[i * 3 + c]! - rgba[i * 4 + c]!);
    return sum / (n * 3);
  };

  for (const [key, format, durationMs] of [["lineup", "post", 15_000], ["birthday", "story", 10_000]] as const) {
    it(`renders a ${key} ${format} with music: H.264 + AAC, ${durationMs / 1000} s, small, the background zooming as the editor shows it`, async () => {
      const song = path.join(work, `${key}-song.m4a`);
      execFileSync("ffmpeg", ["-nostdin", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=330:duration=4", "-c:a", "aac", "-ac", "2", song]);
      // A fine checkerboard for every picture, so a zoom shows up everywhere.
      const checker = createCanvas(1080, 1920);
      const c = checker.getContext("2d");
      for (let y = 0; y < 1920; y += 30) for (let x = 0; x < 1080; x += 30) {
        c.fillStyle = (x + y) / 30 % 2 ? "#E03030" : "#20A0F0";
        c.fillRect(x, y, 30, 30);
      }
      const data = templateSampleData(key, "en");
      // As renderJobs does: the layers this data shows (a line-up without photos draws numbers only).
      const base = sceneForData(buildTemplateScene(key, "broadcast", format, "en"), data);
      const scene: Scene = { ...base, durationMs, slowZoom: true, music: { trackId: 1, volume: 0.6, fadeInMs: 300, fadeOutMs: 1500 } };
      const images = async (_l: unknown, src: { type: string }) => (src.type === "crest" ? null : checker);
      const out = path.join(work, `${key}.mp4`);
      await renderSceneMp4({ scene, brand: BRAND, data, images, videos: async () => null, music: { path: song, loudnessLufs: null }, workDir: work, out });

      const info = probe(out);
      expect(info.streams.find((x) => x.codec_type === "video")).toMatchObject({ codec_name: "h264", width: 1080, height: format === "story" ? 1920 : 1350 });
      expect(info.streams.find((x) => x.codec_type === "audio")?.codec_name).toBe("aac");
      expect(Math.abs(Number(info.format.duration) - durationMs / 1000)).toBeLessThan(0.15);
      expect(fs.statSync(out).size).toBeLessThan(8 * 1024 * 1024);
      const err = spawnSync("ffmpeg", ["-nostdin", "-hide_banner", "-ss", "2", "-t", "1", "-i", out, "-vn", "-af", "volumedetect", "-f", "null", "-"], { encoding: "utf8" }).stderr;
      expect(Number(/mean_volume: (-?[\d.]+) dB/.exec(err)?.[1] ?? -99)).toBeGreaterThan(-35);

      // The export's frame near the end matches the still renderer's frame at that time (zoomed), not its first frame.
      const T = durationMs / 1000 - 0.5;
      const frame = frameRgb(out, T);
      const at = async (t: number) => {
        const cv = await renderSceneCanvas({ scene, brand: BRAND, data, images, t, entrances: true });
        return cv.getContext("2d").getImageData(0, 0, cv.width, cv.height).data;
      };
      const synced = meanDiff(frame, await at(Math.round(T * 30) * (1000 / 30)));
      const unzoomed = meanDiff(frame, await at(0));
      expect(slowZoomAt(scene, T * 1000)).toBeGreaterThan(1.05);
      expect(synced).toBeLessThan(unzoomed * 0.6);
    }, 180_000);
  }
});

describe("field pack motion: pushes, wipes and the end card's blur", () => {
  it("pushes come in from a whole canvas away, the wipe crosses the canvas, blur switches on at its time", () => {
    const push = { id: "p", kind: "shape", shape: "rect", x: 0, y: 0, w: 1080, h: 1920, startMs: 1000, enter: "push-up" } as SceneLayer;
    expect(entranceAt(push, 1000, { w: 1080, h: 1920 }).dy).toBe(1920);
    expect(entranceAt(push, 1000 + PUSH_MS, { w: 1080, h: 1920 }).dy).toBe(0);
    expect(entranceAt({ ...push, enter: "push-down" } as SceneLayer, 1000, { w: 1080, h: 1920 }).dy).toBe(-1920);
    const wipe = { ...push, enter: "wipe", startMs: 2000, endMs: 2600 } as SceneLayer;
    expect(entranceAt(wipe, 2000, { w: 1080, h: 1920 }).dx).toBe(1080);
    expect(Math.abs(entranceAt(wipe, 2300, { w: 1080, h: 1920 }).dx)).toBeLessThan(1);
    expect(entranceAt(wipe, 2600, { w: 1080, h: 1920 }).dx).toBe(-1080);
    const vid = { id: "v", kind: "video", src: { type: "recording", recordingId: 1, fromMs: 0, toMs: 5000 }, x: 0, y: 0, w: 1080, h: 1920, blur: { fromMs: 4000, px: 22 } } as Extract<SceneLayer, { kind: "video" }>;
    expect(blurAt(vid, 3999)).toBe(0);
    expect(blurAt(vid, 4000)).toBe(22);
  });

  it("writes the same motion as ffmpeg expressions, and the blur on the layer's own clock", () => {
    expect(entranceXY("push-up", 1000, "0", "0").y).toBe("0+1920*pow(1-clip((t-1.000)/0.600,0,1),3)");
    expect(entranceXY("wipe", 2000, "0", "0", { w: 1080, h: 1920 }, 2600).x).toContain("0+1080*(1-2*");
    expect(blurFilter({ blur: { fromMs: 12000, px: 22 }, startMs: 2500 })).toBe(",boxblur=luma_radius=33:luma_power=2:chroma_radius=17:chroma_power=2:enable='gte(t,9.500)'");
    expect(blurFilter({ startMs: 0 })).toBe("");
  });

  // About 2 minutes on two cores: the field pack's moving layers are each their own overlay.
  it("renders a field award video: opening card, the wipe, the clip, and the end card over the clip blurred", async () => {
    const src = path.join(work, "pitch.mp4");
    // A sharp pattern: 8 px black and white bars (about 28 px once the 9:16 window fills the frame).
    // Blurred, they average out to grey.
    execFileSync("ffmpeg", ["-nostdin", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=white:s=1920x540:r=30:d=16",
      "-vf", "drawgrid=w=16:h=1080:t=8:c=black", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "12", src]);
    const built = buildTemplateScene("field-award", "field", "story", "en");
    const data = { ...templateSampleData("field-award", "en"), media: { type: "recording" as const, recordingId: 1, fromMs: 0, toMs: 15_000 } };
    const scene = { ...sceneForData(built, data), music: undefined } as Scene;
    const out = path.join(work, "field-award.mp4");
    await renderSceneMp4({
      scene, brand: BRAND, data,
      videos: async () => ({ path: src, zeroAtSec: 0, durationMs: 15_000, hasAudio: false }),
      workDir: work, out,
    });
    const v = probe(out).streams.find((s) => s.codec_type === "video");
    expect(v).toMatchObject({ width: 1080, height: 1920 });
    expect(Number(probe(out).format.duration)).toBeCloseTo(15, 0);
    // 2.5 s: halfway through its crossing, the wipe in the main colour covers the frame.
    const wiping = frameAt(out, 2.5, 540, 960);
    expect(wiping[0]).toBeGreaterThan(200);
    expect(wiping[2]).toBeLessThan(90);
    // 7 s: the clip, sharp: somewhere across a bar there is near-black and near-white.
    const row = (t: number) => Array.from({ length: 12 }, (_, i) => frameAt(out, t, 100 + i * 6, 700)[1]);
    expect(Math.min(...row(7))).toBeLessThan(60);
    expect(Math.max(...row(7))).toBeGreaterThan(160);
    // 14 s: under the end card the same bars are blurred (and dimmed): no near-white left.
    expect(Math.max(...row(14))).toBeLessThan(120);
  }, 400_000);
});
