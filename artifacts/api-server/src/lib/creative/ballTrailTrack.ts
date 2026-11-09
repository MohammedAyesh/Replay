import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { ballTrailAt, drawBallTrail, framingCentre, trailWidthFor, type BallTrailSample, type SceneLayer } from "@workspace/api-zod";
import { logger } from "../logger";

/**
 * The red ball trail in Creative hub videos (scene video layers with
 * `ballTrail: true`).
 *
 * ffmpeg cannot draw a curve, so the trail is drawn here, one transparent
 * PNG per footage frame, at that frame's exact timestamp, and listed in an
 * ffconcat file that ffmpeg reads as a second input and overlays on the
 * footage. The overlay goes on right after the framing crop (or on the whole
 * source when there is no framing), on the file's own clock, before any trim
 * or speed change, so slow motion slows the trail with the ball.
 *
 * Each PNG is drawn in the coordinates of what it is laid over: the framing
 * window at that moment, computed exactly as renderVideo's framingCrop does
 * (same keys, same size rounding, same clamping). Frames with no trail share
 * one blank PNG.
 */

type VideoLayer = Extract<SceneLayer, { kind: "video" }>;

/** Most trail frames drawn for one layer (5 minutes of 20 fps footage). */
const MAX_TRAIL_FRAMES = 6000;
/** Trail PNGs are drawn at most this wide and scaled up by ffmpeg (it is a soft streak). */
const MAX_DRAW_WIDTH = 1280;

export type BallTrailTrack = {
  /** ffconcat list of the trail frames, on the footage file's clock */
  list: string;
  /** size of the picture the trail is laid over (the framing crop, or the whole source) */
  w: number;
  h: number;
  /** frames that carry a trail */
  drawn: number;
};

/** Same thinning as renderVideo.thinKeys (kept here to avoid an import cycle). */
function thin(keys: ReadonlyArray<readonly [number, number, number]>, max = 48): Array<[number, number, number]> {
  const sorted = [...keys].sort((a, b) => a[0] - b[0]).map((k) => [k[0], k[1], k[2]] as [number, number, number]);
  if (sorted.length <= max) return sorted;
  const out: Array<[number, number, number]> = [];
  for (let i = 0; i < max; i++) out.push(sorted[Math.round((i * (sorted.length - 1)) / (max - 1))]);
  return out;
}

const even = (n: number) => Math.max(2, Math.trunc(n / 2) * 2);

/**
 * The source rectangle (buffer pixels) the layer shows at `fileSec`, matching
 * framingCrop: w = trunc(min(iw·zoom, ih·A)/2)·2, h = trunc(w/A/2)·2, centred
 * on the keys (piecewise linear on the file's clock) and kept inside.
 * Without framing the overlay goes on the whole source.
 */
export function trailWindow(
  layer: Pick<VideoLayer, "framing" | "w" | "h">,
  zeroAtSec: number,
  iw: number,
  ih: number,
): { w: number; h: number; at: (fileSec: number) => { x: number; y: number } } {
  const framing = layer.framing;
  if (!framing?.keys.length) return { w: iw, h: ih, at: () => ({ x: 0, y: 0 }) };
  const A = Math.max(2, Math.round(layer.w)) / Math.max(2, Math.round(layer.h));
  const w = even(Math.min(iw * framing.zoom, ih * A));
  const h = even(w / A);
  const keys = thin(framing.keys);
  return {
    w,
    h,
    at: (fileSec) => {
      const [cx, cy] = framingCentre({ keys }, (fileSec - zeroAtSec) * 1000);
      return {
        x: Math.max(0, Math.min(iw - w, cx * iw - w / 2)),
        y: Math.max(0, Math.min(ih - h, cy * ih - h / 2)),
      };
    },
  };
}

