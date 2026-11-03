import { afterAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CreativeBrand, Scene, SceneLayer } from "@workspace/api-zod";
import { DUCK, atempoChain, audioMixFilters, buildFfmpegArgs, musicFilters, musicMixFor, overlayIntervals, planStack, renderSceneMp4, type MusicMix } from "./renderVideo";

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
    expect(stack.map((s) => (s.type === "stills" ? s.layers.map((l) => l.id).join("+") : `${s.type}:${s.layer.id}`)))
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
