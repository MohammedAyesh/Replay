import { spawn } from "child_process";
import { randomUUID } from "crypto";
import path from "path";
import fs from "fs";
import os from "os";
import { logger } from "./logger";

const SRC_W = 3840;
const SRC_H = 1080;

/**
 * Longest selection we will render, in seconds of source footage.
 *
 * Exceeding it is an error, not a silent trim: quietly returning 15 minutes of
 * a 25-minute clip marked "done" is worse than refusing it.
 */
const MAX_CLIP_SECONDS = Math.max(
  5,
  parseInt(process.env.MAX_CLIP_SECONDS ?? "1800", 10) || 1800,
);

/** Wall-clock ceiling on a single FFmpeg invocation. */
const FFMPEG_TIMEOUT_MS = Math.max(
  60_000,
  parseInt(process.env.FFMPEG_TIMEOUT_MS ?? "1800000", 10) || 1_800_000,
);

type KF = { t: number; x: number; y: number; w: number; h: number };

export interface FfmpegExportOptions {
  /** URL passed to FFmpeg as the input source (HLS or direct MP4). */
  videoUrl: string;
  /**
   * Total recording duration in seconds.
   * Obtained from the Bunny Stream Management API (server-to-server, no CDN access needed).
   */
  totalDuration: number;
  /** 0-1 fraction of total recording duration */
  startTime: number;
  endTime: number;
  cropPath: KF[];
  aspectRatio: string;
  title: string;
  /**
   * Optional Referer header to include in FFmpeg's HTTP requests.
   * Bunny CDN blocks requests without a matching Referer; pass the CDN origin
   * (e.g. "https://vz-xxx.b-cdn.net/") so the CDN accepts server-side fetches.
   */
  referer?: string;
}

export interface PrependIntroOptions {
  introUrl: string;
  clipPath: string;
  referer?: string;
  accessKey?: string;
}


/**
 * Build an FFmpeg crop filter string for the given keyframes.
 *
 * keyframe.t  — 0-1 fraction of clip duration (not recording duration)
 * keyframe.x  — left edge of crop window as fraction of SRC_W
 * keyframe.w  — width of crop window as fraction of SRC_W
 *
 * Returns a crop= filter string like "crop=1920:1080:x_expr:0".
 *
 * In FFmpeg filter option values, commas must be escaped as \, because the
 * filter graph parser uses comma to separate filters.
 */
// Maximum number of keyframes in the FFmpeg crop expression.
// FFmpeg's expression evaluator hits a recursion/depth limit with deeply nested if() chains;
// 30 segments is smooth enough for any pan and well within the limit.
const MAX_CROP_KEYFRAMES = 30;

const SRC_ASPECT = SRC_W / SRC_H;

/**
 * Detect and rewrite cropPaths written before the frame model existed.
 *
 * A valid frame satisfies h === w * SRC_ASPECT / outAspect, since the frame
 * carries the output aspect by construction. Legacy data violates that: 16:9
 * clips were stored as {x:0, w:1, y:0, h:1} and 9:16 clips stored w as a
 * fraction of the on-screen container with h pinned to 1. Rendering those with
 * the frame-derived crop size would stretch the whole panorama into the output
 * box; normalising to a zoom-1 frame at the same horizontal centre reproduces
 * what the old exporter actually did (centre-crop to the output width).
 *
 * Mirrors normalizeFrame in artifacts/soccerwatch/src/lib/cropFrame.ts —
 * keep the two in sync.
 */
/**
 * Hard bounds on the crop frame, in multiples of the source dimensions.
 *
 * cropPath keyframes arrive from the client validated only as bare numbers, and
 * `w`/`h` size the pad canvas below (`frameW = w * 3840`). Unclamped, a single
 * request carrying `{w: 50, h: 100}` makes FFmpeg allocate a 192000x108000
 * canvas — about 31 GB a frame — and takes the box down.
 *
 * The ceiling must sit ABOVE anything the editor can produce, or normalizePath
 * below sees the clamped frame, decides `h !== w * srcAspect / outAspect`,
 * classifies a perfectly good frame as pre-frame-model legacy data and rewrites
 * it to a zoom-1 centre crop. field-detail.tsx caps 9:16 at MAX_FRAME_ZOOM = 4,
 * where `h === zoom === 4`, so 4.5 leaves headroom while keeping the worst-case
 * canvas at 19200x5400 instead of unbounded.
 */
