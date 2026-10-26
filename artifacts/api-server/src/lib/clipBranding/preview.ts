import fs from "fs";
import os from "os";
import path from "path";
import { createHash } from "crypto";
import { spawn } from "child_process";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { brandingAssetDir, ensureBrandingFonts, loadLocalImage, replayMarkPath } from "./assets";
import { drawEndScreenFrame } from "./endScreenFrame";
import { applyEndScreen, endScreenStart, FPS, type EndScreenJob } from "./endScreenVideo";
import { renderOverlayPng } from "./overlay";
import { publicBase } from "./plan";
import type { BrandLook, Dims, EndScreen, EndScreenKind, OverlayStyle } from "./types";

/**
 * The console's preview: the venue's real branding over real Jordan Galaxy
 * footage (assets/branding/preview), with sample numbers.
 *
 * The numbers are samples and the console says so; everything else — crest,
 * colours, names, fonts, timing — goes through exactly the code a real export
 * runs, so what the admin approves is what players get.
 */

export const PREVIEW_DIMS: Record<"9:16" | "16:9", Dims> = {
  "9:16": { w: 608, h: 1080 },
  "16:9": { w: 1920, h: 1080 },
};

export function sampleEndScreen(kind: EndScreenKind, look: BrandLook): EndScreen {
  // A link of the same length as a real share card, so the preview's QR has
  // the density an export's will.
  const common = { look, dateLabel: "SAT 24 OCT · 22:00", link: `${publicBase()}/s/1234/0123456789abcdef0123` };
  switch (kind) {
    case "player":
      return {
        ...common,
        kind,
        player: { big: "#10", sub: "Ahmad", awardAr: "متصدّر السرعة" },
        stats: [
          { value: 2, decimals: 0, unit: "", labelAr: "أهداف", best: false },
          { value: 24.3, decimals: 1, unit: "km/h", labelAr: "أعلى سرعة", best: true },
          { value: 4.6, decimals: 1, unit: "km", labelAr: "مسافة", best: false },
          { value: 3, decimals: 0, unit: "", labelAr: "تسديدة على المرمى", best: false },
        ],
      };
    case "match":
      return {
        ...common,
        kind,
        score: { a: 4, b: 3, aName: "Orange", bName: "White", aColor: "#FF6B1A", bColor: "#F2F4F8", aGoals: [8, 23, 41, 55], bGoals: [15, 33, 47] },
        motm: "#7 Omar",
      };
    case "academy":
      return {
        ...common,
        kind,
        player: { big: "#7", sub: null },
        ageGroup: "U-12",
        stats: [
          { value: 3.1, decimals: 1, unit: "km", labelAr: "مسافة", best: false, delta: { text: "12%", up: true } },
          { value: 21.4, decimals: 1, unit: "km/h", labelAr: "أعلى سرعة", best: false, delta: { text: "0.9", up: true } },
          { value: 2, decimals: 0, unit: "", labelAr: "تسديدة على المرمى", best: false, delta: { text: "1", up: true } },
        ],
      };
    default:
      return { ...common, kind: "signOff" };
  }
}

function aspectKey(dims: Dims): "portrait" | "landscape" {
  return dims.h > dims.w ? "portrait" : "landscape";
}

/** A still: the end screen settled, or the overlay over a sharp frame. */
export async function renderPreviewPng(input: {
  look: BrandLook;
  what: EndScreenKind | Exclude<OverlayStyle, "uploaded">;
  dims: Dims;
  blur: number;
  dim: number;
  /** A real card (a player's own) instead of the sample for `what`. */
  spec?: EndScreen;
}): Promise<Buffer> {
  ensureBrandingFonts();
  const { dims } = input;
  const portrait = dims.h > dims.w;
  const frame = await loadImage(path.join(brandingAssetDir(), "preview", `frame-${aspectKey(dims)}.jpg`));
  const mark = await loadLocalImage(replayMarkPath());
  const canvas = createCanvas(dims.w, dims.h);
  const ctx = canvas.getContext("2d");
  const isOverlay = input.what === "cornerCrest" || input.what === "broadcastBar" || input.what === "academyFrame";
  const scale = dims.w / (portrait ? 1080 : 1920);
  if (!isOverlay && input.blur > 0) ctx.filter = `blur(${Math.round(input.blur * scale)}px)`;
  ctx.drawImage(frame, 0, 0, dims.w, dims.h);
  ctx.filter = "none";
  if (isOverlay) {
    const png = renderOverlayPng({
      style: input.what as Exclude<OverlayStyle, "uploaded">,
      look: input.look,
      dims,
      dateLabel: "SAT 24 OCT · 22:00",
      tag: "U-12",
      mark,
    });
    ctx.drawImage(await loadImage(png), 0, 0);
  } else {
    ctx.scale(scale, scale);
    drawEndScreenFrame(ctx, input.spec ?? sampleEndScreen(input.what as EndScreenKind, input.look), 3, {
      portrait,
      total: 3,
      dim: input.dim,
      mark,
    });
  }
  return canvas.toBuffer("image/png");
}

