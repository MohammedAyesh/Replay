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

/**
 * Ceiling on the shorter helper subprocesses — ffprobe, intro normalize, concat.
 * These operate on a short intro or on already-rendered local files, so they
 * should never approach the main render's budget.
 */
const SUBPROCESS_TIMEOUT_MS = Math.max(
  10_000,
  parseInt(process.env.FFMPEG_SUBPROCESS_TIMEOUT_MS ?? "300000", 10) || 300_000,
);

/**
 * Longest intro we will prepend. An intro is branding, not content, and it is
 * re-encoded on every export that uses it, so an admin uploading a
 * several-minute file must not multiply every render on the box.
 */
const MAX_INTRO_SECONDS = Math.max(
  1,
  parseInt(process.env.MAX_INTRO_SECONDS ?? "30", 10) || 30,
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
  /** Academy branding intro to prepend, if the clip's academy has one set. */
  introUrl?: string;
  /** Referer for fetching introUrl, if it's also behind a CDN that checks one. */
  introReferer?: string;
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

/** Output pixel dimensions for a given aspect ratio — shared by the main
 * render and by intro-video normalization so the two segments concatenate
 * cleanly (concat demuxer requires matching dimensions/codec across parts). */
function getOutputDims(is9to16: boolean): { w: number; h: number } {
  return is9to16
    ? { w: Math.round((SRC_H * 9) / 16), h: SRC_H }
    : { w: 1920, h: SRC_H };
}

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
  const { w: OUT_W, h: OUT_H } = getOutputDims(is9to16);

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
 * Run an ffmpeg/ffprobe-family binary, resolving on exit code 0 and rejecting
 * otherwise.
 *
 * The timeout is not optional. Every call here reaches a CDN, and a host that
 * accepts the connection then stalls leaves the process alive forever — which
 * in the intro path meant the render slot and the clip's in-flight entry were
 * never released, stranding that clip on "pending" and, after
 * MAX_CONCURRENT_RENDERS such events, queueing every later export indefinitely.
 */
function run(bin: string, args: string[], timeoutMs = SUBPROCESS_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args);
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    proc.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr?.on("data", (d: Buffer) => { stderr = (stderr + d.toString()).slice(-8000); });

    const timer = setTimeout(() => {
      timedOut = true;
      logger.error({ bin, timeoutMs }, "Subprocess timed out — killing");
      proc.kill("SIGKILL");
    }, timeoutMs);

    proc.on("error", (err) => { clearTimeout(timer); reject(err); });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`${bin} timed out after ${timeoutMs}ms`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`${bin} exited with code ${code}: ${stderr.slice(-1000)}`));
        return;
      }
      resolve(stdout);
    });
  });
}

