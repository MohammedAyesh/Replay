import { execFile } from "node:child_process";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { spanOf, clipSpan } from "./clipSpan";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { venueClip, venueRecording } from "./venueLibrary";
import fs from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { createCanvas, loadImage, type Canvas, type Image } from "@napi-rs/canvas";
import {
  academyAdMediaTable,
  academyMembersTable,
  academyRecordingsTable,
  brandingProfilesTable,
  db,
  recordingsTable,
  userClipsTable,
  type AcademyAdMedia,
} from "@workspace/db";
import {
  parsePlateKey,
  plateAspects,
  plateKey,
  type CreativeBrand,
  type CreativeData,
  type CreativeFormat,
  type MediaSource,
  type PlateAspect,
  type ResolvedTint,
} from "@workspace/api-zod";
import type { AcademyOwnerAccess } from "../academyOwner";
import { displayPhone, instagramHandle } from "../academyOwner";
import { brandingAssetDir } from "../clipBranding/assets";
import { drawCrest } from "../clipBranding/draw";
import type { BrandLook } from "../clipBranding/types";
import { logger } from "../logger";
import { downloadToTemp } from "../meta/media";
import { firstName, namesAllowed, studioLook } from "../../routes/academyStudio";
import { academyPlayerPhoto, playerPictures, readAvatarFile, readPlayerPhotoFile, type PlayerPicture } from "../academyPlayerPhotos";
import { avatarUrlFor } from "../matchRooms";
import type { ConcreteSource, ImageResolver, MediaLayer } from "./render";
import type { VideoResolver, VideoSourceFile } from "./renderVideo";
import { tintKey, tintPicture } from "./renderTint";
import { Camera4kNotReadyError, waitForCamera4kSource } from "../clipExportSource";
import { bufferCameraHlsClip, probeVideoDimensions } from "../ffmpegExport";
import { fetchExportObject, probeExportObject } from "../backupExport";
import { getBunnyPlaybackUrl, getBunnyProxiedPlaybackUrl, getBunnyProxiedThumbnailUrl, isBunnyConfigured } from "../bunny";
import { uhdPlaybackUrl, uhdPlaybackWindowUrl } from "../uhdPlayback";

/**
 * Creative hub engine: where a scene's pictures and footage come from.
 *
 * Every source is checked against the academy before anything is read: a clip
 * must be the academy's and made by one of its members (as Studio's clips), a
 * recording must be linked to the academy (academy_recordings), an upload must
 * be in its academy_ad_media. The browser never names an academy; the route's
 * owner check does.
 */

export class CreativeRenderError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

// ── Brand and data ───────────────────────────────────────────────────────────

export type CreativeContext = { brand: CreativeBrand; look: BrandLook; showNames: boolean };

/** What @primary/@accent/… resolve to, the crest, and the names setting (as GET …/creative/brand). */
export async function loadCreativeContext(access: AcademyOwnerAccess, temps: string[]): Promise<CreativeContext> {
  const [look, showNames] = await Promise.all([studioLook(access, temps), namesAllowed(access.academyId)]);
  return {
    look,
    showNames,
    brand: {
      primary: look.primaryColor,
      accent: look.accentColor ?? "#D4FF4F",
      ink: "#0B0F1A",
      paper: "#FFFFFF",
      muted: "#8A93A6",
      nameEn: look.nameEn,
      nameAr: look.nameAr,
    },
  };
}

/**
 * The data a render uses. The academy's own facts come from the server, never
 * from the browser; a player's name is a first name and only when the academy
 * allows names (most players are children), otherwise it is dropped and the
 * shirt number stands.
 */
export function serverData(access: AcademyOwnerAccess, ctx: CreativeContext, raw: unknown): CreativeData {
  const data = (raw && typeof raw === "object" ? { ...(raw as CreativeData) } : {}) as CreativeData;
  data.academy = {
    name: ctx.look.nameEn,
    nameAr: ctx.look.nameAr,
    phone: ctx.look.bookingPhone ?? displayPhone(access.academy.whatsappPhone) ?? access.academy.contactPhone ?? null,
    instagram: ctx.look.instagram ?? instagramHandle(access.academy.instagramUrl),
  };
  if (data.player && typeof data.player === "object") {
    data.player = { ...data.player, name: ctx.showNames ? firstName(data.player.name ?? null) : null };
  }
  return ctx.showNames ? data : withoutPlayerPictures(data);
}

const isPlayerPicture = (src: unknown): boolean =>
  !!src && typeof src === "object" && ((src as MediaSource).type === "player" || (src as MediaSource).type === "player-photo");

/**
 * The data with every player picture taken out (an academy that does not show
 * players' names shows no player photos either): a line-up then draws its
 * numbers-only rows (its row photos go whatever they are), a player post its
 * number. Other pictures stay.
 */
export function withoutPlayerPictures(data: CreativeData): CreativeData {
  const out: CreativeData = { ...data };
  if (isPlayerPicture(out.media)) delete out.media;
  if (Array.isArray(out.more)) out.more = out.more.map((m) => (isPlayerPicture(m) ? (null as unknown as MediaSource) : m));
  // A line-up stays numbers-only: its photo tiles show only for an academy that shows names.
  delete out.photos;
  if (out.player && isPlayerPicture(out.player.photo)) {
    const { photo: _photo, ...rest } = out.player;
    out.player = rest;
  }
  return out;
}

// ── Bundled assets ───────────────────────────────────────────────────────────