/** Video packet timestamps (seconds), sorted: one per frame, read without decoding. */
export function probeFrameTimes(file: string): Promise<number[]> {
  return new Promise((resolve, reject) => {
    execFile("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts_time", "-of", "csv=p=0", file],
      { timeout: 60_000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
        if (err) return reject(err);
        const times = stdout.split("\n").map((l) => Number(l.trim().split(",")[0])).filter((n) => Number.isFinite(n));
        resolve(times.sort((a, b) => a - b));
      });
  });
}

/**
 * Draw the trail frames for one footage file and write their ffconcat list.
 * Null when the ball path draws nothing over the part of the file the layer uses.
 */
export async function prepareBallTrail(opts: {
  layer: Pick<VideoLayer, "id" | "framing" | "w" | "h">;
  file: { path: string; zeroAtSec: number; sourceDimensions?: { width: number; height: number } };
  /** the match's ball path: [video seconds, x, y] as shares of the panorama */
  samples: ReadonlyArray<BallTrailSample>;
  /** match video seconds at the file's 0 */
  fileStartSec: number;
  /** the stretch of the file the layer uses (file seconds) */
  usedFrom: number;
  usedTo: number;
  workDir: string;
  frameTimes?: number[];
}): Promise<BallTrailTrack | null> {
  const iw = opts.file.sourceDimensions?.width ?? 3840;
  const ih = opts.file.sourceDimensions?.height ?? 1080;
  const win = trailWindow(opts.layer, opts.file.zeroAtSec, iw, ih);
  const times = (opts.frameTimes ?? await probeFrameTimes(opts.file.path))
    .filter((t) => t <= opts.usedTo + 0.25)
    .slice(0, MAX_TRAIL_FRAMES);
  if (!times.length) return null;

  const scale = Math.min(1, MAX_DRAW_WIDTH / win.w);
  const W = even(win.w * scale);
  const H = even(win.h * scale);
  const dir = path.join(opts.workDir, `trail-${opts.layer.id.replace(/[^a-zA-Z0-9_-]/g, "_")}`);
  await fs.promises.mkdir(dir, { recursive: true });
  const blank = path.join(dir, "blank.png");
  await fs.promises.writeFile(blank, await createCanvas(W, H).encode("png"));

  const width = trailWidthFor(ih) * scale;
  const entries: Array<{ file: string; duration: number }> = [];
  if (times[0] > 0.0005) entries.push({ file: blank, duration: times[0] });
  let drawn = 0;
  for (let i = 0; i < times.length; i++) {
    const t = times[i];
    const duration = i + 1 < times.length ? times[i + 1] - t : 0.05;
    let file = blank;
    if (t >= opts.usedFrom - 0.25) {
      const points = ballTrailAt(opts.samples, opts.fileStartSec + t);
      if (points) {
        const { x, y } = win.at(t);
        const canvas = createCanvas(W, H);
        const ctx = canvas.getContext("2d");
        drawBallTrail(ctx as unknown as Parameters<typeof drawBallTrail>[0], points,
          (px, py) => [(px * iw - x) * scale, (py * ih - y) * scale], width);
        file = path.join(dir, `t${String(i).padStart(5, "0")}.png`);
        await fs.promises.writeFile(file, await canvas.encode("png"));
        drawn++;
      }
    }
    entries.push({ file, duration: Math.max(0.001, duration) });
  }
  if (!drawn) return null;
  const quote = (p: string) => `'${p.replace(/'/g, "'\\''")}'`;
  const lines = ["ffconcat version 1.0"];
  for (const e of entries) lines.push(`file ${quote(e.file)}`, `duration ${e.duration.toFixed(6)}`);
  // The concat demuxer drops the last entry's duration unless the file is listed again.
  lines.push(`file ${quote(entries[entries.length - 1].file)}`);
  const list = path.join(dir, "trail.ffconcat");
  await fs.promises.writeFile(list, `${lines.join("\n")}\n`);
  logger.info({ layerId: opts.layer.id, frames: times.length, drawn, w: win.w, h: win.h }, "Creative render: ball trail drawn");
  return { list, w: win.w, h: win.h, drawn };
}
