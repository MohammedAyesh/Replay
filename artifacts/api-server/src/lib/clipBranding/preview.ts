import fs from "fs";
import os from "os";
import path from "path";
import { createHash } from "crypto";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { brandingAssetDir, ensureBrandingFonts, loadLocalImage, replayMarkPath } from "./assets";
import { drawEndScreenFrame } from "./endScreenFrame";
import { applyEndScreen, endScreenStart, type EndScreenJob } from "./endScreenVideo";
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
          { value: 62, decimals: 0, unit: "", labelAr: "لمسة", best: false },
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
        player: { big: "#7", sub: "75 MIN ON CAMERA" },
        ageGroup: "U-12",
        stats: [
          { value: 3.1, decimals: 1, unit: "km", labelAr: "مسافة", best: false, delta: { text: "12%", up: true } },
          { value: 21.4, decimals: 1, unit: "km/h", labelAr: "أعلى سرعة", best: false, delta: { text: "0.9", up: true } },
          { value: 48, decimals: 0, unit: "", labelAr: "لمسة", best: false, delta: { text: "3", up: false } },
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
    drawEndScreenFrame(ctx, sampleEndScreen(input.what as EndScreenKind, input.look), 3, {
      portrait,
      total: 3,
      dim: input.dim,
      mark,
    });
  }
  return canvas.toBuffer("image/png");
}

const mp4Cache = new Map<string, { file: string; at: number }>();
const MP4_TTL_MS = 15 * 60 * 1000;

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
}): Promise<string> {
  const key = createHash("sha1")
    .update(JSON.stringify([input.lookKey, input.kind, input.dims, input.seconds, input.blur, input.dim]))
    .digest("hex");
  const hit = mp4Cache.get(key);
  if (hit && Date.now() - hit.at < MP4_TTL_MS && fs.existsSync(hit.file)) return hit.file;

  for (const [k, v] of mp4Cache) {
    if (Date.now() - v.at >= MP4_TTL_MS) { fs.unlink(v.file, () => {}); mp4Cache.delete(k); }
  }

  const sample = path.join(brandingAssetDir(), "preview", `sample-${aspectKey(input.dims)}.mp4`);
  const job: EndScreenJob = {
    spec: sampleEndScreen(input.kind, input.look),
    seconds: input.seconds,
    blur: input.blur,
    dim: input.dim,
  };
  const duration = aspectKey(input.dims) === "portrait" ? 7.6 : 8;
  const out = await applyEndScreen({
    mainPath: sample,
    dims: input.dims,
    job,
    start: endScreenStart(duration, input.seconds),
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
  mp4Cache.set(key, { file: kept, at: Date.now() });
  return kept;
}