/** assets/creative next to assets/branding (found the same way, so it works from src and dist). */
export function creativeAssetDir(): string {
  return path.join(path.dirname(brandingAssetDir()), "creative");
}

const ASSET_KEY = /^[a-z0-9][a-z0-9/_-]{0,119}$/;

/** assets/creative/artwork (CREATIVE_ARTWORK_DIR overrides it, for tests). */
export function artworkDir(): string {
  return process.env.CREATIVE_ARTWORK_DIR || path.join(creativeAssetDir(), "artwork");
}

/**
 * assets/creative/artwork/<key>.png, or null when the key is odd or the file is
 * not there. A background plate key "bg/<style>/<n>" names two files,
 * <n>-post.png (4:5) and <n>-story.png (9:16): a story takes the story file if
 * there is one, else the post file (drawn with cover); post and square take
 * the post file, else the story file.
 */
export function artworkPath(key: string, format?: CreativeFormat): string | null {
  if (!ASSET_KEY.test(key) || key.includes("..") || key.includes("//")) return null;
  const dir = artworkDir();
  const names = parsePlateKey(key) ? plateAspects(format).map((a) => `${key}-${a}.png`) : [`${key}.png`];
  for (const name of names) {
    const file = path.join(dir, name);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

// ── Background plates (GET …/creative/artwork/backgrounds) ───────────────────

export type PlateEntry = { key: string; n: number; aspects: PlateAspect[] };

const PLATE_FILE = /^(\d{1,3})-(post|story)\.png$/;

/** Every plate under <root>/<style>/<n>-<aspect>.png, by style, in number order. */
export function scanPlates(root = path.join(artworkDir(), "bg")): Map<string, PlateEntry[]> {
  const out = new Map<string, PlateEntry[]>();
  let styles: fs.Dirent[] = [];
  try { styles = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const dir of styles) {
    if (!dir.isDirectory() || !/^[a-z]+$/.test(dir.name)) continue;
    const byN = new Map<number, Set<PlateAspect>>();
    let files: string[] = [];
    try { files = fs.readdirSync(path.join(root, dir.name)); } catch { continue; }
    for (const f of files) {
      const m = PLATE_FILE.exec(f);
      if (!m || Number(m[1]) < 1) continue;
      const n = Number(m[1]);
      if (!byN.has(n)) byN.set(n, new Set());
      byN.get(n)!.add(m[2] as PlateAspect);
    }
    const list = [...byN.entries()].sort((a, b) => a[0] - b[0])
      .map(([n, set]) => ({ key: plateKey(dir.name, n), n, aspects: (["post", "story"] as const).filter((a) => set.has(a)) }));
    if (list.length) out.set(dir.name, list);
  }
  return out;
}

let plateIndex: Map<string, PlateEntry[]> | null = null;

/** Read the plate folder again (at boot; tests). */
export function rescanPlates(root?: string): Map<string, PlateEntry[]> {
  plateIndex = scanPlates(root);
  return plateIndex;
}

/** The plates shipped for a style (scanned once per process; empty when there are none). */
export function backgroundPlates(style: string): PlateEntry[] {
  return (plateIndex ?? rescanPlates()).get(style) ?? [];
}

/** assets/creative/music/<trackKey>.(m4a|mp3|aac), or null. */
export function musicPath(trackKey: string | undefined): string | null {
  if (!trackKey || !ASSET_KEY.test(trackKey) || trackKey.includes("..")) return null;
  for (const ext of ["m4a", "mp3", "aac"]) {
    const file = path.join(creativeAssetDir(), "music", `${trackKey}.${ext}`);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

// ── The academy's own rows ───────────────────────────────────────────────────

export async function academyClip(academyId: number, clipId: number) {
  const [row] = await db.select({ clip: userClipsTable }).from(userClipsTable)
    .innerJoin(academyMembersTable, and(eq(academyMembersTable.academyId, academyId), eq(academyMembersTable.userId, userClipsTable.userId)))
    .where(and(eq(userClipsTable.id, clipId), eq(userClipsTable.academyId, academyId)))
    .limit(1);
  if (row && !row.clip.hiddenReason) return row.clip;
  // A field: any clip cut from its own camera's footage.
  const venue = await venueClip(academyId, clipId);
  return venue && !venue.hiddenReason ? venue : null;
}

export async function academyRecording(academyId: number, recordingId: number) {
  const [row] = await db.select({ id: recordingsTable.id, videoUrl: recordingsTable.videoUrl }).from(academyRecordingsTable)
    .innerJoin(recordingsTable, eq(recordingsTable.id, academyRecordingsTable.recordingId))
    .where(and(eq(academyRecordingsTable.academyId, academyId), eq(academyRecordingsTable.recordingId, recordingId)))
    .limit(1);
  if (row && row.videoUrl) return row;
  // A field: any recording at its fields.
  return venueRecording(academyId, recordingId);
}

export async function academyUpload(academyId: number, mediaId: number): Promise<AcademyAdMedia | null> {
  const [row] = await db.select().from(academyAdMediaTable)
    .where(and(eq(academyAdMediaTable.id, mediaId), eq(academyAdMediaTable.academyId, academyId))).limit(1);
  return row && row.status !== "failed" ? row : null;
}

/** Resolve the camera video GUID from a stored Bunny URL or GUID. */
export function videoIdOf(url: string | null | undefined): string | null {
  if (!url) return null;
  if (!url.includes("/") && !url.includes(":")) return url;
  try {
    const parts = new URL(url).pathname.split("/").filter(Boolean);
    return parts.find((part) => /^(?:[0-9a-f]{32}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i.test(part))
      ?? parts[0]
      ?? null;
  } catch {
    return null;
  }
}

export type BrowserPlaybackSource = { kind: "camera-4k" | "stream"; url: string; fullUrl?: string };

/** Authorized HLS sources for a recording moment; the client can fall back without waiting for a cut. */
export async function browserPlaybackSources(
  access: AcademyOwnerAccess,
  src: ConcreteSource,
): Promise<BrowserPlaybackSource[] | null> {
  if (src.type !== "recording") return null;
  const rec = await academyRecording(access.academyId, src.recordingId);
  const videoId = videoIdOf(rec?.videoUrl);
  if (!rec || !videoId || videoId.startsWith("live:")) return null;
  const camera4kUrl = uhdPlaybackWindowUrl(videoId, src.fromMs, src.toMs);
  if (!camera4kUrl) return null;

  const fullUrl = uhdPlaybackUrl(videoId);
  const sources: BrowserPlaybackSource[] = [{
    kind: "camera-4k",
    url: camera4kUrl,
    ...(fullUrl ? { fullUrl } : {}),
  }];
  if (isBunnyConfigured()) {
    sources.push({ kind: "stream", url: getBunnyProxiedPlaybackUrl(videoId) });
  }
  return sources;
}

const CAMERA_4K_NOT_READY = "The 4K for this match isn't ready yet. Please try again later.";
const CAMERA_4K_WAIT_MS = 3_000;
export const CAMERA_4K_AUTOPILOT_PROBE_MS = 3_000;

type Camera4kSource = Awaited<ReturnType<typeof waitForCamera4kSource>>;

async function resolveCamera4kSource(videoId: string, waitMs = CAMERA_4K_WAIT_MS): Promise<Camera4kSource> {
  try {
    return await waitForCamera4kSource(videoId, { timeoutMs: waitMs });
  } catch (error) {
    if (error instanceof Camera4kNotReadyError) {
      logger.warn({ videoId, waitedMs: error.waitedMs }, "Creative render deferred: camera 4K is not ready");
      throw new CreativeRenderError(CAMERA_4K_NOT_READY, 409);
    }
    throw error;
  }
}

type ClipVideoSource =
  | { kind: "camera-4k"; source: Camera4kSource; span: NonNullable<ReturnType<typeof spanOf>> }
  | { kind: "saved-file"; path: string; durationMs: number; hasAudio: boolean }
  | { kind: "stream"; url: string; referer: string; span: NonNullable<Awaited<ReturnType<typeof clipSpan>>> };

export type CreativeResolvedVideoSource = {
  layerId: string;
  sceneSource: ConcreteSource;
  selectedKind: "camera-4k" | "saved-file" | "stream" | "academy-upload";
  videoId: string | null;
  locator: string | null;
  width: number;
  height: number;
  durationMs: number | null;
  fromMs: number;
  toMs: number;
};

const STREAM_PROBE_TIMEOUT_MS = 8_000;
const STREAM_BUFFER_TIMEOUT_MS = 20 * 60_000;
const CREATIVE_EXPORT_DOWNLOAD_TIMEOUT_MS = 20 * 60_000;

/**
 * Confirm Stream has a real media playlist and at least one retrievable
 * segment. A GUID or a master playlist alone is not proof that it can play.
 */
export async function playableStream(videoId: string): Promise<{ url: string; referer: string } | null> {
  if (!isBunnyConfigured() || videoId.startsWith("live:")) return null;
  let masterUrl: string;
  try {
    masterUrl = getBunnyPlaybackUrl(videoId);
  } catch {
    return null;
  }
  const referer = `${new URL(masterUrl).origin}/`;
  try {
    const master = await fetch(masterUrl, { headers: { Referer: referer }, signal: AbortSignal.timeout(STREAM_PROBE_TIMEOUT_MS) });
    if (!master.ok) { await master.body?.cancel().catch(() => {}); return null; }
    const body = await master.text();
    if (!body.trimStart().startsWith("#EXTM3U")) return null;
    let mediaUrl = masterUrl;
    let mediaBody = body;
    if (!mediaBody.includes("#EXTINF:")) {
      const entry = body.split(/\r?\n/).map((line) => line.trim()).find((line) => line && !line.startsWith("#"));
      if (!entry) return null;
      mediaUrl = new URL(entry, masterUrl).href;
      const media = await fetch(mediaUrl, { headers: { Referer: referer }, signal: AbortSignal.timeout(STREAM_PROBE_TIMEOUT_MS) });
      if (!media.ok) { await media.body?.cancel().catch(() => {}); return null; }
      mediaBody = await media.text();
    }
    if (!mediaBody.trimStart().startsWith("#EXTM3U") || !mediaBody.includes("#EXTINF:")) return null;
    const segment = mediaBody.split(/\r?\n/).map((line) => line.trim()).find((line) => line && !line.startsWith("#"));
    if (!segment) return null;
    const probe = await fetch(new URL(segment, mediaUrl), {
      headers: { Referer: referer, Range: "bytes=0-0" },
      signal: AbortSignal.timeout(STREAM_PROBE_TIMEOUT_MS),
    });
    await probe.body?.cancel().catch(() => {});
    if (probe.status !== 200 && probe.status !== 206) return null;
    return { url: masterUrl, referer };
  } catch (err) {
    logger.debug({ err, videoId }, "Creative Stream source did not pass playback probe");
    return null;
  }
}

export async function downloadSavedClip(
  clip: { id: number; exportedUrl?: string | null },
  temps: string[],
): Promise<{ path: string; durationMs: number; hasAudio: boolean } | null> {
  if (!clip?.exportedUrl) return null;
  const probe = await probeExportObject(clip.exportedUrl);
  if (probe.state !== "exists") return null;
  const file = path.join(os.tmpdir(), `creative-saved-clip-${randomUUID()}.mp4`);
  temps.push(file);
  try {
    const response = await fetchExportObject(probe.url, { signal: AbortSignal.timeout(CREATIVE_EXPORT_DOWNLOAD_TIMEOUT_MS) });
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => {});
      return null;
    }
    await pipeline(Readable.fromWeb(response.body as never), fs.createWriteStream(file));
    const durationMs = await probeDurationMs(file);
    if (!durationMs) return null;
    return { path: file, durationMs, hasAudio: await hasAudioStream(file) };
  } catch (err) {
    await fs.promises.rm(file, { force: true }).catch(() => {});
    logger.debug({ err, clipId: clip.id }, "Creative saved clip file could not be loaded");
    return null;
  }
}

async function resolveClipVideo(
  clip: NonNullable<Awaited<ReturnType<typeof academyClip>>>,
  temps: string[],
  sourceWaitMs = CAMERA_4K_WAIT_MS,
): Promise<ClipVideoSource> {
  try {
    const source = await resolveCamera4kSource(clip.videoId, sourceWaitMs);
    const span = spanOf(Number(clip.startTime), Number(clip.endTime), clip.thumbnailTime == null ? null : Number(clip.thumbnailTime), source.duration);
    if (span) return { kind: "camera-4k", source, span };
  } catch (err) {
    logger.debug({ err, clipId: clip.id }, "Creative 4K unavailable; checking saved clip and Stream");
  }

  const saved = await downloadSavedClip(clip, temps);
  if (saved) return { kind: "saved-file", ...saved };

  const [span, stream] = await Promise.all([
    clipSpan(clip),
    playableStream(clip.videoId),
  ]);
  if (span && stream) return { kind: "stream", ...stream, span };
  throw new CreativeRenderError(
    "This clip is unavailable right now. Its 4K, saved file, and playable Stream source could not be loaded.",
    409,
  );
}

async function frameFromFile(file: string, atSec: number, temps: string[]): Promise<Buffer> {
  const framePath = path.join(os.tmpdir(), `creative-saved-frame-${randomUUID()}.png`);
  temps.push(framePath);
  await new Promise<void>((resolve, reject) => {
    execFile("ffmpeg", [
      "-nostdin", "-hide_banner", "-loglevel", "error", "-threads", "1",
      "-ss", Math.max(0, atSec).toFixed(3), "-i", file,
      "-frames:v", "1", "-vf", "scale=w='min(1920,iw)':h=-2:flags=fast_bilinear", "-y", framePath,
    ], { timeout: 30_000 }, (error) => error ? reject(error) : resolve());
  });
  return fs.promises.readFile(framePath);
}

async function frameFromStream(url: string, referer: string, atSec: number, temps: string[]): Promise<Buffer> {
  const framePath = path.join(os.tmpdir(), `creative-stream-frame-${randomUUID()}.png`);
  temps.push(framePath);
  const headers = `Referer: ${referer}\r\n`;
  await new Promise<void>((resolve, reject) => {
    execFile("ffmpeg", [
      "-nostdin", "-hide_banner", "-loglevel", "error", "-threads", "1", "-headers", headers,
      "-ss", Math.max(0, atSec).toFixed(3), "-i", url, "-frames:v", "1",
      "-vf", "scale=w='min(1920,iw)':h=-2:flags=fast_bilinear", "-threads", "1", "-y", framePath,
    ], { timeout: STREAM_BUFFER_TIMEOUT_MS }, (error) => error ? reject(error) : resolve());
  });
  return fs.promises.readFile(framePath);
}

export async function bufferStreamClip(
  url: string,
  referer: string,
  startSec: number,
  durationSec: number,
  temps: string[],
): Promise<{ bufferPath: string; bufferedDuration: number; bufferDimensions: { width: number; height: number } }> {
  if (!Number.isFinite(startSec) || !Number.isFinite(durationSec) || durationSec <= 0) {
    throw new CreativeRenderError("There is no playable footage in this clip.", 404);
  }
  const bufferPath = path.join(os.tmpdir(), `creative-stream-clip-${randomUUID()}.mp4`);
  temps.push(bufferPath);
  await new Promise<void>((resolve, reject) => {
    execFile("ffmpeg", [
      "-nostdin", "-hide_banner", "-loglevel", "error", "-filter_threads", "1", "-threads", "1",
      "-headers", `Referer: ${referer}\r\n`,
      "-ss", Math.max(0, startSec).toFixed(3), "-i", url, "-t", durationSec.toFixed(3),
      "-map", "0:v:0", "-map", "0:a?",
      "-vf", "scale=3840:1080:flags=fast_bilinear",
      "-threads:v", "1", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "18",
      "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", "-y", bufferPath,
    ], { timeout: STREAM_BUFFER_TIMEOUT_MS }, (error) => error ? reject(error) : resolve());
  });
  const bufferedDuration = await probeDurationMs(bufferPath);
  if (!bufferedDuration || bufferedDuration < durationSec * 1000 - 1_500) {
    throw new CreativeRenderError("The playable Stream clip ended before its selected window.", 409);
  }
  const bufferDimensions = await probeVideoDimensions(bufferPath);
  if (bufferDimensions.width !== 3840 || bufferDimensions.height !== 1080) {
    throw new CreativeRenderError(
      `The playable Stream buffer is ${bufferDimensions.width}x${bufferDimensions.height}; expected 3840x1080.`,
      409,
    );
  }
  return { bufferPath, bufferedDuration: bufferedDuration / 1000, bufferDimensions };
}

async function bufferCamera4kWindow(
  source: Camera4kSource,
  startSec: number,
  endSec: number,
  temps: string[],
): Promise<Awaited<ReturnType<typeof bufferCameraHlsClip>>> {
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec <= startSec) {
    throw new CreativeRenderError("There is no footage in the selected 4K window.");
  }
  const buffered = await bufferCameraHlsClip({
    remoteUrl: source.url,
    playlist: source.playlist,
    referer: `${new URL(source.url).origin}/`,
    startSec,
    clipDuration: endSec - startSec,
    totalDuration: source.duration,
  });
  temps.push(buffered.bufferPath);
  logger.info({
    source: "camera-original-4k",
    videoId: source.url.split("/").at(-2),
    sourceWidth: buffered.sourceDimensions.width,
    sourceHeight: buffered.sourceDimensions.height,
    startSec,
    endSec,
    downloadedBytes: buffered.downloadedBytes,
  }, "Creative render buffered camera 4K byte ranges");
  return buffered;
}

// ── Stills (server) ──────────────────────────────────────────────────────────

async function dataUrlImage(dataUrl: string | null | undefined): Promise<Image | null> {
  const m = /^data:image\/[a-z+.-]+;base64,/i.exec(dataUrl ?? "");
  if (!m) return null;
  return loadImage(Buffer.from(dataUrl!.slice(m[0].length), "base64")).catch(() => null);
}

/**
 * Pictures for the still renderer. A video layer draws the frame at its trim
 * point; an image layer of a clip draws the clip's own thumbnail.
 */
export function creativeImageResolver(
  academyId: number,
  look: Pick<BrandLook, "crest">,
  sourceWaitMs = CAMERA_4K_WAIT_MS,
  temps: string[] = [],
): ImageResolver {
  let names: Promise<boolean> | null = null;
  const allowed = () => (names ??= namesAllowed(academyId).catch(() => false));
  return async (layer: MediaLayer, src: ConcreteSource, scene?: { format: CreativeFormat }): Promise<Image | Canvas | null> => {
    const trimSec = layer.kind === "video" ? (layer.trimInMs ?? 0) / 1000 : 0;
    switch (src.type) {
      case "player":
      case "player-photo": {
        const bytes = await playerPictureBytes(academyId, src, await allowed());
        return bytes ? loadImage(bytes).catch(() => null) : null;
      }
      case "crest":
        return (look.crest as Image | null) ?? null;
      case "artwork": {
        const file = artworkPath(src.key, scene?.format);
        return file ? loadImage(file).catch(() => null) : null;
      }
      case "upload": {
        const row = await academyUpload(academyId, src.mediaId);
        return row ? dataUrlImage(row.imageData) : null;
      }
      case "clip": {
        const clip = await academyClip(academyId, src.clipId);
        if (!clip || clip.videoId.startsWith("live:")) return null;
        // Thumbnails and editor previews must not wait for camera-original 4K.
        const saved = await downloadSavedClip(clip, temps);
        if (saved) {
          const span = await clipSpan(clip);
          const at = layer.kind === "video" ? trimSec : span ? Math.max(0, (span.thumbSec ?? span.startSec) - span.startSec) : saved.durationMs / 2000;
          return loadImage(await frameFromFile(saved.path, at, temps));
        }
        const [span, stream] = await Promise.all([clipSpan(clip), playableStream(clip.videoId)]);
        if (!span || !stream) return null;
        const at = layer.kind === "video" ? span.startSec + trimSec : span.thumbSec ?? span.startSec;
        return loadImage(await frameFromStream(stream.url, stream.referer, at, temps));
      }
      case "recording":
      case "frame": {
        const rec = await academyRecording(academyId, src.recordingId);
        const id = videoIdOf(rec?.videoUrl);
        if (!id) return null;
        const at = src.type === "frame" ? src.atMs / 1000 : src.fromMs / 1000 + trimSec;
        const stream = await playableStream(id);
        return stream ? loadImage(await frameFromStream(stream.url, stream.referer, at, temps)) : null;
      }
    }
  };
}

/**
 * A player's picture, scoped to the academy: a gallery photo of one of its
 * players, a player's primary photo, else his linked account's avatar. Null
 * for an academy that does not show players' names, and for anything of
 * another academy.
 */
export async function playerPictureFor(
  academyId: number, src: Extract<MediaSource, { type: "player" | "player-photo" }>, showNames: boolean,
): Promise<NonNullable<PlayerPicture> | null> {
  if (!showNames) return null;
  if (src.type === "player-photo") {
    const photo = await academyPlayerPhoto(academyId, src.photoId);
    return photo ? { kind: "photo", photo } : null;
  }
  return (await playerPictures(academyId, [src.playerId])).get(src.playerId) ?? null;
}

async function playerPictureBytes(academyId: number, src: Extract<MediaSource, { type: "player" | "player-photo" }>, showNames: boolean): Promise<Buffer | null> {
  const pic = await playerPictureFor(academyId, src, showNames);
  if (!pic) return null;
  return pic.kind === "photo" ? readPlayerPhotoFile(pic.photo) : readAvatarFile(pic.avatarPath);
}

// ── Footage (server) ─────────────────────────────────────────────────────────

function hasAudioStream(file: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("ffprobe", ["-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", file],
      { timeout: 15_000 }, (err, stdout) => resolve(!err && stdout.trim().length > 0));
  });
}

