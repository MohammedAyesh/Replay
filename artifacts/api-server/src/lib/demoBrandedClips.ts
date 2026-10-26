/**
 * Demo copies of real player clips, in the new Jordan Galaxy branding.
 *
 * Mohammed (2026-10-26): the demo's clips should be "the new ones I made for
 * Jordan Galaxy". Only clips exported after a venue switched drawn branding on
 * carry it, and one of those ends on a player card with a name on it. So the
 * demo renders its own copy of each clip it shows: the same window and camera
 * path from the recording, through the same renderer a player's export uses,
 * with the Jordan Galaxy preset's corner crest and its sign-off card (no names,
 * no numbers). Players' own clips are never touched.
 *
 * Copies live in Bunny Storage under demo/branded/<version>/, so each clip is
 * rendered once, ever. Bump DEMO_BRAND_VERSION when the look changes.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";
import { spawn } from "child_process";
import { like, sql } from "drizzle-orm";
import { db, recordingsTable, userClipsTable } from "@workspace/db";

import {
  BUNNY_CDN_HOSTNAME,
  BUNNY_STORAGE_API_KEY,
  BUNNY_STORAGE_HOSTNAME,
  BUNNY_STORAGE_ZONE,
  getBunnyVideoInfo,
  isBunnyConfigured,
  isBunnyStorageConfigured,
  uploadBufferToBunnyStorage,
  uploadFileToBunnyStoragePath,
} from "./bunny";
import { loadLocalImage, replayMarkPath } from "./clipBranding/assets";
import { demoBrandLook } from "./clipBranding/demoLook";
import { renderOverlayPng } from "./clipBranding/overlay";
import { dateLabelFromLocal, publicBase } from "./clipBranding/plan";
import type { EndScreenJob } from "./clipBranding/endScreenVideo";
import { selectExportSource } from "./exportSource";
import { bufferRemoteClip, cleanupTempFile, getOutputDims, renderClip } from "./ffmpegExport";
import { logger } from "./logger";
import { renderQueue } from "./renderQueue";

export const DEMO_BRAND_VERSION = "galaxy-v1";
/** The card's length, blur and darkening: the same as field 10's switched-on look. */
const CARD = { seconds: 2.5, blur: 22, dim: 0.5 } as const;
/** A clip that failed is tried again after this long, not on every visit. */
const RETRY_AFTER_MS = 30 * 60 * 1000;

type ClipRow = typeof userClipsTable.$inferSelect;
type State = { status: "ready" } | { status: "rendering" } | { status: "failed"; at: number } | { status: "missing" };

const state = new Map<number, State>();
const checking = new Map<number, Promise<boolean>>();
const listeners = new Set<() => void>();
let queue: Promise<void> = Promise.resolve();

export function demoBrandedVideoPath(clipId: number): string {
  return `demo/branded/${DEMO_BRAND_VERSION}/c${clipId}.mp4`;
}

export function demoBrandedPosterPath(clipId: number): string {
  return `demo/branded/${DEMO_BRAND_VERSION}/c${clipId}.jpg`;
}

