import { spawn } from "child_process";
import { randomUUID } from "crypto";
import path from "path";
import fs from "fs";
import os from "os";
import { logger } from "./logger";
import { BUNNY_STORAGE_API_KEY, BUNNY_STORAGE_HOSTNAME } from "./bunny";
import {
  EXPORT_SOURCE_WIDTH,
  EXPORT_SOURCE_HEIGHT,
  EXPORT_SOURCE_LABEL,
} from "./exportSource";

/**
 * Source geometry every crop calculation below is scaled against.
 *
 * These are re-exported from exportSource so the constant the crop maths uses
 * and the constant the source-pinning logic verifies against are the same two
 * numbers. See exportSource.ts for why they are 3840x1080 and not 4096x1152,
 * and why handing this file a different rendition is a silent-corruption bug
 * rather than a visible failure.
 */
const SRC_W = EXPORT_SOURCE_WIDTH;
const SRC_H = EXPORT_SOURCE_HEIGHT;

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
 * Ceiling on the remote-clip buffering step (download + ultrafast re-encode).
 * Must be less than FFMPEG_TIMEOUT_MS so a stalled CDN fetch does not hold a
 * render slot for the full 30-minute render budget.  10 minutes is generous
 * for any clip within MAX_CLIP_SECONDS at ultrafast; increase via env if
 * extremely long clips on slow connections require more headroom.
 */