function probeDurationMs(file: string): Promise<number | null> {
  return new Promise((resolve) => {
    execFile("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file],
      { timeout: 15_000 }, (err, stdout) => {
        const s = Number(stdout.trim());
        resolve(!err && Number.isFinite(s) && s > 0 ? Math.round(s * 1000) : null);
      });
  });
}

/** Longest stretch of source one layer may pull (a 3-minute scene at 4× speed). */
const MAX_SOURCE_MS = 12 * 60_000;

/** Footage for the MP4 renderer, as local files in `workDir` (the caller deletes it). */
export function creativeVideoResolver(
  academyId: number,
  _workDir: string,
  temps: string[],
  sourceWaitMs = CAMERA_4K_WAIT_MS,
  onResolved?: (source: CreativeResolvedVideoSource) => void | Promise<void>,
): VideoResolver {
  return async (layer, src, need): Promise<VideoSourceFile | null> => {
    const span = Math.min(MAX_SOURCE_MS, Math.max(500, need.toMs - need.fromMs));
    const fail = (err: unknown): never => {
      if (err instanceof CreativeRenderError) throw err;
      logger.warn({ err, academyId, src }, "Creative render: footage unavailable");
      throw new CreativeRenderError("Couldn't load the footage for one of the videos. Please try again.", 409);
    };
    try {
      switch (src.type) {
        case "clip": {
          const clip = await academyClip(academyId, src.clipId);
          if (!clip) throw new CreativeRenderError("A clip in this design is no longer available. Pick another one.");
          if (clip.videoId.startsWith("live:")) {
            throw new CreativeRenderError("Live footage isn't available in the Creative Hub renderer.", 409);
          }
          const resolved = await resolveClipVideo(clip, temps, sourceWaitMs);
          if (resolved.kind === "saved-file") {
            const dimensions = await probeVideoDimensions(resolved.path);
            await onResolved?.({
              layerId: layer.id,
              sceneSource: src,
              selectedKind: "saved-file",
              videoId: clip.videoId,
              locator: clip.exportedUrl,
              width: dimensions.width,
              height: dimensions.height,
              durationMs: resolved.durationMs,
              fromMs: need.fromMs,
              toMs: need.toMs,
            });
            return { path: resolved.path, zeroAtSec: 0, durationMs: resolved.durationMs, hasAudio: resolved.hasAudio };
          }
          if (resolved.kind === "stream") {
            const from = resolved.span.startSec + need.fromMs / 1000;
            const to = Math.min(resolved.span.endSec, resolved.span.startSec + (need.fromMs + span) / 1000);
            const buffered = await bufferStreamClip(resolved.url, resolved.referer, from, to - from, temps);
            const dimensions = buffered.bufferDimensions;
            await onResolved?.({
              layerId: layer.id,
              sceneSource: src,
              selectedKind: "stream",
              videoId: clip.videoId,
              locator: resolved.url,
              width: dimensions.width,
              height: dimensions.height,
              durationMs: buffered.bufferedDuration * 1000,
              fromMs: Math.round(from * 1000),
              toMs: Math.round(to * 1000),
            });
            return {
              path: buffered.bufferPath,
              zeroAtSec: -need.fromMs / 1000,
              durationMs: Math.round((resolved.span.endSec - resolved.span.startSec) * 1000),
              hasAudio: await hasAudioStream(buffered.bufferPath),
              sourceDimensions: buffered.bufferDimensions,
              trailSource: { videoId: clip.videoId, fromSec: from },
            };
          }
          const from = resolved.span.startSec + need.fromMs / 1000;
          const to = Math.min(resolved.span.endSec, resolved.span.startSec + (need.fromMs + span) / 1000);
          const buffered = await bufferCamera4kWindow(resolved.source, from, to, temps);
          await onResolved?.({
            layerId: layer.id,
            sceneSource: src,
            selectedKind: "camera-4k",
            videoId: clip.videoId,
            locator: `camera-original-4k:${clip.videoId}`,
            width: buffered.sourceDimensions.width,
            height: buffered.sourceDimensions.height,
            durationMs: Math.round((resolved.span.endSec - resolved.span.startSec) * 1000),
            fromMs: Math.round(from * 1000),
            toMs: Math.round(to * 1000),
          });
          return {
            path: buffered.bufferPath,
            zeroAtSec: -need.fromMs / 1000,
            durationMs: Math.round((resolved.span.endSec - resolved.span.startSec) * 1000),
            hasAudio: await hasAudioStream(buffered.bufferPath),
            sourceDimensions: buffered.bufferDimensions,
            trailSource: { videoId: clip.videoId, fromSec: from },
          };
        }
        case "recording": {
          const rec = await academyRecording(academyId, src.recordingId);
          if (!rec) throw new CreativeRenderError("A recording in this design is no longer available.");
          const videoId = videoIdOf(rec.videoUrl);
          if (!videoId) throw new CreativeRenderError("This recording has no camera video ID.");
          const length = Math.max(0, src.toMs - src.fromMs);
          const from = (src.fromMs + need.fromMs) / 1000;
          const to = (src.fromMs + Math.min(length || need.toMs, need.fromMs + span)) / 1000;
          try {
            const source = await resolveCamera4kSource(videoId, sourceWaitMs);
            const buffered = await bufferCamera4kWindow(source, from, to, temps);
            await onResolved?.({
              layerId: layer.id,
              sceneSource: src,
              selectedKind: "camera-4k",
              videoId,
              locator: `camera-original-4k:${videoId}`,
              width: buffered.sourceDimensions.width,
              height: buffered.sourceDimensions.height,
              durationMs: length || null,
              fromMs: Math.round(from * 1000),
              toMs: Math.round(to * 1000),
            });
            return {
              path: buffered.bufferPath,
              zeroAtSec: -need.fromMs / 1000,
              durationMs: length || null,
              hasAudio: await hasAudioStream(buffered.bufferPath),
              sourceDimensions: buffered.bufferDimensions,
              trailSource: { videoId, fromSec: from },
            };
          } catch (err) {
            logger.debug({ err, videoId, recordingId: src.recordingId }, "Creative recording 4K unavailable; checking Stream");
            const stream = await playableStream(videoId);
            if (!stream) throw new CreativeRenderError("This recording is unavailable: neither 4K nor a playable Stream source could be loaded.", 409);
            const buffered = await bufferStreamClip(stream.url, stream.referer, from, to - from, temps);
            const dimensions = buffered.bufferDimensions;
            await onResolved?.({
              layerId: layer.id,
              sceneSource: src,
              selectedKind: "stream",
              videoId,
              locator: stream.url,
              width: dimensions.width,
              height: dimensions.height,
              durationMs: buffered.bufferedDuration * 1000,
              fromMs: Math.round(from * 1000),
              toMs: Math.round(to * 1000),
            });
            return {
              path: buffered.bufferPath,
              zeroAtSec: -need.fromMs / 1000,
              durationMs: length || null,
              hasAudio: await hasAudioStream(buffered.bufferPath),
              sourceDimensions: dimensions,
              trailSource: { videoId, fromSec: from },
            };
          }
        }
        case "upload": {
          const row = await academyUpload(academyId, src.mediaId);
          if (!row) throw new CreativeRenderError("An upload in this design is no longer available.");
          if (row.kind !== "video" || !row.storageUrl) return null;
          const file = await downloadToTemp(row.storageUrl);
          temps.push(file);
          const dimensions = await probeVideoDimensions(file);
          await onResolved?.({
            layerId: layer.id,
            sceneSource: src,
            selectedKind: "academy-upload",
            videoId: null,
            locator: row.storageUrl,
            width: dimensions.width,
            height: dimensions.height,
            durationMs: row.durationSec ? Math.round(row.durationSec * 1000) : await probeDurationMs(file),
            fromMs: need.fromMs,
            toMs: need.toMs,
          });
          return { path: file, zeroAtSec: 0, durationMs: row.durationSec ? Math.round(row.durationSec * 1000) : await probeDurationMs(file), hasAudio: await hasAudioStream(file) };
        }
        default:
          // crest, artwork, frame: a picture, drawn as a still.
          return null;
      }
    } catch (err) {
      return fail(err);
    }
  };
}

