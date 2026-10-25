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
 * Puts an end screen after a rendered clip, over the footage that follows it.
 *
 * The clip the player chose is never covered: the export renders a few seconds
 * past his end point, and the card plays over those (Mohammed, 2026-10-25: "the
 * recording should keep going for more seconds and add the branding at the
 * end"). A blurred copy of that footage fades in over the sharp one (ffmpeg's
 * gblur, faded in), and the card is drawn frame by frame in Node and laid over
 * it as raw RGBA. The card being ordinary 2D canvas code is the point —
 * easing, count-ups, Arabic shaping and a real QR code are all one function,
 * and the same function draws the console's preview.
 *
 * Only the tail is re-encoded. The main render puts a keyframe exactly at the
 * clip's end (see endScreenStart), so the clip itself is a stream copy and the
 * two halves join with the concat demuxer like the intro and end card do.
 *
 * When the recording stops before the card does (a clip at the very end of an
 * hour), the last frame is held for the rest of it.
 */

export const FPS = 30;

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
 * Where the end screen begins: the end of the clip the player chose, on a
 * frame boundary. The main encode forces a keyframe here so the clip can be
 * copied, and renders up to `seconds` of footage past it for the card.
 */
export function endScreenStart(clipDuration: number): number {
  return Math.max(0, Math.round(clipDuration * FPS) / FPS);
}

/** How much footage past the clip the export renders for the card. */
export function endScreenRunOn(clipEndSec: number, sourceDuration: number, seconds: number): number {
  const left = Number.isFinite(sourceDuration) ? sourceDuration - clipEndSec : 0;
  // Less than a frame is nothing: the card then holds the last frame.
  const runOn = Math.max(0, Math.min(seconds, left));
  return runOn < 1 / FPS ? 0 : Math.floor(runOn * FPS) / FPS;
}

function spawnFfmpeg(args: string[], timeoutMs: number): {
  proc: ReturnType<typeof spawn>;
  done: Promise<void>;
} {
  const proc = spawn("ffmpeg", args, { stdio: ["pipe", "ignore", "pipe"] });
  // If FFmpeg exits while frames are still being written, the next write fails
  // with EPIPE. Without a listener that is an uncaught error that takes the
  // whole API server down; `done` already reports the failure.
  proc.stdin?.on("error", () => {});
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
  const closed = () => {
    const w = sink as NodeJS.WritableStream & { destroyed?: boolean; writableEnded?: boolean };
    return w.destroyed === true || w.writableEnded === true;
  };
  for (let i = 0; i < frames; i++) {
    // The reader has gone (FFmpeg finished, or was killed): stop drawing.
    if (closed()) return;
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
        // A pipe that closes without draining must not leave this waiting forever.
        const onClose = () => { cleanup(); resolve(); };
        const cleanup = () => {
          sink.off("drain", onDrain);
          sink.off("error", onError);
          sink.off("close", onClose);
        };
        sink.on("drain", onDrain);
        sink.on("error", onError);
        sink.on("close", onClose);
      });
    }
  }
  if (!closed()) sink.end();
}

function isClosedPipe(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  return code === "EPIPE" || code === "ERR_STREAM_DESTROYED" || code === "ERR_STREAM_WRITE_AFTER_END";
}

/**
 * Run FFmpeg with the card's frames on its stdin. FFmpeg's exit decides the
 * result: a run that finishes cleanly before reading every frame (it reached
 * its -t, or the shortest input ended — FFmpeg 7.1 stops a few frames earlier
 * than 6.1 on the appended path) leaves the rest unread, and those writes fail
 * with EPIPE. That is not a failure. A drawing error is, and kills FFmpeg so it
 * cannot sit waiting for frames that will never come.
 */
export async function ffmpegWithCard(args: string[], job: EndScreenJob, dims: Dims, timeoutMs = 300_000): Promise<void> {
  const { proc, done } = spawnFfmpeg(args, timeoutMs);
  const writing = writeCardFrames(proc.stdin!, job, dims).catch((err) => {
    if (!isClosedPipe(err)) {
      proc.kill("SIGKILL");
      throw err;
    }
  });
  try {
    await done;
  } catch (err) {
    // FFmpeg failed; if the writer failed first, its error is the cause.
    await writing.catch((writerErr) => { throw writerErr; });
    throw err;
  }
  proc.stdin?.destroy();
  await writing.catch(() => {});
}

/**
 * Render the card over the footage after `start` (held on its last frame when
 * it runs out) to an MP4 encoded with the shared export spec. Always exactly
 * `job.seconds` long.
 */