const MAX_FRAME_SCALE = 4.5;
/**
 * Canvas ceilings, per dimension.
 *
 * A 9:16 clip at the editor's maximum zoom has h = 4, and a full vertical pan
 * across it needs 1080 + 3240 + 3240 = 7560 rows of canvas — so the height
 * ceiling has to clear that or a legitimate pan gets cut. Width never needs
 * padding in practice (16:9 tops out at w = 0.5, 9:16 at w ≈ 0.63), so 2x is
 * already slack. Worst case is now 7680x8640 rather than unbounded.
 */
const MAX_CANVAS_W_SCALE = 2;
const MAX_CANVAS_H_SCALE = 8;

/** Clamp client-supplied keyframes into a range FFmpeg can survive. */
function sanitizeKeyframes(kfs: KF[]): KF[] {
  if (!Array.isArray(kfs)) return [];
  const num = (v: unknown, fallback: number) =>
    typeof v === "number" && Number.isFinite(v) ? v : fallback;
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  return kfs
    .filter((kf) => kf && typeof kf === "object")
    .map((kf) => ({
      t: clamp(num(kf.t, 0), 0, 1),
      // Position may legitimately sit outside the source — that is how a clip
      // gets black bars — but only by the amount the frame itself can span.
      x: clamp(num(kf.x, 0), -MAX_FRAME_SCALE, MAX_FRAME_SCALE),
      y: clamp(num(kf.y, 0), -MAX_FRAME_SCALE, MAX_FRAME_SCALE),
      w: clamp(num(kf.w, 0), 0, MAX_FRAME_SCALE),
      h: clamp(num(kf.h, 1), 0, MAX_FRAME_SCALE),
    }));
}

function normalizePath(kfs: KF[], is9to16: boolean): KF[] {
  if (!kfs || kfs.length === 0) return kfs;
  const outAspect = is9to16 ? 9 / 16 : 16 / 9;
  const baseW = outAspect / SRC_ASPECT;
  return kfs.map((kf) => {
    const w = kf.w > 0 ? kf.w : baseW;
    const derivedH = (w * SRC_ASPECT) / outAspect;
    if (Math.abs((kf.h ?? 1) - derivedH) <= 0.02) return kf;
    const cx = (kf.x ?? 0) + w / 2;
    const h = (baseW * SRC_ASPECT) / outAspect;
    const lo = Math.min(0, 1 - baseW);
    const hi = Math.max(0, 1 - baseW);
    return {
      t: kf.t,
      x: Math.max(lo, Math.min(hi, cx - baseW / 2)),
      y: 0,
      w: baseW,
      h,
    };
  });
}

/** Linear interpolation of a keyframe path at time t (same units as kf.t). */
function sampleAt(kfs: KF[], t: number): KF {
  if (kfs.length === 1) return kfs[0];
  if (t <= kfs[0].t) return kfs[0];
  const last = kfs[kfs.length - 1];
  if (t >= last.t) return last;
  const nextIdx = kfs.findIndex((k) => k.t > t);
  if (nextIdx <= 0) return last;
  const a = kfs[nextIdx - 1];
  const b = kfs[nextIdx];
  const span = b.t - a.t;
  const p = span > 1e-6 ? (t - a.t) / span : 0;
  return {
    t,
    x: a.x + (b.x - a.x) * p,
    y: a.y + (b.y - a.y) * p,
    w: a.w + (b.w - a.w) * p,
    h: a.h + (b.h - a.h) * p,
  };
}

/**
 * Resample the pan path onto MAX_CROP_KEYFRAMES evenly spaced points in TIME.
 *
 * Sampling by index (the previous approach) weights each recorded keyframe
 * equally, but keyframes are emitted on a fixed wall-clock interval while their
 * timestamps come from the video clock. A playback stall therefore piles up many
 * keyframes at the same instant and, sampled by index, that frozen moment
 * consumed a disproportionate share of the budget and starved real camera
 * motion of resolution.
 */