const BUFFER_TIMEOUT_MS = Math.max(
  60_000,
  parseInt(process.env.FFMPEG_BUFFER_TIMEOUT_MS ?? "600000", 10) || 600_000,
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
    if (Math.abs((kf.h ?? 1) - derivedH) <= 0.05) return kf;
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
 * Build the fixed-size multi-keyframe renderer.
 *
 * zoompan evaluates z/x/y per output frame, unlike crop's w/h expressions.
 * The input is padded to the output aspect ratio first, then supersampled so
 * zoompan's integer coordinate quantization does not turn slow pans into
 * visible staircase motion.
 */
function buildZoompanFilter(options: {
  kfs: KF[];
  clipDuration: number;
  is9to16: boolean;
  outW: number;
  outH: number;
  canvasW: number;
  canvasH: number;
  padLeft: number;
  padTop: number;
}): string {
  const {
    kfs,
    clipDuration,
    is9to16,
    outW,
    outH,
    canvasW,
    canvasH,
    padLeft,
    padTop,
  } = options;
  const evenCeil = (value: number) => Math.max(2, Math.ceil(value / 2) * 2);
  const evenFloor = (value: number) => Math.max(2, Math.floor(value / 2) * 2);

  type BoundedRegion = {
    left: number;
    top: number;
    width: number;
    height: number;
    sourceLeft: number;
    sourceTop: number;
    sourceWidth: number;
    sourceHeight: number;
    sourcePadLeft: number;
    sourcePadTop: number;
  };

  /**
   * A vertical output normally visits a much smaller part of the panoramic
   * source than the full 3840px width. Keep only that union plus a tiny safety
   * margin, then pad the region to the requested output aspect.
   */
  const boundedVerticalRegion = (): BoundedRegion | null => {
    if (!is9to16) return null;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const kf of kfs) {
      const x = kf.x * SRC_W;
      const y = kf.y * SRC_H;
      const w = Math.max(2, kf.w * SRC_W);
      const h = Math.max(2, kf.h * SRC_H);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + w);
      maxY = Math.max(maxY, y + h);
    }
    if (!Number.isFinite(minX) || !Number.isFinite(maxX)) return null;

    const left = Math.floor(minX) - 2;
    const top = Math.floor(minY) - 2;
    const right = left + evenCeil(Math.ceil(maxX) + 2 - left);
    const bottom = top + evenCeil(Math.ceil(maxY) + 2 - top);
    const width = right - left;
    const height = bottom - top;
    const sourceLeft = Math.max(0, Math.min(SRC_W - 2, evenFloor(left)));
    const sourceTop = Math.max(0, Math.min(SRC_H - 2, evenFloor(top)));
    const sourceRight = Math.min(SRC_W, right);
    const sourceBottom = Math.min(SRC_H, bottom);
    if (sourceRight <= sourceLeft || sourceBottom <= sourceTop) return null;

    const sourceWidth = Math.min(
      evenFloor(SRC_W - sourceLeft),
      evenFloor(sourceRight - sourceLeft),
    );
    const sourceHeight = Math.min(
      evenFloor(SRC_H - sourceTop),
      evenFloor(sourceBottom - sourceTop),
    );
    if (sourceWidth < 2 || sourceHeight < 2) return null;

    return {
      left,
      top,
      width,
      height,
      sourceLeft,
      sourceTop,
      sourceWidth,
      sourceHeight,
      sourcePadLeft: sourceLeft - left,
      sourcePadTop: sourceTop - top,
    };
  };

  const boundedRegion = boundedVerticalRegion();
  const baseCanvasW = boundedRegion?.width ?? canvasW;
  const baseCanvasH = boundedRegion?.height ?? canvasH;
  const aspectUnitW = is9to16 ? 9 : 16;
  const aspectUnitH = is9to16 ? 16 : 9;
  let aspectUnits = Math.max(
    Math.ceil(baseCanvasW / aspectUnitW),
    Math.ceil(baseCanvasH / aspectUnitH),
  );
  while (
    (aspectUnitW * aspectUnits) % 2 !== 0 ||
    (aspectUnitH * aspectUnits) % 2 !== 0
  ) {
    aspectUnits++;
  }
  const workingCanvasW = aspectUnitW * aspectUnits;
  const workingCanvasH = aspectUnitH * aspectUnits;

  const DEFAULT_SUPERSAMPLE = 4;
  const FALLBACK_SUPERSAMPLE = 2;
  const MINIMUM_SUPERSAMPLE = 1;
  // Select the highest quality level that stays under the post-fallback
  // working-raster ceiling. The 1x last resort matters for a vertical path
  // that genuinely visits most of the panoramic source.
  const MAX_SUPERSAMPLED_PIXELS = 60_000_000;
  const supersample = [DEFAULT_SUPERSAMPLE, FALLBACK_SUPERSAMPLE, MINIMUM_SUPERSAMPLE]
    .find((candidate) =>
      workingCanvasW * workingCanvasH * candidate ** 2 <= MAX_SUPERSAMPLED_PIXELS,
    ) ?? MINIMUM_SUPERSAMPLE;
  const workingW = workingCanvasW * supersample;
  const workingH = workingCanvasH * supersample;

  const formatNumber = (value: number) =>
    Number.isFinite(value) ? Number(value.toFixed(9)).toString() : "0";

  type Geometry = {
    zoom: number;
    xPx: number;
    yPx: number;
    windowW: number;
    windowH: number;
  };

  /**
   * This is the only geometry calculation used by both the expressions and
   * the invariant. The source path is still interpolated in its original
   * normalized coordinates; only the final canvas coordinates are scaled.
   */
  const evalGeometryAt = (timeSec: number): Geometry => {
    const tFrac = clipDuration > 1e-6 ? timeSec / clipDuration : 0;
    const kf = sampleAt(kfs, tFrac);
    const wpx = Math.max(2, kf.w * SRC_W);
    const zoom = workingCanvasW / wpx;
    return {
      zoom,
      xPx: kf.x * SRC_W + (boundedRegion ? -boundedRegion.left : padLeft),
      yPx: kf.y * SRC_H + (boundedRegion ? -boundedRegion.top : padTop),
      windowW: workingCanvasW / zoom,
      windowH: workingCanvasH / zoom,
    };
  };

  /**
   * Flat piecewise-linear expression:
   * v0 + slope0*clip(time-t0,0,dt0) + ...
   *
   * `on` is zoompan's output frame counter and starts at zero. Commas inside
   * clip() are escaped for the FFmpeg filter-graph parser.
   */
  const buildFlatExpr = (values: number[]): string => {
    if (values.length === 1) return formatNumber(values[0]);
    const terms = [formatNumber(values[0])];
    for (let i = 0; i < values.length - 1; i++) {
      const t0 = kfs[i].t * clipDuration;
      const dt = Math.max(1e-9, (kfs[i + 1].t - kfs[i].t) * clipDuration);
      const slope = (values[i + 1] - values[i]) / dt;
      terms.push(
        `(${formatNumber(slope)}*clip((on/30)-${formatNumber(t0)}\\,0\\,${formatNumber(dt)}))`,
      );
    }
    return terms.join("+");
  };

  const geometryAtKeyframes = kfs.map((kf) =>
    evalGeometryAt(kf.t * clipDuration),
  );
  // Interpolate the recorded crop width, then derive zoom from that exact
  // width curve. Interpolating reciprocal zoom values would change the crop
  // geometry between keyframes and invalidate the invariant below.
  const widthExpr = buildFlatExpr(
    geometryAtKeyframes.map((g) => g.windowW),
  );
  const zoomExpr = `${formatNumber(workingCanvasW)}/(${widthExpr})`;
  const xExpr = buildFlatExpr(
    geometryAtKeyframes.map((g) => g.xPx * supersample),
  );
  const yExpr = buildFlatExpr(
    geometryAtKeyframes.map((g) => g.yPx * supersample),
  );

  const FPS = 30;
  const frameCount = Math.ceil(clipDuration * FPS);
  const EPSILON = 1 / supersample + 1e-6;
  for (let i = 0; i < frameCount; i++) {
    const timeSec = i / FPS;
    const geometry = evalGeometryAt(timeSec);
    const quantizedX = Math.round(geometry.xPx * supersample) / supersample;
    const quantizedY = Math.round(geometry.yPx * supersample) / supersample;
    const kf = sampleAt(
      kfs,
      clipDuration > 1e-6 ? timeSec / clipDuration : 0,
    );
    const requestedW = Math.max(2, kf.w * SRC_W);
    const requestedH = Math.max(2, kf.h * SRC_H);
    const valid =
      Number.isFinite(geometry.zoom) &&
      geometry.zoom > 0 &&
      Number.isFinite(quantizedX) &&
      Number.isFinite(quantizedY) &&
      quantizedX >= -EPSILON &&
      quantizedY >= -EPSILON &&
      quantizedX + geometry.windowW <= workingCanvasW + EPSILON &&
      quantizedY + geometry.windowH <= workingCanvasH + EPSILON &&
      Math.abs(geometry.windowW - requestedW) <= 2 &&
      Math.abs(geometry.windowH - requestedH) <= 2;
    if (!valid) {
      logger.error(
        {
          frame: i,
          timeSec,
          geometry,
          quantizedX,
          quantizedY,
          requestedW,
          requestedH,
          workingCanvasW,
          workingCanvasH,
          supersample,
        },
        "buildCropCommands: zoompan geometric invariant violated — export aborted",
      );
      throw new Error(
        `Zoompan geometry invariant failed at frame ${i} ` +
        `(t=${timeSec.toFixed(3)}s): ` +
        `x=${quantizedX.toFixed(3)} y=${quantizedY.toFixed(3)} ` +
        `window=${geometry.windowW.toFixed(3)}x${geometry.windowH.toFixed(3)} ` +
        `requested=${requestedW.toFixed(3)}x${requestedH.toFixed(3)} ` +
        `canvas=${workingCanvasW}x${workingCanvasH}`,
      );
    }
  }

  logger.info(
    {
      workingCanvasW,
      workingCanvasH,
      supersample,
      supersampledW: workingW,
      supersampledH: workingH,
      workingPixels: workingW * workingH,
      boundedRegion: !!boundedRegion,
      keyframes: kfs.length,
      frames: frameCount,
    },
    "zoompan geometry validated",
  );

  const zoompanPadFilter =
    boundedRegion
      ? `fps=${FPS},crop=${boundedRegion.sourceWidth}:${boundedRegion.sourceHeight}:` +
        `${boundedRegion.sourceLeft}:${boundedRegion.sourceTop},` +
        `pad=${boundedRegion.width}:${boundedRegion.height}:` +
        `${boundedRegion.sourcePadLeft}:${boundedRegion.sourcePadTop}:black,` +
        `pad=${workingCanvasW}:${workingCanvasH}:0:0:black,`
      : `fps=${FPS},pad=${workingCanvasW}:${workingCanvasH}:${padLeft}:${padTop}:black,`;
  const renderFilter =
    `${zoompanPadFilter}` +
    `scale=${workingW}:${workingH}:flags=lanczos,`;
  return (
    `${renderFilter}zoompan=z='${zoomExpr}':x='${xExpr}':y='${yExpr}':` +
    `d=1:s=${outW}x${outH}:fps=${FPS}`
  );
}