// ── For the browser (GET …/creative/media) ───────────────────────────────────

export type BrowserMedia =
  | { redirect: string }
  | { file: string; type: string }
  | { buffer: Buffer; type: string }
  | null;

/** The crest as a PNG: the uploaded crest contained in a square, or the initials shield. */
async function crestPng(look: BrandLook): Promise<Buffer> {
  const size = 512;
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext("2d");
  if (look.crest) {
    const img = look.crest as Image;
    const k = Math.min(size / img.width, size / img.height);
    ctx.drawImage(img, (size - img.width * k) / 2, (size - img.height * k) / 2, img.width * k, img.height * k);
  } else {
    drawCrest(ctx, { ...look, isAcademy: true }, size / 2, size / 2, size);
  }
  return canvas.toBuffer("image/png");
}

const MAX_BROWSER_WINDOW_MS = 10 * 60_000;

/**
 * A URL (or bytes) the browser can load for a scene source: an image for
 * want=still, a playable MP4 for want=video. Null is a 404.
 */
export async function browserMedia(
  access: AcademyOwnerAccess, src: ConcreteSource, want: "still" | "video", temps: string[], format?: CreativeFormat,
): Promise<BrowserMedia> {
  const academyId = access.academyId;
  const base = `/api/academy/console/academies/${academyId}`;
  switch (src.type) {
    case "player":
    case "player-photo": {
      const pic = await playerPictureFor(academyId, src, await namesAllowed(academyId));
      if (!pic) return null;
      if (pic.kind === "avatar") {
        const url = avatarUrlFor(pic.userId, pic.avatarPath);
        return url ? { redirect: url } : null;
      }
      const bytes = await readPlayerPhotoFile(pic.photo);
      return bytes ? { buffer: bytes, type: pic.photo.mime } : null;
    }
    case "crest": {
      const [profile] = await db.select({ crestUrl: brandingProfilesTable.crestUrl, updatedAt: brandingProfilesTable.updatedAt }).from(brandingProfilesTable)
        .where(and(eq(brandingProfilesTable.scopeType, "academy"), eq(brandingProfilesTable.scopeId, academyId)));
      if (profile?.crestUrl) return { redirect: `${base}/branding/crest?v=${encodeURIComponent(profile.updatedAt.toISOString())}` };
      return { buffer: await crestPng(await studioLook(access, temps)), type: "image/png" };
    }
    case "artwork": {
      const file = artworkPath(src.key, format);
      return file ? { file, type: "image/png" } : null;
    }
    case "upload": {
      const row = await academyUpload(academyId, src.mediaId);
      if (!row) return null;
      if (want === "video" && row.kind === "video" && row.storageUrl) return { redirect: `${base}/ads/media/${row.id}/file` };
      return row.imageData ? { redirect: `${base}/ads/media/${row.id}/thumb` } : null;
    }
    case "clip": {
      const clip = await academyClip(academyId, src.clipId);
      if (!clip || clip.videoId.startsWith("live:")) return null;
      if (want === "still") {
        // The editor/library thumbnail is deliberately independent of 4K.
        const saved = await downloadSavedClip(clip, temps);
        if (saved) {
          const span = await clipSpan(clip);
          const at = span ? Math.max(0, (span.thumbSec ?? span.startSec) - span.startSec) : saved.durationMs / 2000;
          return { buffer: await frameFromFile(saved.path, at, temps), type: "image/png" };
        }
        const [span, stream] = await Promise.all([clipSpan(clip), playableStream(clip.videoId)]);
        if (!span || !stream) return null;
        return { redirect: getBunnyProxiedThumbnailUrl(clip.videoId, span.thumbSec ?? span.startSec) };
      }
      const resolved = await resolveClipVideo(clip, temps, CAMERA_4K_WAIT_MS);
      if (resolved.kind === "saved-file") return { file: resolved.path, type: "video/mp4" };
      const start = resolved.span.startSec;
      const end = resolved.span.endSec;
      const to = Math.min(end, start + MAX_BROWSER_WINDOW_MS / 1000);
      if (to <= start) return null;
      if (resolved.kind === "camera-4k") {
        const buffered = await bufferCamera4kWindow(resolved.source, start, to, temps);
        return { file: buffered.bufferPath, type: "video/mp4" };
      }
      if (resolved.kind === "stream") {
        const buffered = await bufferStreamClip(resolved.url, resolved.referer, start, to - start, temps);
        return { file: buffered.bufferPath, type: "video/mp4" };
      }
      return null;
    }
    case "recording":
    case "frame": {
      const rec = await academyRecording(academyId, src.recordingId);
      const id = videoIdOf(rec?.videoUrl);
      if (!rec || !id) return null;
      if (src.type === "frame" || want === "still") {
        const atSec = (src.type === "frame" ? src.atMs : src.fromMs) / 1000;
        const stream = await playableStream(id);
        return stream ? { redirect: getBunnyProxiedThumbnailUrl(id, atSec) } : null;
      }
      const to = Math.min(src.toMs, src.fromMs + MAX_BROWSER_WINDOW_MS);
      if (to <= src.fromMs) return null;
      const stream = await playableStream(id);
      if (!stream) return null;
      const buffered = await bufferStreamClip(stream.url, stream.referer, src.fromMs / 1000, (to - src.fromMs) / 1000, temps);
      return { file: buffered.bufferPath, type: "video/mp4" };
    }
  }
}