const mp4Cache = new Map<string, { file: string; at: number; ttl: number }>();
const keyedSampleCache = new Map<string, { file: string; at: number }>();
const keyedSampleInFlight = new Map<string, Promise<string>>();
const MP4_TTL_MS = 15 * 60 * 1000;

/**
 * The bundled clips are only source footage, not production renders. Re-encode
 * them for the console preview so its card boundary is a real keyframe and the
 * footage can continue behind the card. Production exports still key their
 * main encode in ffmpegExport.ts.
 */
async function keyframePreviewSample(sample: string, aspect: string, start: number): Promise<string> {
  const key = `${aspect}:${start.toFixed(3)}`;
  const hit = keyedSampleCache.get(key);
  if (hit && Date.now() - hit.at < MP4_TTL_MS && fs.existsSync(hit.file)) {
    hit.at = Date.now();
    return hit.file;
  }
  const pending = keyedSampleInFlight.get(key);
  if (pending) return pending;

  const promise = (async () => {
    const out = path.join(os.tmpdir(), `soccerwatch-branding-sample-${createHash("sha1").update(key).digest("hex")}-${Date.now()}.mp4`);
    const proc = spawn("ffmpeg", [
      "-nostdin", "-y", "-v", "error", "-i", sample,
      "-map", "0:v:0", "-map", "0:a?",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "26", "-pix_fmt", "yuv420p",
      "-r", String(FPS), "-fps_mode", "cfr",
      "-c:a", "aac", "-b:a", "96k", "-ar", "44100", "-ac", "2",
      "-force_key_frames", start.toFixed(3),
      "-movflags", "+faststart", out,
    ], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr?.on("data", (data: Buffer) => { stderr = (stderr + data.toString()).slice(-4000); });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          proc.kill("SIGKILL");
          reject(new Error("ffmpeg timed out while preparing the branding preview source"));
        }, 300_000);
        proc.on("error", (err) => { clearTimeout(timer); reject(err); });
        proc.on("close", (code) => {
          clearTimeout(timer);
          if (code === 0) resolve();
          else reject(new Error(`ffmpeg could not prepare the branding preview source: ${stderr.slice(-1500)}`));
        });
      });
      keyedSampleCache.set(key, { file: out, at: Date.now() });
      return out;
    } catch (err) {
      fs.unlink(out, () => {});
      throw err;
    }
  })();
  keyedSampleInFlight.set(key, promise);
  try {
    return await promise;
  } finally {
    keyedSampleInFlight.delete(key);
  }
}

/**
 * The end screen played over a real clip, so the transition can be judged.
 * Cached per look and settings for a quarter of an hour: an admin flicking
 * between kinds should not re-encode every time.
 */
export async function renderPreviewMp4(input: {
  look: BrandLook;
  lookKey: string;
  kind: EndScreenKind;
  dims: Dims;
  seconds: number;
  blur: number;
  dim: number;
  /**
   * How long the file is kept. The public demo's fixed preset passes
   * Infinity: it never changes, and re-encoding it after a quarter of an
   * hour left prospects looking at black boxes while it rendered.
   */
  keepMs?: number;
}): Promise<string> {
  const ttl = input.keepMs ?? MP4_TTL_MS;
  const key = createHash("sha1")
    .update(JSON.stringify([input.lookKey, input.kind, input.dims, input.seconds, input.blur, input.dim]))
    .digest("hex");
  const hit = mp4Cache.get(key);
  if (hit && Date.now() - hit.at < hit.ttl && fs.existsSync(hit.file)) return hit.file;

  for (const [k, v] of mp4Cache) {
    if (Date.now() - v.at >= v.ttl) { fs.unlink(v.file, () => {}); mp4Cache.delete(k); }
  }
  for (const [k, v] of keyedSampleCache) {
    if (Date.now() - v.at >= MP4_TTL_MS) { fs.unlink(v.file, () => {}); keyedSampleCache.delete(k); }
  }

  const sample = path.join(brandingAssetDir(), "preview", `sample-${aspectKey(input.dims)}.mp4`);
  const duration = aspectKey(input.dims) === "portrait" ? 7.6 : 8;
  const start = endScreenStart(Math.max(0, duration - input.seconds));
  const keyedSample = await keyframePreviewSample(sample, aspectKey(input.dims), start);
  const job: EndScreenJob = {
    spec: sampleEndScreen(input.kind, input.look),
    seconds: input.seconds,
    blur: input.blur,
    dim: input.dim,
  };
  const out = await applyEndScreen({
    mainPath: keyedSample,
    dims: input.dims,
    job,
    start,
    encode: {
      video: ["-c:v", "libx264", "-preset", "veryfast", "-crf", "26", "-pix_fmt", "yuv420p", "-r", "30", "-fps_mode", "cfr"],
      audio: ["-c:a", "aac", "-b:a", "96k", "-ar", "44100", "-ac", "2"],
    },
    hasAudio: true,
  });
  const kept = path.join(os.tmpdir(), `soccerwatch-branding-preview-${key}.mp4`);
  await fs.promises.rename(out, kept).catch(async () => {
    await fs.promises.copyFile(out, kept);
    fs.unlink(out, () => {});
  });
  mp4Cache.set(key, { file: kept, at: Date.now(), ttl });
  return kept;
}
