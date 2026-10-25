import { spawn } from "child_process";
import { randomUUID } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { createCanvas } from "@napi-rs/canvas";
import { logger } from "../logger";
import { ensureBrandingFonts, loadLocalImage, replayMarkPath } from "./assets";
import { drawEndScreenFrame } from "./endScreenFrame";
import type { Dims, EndScreen } from "./types";

/**
 * Puts an end screen over the last seconds of a rendered clip.
 *
 * The footage keeps playing underneath: a blurred copy of it fades in over the
 * sharp one (ffmpeg's gblur, faded in), and the card is drawn frame by frame in
 * Node and laid over that as raw RGBA. The card being ordinary 2D canvas code is
 * the point — easing, count-ups, Arabic shaping and a real QR code are all one
 * function, and the same function draws the console's preview.
 *
 * Only the tail is re-encoded. The main render puts a keyframe exactly where the
 * end screen starts (see endScreenStart), so the head is a stream copy and the
 * two halves join with the concat demuxer like the intro and end card do.
 *
 * A clip too short to give up its last seconds gets the card appended instead,
 * over its last frame frozen and blurred: the moment itself is never covered.
 */

export const FPS = 30;
/** Clips shorter than this keep every frame; the card is appended. */
export const MIN_OVERLAP_CLIP_SECONDS = 6;

export type EndScreenJob = {
  spec: EndScreen;
  /** How long the card lasts. */
  seconds: number;
  /** Blur strength in design pixels (1080-wide portrait, 1920-wide landscape). */
  blur: number;
  /** 0–1. */
  dim: number;
};

/**
 * Where the end screen begins inside the main clip, or null when it is
 * appended. The main encode forces a keyframe here so the head can be copied.
 */
export function endScreenStart(clipDuration: number, seconds: number): number | null {
  if (clipDuration < Math.max(MIN_OVERLAP_CLIP_SECONDS, seconds + 3)) return null;
  // Whole frames, so the keyframe and the cut land on the same frame.
  return Math.round((clipDuration - seconds) * FPS) / FPS;
}

function spawnFfmpeg(args: string[], timeoutMs: number): {
  proc: ReturnType<typeof spawn>;
  done: Promise<void>;
} {
  const proc = spawn("ffmpeg", args, { stdio: ["pipe", "ignore", "pipe"] });
  let stderr = "";
  proc.stderr?.on("data", (d: Buffer) => { stderr = (stderr + d.toString()).slice(-6000); });
  const done = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`ffmpeg timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    proc.on("error", (err) => { clearTimeout(timer); reject(err); });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-1500)}`));
    });
  });
  return { proc, done };
}

async function runFfmpeg(args: string[], timeoutMs = 300_000): Promise<void> {
  const { proc, done } = spawnFfmpeg(args, timeoutMs);
  proc.stdin?.end();
  await done;
}

async function probeDuration(file: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]);
    let out = "";
    proc.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    proc.on("error", reject);
    proc.on("close", (code) => {
      const n = Number.parseFloat(out.trim());
      if (code === 0 && Number.isFinite(n)) resolve(n);
      else reject(new Error(`ffprobe could not read the duration of ${file}`));
    });
  });
}

/**
 * Draw every frame of the card and write it to `sink` as raw RGBA, honouring
 * back-pressure so a slow encoder never buffers seconds of 2 MB frames.
 */
export async function writeCardFrames(
  sink: NodeJS.WritableStream,
  job: EndScreenJob,
  dims: Dims,
): Promise<void> {
  ensureBrandingFonts();
  const portrait = dims.h > dims.w;
  const scale = dims.w / (portrait ? 1080 : 1920);
  const mark = await loadLocalImage(replayMarkPath());
  const canvas = createCanvas(dims.w, dims.h);
  const ctx = canvas.getContext("2d");
  const frames = Math.round(job.seconds * FPS);
  for (let i = 0; i < frames; i++) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, dims.w, dims.h);
    ctx.scale(scale, scale);
    drawEndScreenFrame(ctx, job.spec, i / FPS, {
      portrait,
      total: job.seconds,
      dim: job.dim,
      mark,
    });
    const pixels = ctx.getImageData(0, 0, dims.w, dims.h).data;
    const chunk = Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength);
    if (!sink.write(chunk)) {
      await new Promise<void>((resolve, reject) => {
        const onDrain = () => { cleanup(); resolve(); };
        const onError = (err: Error) => { cleanup(); reject(err); };
        const cleanup = () => { sink.off("drain", onDrain); sink.off("error", onError); };
        sink.on("drain", onDrain);
        sink.on("error", onError);
      });
    }
  }
  sink.end();
}

/**
 * Render the card over `background` (the clip's tail, or its frozen last frame)
 * to an MP4 encoded with the shared export spec.
 */
