import { spawn } from "child_process";
import { randomUUID } from "crypto";
import path from "path";
import fs from "fs";
import os from "os";
import { logger } from "./logger";

const SRC_W = 3840;
const SRC_H = 1080;

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
function buildCropFilter(keyframes: KF[], clipDuration: number, is9to16: boolean): string {
  const OUT_W = is9to16 ? Math.round(SRC_H * 9 / 16) : 1920;
  const OUT_H = SRC_H;

  const kfW0 = keyframes[0]?.w ?? (is9to16 ? (SRC_H * 9 / 16) / SRC_W : 0.5);

  function kfToSourceX(kf: KF): number {
    const cropCenterSrc = (kf.x + kfW0 / 2) * SRC_W;
    return Math.round(Math.max(0, Math.min(SRC_W - OUT_W, cropCenterSrc - OUT_W / 2)));
  }

  if (keyframes.length === 0) {
    const x = Math.round((SRC_W - OUT_W) / 2);
    return `crop=${OUT_W}:${OUT_H}:${x}:0`;
  }

  if (keyframes.length === 1) {
    return `crop=${OUT_W}:${OUT_H}:${kfToSourceX(keyframes[0])}:0`;
  }

  // Convert keyframe t-fractions to absolute seconds within the clip (filter t starts at 0)
  const pts = keyframes.map(kf => ({
    t: kf.t * clipDuration,
    x: kfToSourceX(kf),
  }));

  // Build piecewise linear expression with plain commas throughout,
  // then escape exactly once at the end before embedding in the filter string.
  // Calling esc() inside the loop AND on the outer wrap causes double-escaping:
  //   \,  →  \\,  which FFmpeg reads as literal-backslash + filter-separator.
  let xExpr = `${pts[pts.length - 1].x}`;
  for (let i = pts.length - 2; i >= 0; i--) {
    const a = pts[i];
    const b = pts[i + 1];
    const tDiff = b.t - a.t;
    let segExpr: string;
    if (tDiff < 0.001) {
      segExpr = `${a.x}`;
    } else {
      const slope = (b.x - a.x) / tDiff;
      segExpr = `${a.x}+${slope.toFixed(4)}*(t-${a.t.toFixed(4)})`;
    }
    xExpr = `if(lt(t,${b.t.toFixed(4)}),${segExpr},${xExpr})`;
  }
  // Clamp to valid pixel range, then escape commas once for the FFmpeg filter graph
  const rawExpr = `max(0,min(${SRC_W - OUT_W},${xExpr}))`;
  const escapedExpr = rawExpr.replace(/,/g, "\\,");

  return `crop=${OUT_W}:${OUT_H}:${escapedExpr}:0`;
}

/**
 * Render a trimmed, cropped MP4 clip via FFmpeg.
 * Returns the path to a temporary file that the caller is responsible for deleting.
 */
export async function renderClip(options: FfmpegExportOptions): Promise<string> {
  const { videoUrl, totalDuration, startTime, endTime, cropPath, aspectRatio, title, referer } = options;

  logger.info({ title, startTime, endTime, totalDuration }, "Starting FFmpeg render");

  const startSec = isFinite(startTime) ? startTime * totalDuration : 0;
  const endSec = isFinite(endTime) ? endTime * totalDuration : totalDuration;
  const clipDuration = Math.max(0.1, endSec - startSec);
  const is9to16 = aspectRatio === "9:16";
  const cropFilter = buildCropFilter(cropPath, clipDuration, is9to16);
  const OUT_W = is9to16 ? Math.round(SRC_H * 9 / 16) : 1920;

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
    // Crop pan filter, then ensure even dimensions
    "-vf", `${cropFilter},scale=${OUT_W}:${SRC_H}:force_original_aspect_ratio=disable`,
    // H.264 video, fast encode, web-compatible
    "-c:v", "libx264",
    "-preset", "fast",
    "-crf", "23",
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

    let stderr = "";
    proc.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });

    proc.on("error", (err) => {
      logger.error({ err }, "FFmpeg process error");
      reject(err);
    });

    proc.on("close", (code) => {
      if (code !== 0) {
        logger.error({ code, stderr: stderr.slice(-2000) }, "FFmpeg exited with non-zero code");
        reject(new Error(`FFmpeg exited with code ${code}`));
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
