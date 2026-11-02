import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CreativeBrand, Scene, SceneLayer } from "@workspace/api-zod";
import { atempoChain, buildFfmpegArgs, overlayIntervals, planStack, renderSceneMp4 } from "./renderVideo";

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
});