function buildHeaderVal(referer?: string): string {
  return [
    referer ? `Referer: ${referer}` : null,
    "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  ].filter(Boolean).join("\r\n") + "\r\n";
}

/**
 * Whether the given source has an audio stream.
 * Used so intro normalization can guarantee an audio track exists (silent if
 * necessary) — concatenating segments with an inconsistent stream layout
 * causes audio to drop out or desync partway through playback.
 * Defaults to false (adds silence) if probing fails, since mapping a
 * nonexistent audio stream would otherwise abort the whole normalize step.
 */
async function probeHasAudio(url: string, referer?: string): Promise<boolean> {
  try {
    const out = await run("ffprobe", [
      "-headers", buildHeaderVal(referer),
      "-v", "error",
      "-select_streams", "a",
      "-show_entries", "stream=codec_type",
      "-of", "csv=p=0",
      url,
    ]);
    return out.trim().length > 0;
  } catch (err) {
    logger.warn({ err, url }, "ffprobe audio check failed — assuming no audio track");
    return false;
  }
}

/**
 * Re-encode an arbitrary video to match the main clip's output spec exactly
 * (dimensions, fps, codec, pixel format) plus a guaranteed audio track, so it
 * can be concatenated with the main clip via the concat demuxer (which needs
 * matching parameters across segments — this is *not* the same as -c copy
 * concatenation of already-matching files).
 */
async function normalizeSegment(
  url: string,
  dims: { w: number; h: number },
  referer: string | undefined,
  hasAudio: boolean,
): Promise<string> {
  const tmpPath = path.join(os.tmpdir(), `soccerwatch-intro-${randomUUID()}.mp4`);
  const scalePad =
    `scale=${dims.w}:${dims.h}:force_original_aspect_ratio=decrease,` +
    `pad=${dims.w}:${dims.h}:(ow-iw)/2:(oh-ih)/2:black,fps=30,setsar=1`;

  const args = hasAudio
    ? [
        "-headers", buildHeaderVal(referer),
        "-i", url,
        // Branding, not content — see MAX_INTRO_SECONDS.
        "-t", String(MAX_INTRO_SECONDS),
        "-vf", scalePad,
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-ac", "2",
        "-movflags", "+faststart",
        "-y", tmpPath,
      ]
    : [
        // No source audio: synthesize silence so the segment still has an
        // audio stream matching the main clip's layout (see probeHasAudio).
        "-headers", buildHeaderVal(referer),
        "-i", url,
        "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
        "-t", String(MAX_INTRO_SECONDS),
        "-vf", scalePad,
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "128k",
        "-map", "0:v:0", "-map", "1:a:0",
        "-shortest",
        "-movflags", "+faststart",
        "-y", tmpPath,
      ];

  await run("ffmpeg", args);
  return tmpPath;
}

/** Concatenate already-matching MP4s (same codec/dims/fps) via the concat demuxer. */
async function concatSegments(paths: string[]): Promise<string> {
  const listPath = path.join(os.tmpdir(), `soccerwatch-concat-${randomUUID()}.txt`);
  const outPath = path.join(os.tmpdir(), `soccerwatch-final-${randomUUID()}.mp4`);
  // Paths are our own tmpdir names (UUID + fixed suffix, no spaces/quotes),
  // so a bare `file '<path>'` line per entry is safe here.
  const listContent = paths.map((p) => `file '${p}'`).join("\n") + "\n";
  await fs.promises.writeFile(listPath, listContent, "utf8");
  try {
    await run("ffmpeg", ["-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", "-movflags", "+faststart", "-y", outPath]);
  } catch (err) {
    // ffmpeg -y has already created and partially written outPath. Nothing
    // downstream holds a reference to it once we throw, so it would sit in
    // tmpdir forever.
    fs.unlink(outPath, () => {});
    throw err;
  } finally {
    fs.unlink(listPath, () => {});
  }
  return outPath;
}

/**
 * Render the main clip, then — if an intro is given — normalize it to match
 * the main clip's exact output spec and prepend it via concat.
 *
 * A broken/unreachable intro must never block the user's own clip: any
 * failure in the intro or concat step is logged and swallowed, falling back
 * to the main-only render.
 */
async function withIntro(
  mainPath: string,
  is9to16: boolean,
  introUrl: string | undefined,
  introReferer: string | undefined,
): Promise<string> {
  if (!introUrl) return mainPath;

  let introNormPath: string | null = null;
  try {
    const dims = getOutputDims(is9to16);
    const hasAudio = await probeHasAudio(introUrl, introReferer);
    introNormPath = await normalizeSegment(introUrl, dims, introReferer, hasAudio);
    const finalPath = await concatSegments([introNormPath, mainPath]);
    cleanupTempFile(mainPath);
    return finalPath;
  } catch (err) {
    logger.error({ err, introUrl }, "Intro concat failed — exporting clip without intro");
    return mainPath;
  } finally {
    if (introNormPath) cleanupTempFile(introNormPath);
  }
}


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
  const headerVal = buildHeaderVal(referer);

  // When an intro will be concatenated, the main clip has to match the spec
  // normalizeSegment pins the intro to — 30 fps, 44.1 kHz stereo AAC, and an
  // audio stream that definitely exists. The concat demuxer runs with -c copy,
  // so a source that is mono, 16 kHz, or silent (all normal for a Reolink feed)
  // would otherwise either fail the concat — silently dropping the intro,
  // because withIntro swallows the error — or emit a file whose main portion
  // plays at the intro's declared sample rate.
  //
  // Only done when there is an intro: the plain export path keeps the source's
  // own audio parameters and costs no extra probe.
  const mainHasAudio = options.introUrl
    ? await probeHasAudio(videoUrl, referer)
    : true;
  const needsSilentTrack = !!options.introUrl && !mainHasAudio;

  const args = [
    // HTTP headers must come before -i so they apply to the input request
    "-headers", headerVal,
    // Fast seek before input (segment-level for HLS)
    "-ss", String(startSec),
    "-i", videoUrl,
    ...(needsSilentTrack
      ? ["-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100"]
      : []),
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
    ...(options.introUrl ? ["-r", "30", "-ar", "44100", "-ac", "2"] : []),
    ...(needsSilentTrack ? ["-map", "0:v:0", "-map", "1:a:0", "-shortest"] : []),
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
      // ffmpeg -y creates the output file up front, and the caller only learns
      // the path from a successful resolve — so on failure nobody else can
      // clean it up.
      fs.unlink(tmpPath, () => {});
      reject(err);
    });

    proc.on("close", (code, signal) => {
      clearTimeout(timeout);
      if (code !== 0) {
        logger.error({ code, signal, stderr: stderr.slice(-2000) }, "FFmpeg exited with non-zero code");
        fs.unlink(tmpPath, () => {});
        reject(new Error(`FFmpeg exited with code ${code}${signal ? ` (${signal})` : ""}`));
        return;
      }
      logger.info({ tmpPath }, "FFmpeg render complete");
      withIntro(tmpPath, is9to16, options.introUrl, options.introReferer).then(resolve, reject);
    });
  });
}

/** Delete a temp file produced by renderClip, ignoring errors. */
export function cleanupTempFile(filePath: string): void {
  fs.unlink(filePath, (err) => {
    if (err) logger.warn({ err, filePath }, "Failed to delete temp clip file");
  });
}