/** Called whenever a copy becomes ready, so the showcase cache can let it in. */
export function onDemoBrandedReady(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function isDemoBrandedReady(clipId: number): boolean {
  return state.get(clipId)?.status === "ready";
}

/** Test hook. */
export function resetDemoBrandedState(): void {
  state.clear();
  checking.clear();
  queue = Promise.resolve();
}

async function storageHas(remotePath: string): Promise<boolean> {
  const response = await fetch(`https://${BUNNY_STORAGE_HOSTNAME}/${BUNNY_STORAGE_ZONE}/${remotePath}`, {
    headers: { AccessKey: BUNNY_STORAGE_API_KEY, Range: "bytes=0-0" },
    signal: AbortSignal.timeout(10_000),
  });
  await response.body?.cancel().catch(() => {});
  if (response.status === 404) return false;
  if (response.ok) return true;
  throw new Error(`Bunny Storage answered ${response.status} for ${remotePath}`);
}

/** Whether both files of a clip's copy are in Storage, asked once per server. */
async function checkStored(clipId: number): Promise<boolean> {
  const known = state.get(clipId);
  if (known?.status === "ready") return true;
  if (known && known.status !== "missing") return false;
  let pending = checking.get(clipId);
  if (!pending) {
    pending = Promise.all([storageHas(demoBrandedVideoPath(clipId)), storageHas(demoBrandedPosterPath(clipId))])
      .then(([video, poster]) => {
        const ready = video && poster;
        if (ready) state.set(clipId, { status: "ready" });
        else if (!state.has(clipId)) state.set(clipId, { status: "missing" });
        return ready;
      })
      .catch((err) => {
        logger.warn({ err, clipId }, "Could not check a demo clip copy in Storage");
        return false;
      })
      .finally(() => checking.delete(clipId));
    checking.set(clipId, pending);
  }
  return pending;
}

/**
 * Which of these clips have their branded copy ready. Starts rendering the
 * rest in the background, one at a time, behind players' own exports.
 */
export async function demoBrandedReadyIds(clips: ClipRow[]): Promise<Set<number>> {
  const ready = new Set<number>();
  if (!isBunnyStorageConfigured() || !isBunnyConfigured()) return ready;
  await Promise.all(clips.map(async (clip) => {
    if (await checkStored(clip.id)) ready.add(clip.id);
  }));
  for (const clip of clips) {
    if (ready.has(clip.id)) continue;
    const current = state.get(clip.id);
    if (current?.status === "rendering") continue;
    if (current?.status === "failed" && Date.now() - current.at < RETRY_AFTER_MS) continue;
    state.set(clip.id, { status: "rendering" });
    queue = queue.then(() => renderAndStore(clip)).catch(() => {});
  }
  return ready;
}

async function renderAndStore(clip: ClipRow): Promise<void> {
  try {
    await renderQueue.run(`demo-${clip.id}`, async () => {
      const file = await renderDemoCopy(clip);
      try {
        const poster = await posterFrom(file);
        await uploadFileToBunnyStoragePath(file, demoBrandedVideoPath(clip.id));
        await uploadBufferToBunnyStorage(poster, demoBrandedPosterPath(clip.id), "image/jpeg");
      } finally {
        cleanupTempFile(file);
      }
    });
    state.set(clip.id, { status: "ready" });
    logger.info({ clipId: clip.id, version: DEMO_BRAND_VERSION }, "Demo clip copy rendered in the Jordan Galaxy branding");
    for (const listener of listeners) {
      try { listener(); } catch { /* a listener never stops the queue */ }
    }
  } catch (err) {
    state.set(clip.id, { status: "failed", at: Date.now() });
    logger.error({ err, clipId: clip.id }, "Could not render a demo clip copy");
  }
}

/** "2026-10-22" + "22:30" → "THU 22 OCT · 22:30", from the clip's recording. */
async function recordingDateLabel(videoId: string): Promise<string | null> {
  const [recording] = await db
    .select({ date: recordingsTable.date, timeSlot: recordingsTable.timeSlot })
    .from(recordingsTable)
    .where(like(recordingsTable.videoUrl, sql`${"%" + videoId + "%"}`))
    .limit(1)
    .catch(() => []);
  if (!recording) return null;
  const time = /^(\d{1,2}):(\d{2})/.exec(recording.timeSlot ?? "");
  return time ? dateLabelFromLocal(`${recording.date} ${time[1].padStart(2, "0")}:${time[2]}`) : null;
}

function exportWindow(startFraction: number, endFraction: number, duration: number) {
  const total = Math.max(0, Number.isFinite(duration) ? duration : 0);
  const startSec = Math.min(total, Math.max(0, (Number.isFinite(startFraction) ? startFraction : 0) * total));
  const endSec = Math.min(total, Math.max(startSec, (Number.isFinite(endFraction) ? endFraction : 1) * total));
  return { startSec, clipDuration: endSec - startSec };
}

/** The clip, from its recording, with the preset's crest and sign-off card. */
async function renderDemoCopy(clip: ClipRow): Promise<string> {
  const temps: string[] = [];
  try {
    const info = await getBunnyVideoInfo(clip.videoId);
    const { startSec, clipDuration } = exportWindow(Number(clip.startTime), Number(clip.endTime), info.duration);
    if (clipDuration <= 0) throw new Error("The clip has no footage");

    const referer = `https://${BUNNY_CDN_HOSTNAME}/`;
    const source = await selectExportSource({
      videoId: clip.videoId,
      hasMP4Fallback: info.hasMP4Fallback,
      availableResolutions: info.availableResolutions,
      referer,
    });
    const buffer = await bufferRemoteClip({ remoteUrl: source.url, referer, startSec, clipDuration, totalDuration: info.duration });
    temps.push(buffer.bufferPath);

    const portrait = clip.aspectRatio === "9:16";
    const look = await demoBrandLook({ look: "galaxy", name: "", color: "", persona: "pitch" });
    const mark = await loadLocalImage(replayMarkPath());
    const dateLabel = await recordingDateLabel(clip.videoId);
    const overlay = path.join(os.tmpdir(), `soccerwatch-demo-overlay-${randomUUID()}.png`);
    await fs.promises.writeFile(overlay, renderOverlayPng({ style: "cornerCrest", look, dims: getOutputDims(portrait), dateLabel, mark }));
    temps.push(overlay);

    const endScreen: EndScreenJob = {
      // The QR opens the demo, not the player's share card: the copy belongs to the demo.
      spec: { kind: "signOff", look, dateLabel, link: `${publicBase()}/demo` },
      ...CARD,
    };
    return await renderClip({
      videoUrl: buffer.bufferPath,
      totalDuration: buffer.bufferedDuration,
      startTime: Math.max(0, buffer.adjustedOffsetSec / buffer.bufferedDuration),
      endTime: Math.min(1, (buffer.adjustedOffsetSec + clipDuration) / buffer.bufferedDuration),
      cropPath: (clip.cropPath ?? []) as { t: number; x: number; y: number; w: number; h: number }[],
      aspectRatio: clip.aspectRatio,
      title: `demo-${clip.id}`,
      overlayUrl: overlay,
      endScreen,
    });
  } finally {
    for (const file of temps) cleanupTempFile(file);
  }
}

/** A still from a second in: the crest is on it and the play has started. */
async function posterFrom(video: string): Promise<Buffer> {
  const out = path.join(os.tmpdir(), `soccerwatch-demo-poster-${randomUUID()}.jpg`);
  try {
    await new Promise<void>((resolve, reject) => {
      const proc = spawn("ffmpeg", [
        "-nostdin", "-y", "-v", "error", "-ss", "1", "-i", video,
        "-frames:v", "1", "-vf", "scale='min(720,iw)':-2", "-q:v", "4", out,
      ], { stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      proc.stderr?.on("data", (data: Buffer) => { stderr = (stderr + data.toString()).slice(-2000); });
      const timer = setTimeout(() => { proc.kill("SIGKILL"); reject(new Error("Poster timed out")); }, 60_000);
      proc.on("error", (err) => { clearTimeout(timer); reject(err); });
      proc.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`Poster failed: ${stderr}`));
      });
    });
    return await fs.promises.readFile(out);
  } finally {
    fs.unlink(out, () => {});
  }
}