async function renderTail(options: {
  mainPath: string;
  dims: Dims;
  job: EndScreenJob;
  start: number;
  /** No footage after `start`: the card holds the clip's last frame. */
  held: boolean;
  duration: number;
  encode: { video: string[]; audio: string[] };
  hasAudio: boolean;
}): Promise<string> {
  const { mainPath, dims, job, start, held, encode } = options;
  const out = path.join(os.tmpdir(), `soccerwatch-endscreen-${randomUUID()}.mp4`);
  const portrait = dims.h > dims.w;
  const scale = dims.w / (portrait ? 1080 : 1920);
  const sigma = Math.max(0.5, job.blur * scale);
  const S = job.seconds.toFixed(3);
  const ramp = 0.4;

  // Seek on the input (accurate when transcoding) rather than trimming in the
  // graph, so a long clip is not decoded from its first frame. A held card
  // seeks just before the end so there is a last frame to hold.
  const seekTo = held ? Math.max(0, options.duration - 0.1) : start;
  // Whatever footage follows, then its last frame held, cut to the card's length.
  const videoIn =
    `[0:v]setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=${S},trim=duration=${S},setpts=PTS-STARTPTS`;
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
    held || !options.hasAudio
      ? `[2:a]atrim=duration=${S},asetpts=PTS-STARTPTS[a]`
      // The match's sound carries on, ducked to 30% as the card lands, and
      // goes quiet if the recording ends first.
      : `[0:a]asetpts=PTS-STARTPTS,apad,atrim=duration=${S},` +
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
  try {
    await ffmpegWithCard(args, job, dims, 300_000);
  } catch (err) {
    fs.unlink(out, () => {});
    throw err;
  }
  return out;
}

/**
 * Everything before the forced keyframe at `start`, stream-copied: no second
 * encode of the clip.
 *
 * Not `-t start -c copy`: that cuts in decode order, and with B-frames the
 * keyframe at `start` and the frame after it end up in the head as well, so the
 * footage jumps back two frames where the end screen begins. The segment muxer
 * splits on the keyframe itself, so the head ends on the frame before it.
 */
export async function cutHead(mainPath: string, start: number, temps: string[]): Promise<string> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "soccerwatch-endscreen-head-"));
  try {
    await runFfmpeg([
      "-nostdin", "-y", "-i", mainPath,
      "-map", "0", "-c", "copy",
      "-f", "segment",
      // Half a frame early, so the split lands on the keyframe at `start`.
      "-segment_times", Math.max(0, start - 0.5 / FPS).toFixed(4),
      "-reset_timestamps", "1",
      "-segment_format", "mp4",
      path.join(dir, "seg%d.mp4"),
    ]);
    const head = path.join(os.tmpdir(), `soccerwatch-endscreen-head-${randomUUID()}.mp4`);
    await fs.promises.rename(path.join(dir, "seg0.mp4"), head);
    temps.push(head);
    return head;
  } finally {
    fs.rm(dir, { recursive: true, force: true }, () => {});
  }
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
 * Apply the end screen to `mainPath` and return the new file: the clip up to
 * `start`, then the card for `job.seconds` over whatever footage follows.
 * Throws on any failure; the caller decides that a clip without its end screen
 * is still a clip (renderClip does, and trims the run-on footage off).
 */
export async function applyEndScreen(options: {
  mainPath: string;
  dims: Dims;
  job: EndScreenJob;
  /** The clip's end inside mainPath: endScreenStart(), the value the main encode keyed on. */
  start: number;
  encode: { video: string[]; audio: string[] };
  hasAudio: boolean;
}): Promise<string> {
  const { mainPath, job, encode } = options;
  const duration = await probeDuration(mainPath);
  const held = options.start >= duration - 1 / FPS;
  const start = Math.min(options.start, duration);
  const temps: string[] = [];
  try {
    const tail = await renderTail({
      mainPath,
      dims: options.dims,
      job,
      start,
      held,
      duration,
      encode,
      hasAudio: options.hasAudio,
    });
    temps.push(tail);

    const head = held ? mainPath : await cutHead(mainPath, start, temps);
    const final = await concat([head, tail]);
    logger.info(
      { kind: job.spec.kind, start, runOn: held ? 0 : Math.min(job.seconds, duration - start), seconds: job.seconds },
      "End screen applied",
    );
    return final;
  } finally {
    for (const t of temps) fs.unlink(t, () => {});
  }
}