/** Longest side of a tinted preview picture (the export tints at the size it draws). */
export const TINTED_PREVIEW_MAX_SIDE = 1920;
const TINT_CACHE_ENTRIES = 32;
const TINT_CACHE_BYTES = 128 * 1024 * 1024;
const tinted = new Map<string, Buffer>();
const tinting = new Map<string, Promise<Buffer | null>>();
let tintedBytes = 0;

function rememberTinted(key: string, png: Buffer): void {
  const old = tinted.get(key);
  if (old) { tinted.delete(key); tintedBytes -= old.length; }
  tinted.set(key, png);
  tintedBytes += png.length;
  while (tinted.size > TINT_CACHE_ENTRIES || (tintedBytes > TINT_CACHE_BYTES && tinted.size > 1)) {
    const [k, v] = tinted.entries().next().value!;
    tinted.delete(k);
    tintedBytes -= v.length;
  }
}

/** For tests. */
export function clearTintedCache(): void {
  tinted.clear();
  tinting.clear();
  tintedBytes = 0;
}

/**
 * A still recoloured exactly as the renderer recolours it (renderTint.ts), as
 * a PNG, for SceneCanvas, at most `maxSide` (≤ 1920) on its longest side.
 * Kept in a small in-memory LRU by academy, source, format, tint and size. Null when the picture can't be loaded here (the caller then
 * serves it untinted, or 404s).
 */