async function renderTail(options: {
  mainPath: string;
  dims: Dims;
  job: EndScreenJob;
  start: number;
  appended: boolean;
  encode: { video: string[]; audio: string[] };
  hasAudio: boolean;
}): Promise<string> {
  const { mainPath, dims, job, start, appended, encode } = options;
  const out = path.join(os.tmpdir(), `soccerwatch-endscreen-${randomUUID()}.mp4`);
  const portrait = dims.h > dims.w;
  const scale = dims.w / (portrait ? 1080 : 1920);
  const sigma = Math.max(0.5, job.blur * scale);
  const S = job.seconds.toFixed(3);
  const ramp = 0.4;

  // Seek on the input (accurate when transcoding) rather than trimming in the
  // graph, so a long clip is not decoded from its first frame.
  const seekTo = appended ? Math.max(0, start - 0.1) : start;
  const videoIn = appended
    // The last frame, held for the whole card.
    ? `[0:v]setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=${S},trim=duration=${S},setpts=PTS-STARTPTS`
    : `[0:v]setpts=PTS-STARTPTS,trim=duration=${S},setpts=PTS-STARTPTS`;
  const filter = [
    `${videoIn},fps=${FPS},format=yuv420p,split=2[sharp][toblur]`,
    // Blurred at a quarter of the size and scaled back: the same look for a
    // blur this heavy, at a fraction of the cost on a 1080p frame. It fades in
    // over the sharp copy as an alpha ramp — `blend` with a time expression
    // does the same thing per pixel in the expression evaluator and was 4x
    // slower on a 1080p tail.
    `[toblur]scale=trunc(iw/8)*2:trunc(ih/8)*2,gblur=sigma=${(sigma / 4).toFixed(2)},` +
      `scale=${dims.w}:${dims.h}:flags=bilinear,format=yuva420p,fade=t=in:st=0:d=${ramp}:alpha=1[blurred]`,
    `[sharp][blurred]overlay=0:0[bg]`,
    `[1:v]format=rgba[card]`,
    `[bg][card]overlay=0:0:format=auto:shortest=1,format=yuv420p[v]`,
    appended || !options.hasAudio
      ? `[2:a]atrim=duration=${S},asetpts=PTS-STARTPTS[a]`
      // The clip's sound carries on, ducked to 30% as the card lands.
      : `[0:a]asetpts=PTS-STARTPTS,atrim=duration=${S},` +
        `volume='if(lt(t,${ramp}),1-0.7*t/${ramp},0.3)':eval=frame[a]`,
  ].join(";");

  const args = [
    "-y",
    "-ss", seekTo.toFixed(3),
    "-i", mainPath,
    // Input 1: the card, as raw RGBA frames on stdin.
    "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${dims.w}x${dims.h}`, "-framerate", String(FPS), "-i", "pipe:0",
    "-f", "lavfi", "-t", S, "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
    "-filter_complex", filter,
    "-map", "[v]", "-map", "[a]",
    "-t", S,
    ...encode.video,
    ...encode.audio,
    "-movflags", "+faststart",
    out,
  ];
  const { proc, done } = spawnFfmpeg(args, 300_000);
  const writing = writeCardFrames(proc.stdin!, job, dims).catch((err) => {
    proc.kill("SIGKILL");
    throw err;
  });
  try {
    await Promise.all([writing, done]);
  } catch (err) {
    fs.unlink(out, () => {});
    throw err;
  }
  return out;
}

async function concat(parts: string[]): Promise<string> {
  const list = path.join(os.tmpdir(), `soccerwatch-endscreen-list-${randomUUID()}.txt`);
  const out = path.join(os.tmpdir(), `soccerwatch-endscreen-final-${randomUUID()}.mp4`);
  await fs.promises.writeFile(list, parts.map((p) => `file '${p}'`).join("\n") + "\n", "utf8");
  try {
    await runFfmpeg(["-nostdin", "-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-movflags", "+faststart", out]);
  } catch (err) {
    fs.unlink(out, () => {});
    throw err;
  } finally {
    fs.unlink(list, () => {});
  }
  return out;
}

/**
 * Apply the end screen to `mainPath` and return the new file. Throws on any
 * failure; the caller decides that a clip without its end screen is still a
 * clip (renderClip does, and exports `mainPath` unchanged).
 */
export async function applyEndScreen(options: {
  mainPath: string;
  dims: Dims;
  job: EndScreenJob;
  /** From endScreenStart(), the same value the main encode keyed on. */
  start: number | null;
  encode: { video: string[]; audio: string[] };
  hasAudio: boolean;
}): Promise<string> {
  const { mainPath, job, encode } = options;
  const duration = await probeDuration(mainPath);
  const appended = options.start === null || options.start >= duration - 0.5;
  const start = appended ? duration : options.start!;
  const temps: string[] = [];
  try {
    const tail = await renderTail({
      mainPath,
      dims: options.dims,
      job,
      start,
      appended,
      encode,
      hasAudio: options.hasAudio,
    });
    temps.push(tail);

    let head = mainPath;
    if (!appended) {
      head = path.join(os.tmpdir(), `soccerwatch-endscreen-head-${randomUUID()}.mp4`);
      temps.push(head);
      // A stream copy up to the forced keyframe: no second encode of the clip.
      await runFfmpeg(["-nostdin", "-y", "-i", mainPath, "-t", start.toFixed(3), "-c", "copy", "-avoid_negative_ts", "make_zero", head]);
    }
    const final = await concat([head, tail]);
    logger.info({ kind: job.spec.kind, appended, start, seconds: job.seconds }, "End screen applied");
    return final;
  } finally {
    for (const t of temps) fs.unlink(t, () => {});
  }
}
