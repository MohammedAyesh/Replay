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
import { and, eq, isNull, like, sql } from "drizzle-orm";
import { db, recordingsTable, userClipsTable } from "@workspace/db";

import {
  BunnyVideoNotFoundError,
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
import { ExportSourceUnavailableError, selectExportSource } from "./exportSource";
import { bufferRemoteClip, cleanupTempFile, getOutputDims, renderClip } from "./ffmpegExport";
import { logger } from "./logger";
import { renderQueue } from "./renderQueue";

export const DEMO_BRAND_VERSION = "galaxy-v1";
/**
 * Two sets of copies: the pitch view's in the Jordan Galaxy preset, and the
 * academy view's in the JUFA preset (an academy that trains at Galaxy), so an
 * academy owner sees an academy's badge, not a pitch's (Mohammed, 26 Oct).
 */
export type DemoBrand = "galaxy" | "academy";
const BRAND_VERSIONS: Record<DemoBrand, string> = { galaxy: DEMO_BRAND_VERSION, academy: "jufa-v1" };
/** The card's length, blur and darkening: the same as field 10's switched-on look. */
const CARD = { seconds: 2.5, blur: 22, dim: 0.5 } as const;
/** A clip that failed is tried again after this long, not on every visit... */
const RETRY_AFTER_MS = 30 * 60 * 1000;
/** ...and not more than this many times on one server. */
const MAX_ATTEMPTS = 3;
/** How often a waiting demo render looks for an idle renderer. */
const IDLE_POLL_MS = 60_000;

type ClipRow = typeof userClipsTable.$inferSelect;
type State =
  | { status: "ready" }
  | { status: "rendering" }
  | { status: "failed"; at: number; attempts: number }
  /** Its recording is gone or cannot be exported: never tried again on this server. */
  | { status: "unrenderable" }
  | { status: "missing"; attempts: number };

const state = new Map<string, State>();
const checking = new Map<string, Promise<boolean | null>>();
const keyOf = (clipId: number, brand: DemoBrand) => `${brand}:${clipId}`;
const listeners = new Set<() => void>();
let queue: Promise<void> = Promise.resolve();

export function demoBrandedVideoPath(clipId: number, brand: DemoBrand = "galaxy"): string {
  return `demo/branded/${BRAND_VERSIONS[brand]}/c${clipId}.mp4`;
}

export function demoBrandedPosterPath(clipId: number, brand: DemoBrand = "galaxy"): string {
  return `demo/branded/${BRAND_VERSIONS[brand]}/c${clipId}.jpg`;
}

/** Called whenever a copy becomes ready, so the showcase cache can let it in. */
export function onDemoBrandedReady(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function isDemoBrandedReady(clipId: number, brand: DemoBrand = "galaxy"): boolean {
  return state.get(keyOf(clipId, brand))?.status === "ready";
}

/** Test hook. */
export function resetDemoBrandedState(): void {
  state.clear();
  checking.clear();
  queue = Promise.resolve();
}

/** Test hook: how long a queued demo render waits between looks at the renderer. */
let idlePollMs = IDLE_POLL_MS;
export function setDemoIdlePollMs(ms: number): void {
  idlePollMs = ms;
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

/**
 * Whether both files of a clip's copy are in Storage: true, false, or null
 * when Storage could not say (then nothing is rendered on the strength of it).
 * Asked once per server, and again while the copy is missing.
 */
export async function checkStored(clipId: number, brand: DemoBrand = "galaxy"): Promise<boolean | null> {
  const key = keyOf(clipId, brand);
  const known = state.get(key);
  if (known?.status === "ready") return true;
  if (known && known.status !== "missing") return false;
  let pending = checking.get(key);
  if (!pending) {
    pending = Promise.all([storageHas(demoBrandedVideoPath(clipId, brand)), storageHas(demoBrandedPosterPath(clipId, brand))])
      .then(([video, poster]): boolean => {
        const ready = video && poster;
        if (ready) state.set(key, { status: "ready" });
        else if (!state.has(key)) state.set(key, { status: "missing", attempts: 0 });
        return ready;
      })
      .catch((err): null => {
        logger.warn({ err, clipId }, "Could not check a demo clip copy in Storage");
        return null;
      })
      .finally(() => checking.delete(key));
    checking.set(key, pending);
  }
  return pending;
}

/**
 * Which of these clips have their branded copy ready. Starts rendering the
 * rest in the background, one at a time, behind players' own exports.
 */
export async function demoBrandedReadyIds(clips: ClipRow[], brand: DemoBrand = "galaxy"): Promise<Set<number>> {
  const ready = new Set<number>();
  if (!isBunnyStorageConfigured() || !isBunnyConfigured()) return ready;
  const unknown = new Set<number>();
  await Promise.all(clips.map(async (clip) => {
    const stored = await checkStored(clip.id, brand);
    if (stored) ready.add(clip.id);
    else if (stored === null) unknown.add(clip.id);
  }));
  for (const clip of clips) {
    if (ready.has(clip.id) || unknown.has(clip.id)) continue;
    const key = keyOf(clip.id, brand);
    const current = state.get(key);
    if (!current || current.status === "rendering" || current.status === "unrenderable" || current.status === "ready") continue;
    if (current.status === "failed" && (current.attempts >= MAX_ATTEMPTS || Date.now() - current.at < RETRY_AFTER_MS)) continue;
    const attempts = current.attempts;
    state.set(key, { status: "rendering" });
    queue = queue.then(() => renderAndStore(clip, brand, attempts)).catch(() => {});
  }
  return ready;
}

/**
 * Run one demo render only when this server's renderer is idle, so a demo copy
 * never takes a slot a player's export is waiting for, never pushes a player's
 * export to the backup renderer, and never shows in a player's queue position.
 */
async function whenIdle<T>(key: string, job: () => Promise<T>): Promise<T> {
  for (;;) {
    const now = renderQueue.snapshot();
    if (now.active === 0 && now.waiting === 0 && now.yielding === 0) {
      const attempt = await renderQueue.tryRunImmediately(key, job);
      if (attempt.started) return attempt.completion;
    }
    await new Promise((resolve) => setTimeout(resolve, idlePollMs).unref?.());
  }
}

function isPermanent(err: unknown): boolean {
  return err instanceof BunnyVideoNotFoundError
    || err instanceof ExportSourceUnavailableError
    || /no footage|no source content/i.test(String((err as Error)?.message ?? ""));
}

async function renderAndStore(clip: ClipRow, brand: DemoBrand, previousAttempts: number): Promise<void> {
  const key = keyOf(clip.id, brand);
  try {
    await whenIdle(`demo-${brand}-${clip.id}`, async () => {
      const file = await renderDemoCopy(clip, brand);
      try {
        const poster = await posterFrom(file);
        await uploadFileToBunnyStoragePath(file, demoBrandedVideoPath(clip.id, brand));
        await uploadBufferToBunnyStorage(poster, demoBrandedPosterPath(clip.id, brand), "image/jpeg");
      } finally {
        cleanupTempFile(file);
      }
    });
    state.set(key, { status: "ready" });
    logger.info({ clipId: clip.id, brand, version: BRAND_VERSIONS[brand] }, "Demo clip copy rendered");
    for (const listener of listeners) {
      try { listener(); } catch { /* a listener never stops the queue */ }
    }
  } catch (err) {
    const permanent = isPermanent(err);
    state.set(key, permanent ? { status: "unrenderable" } : { status: "failed", at: Date.now(), attempts: previousAttempts + 1 });
    logger.error({ err, clipId: clip.id, brand, permanent, attempts: previousAttempts + 1 }, "Could not render a demo clip copy");
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

/**
 * The clip, from its recording, with the preset's overlay and sign-off card:
 * Jordan Galaxy's corner crest, or JUFA's academy frame.
 */
async function renderDemoCopy(clip: ClipRow, brand: DemoBrand): Promise<string> {
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
    const look = await demoBrandLook({ look: brand, name: "", color: "", persona: brand === "academy" ? "academy" : "pitch" });
    const mark = await loadLocalImage(replayMarkPath());
    const dateLabel = await recordingDateLabel(clip.videoId);
    const overlay = path.join(os.tmpdir(), `soccerwatch-demo-overlay-${randomUUID()}.png`);
    await fs.promises.writeFile(overlay, renderOverlayPng({ style: brand === "academy" ? "academyFrame" : "cornerCrest", look, dims: getOutputDims(portrait), dateLabel, mark }));
    temps.push(overlay);

    const endScreen: EndScreenJob = {
      // The QR opens the demo, not the player's share card: the copy belongs to the demo.
      spec: { kind: "signOff", look, dateLabel, link: `${publicBase()}/demo${brand === "academy" ? "?for=academy" : ""}` },
      ...CARD,
    };
    return await renderClip({
      videoUrl: buffer.bufferPath,
      totalDuration: buffer.bufferedDuration,
      startTime: Math.max(0, buffer.adjustedOffsetSec / buffer.bufferedDuration),
      endTime: Math.min(1, (buffer.adjustedOffsetSec + clipDuration) / buffer.bufferedDuration),
      cropPath: (clip.cropPath ?? []) as { t: number; x: number; y: number; w: number; h: number }[],
      aspectRatio: clip.aspectRatio,
      title: `demo-${brand}-${clip.id}`,
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

/**
 * Whether /api/demo/clips may serve this clip's copy: the copy exists and the
 * clip is still one the demo may show (not hidden, reported or deleted).
 *
 * It does not depend on this server's showcase cache: with several instances,
 * or a re-ordered pick, the page can hold a copy's URL another instance has not
 * listed yet.
 */
export async function isServableDemoCopy(clipId: number, brand: DemoBrand = "galaxy"): Promise<boolean> {
  if ((await checkStored(clipId, brand)) !== true) return false;
  const [row] = await db
    .select({ id: userClipsTable.id })
    .from(userClipsTable)
    .where(and(eq(userClipsTable.id, clipId), eq(userClipsTable.isHidden, false), isNull(userClipsTable.hiddenReason)))
    .limit(1);
  return Boolean(row);
}