export async function tintedStill(
  access: AcademyOwnerAccess, src: ConcreteSource, format: CreativeFormat | undefined, tint: ResolvedTint, temps: string[], maxSide?: number,
): Promise<Buffer | null> {
  const side = Math.round(Math.min(TINTED_PREVIEW_MAX_SIDE, maxSide ?? TINTED_PREVIEW_MAX_SIDE));
  const key = `${access.academyId}|${JSON.stringify(src)}|${format ?? ""}|${tintKey(tint)}|${side}`;
  const hit = tinted.get(key);
  if (hit) {
    tinted.delete(key);
    tinted.set(key, hit);
    return hit;
  }
  let job = tinting.get(key);
  if (!job) {
    job = (async () => {
      const look = src.type === "crest" ? await studioLook(access, temps) : { crest: null };
      const layer = { id: "tint", kind: "image", src, fit: "cover", x: 0, y: 0, w: 1, h: 1 } as MediaLayer;
      const img = await creativeImageResolver(access.academyId, look, 1_000, temps)(layer, src, { format: format ?? "post" });
      if (!img || img.width <= 0 || img.height <= 0) return null;
      const png = tintPicture(img, tint, side).toBuffer("image/png");
      rememberTinted(key, png);
      return png;
    })().finally(() => tinting.delete(key));
    tinting.set(key, job);
  }
  return job;
}

export type { MediaSource };