/**
 * Build the video filter chain: pad -> crop -> scale for static clips, or
 * pad -> supersample -> zoompan for multi-keyframe clips.
 *
 * For single-keyframe (static) clips a plain `crop=W:H:X:Y` expression is
 * returned directly without a filter script.
 *
 * For multi-keyframe clips the source is mapped to an aspect-matched padded
 * canvas and rendered with fixed-size zoompan expressions. This avoids crop
 * w/h reconfiguration, which FFmpeg does not reliably apply per frame.
 *
 * The crop frame is allowed to extend beyond the source (that's how a clip gets
 * deliberate black bars), but FFmpeg's crop filter cannot read outside the input.
 * So the source is first padded onto a larger black canvas big enough to contain
 * every frame position the pan visits (computed across ALL keyframes, not just
 * kfs[0]), and the crop then runs entirely inside that canvas.
 */
export function buildCropCommands(
  keyframes: KF[],
  clipDuration: number,
  is9to16: boolean,
): { filter: string; filterScriptPath: string | null } {
  const { w: OUT_W, h: OUT_H } = getOutputDims(is9to16);
  const normalized = normalizePath(sanitizeKeyframes(keyframes), is9to16)
    .sort((a, b) => a.t - b.t);
  const kfs = normalized.reduce<KF[]>((result, kf) => {
    const previous = result[result.length - 1];
    if (previous && Math.abs(previous.t - kf.t) <= 1e-9) {
      result[result.length - 1] = kf;
    } else {
      result.push(kf);
    }
    return result;
  }, []);

  const scaleFilter = `scale=${OUT_W}:${OUT_H}:force_original_aspect_ratio=disable`;

  /** Round a pixel dimension to the nearest even integer (required by yuv420p). */
  const toEven = (n: number) => {
    const r = Math.max(2, Math.round(n));
    return r % 2 === 0 ? r : r + 1;
  };

  /** Pixel dimensions for a single keyframe. */
  const kfPx = (kf: KF) => ({
    w: toEven(kf.w * SRC_W),
    h: toEven(kf.h * SRC_H),
  });

  // Compute pad bounds from ALL keyframes (not just kfs[0]) so a zoom-in
  // mid-clip doesn't push the crop rectangle outside the padded canvas.
  let minX = 0;
  let minY = 0;
  let maxExtentX = 0; // max of (x * SRC_W + w_px) across all keyframes
  let maxExtentY = 0; // max of (y * SRC_H + h_px) across all keyframes

  if (kfs.length > 0) {
    minX = Infinity;
    minY = Infinity;
    for (const kf of kfs) {
      const { w: wpx, h: hpx } = kfPx(kf);
      const xSrc = (kf.x ?? 0) * SRC_W;
      const ySrc = (kf.y ?? 0) * SRC_H;
      if (xSrc < minX) minX = xSrc;
      if (ySrc < minY) minY = ySrc;
      const extX = xSrc + wpx;
      const extY = ySrc + hpx;
      if (extX > maxExtentX) maxExtentX = extX;
      if (extY > maxExtentY) maxExtentY = extY;
    }
    if (!isFinite(minX)) { minX = 0; minY = 0; }
  }

  const padLeft   = Math.max(0, Math.ceil(-minX));
  const padTop    = Math.max(0, Math.ceil(-minY));
  const padRight  = Math.max(0, Math.ceil(maxExtentX - SRC_W));
  const padBottom = Math.max(0, Math.ceil(maxExtentY - SRC_H));

  // Belt and braces: keep the canvas within FFmpeg-survivable bounds.
  const canvasW = Math.min(SRC_W * MAX_CANVAS_W_SCALE, SRC_W + padLeft + padRight);
  const canvasH = Math.min(SRC_H * MAX_CANVAS_H_SCALE, SRC_H + padTop + padBottom);

  const needsPad = padLeft > 0 || padTop > 0 || padRight > 0 || padBottom > 0;
  const padFilter = needsPad
    ? `pad=${canvasW}:${canvasH}:${padLeft}:${padTop}:black,`
    : "";

  /** Canvas-relative x for a keyframe, clamped so crop stays inside canvas. */
  const toCanvasX = (kf: KF, wpx: number) =>
    Math.round(Math.max(0, Math.min(canvasW - wpx, (kf.x ?? 0) * SRC_W + padLeft)));
  const toCanvasY = (kf: KF, hpx: number) =>
    Math.round(Math.max(0, Math.min(canvasH - hpx, (kf.y ?? 0) * SRC_H + padTop)));

  // ── 0 keyframes: centre-crop with fallback dimensions ────────────────────
  if (kfs.length === 0) {
    const fallbackW = is9to16 ? (SRC_H * 9 / 16) / SRC_W : 0.5;
    const frameW = Math.min(toEven(fallbackW * SRC_W), canvasW);
    const frameH = Math.min(toEven(1 * SRC_H), canvasH);
    const x = Math.round((canvasW - frameW) / 2);
    const y = Math.round((canvasH - frameH) / 2);
    return {
      filter: `${padFilter}crop=${frameW}:${frameH}:${x}:${y},${scaleFilter}`,
      filterScriptPath: null,
    };
  }

  // ── 1 keyframe: static crop, no sendcmd ──────────────────────────────────
  if (kfs.length === 1) {
    const { w: wpx, h: hpx } = kfPx(kfs[0]);
    const frameW = Math.min(wpx, canvasW);
    const frameH = Math.min(hpx, canvasH);
    const xCanvas = toCanvasX(kfs[0], frameW);
    const yCanvas = toCanvasY(kfs[0], frameH);
    return {
      filter: `${padFilter}crop=${frameW}:${frameH}:${xCanvas}:${yCanvas},${scaleFilter}`,
      filterScriptPath: null,
    };
  }

  const filter = buildZoompanFilter({
    kfs,
    clipDuration,
    is9to16,
    outW: OUT_W,
    outH: OUT_H,
    canvasW,
    canvasH,
    padLeft,
    padTop,
  });
  // Keep the full keyframe path out of execve's argument-size limit. FFmpeg's
  // filter-script input parses the same graph as -vf, but spawn receives only
  // this short file path.
  const filterScriptPath = path.join(os.tmpdir(), `soccerwatch-filter-${randomUUID()}.txt`);
  fs.writeFileSync(filterScriptPath, `${filter}\n`, "utf8");
  return { filter: "", filterScriptPath };

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

/**
 * Bunny Storage (storage.bunnycdn.com) is an authenticated origin — a plain GET
 * returns 401 without an AccessKey. Intro videos are uploaded there and the URL
 * that gets stored is built from BUNNY_STORAGE_CDN_URL, which on this
 * deployment points at the storage host rather than a public pull zone. So the
 * intro fetch has to carry the key.
 *
 * Only for that exact host: the key must never be attached to an arbitrary URL
 * an admin could paste in.
 */
function isBunnyStorageUrl(url: string): boolean {
  try {
    return new URL(url).host.toLowerCase() === BUNNY_STORAGE_HOSTNAME.toLowerCase();
  } catch {
    return false;
  }
}

function buildHeaderVal(referer?: string, url?: string): string {
  const needsKey = !!url && !!BUNNY_STORAGE_API_KEY && isBunnyStorageUrl(url);
  return [
    referer ? `Referer: ${referer}` : null,
    needsKey ? `AccessKey: ${BUNNY_STORAGE_API_KEY}` : null,
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
      "-headers", buildHeaderVal(referer, url),
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
 * Decoded frame dimensions of the first video stream, straight from ffprobe.
 *
 * Deliberately not tolerant: any failure to read a width and a height is
 * propagated, because "I could not tell what geometry this is" and "this is the
 * wrong geometry" carry the same risk to the crop maths.
 */
export async function probeVideoDimensions(
  filePath: string,
): Promise<{ width: number; height: number }> {
  const out = await run("ffprobe", [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height",
    "-of", "csv=p=0:s=x",
    filePath,
  ]);
  const [w, h] = out.trim().split("x").map((n) => Number.parseInt(n, 10));
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    throw new Error(
      `Could not read video dimensions from ${filePath} — ffprobe returned "${out.trim()}"`,
    );
  }
  return { width: w, height: h };
}

/**
 * Assert that a decoded frame is the geometry every crop keyframe is scaled
 * against, and throw rather than proceed if it is not.
 *
 * This is the backstop behind exportSource's URL-level pinning. Pinning stops
 * the exporter *asking* for the wrong rendition; this stops a wrong rendition
 * being *encoded from* if it ever arrives by some other route — a CDN serving a
 * stale variant under the right name, a re-encode upstream, a hand-passed URL,
 * a future caller that forgets. Both layers are cheap; only one of them
 * survives someone editing the other.
 *
 * Failing here costs one clip. Not failing here costs every clip rendered
 * between the day the ladder changed and the day a human noticed the framing
 * was wrong — and nothing in the pipeline would have raised its hand.
 */
export function assertExportSourceGeometry(
  dims: { width: number; height: number },
  context: string,
): void {
  if (dims.width !== SRC_W || dims.height !== SRC_H) {
    throw new Error(
      `Refusing to export from ${context}: decoded frame is ${dims.width}x${dims.height}, ` +
        `expected ${EXPORT_SOURCE_LABEL}. ` +
        `Every crop keyframe is stored as a fraction and multiplied by ${SRC_W}x${SRC_H}, ` +
        `so rendering from any other geometry produces a silently mis-framed clip. ` +
        `This is a hard stop by design — do not "fix" it by relaxing the check.`,
    );
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
        "-headers", buildHeaderVal(referer, url),
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
        "-headers", buildHeaderVal(referer, url),
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
  // Includes pad (for out-of-source black bars), crop pan, and the output scale.
  // Multi-keyframe clips use zoompan; static clips keep the direct crop fast path.
  const { filter: cropFilter, filterScriptPath } = buildCropCommands(cropPath, clipDuration, is9to16);

  const tmpPath = path.join(os.tmpdir(), `soccerwatch-clip-${randomUUID()}.mp4`);

  logger.info(
    {
      tmpPath,
      startSec,
      endSec,
      clipDuration,
      cropFilter: filterScriptPath ? undefined : cropFilter,
      filterScriptPath,
    },
    "FFmpeg args ready",
  );

  // Build HTTP headers string for CDN access.
  // Bunny CDN blocks server-side requests without browser-like headers;
  // adding a matching Referer + a browser User-Agent bypasses that restriction.
  const headerVal = buildHeaderVal(referer, videoUrl);

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
  let mainHasAudio = true;
  try {
    if (options.introUrl) {
      mainHasAudio = await probeHasAudio(videoUrl, referer);
    }
  } catch (err) {
    if (filterScriptPath) cleanupTempFile(filterScriptPath);
    throw err;
  }
  const needsSilentTrack = !!options.introUrl && !mainHasAudio;

  // Only attach -headers for remote HTTP(S) sources.  For local file paths
  // (e.g. the temp buffer file produced by bufferRemoteClip), FFmpeg's file
  // demuxer does not accept -headers and will error with "Option headers not
  // found" when it is present.
  const isRemoteUrl = /^https?:\/\//i.test(videoUrl);

  const args = [
    // HTTP headers only for remote inputs; omit entirely for local files.
    ...(isRemoteUrl ? ["-headers", headerVal] : []),
    // Fast seek before input (segment-level for HLS)
    "-ss", String(startSec),
    "-i", videoUrl,
    ...(needsSilentTrack
      ? ["-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100"]
      : []),
    // Clip duration
    "-t", String(clipDuration),
    // pad -> crop pan -> scale, all built together so black bars survive
    ...(filterScriptPath ? ["-filter_script:v", filterScriptPath] : ["-vf", cropFilter]),
    // H.264 video, fast encode, web-compatible
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "23",
    "-pix_fmt", "yuv420p",
    // Force constant 30 fps on output. 30 fps is the platform contract: the
    // normalizeSegment() intro pass (above) already pins the intro to 30 fps via
    // the fps=30 filter, and the concat demuxer used by withIntro() requires
    // matching frame rates across segments. Sources recorded at 25 fps are
    // intentionally normalized to that platform rate. -fps_mode cfr enforces
    // constant frame timing rather than just stamping a target rate onto a
    // variable-rate stream.
    "-r", "30",
    "-fps_mode", "cfr",
    // AAC audio — always pin to stereo 44.1 kHz so intro concat works cleanly
    "-c:a", "aac",
    "-b:a", "128k",
    "-ar", "44100",
    "-ac", "2",
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
      if (filterScriptPath) cleanupTempFile(filterScriptPath);
      reject(err);
    });

    proc.on("close", (code, signal) => {
      clearTimeout(timeout);
      // Keep cleanup conditional for compatibility with the static crop path;
      // multi-keyframe zoompan stores its filter graph in this script.
      if (filterScriptPath) cleanupTempFile(filterScriptPath);
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

/**
 * Download and trim the needed clip window from a remote video to a local temp
 * file so FFmpeg can encode from disk rather than over a live network connection.
 *
 * --- Why re-encode for the buffer step, not stream-copy ---
 *
 * Stream-copy (`-c copy`) with any form of seek — input-side or output-side —
 * produces a buffer file whose timestamps depend on keyframe alignment in ways
 * that vary with the source container, edit lists, and FFmpeg version.  Probing
 * the resulting timestamps to derive a correct seek offset for the subsequent
 * encode pass is therefore fragile and container-dependent.
 *
 * Re-encoding with `setpts=PTS-STARTPTS` gives a single, unconditional guarantee:
 *
 *   • Input-side `-ss startSec` with re-encode: the decoder decodes from the
 *     preceding keyframe internally but only passes frames to the encoder from
 *     startSec onward, so the encoder (and its output) starts exactly at the
 *     requested presentation time — regardless of GOP size or keyframe alignment.
 *   • `setpts=PTS-STARTPTS` resets presentation timestamps to 0 in the output,
 *     so the buffer always has a well-defined 0-based local timeline.
 *
 * The consequence: `adjustedOffsetSec` is always 0.  The buffer starts at
 * startSec; `renderClip` starts from position 0 within the buffer without any
 * timestamp probe or offset arithmetic.
 *
 * Trade-off — two encode passes instead of one:
 *   The buffer uses ultrafast/CRF18 (very fast, near-lossless quality).
 *   A 30 s clip at 3840×1080 buffers in < 5 s on the VPS.
 *   The subsequent CRF23/veryfast main encode reads from a fully local file,
 *   eliminating the live-network stalls that caused freeze/stutter in exports.
 */
export async function bufferRemoteClip(options: {
  remoteUrl: string;
  referer: string;
  startSec: number;
  clipDuration: number;
  /** Total duration of the source recording, used to cap the buffer request. */
  totalDuration: number;
}): Promise<{ bufferPath: string; bufferedDuration: number; adjustedOffsetSec: number }> {
  const { remoteUrl, referer, startSec, clipDuration, totalDuration } = options;
  const bufferPath = path.join(os.tmpdir(), `soccerwatch-buffer-${randomUUID()}.mp4`);
  const headerVal = buildHeaderVal(referer, remoteUrl);

  const { requestedWindow } = getBufferedWindow({ startSec, clipDuration, totalDuration });
  if (requestedWindow <= 0) {
    throw new Error("Cannot buffer a clip with no source content remaining");
  }

  // All failures inside this try block clean up any partial buffer file.
  // ffmpeg -y creates the output file before writing begins, so even a timeout
  // or network error may leave a partial file on disk that must be removed.
  try {
    await run(
      "ffmpeg",
      [
        "-headers", headerVal,
        // Input-side seek: fast, and for a re-encode the decoder silently drops
        // frames before startSec — they never reach the encoder.
        "-ss", String(startSec),
        "-i", remoteUrl,
        "-t", String(requestedWindow),
        // Reset timestamps to 0 in the output.  Combined with the input-side seek
        // behaviour above, this gives a buffer whose timeline is:
        //   PTS=0 → startSec in source,  PTS=requestedWindow → end of window.
        // adjustedOffsetSec is therefore always 0 — no probing required.
        "-vf", "setpts=PTS-STARTPTS",
        "-af", "asetpts=PTS-STARTPTS",
        // Fast, high-quality intermediate — not the final export quality.
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "18",
        "-c:a", "aac", "-b:a", "128k",
        "-movflags", "+faststart",
        "-y", bufferPath,
      ],
      // Use a dedicated buffer timeout, shorter than the full render timeout, so
      // a stalled CDN fetch does not hold a render slot for 30 minutes.
      BUFFER_TIMEOUT_MS,
    );

    // Because setpts=PTS-STARTPTS normalises timestamps to 0, the buffer's
    // playback timeline is 0-based and corresponds directly to source time
    // relative to startSec.  adjustedOffsetSec is therefore always 0.
    const adjustedOffsetSec = 0;

    // Probe the actual playback duration of the buffer.  This is reliable since
    // the timestamps start at 0 — format=duration is not mixed with any
    // source-relative PTS offset.
    const durationOut = await run("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "csv=p=0",
      bufferPath,
    ]);
    const bufferedDuration = parseFloat(durationOut.trim());
    if (!isFinite(bufferedDuration) || bufferedDuration <= 0) {
      throw new Error(`Invalid buffered duration from ffprobe: "${durationOut.trim()}"`);
    }

    // Allow up to 0.5 s short of clipDuration: container/encoder rounding at
    // the source end can shave a few frames off the last GOP, and the
    // subsequent renderClip pass will simply reach the end of the buffer file
    // and stop — producing a clip that is at most 0.5 s shorter than requested,
    // which is acceptable.  A larger shortfall indicates a real failure.
    if (bufferedDuration < clipDuration - 0.5) {
      throw new Error(
        `Buffered file (${bufferedDuration.toFixed(2)}s) is more than 0.5 s shorter than ` +
        `clip duration (${clipDuration.toFixed(2)}s) — aborting export`,
      );
    }

    // Geometry gate. The buffer pass applies no scaling filter, so the buffered
    // file carries whatever geometry the CDN actually served — which makes this
    // the last point where a wrong rendition is still cheap to reject, and the
    // first point where we have a decoded frame to measure rather than a URL to
    // trust. renderClip runs immediately after this and treats every keyframe
    // as a fraction of SRC_W x SRC_H, so anything else must not reach it.
    const dims = await probeVideoDimensions(bufferPath);
    assertExportSourceGeometry(dims, `buffered source ${remoteUrl}`);

    logger.info(
      { bufferPath, bufferedDuration, requestedWindow, startSec, ...dims },
      "bufferRemoteClip complete",
    );
    return { bufferPath, bufferedDuration, adjustedOffsetSec };
  } catch (err) {
    cleanupTempFile(bufferPath);
    throw err;
  }
}

export function getBufferedWindow(options: {
  startSec: number;
  clipDuration: number;
  totalDuration: number;
}): { availableDuration: number; requestedWindow: number } {
  const { startSec, clipDuration, totalDuration } = options;
  // Never request more than the source content remaining after startSec.
  const availableDuration = Math.max(0, totalDuration - startSec);
  // +5 s safety margin for GOP alignment, but never beyond what the source has.
  const requestedWindow = Math.min(clipDuration + 5, availableDuration);
  return { availableDuration, requestedWindow };
}
