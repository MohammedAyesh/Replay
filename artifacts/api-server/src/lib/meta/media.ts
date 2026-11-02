import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { eq } from "drizzle-orm";
import { academyAdMediaTable, db, type AcademyAdMedia } from "@workspace/db";
import { uploadFileToBunnyStoragePath } from "../bunny";
import { fetchExportObject } from "../backupExport";
import { logger } from "../logger";
import { graphPost, graphUploadVideo, MetaGraphError, waitForVideo } from "./graph";

/**
 * An academy's ad photos and videos. Photos live in the row as a data URL; videos live in
 * Bunny Storage (served back through the API) and are uploaded to each ad account they run
 * from the first time they're needed: Meta keeps a video per account.
 */

export const MAX_VIDEO_BYTES = 300 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_VIDEO_SECONDS = 10 * 60;

function run(bin: string, args: string[], timeoutMs = 120_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
    proc.stdout.on("data", (d) => { out += d; });
    proc.stderr.on("data", (d) => { err += d; });
    proc.on("error", (e) => { clearTimeout(timer); reject(e); });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`${bin} exited ${code}: ${err.slice(-300)}`));
    });
  });
}

export type VideoFacts = { durationSec: number | null; width: number | null; height: number | null };

export async function probeVideo(filePath: string): Promise<VideoFacts> {
  const out = await run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:format=duration", "-of", "json", filePath], 30_000);
  const data = JSON.parse(out) as { streams?: Array<{ width?: number; height?: number }>; format?: { duration?: string } };
  const stream = data.streams?.[0];
  if (!stream?.width || !stream?.height) throw new Error("No video stream");
  const duration = Number(data.format?.duration);
  return { durationSec: Number.isFinite(duration) ? Math.round(duration * 10) / 10 : null, width: stream.width, height: stream.height };
}

/** A JPEG still (≤ 1080 px wide) from about a second in, as a data URL. */
export async function videoStill(filePath: string, durationSec: number | null): Promise<string> {
  const out = path.join(os.tmpdir(), `ad-still-${randomUUID()}.jpg`);
  const at = durationSec && durationSec > 2 ? Math.min(1, durationSec / 4) : 0;
  try {
    await run("ffmpeg", ["-nostdin", "-v", "error", "-ss", String(at), "-i", filePath, "-frames:v", "1", "-vf", "scale='min(1080,iw)':-2", "-q:v", "3", "-y", out], 60_000);
    return `data:image/jpeg;base64,${(await fs.promises.readFile(out)).toString("base64")}`;
  } finally {
    await fs.promises.rm(out, { force: true });
  }
}

/** Copy a video file into Bunny Storage under the academy's media folder. */
export async function storeVideo(academyId: number, filePath: string): Promise<string> {
  return uploadFileToBunnyStoragePath(filePath, `ad-media/${academyId}/${randomUUID()}.mp4`);
}

/** Download a stored object (Bunny Storage or a finished clip export) to a temp file. */
export async function downloadToTemp(url: string, suffix = ".mp4"): Promise<string> {
  const response = await fetchExportObject(url);
  if (!response.ok || !response.body) throw new Error(`Couldn't read the stored video (${response.status})`);
  const file = path.join(os.tmpdir(), `ad-media-${randomUUID()}${suffix}`);
  await pipeline(Readable.fromWeb(response.body as never), fs.createWriteStream(file));
  return file;
}

export async function imageHash(dataUrl: string, act: string, token: string | undefined): Promise<string> {
  const match = dataUrl.match(/^data:image\/(png|jpe?g|webp);base64,(.+)$/);
  if (!match) throw new MetaGraphError("The ad needs a JPG or PNG image", 400);
  const res = await graphPost<{ images: Record<string, { hash: string }> }>(`${act}/adimages`, { bytes: match[2] }, { token });
  const hash = Object.values(res.images ?? {})[0]?.hash;
  if (!hash) throw new MetaGraphError("Meta didn't accept the image", 502);
  return hash;
}

type MetaVideos = Record<string, { videoId: string }>;

/**
 * The video's id in this ad account, uploading it there first if needed, and waiting (up to
 * the timeout) for Meta to finish processing it.
 */
export async function ensureMetaVideo(media: AcademyAdMedia, act: string, token: string | undefined, timeoutMs = 120_000): Promise<string> {
  if (media.kind !== "video" || !media.storageUrl) throw new MetaGraphError("That isn't a video", 400);
  const known = ((media.metaVideos ?? {}) as MetaVideos)[act]?.videoId;
  let videoId = known;
  if (!videoId) {
    const file = await downloadToTemp(media.storageUrl);
    try {
      videoId = await graphUploadVideo(act, file, media.name || `Replay ${media.id}`, { token });
    } finally {
      await fs.promises.rm(file, { force: true });
    }
    // Re-read so a concurrent upload to another account isn't lost.
    const [fresh] = await db.select({ metaVideos: academyAdMediaTable.metaVideos }).from(academyAdMediaTable).where(eq(academyAdMediaTable.id, media.id));
    const merged: MetaVideos = { ...((fresh?.metaVideos ?? {}) as MetaVideos), [act]: { videoId } };
    await db.update(academyAdMediaTable).set({ metaVideos: merged }).where(eq(academyAdMediaTable.id, media.id));
  }
  const state = await waitForVideo(videoId, { token, timeoutMs });
  if (state === "error") throw new MetaGraphError("Facebook couldn't process this video. Try a different file.", 400);
  if (state !== "ready") throw new MetaGraphError("Facebook is still processing the video. Try again in a minute or two.", 409);
  return videoId;
}

/** Start uploading a new video to the account it will most likely run from. Never throws. */
export function preloadVideo(media: AcademyAdMedia, act: string | null, token: string | undefined): void {
  if (!act) return;
  void ensureMetaVideo(media, act, token, 1000).catch((error) => {
    if (error instanceof MetaGraphError && error.status === 409) return; // still processing: fine
    logger.warn({ mediaId: media.id, error: (error as Error).message }, "Pre-uploading an ad video to Meta failed");
  });
}