function downsampleKeyframes(kfs: KF[]): KF[] {
  if (kfs.length <= MAX_CROP_KEYFRAMES) return kfs;
  const t0 = kfs[0].t;
  const t1 = kfs[kfs.length - 1].t;
  if (!(t1 > t0)) return [kfs[0], kfs[kfs.length - 1]];
  const result: KF[] = [];
  for (let i = 0; i < MAX_CROP_KEYFRAMES; i++) {
    const t = t0 + ((t1 - t0) * i) / (MAX_CROP_KEYFRAMES - 1);
    result.push(sampleAt(kfs, t));
  }
  return result;
}

/**
 * Build the video filter chain: pad -> crop -> scale.
 *
 * The crop frame is allowed to extend beyond the source (that's how a clip gets
 * deliberate black bars), but FFmpeg's crop filter cannot read outside the input.
 * So the source is first padded onto a larger black canvas big enough to contain
 * every frame position the pan visits, and the crop then runs entirely inside
 * that canvas. Regions of the frame that fall outside the original picture pick
 * up the pad colour — black bars, exactly as previewed.
 *
 * Frame SIZE is taken from the first keyframe and held constant for the clip
 * (only position animates), which keeps the crop dimensions fixed and lets the
 * whole pan be expressed as a single x/y expression.
 */
function buildVideoFilter(keyframes: KF[], clipDuration: number, is9to16: boolean): string {
  const OUT_W = is9to16 ? Math.round(SRC_H * 9 / 16) : 1920;
  const OUT_H = SRC_H;

  const kfs = downsampleKeyframes(normalizePath(sanitizeKeyframes(keyframes), is9to16));

  const fallbackW = is9to16 ? (SRC_H * 9 / 16) / SRC_W : 0.5;
  const w0 = kfs[0]?.w && kfs[0].w > 0 ? kfs[0].w : fallbackW;
  const h0 = kfs[0]?.h && kfs[0].h > 0 ? kfs[0].h : 1;

  // Frame size in source pixels (may exceed SRC_W / SRC_H — that's the black space)
  const rawFrameW = Math.max(2, Math.round(w0 * SRC_W));
  const rawFrameH = Math.max(2, Math.round(h0 * SRC_H));

  const xsSrc = kfs.map((kf) => (kf.x ?? 0) * SRC_W);
  const ysSrc = kfs.map((kf) => (kf.y ?? 0) * SRC_H);
  const minX = xsSrc.length ? Math.min(...xsSrc) : 0;
  const maxX = xsSrc.length ? Math.max(...xsSrc) : 0;
  const minY = ysSrc.length ? Math.min(...ysSrc) : 0;
  const maxY = ysSrc.length ? Math.max(...ysSrc) : 0;

  // Padding needed on each side so every visited frame position is in-canvas
  const padLeft = Math.max(0, Math.ceil(-minX));
  const padTop = Math.max(0, Math.ceil(-minY));
  const padRight = Math.max(0, Math.ceil(maxX + rawFrameW - SRC_W));
  const padBottom = Math.max(0, Math.ceil(maxY + rawFrameH - SRC_H));

  // Belt and braces on top of sanitizeKeyframes: whatever the inputs, the
  // canvas FFmpeg is asked to allocate stays bounded.
  const canvasW = Math.min(SRC_W * MAX_CANVAS_W_SCALE, SRC_W + padLeft + padRight);
  const canvasH = Math.min(SRC_H * MAX_CANVAS_H_SCALE, SRC_H + padTop + padBottom);

  // A frame larger than the (clamped) canvas would make crop= fail outright.
  // Only reachable from inputs sanitizeKeyframes already rejected as nonsense;
  // render a valid, if oddly framed, clip rather than erroring the job.
  const frameW = Math.min(rawFrameW, canvasW);
  const frameH = Math.min(rawFrameH, canvasH);

  const needsPad = padLeft > 0 || padTop > 0 || padRight > 0 || padBottom > 0;
  const padFilter = needsPad
    ? `pad=${canvasW}:${canvasH}:${padLeft}:${padTop}:black,`
    : "";

  // Crop coordinates are relative to the padded canvas
  const toCanvasX = (kf: KF) =>
    Math.round(Math.max(0, Math.min(canvasW - frameW, (kf.x ?? 0) * SRC_W + padLeft)));
  const toCanvasY = (kf: KF) =>
    Math.round(Math.max(0, Math.min(canvasH - frameH, (kf.y ?? 0) * SRC_H + padTop)));

  const scaleFilter = `scale=${OUT_W}:${OUT_H}:force_original_aspect_ratio=disable`;

  if (kfs.length === 0) {
    const x = Math.round((canvasW - frameW) / 2);
    const y = Math.round((canvasH - frameH) / 2);
    return `${padFilter}crop=${frameW}:${frameH}:${x}:${y},${scaleFilter}`;
  }

  if (kfs.length === 1) {
    return `${padFilter}crop=${frameW}:${frameH}:${toCanvasX(kfs[0])}:${toCanvasY(kfs[0])},${scaleFilter}`;
  }

  // Convert keyframe t-fractions to absolute seconds within the clip (filter t starts at 0)
  const pts = kfs.map((kf) => ({
    t: kf.t * clipDuration,
    x: toCanvasX(kf),
    y: toCanvasY(kf),
  }));

  // Build piecewise linear expressions with plain commas throughout,
  // then escape exactly once at the end before embedding in the filter string.
  // Calling esc() inside the loop AND on the outer wrap causes double-escaping:
  //   \,  →  \\,  which FFmpeg reads as literal-backslash + filter-separator.
  function buildExpr(axis: "x" | "y"): string {
    let expr = `${pts[pts.length - 1][axis]}`;
    for (let i = pts.length - 2; i >= 0; i--) {
      const a = pts[i];
      const b = pts[i + 1];
      const tDiff = b.t - a.t;
      let segExpr: string;
      if (tDiff < 0.001) {
        segExpr = `${a[axis]}`;
      } else {
        const slope = (b[axis] - a[axis]) / tDiff;
        segExpr = `${a[axis]}+${slope.toFixed(4)}*(t-${a.t.toFixed(4)})`;
      }
      expr = `if(lt(t,${b.t.toFixed(4)}),${segExpr},${expr})`;
    }
    return expr;
  }

  const esc = (s: string) => s.replace(/,/g, "\\,");
  const xExpr = esc(`max(0,min(${canvasW - frameW},${buildExpr("x")}))`);
  const yExpr = esc(`max(0,min(${canvasH - frameH},${buildExpr("y")}))`);

  return `${padFilter}crop=${frameW}:${frameH}:${xExpr}:${yExpr},${scaleFilter}`;
}

/**
 * Render a trimmed, cropped MP4 clip via FFmpeg.
 * Returns the path to a temporary file that the caller is responsible for deleting.
 */
export async function renderClip(options: FfmpegExportOptions): Promise<string> {
  const { videoUrl, totalDuration, startTime, endTime, cropPath, aspectRatio, title, referer } = options;

  logger.info({ title, startTime, endTime, totalDuration }, "Starting FFmpeg render");

  const startSec = Math.max(0, Math.min(totalDuration, isFinite(startTime) ? startTime * totalDuration : 0));
  const endSec = Math.max(0, Math.min(totalDuration, isFinite(endTime) ? endTime * totalDuration : totalDuration));
  // startTime/endTime are unbounded numbers on the wire, and an hour-long
  // selection at -preset slow -crf 16 occupies the encoder for far longer than
  // it takes to request another one.
  const clipDuration = Math.max(0.1, endSec - startSec);
  if (clipDuration > MAX_CLIP_SECONDS) {
    throw new Error(
      `Clip is ${Math.round(clipDuration)}s, longer than the ${MAX_CLIP_SECONDS}s export limit`,
    );
  }
  const is9to16 = aspectRatio === "9:16";
  // Includes pad (for out-of-source black bars), crop pan, and the output scale
  const cropFilter = buildVideoFilter(cropPath, clipDuration, is9to16);

  const tmpPath = path.join(os.tmpdir(), `soccerwatch-clip-${randomUUID()}.mp4`);

  logger.info({ tmpPath, startSec, endSec, clipDuration, cropFilter }, "FFmpeg args ready");

  // Build HTTP headers string for CDN access.
  // Bunny CDN blocks server-side requests without browser-like headers;
  // adding a matching Referer + a browser User-Agent bypasses that restriction.
  const headerVal = [
    referer ? `Referer: ${referer}` : null,
    "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  ].filter(Boolean).join("\r\n") + "\r\n";

  const args = [
    // HTTP headers must come before -i so they apply to the input request
    "-headers", headerVal,
    // Fast seek before input (segment-level for HLS)
    "-ss", String(startSec),
    "-i", videoUrl,
    // Clip duration
    "-t", String(clipDuration),
    // pad -> crop pan -> scale, all built together so black bars survive
    "-vf", cropFilter,
    // H.264 video, fast encode, web-compatible
    "-c:v", "libx264",
    "-preset", "slow",
    "-crf", "16",
    "-pix_fmt", "yuv420p",
    // AAC audio
    "-c:a", "aac",
    "-b:a", "128k",
    // Optimise for streaming/download
    "-movflags", "+faststart",
    // Overwrite output
    "-y",
    tmpPath,
  ];

  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args);

    // Keep only the tail of stderr. FFmpeg emits a progress line per second and
    // the full log was retained for the life of the process; on a stalled input
    // that grew without bound.
    let stderr = "";
    proc.stderr.on("data", (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-8000);
    });

    // An HLS input that stalls leaves FFmpeg alive forever, holding a render
    // slot and its clip's in-flight entry with it.
    const timeout = setTimeout(() => {
      logger.error({ tmpPath, FFMPEG_TIMEOUT_MS }, "FFmpeg render timed out — killing");
      proc.kill("SIGKILL");
    }, FFMPEG_TIMEOUT_MS);

    proc.on("error", (err) => {
      clearTimeout(timeout);
      logger.error({ err }, "FFmpeg process error");
      reject(err);
    });

    proc.on("close", (code, signal) => {
      clearTimeout(timeout);
      if (code !== 0) {
        logger.error({ code, signal, stderr: stderr.slice(-2000) }, "FFmpeg exited with non-zero code");
        reject(new Error(`FFmpeg exited with code ${code}${signal ? ` (${signal})` : ""}`));
        return;
      }
      logger.info({ tmpPath }, "FFmpeg render complete");
      resolve(tmpPath);
    });
  });
}

/** Delete a temp file produced by renderClip, ignoring errors. */
export function cleanupTempFile(filePath: string): void {
  fs.unlink(filePath, (err) => {
    if (err) logger.warn({ err, filePath }, "Failed to delete temp clip file");
  });
}

/**
 * Normalize the selected intro and concatenate it before the already-rendered
 * clip. The intro is scaled into the same 16:9 canvas so the resulting MP4 is
 * compatible with the existing download/player pipeline.
 */
export async function prependIntro(options: PrependIntroOptions): Promise<string> {
  const outputPath = path.join(os.tmpdir(), `soccerwatch-clip-intro-${randomUUID()}.mp4`);
  const headerVal = [
    options.referer ? `Referer: ${options.referer}` : null,
    options.accessKey ? `AccessKey: ${options.accessKey}` : null,
    "User-Agent: Mozilla/5.0",
  ].filter(Boolean).join("\r\n") + "\r\n";
  const args = [
    "-headers", headerVal,
    "-i", options.introUrl,
    "-i", options.clipPath,
    "-filter_complex",
    "[0:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30[introv];" +
      "[1:v]scale=1920:1080:force_original_aspect_ratio=disable,setsar=1,fps=30[clipv];" +
      "[0:a]aresample=async=1[introa];[1:a]aresample=async=1[clipa];" +
      "[introv][introa][clipv][clipa]concat=n=2:v=1:a=1[v][a]",
    "-map", "[v]", "-map", "[a]",
    "-c:v", "libx264", "-preset", "fast", "-crf", "18",
    "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k",
    "-movflags", "+faststart", "-y", outputPath,
  ];
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args);
    let stderr = "";
    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) {
        logger.error({ code, stderr: stderr.slice(-2000) }, "Intro prepend failed");
        reject(new Error(`FFmpeg intro prepend exited with code ${code}`));
      } else resolve(outputPath);
    });
  });
}
