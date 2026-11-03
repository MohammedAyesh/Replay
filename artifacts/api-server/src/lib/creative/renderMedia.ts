import { execFile } from "node:child_process";
import { clipSpan } from "./clipSpan";
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
import { BUNNY_CDN_HOSTNAME, getBunnyPlaybackUrl, getBunnyProxiedThumbnailUrl, getBunnyThumbnailUrl, isBunnyConfigured, isBunnyStorageConfigured } from "../bunny";
import { brandingAssetDir } from "../clipBranding/assets";
import { drawCrest } from "../clipBranding/draw";
import type { BrandLook } from "../clipBranding/types";
import { mediaPlaylistFor, reelClip, reelClipOnBunny, segmentsFor } from "../goalReelClip";
import { logger } from "../logger";
import { downloadToTemp } from "../meta/media";
import { firstName, namesAllowed, studioLook } from "../../routes/academyStudio";
import { academyPlayerPhoto, playerPictures, readAvatarFile, readPlayerPhotoFile, type PlayerPicture } from "../academyPlayerPhotos";
import { avatarUrlFor } from "../matchRooms";
import type { ConcreteSource, ImageResolver, MediaLayer } from "./render";
import type { VideoResolver, VideoSourceFile } from "./renderVideo";
import { tintKey, tintPicture } from "./renderTint";

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

/** "https://cdn/<guid>/playlist.m3u8" → "<guid>". */
export function videoIdOf(url: string | null | undefined): string | null {
  if (!url) return null;
  if (!url.includes("/") && !url.includes(":")) return url;
  try {
    return new URL(url).pathname.split("/").filter(Boolean)[0] ?? null;
  } catch {
    return null;
  }
}

/** A recording's master playlist for ffmpeg: its stored URL, or the Stream URL of its video. */
function recordingPlaylist(videoUrl: string): string {
  if (/\.m3u8(\?|$)/i.test(videoUrl)) return videoUrl;
  const id = videoIdOf(videoUrl);
  return id ? getBunnyPlaybackUrl(id) : videoUrl;
}

// ── Stills (server) ──────────────────────────────────────────────────────────

const stills = new Map<string, Promise<Image | null>>();

/** A Bunny Stream thumbnail at a time (seconds), loaded once; null when Bunny is not set up or it fails. */
function bunnyThumb(videoId: string, atSec: number): Promise<Image | null> {
  if (!isBunnyConfigured()) return Promise.resolve(null);
  const url = getBunnyThumbnailUrl(videoId, Math.max(0, atSec));
  let hit = stills.get(url);
  if (!hit) {
    hit = (async () => {
      const response = await fetch(url, { headers: { Referer: `https://${BUNNY_CDN_HOSTNAME}/` }, signal: AbortSignal.timeout(12_000) });
      if (!response.ok) throw new Error(`thumbnail ${response.status}`);
      return loadImage(Buffer.from(await response.arrayBuffer()));
    })().catch((err: unknown) => {
      logger.warn({ err, videoId }, "Creative render: thumbnail unavailable");
      stills.delete(url);
      return null;
    });
    stills.set(url, hit);
    if (stills.size > 80) stills.delete(stills.keys().next().value!);
  }
  return hit;
}

async function dataUrlImage(dataUrl: string | null | undefined): Promise<Image | null> {
  const m = /^data:image\/[a-z+.-]+;base64,/i.exec(dataUrl ?? "");
  if (!m) return null;
  return loadImage(Buffer.from(dataUrl!.slice(m[0].length), "base64")).catch(() => null);
}

/**
 * Pictures for the still renderer. A video layer draws the frame at its trim
 * point; an image layer of a clip draws the clip's own thumbnail.
 */
export function creativeImageResolver(academyId: number, look: Pick<BrandLook, "crest">): ImageResolver {
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
        const span = await clipSpan(clip);
        if (!span) return null;
        const at = layer.kind === "video" ? span.startSec + trimSec : span.thumbSec ?? span.startSec;
        return bunnyThumb(clip.videoId, at);
      }
      case "recording":
      case "frame": {
        const rec = await academyRecording(academyId, src.recordingId);
        const id = videoIdOf(rec?.videoUrl);
        if (!id) return null;
        const at = src.type === "frame" ? src.atMs / 1000 : src.fromMs / 1000 + trimSec;
        return bunnyThumb(id, at);
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

/**
 * The HLS segments covering [fromSec, toSec] of a Bunny video, joined into one
 * local file (no re-encode: the final ffmpeg pass trims exactly). Returns the
 * file and the video time its first segment starts at.
 */
async function fetchWindow(videoUrl: string, fromSec: number, toSec: number, workDir: string): Promise<{ path: string; segStart: number }> {
  const playlist = await mediaPlaylistFor(videoUrl);
  const { segments, offset } = segmentsFor(playlist, Math.max(0, fromSec), toSec);
  if (!segments.length) throw new CreativeRenderError("There's no footage at that time in the recording.");
  const file = path.join(workDir, `window-${Math.random().toString(36).slice(2)}.${playlist.init ? "mp4" : "ts"}`);
  const out = fs.createWriteStream(file);
  try {
    for (const url of [...(playlist.init ? [playlist.init] : []), ...segments.map((s) => s.url)]) {
      const referer = (() => { try { return `https://${new URL(url).hostname}/`; } catch { return "https://iframe.mediadelivery.net/"; } })();
      const response = await fetch(url, { headers: { Referer: referer }, signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`segment ${response.status}`);
      const buf = Buffer.from(await response.arrayBuffer());
      if (!out.write(buf)) await new Promise<void>((r) => out.once("drain", () => r()));
    }
  } finally {
    await new Promise<void>((r) => out.end(() => r()));
  }
  return { path: file, segStart: offset };
}

/** Longest stretch of source one layer may pull (a 3-minute scene at 4× speed). */
const MAX_SOURCE_MS = 12 * 60_000;

/** Footage for the MP4 renderer, as local files in `workDir` (the caller deletes it). */
export function creativeVideoResolver(academyId: number, workDir: string, temps: string[]): VideoResolver {
  return async (_layer, src, need): Promise<VideoSourceFile | null> => {
    const span = Math.min(MAX_SOURCE_MS, Math.max(500, need.toMs - need.fromMs));
    const fail = (err: unknown): never => {
      if (err instanceof CreativeRenderError) throw err;
      logger.warn({ err, academyId, src }, "Creative render: footage unavailable");
      throw new CreativeRenderError("Couldn't load the footage for one of the videos. Try again in a minute.", 502);
    };
    try {
      switch (src.type) {
        case "clip": {
          const clip = await academyClip(academyId, src.clipId);
          if (!clip) throw new CreativeRenderError("A clip in this design is no longer available. Pick another one.");
          const clipped = clip.videoId.startsWith("live:") ? null : await clipSpan(clip);
          const start = clipped?.startSec ?? 0;
          const end = clipped?.endSec ?? 0;
          if (clipped && isBunnyConfigured()) {
            const from = start + need.fromMs / 1000;
            const to = Math.min(end, start + (need.fromMs + span) / 1000) + 0.5;
            const w = await fetchWindow(getBunnyPlaybackUrl(clip.videoId), from, to, workDir);
            return { path: w.path, zeroAtSec: start - w.segStart, durationMs: Math.round((end - start) * 1000), hasAudio: await hasAudioStream(w.path) };
          }
          if (clip.exportedUrl && clip.exportStatus === "done") {
            const file = await downloadToTemp(clip.exportedUrl);
            temps.push(file);
            return { path: file, zeroAtSec: 0, durationMs: await probeDurationMs(file), hasAudio: await hasAudioStream(file) };
          }
          throw new CreativeRenderError("A clip in this design isn't ready yet. Try again in a few minutes.", 409);
        }
        case "recording": {
          const rec = await academyRecording(academyId, src.recordingId);
          if (!rec) throw new CreativeRenderError("A recording in this design is no longer available.");
          if (!isBunnyConfigured()) throw new CreativeRenderError("Footage isn't available on this server.", 503);
          const length = Math.max(0, src.toMs - src.fromMs);
          const from = (src.fromMs + need.fromMs) / 1000;
          const to = (src.fromMs + Math.min(length || need.toMs, need.fromMs + span)) / 1000 + 0.5;
          const w = await fetchWindow(recordingPlaylist(rec.videoUrl), from, to, workDir);
          return { path: w.path, zeroAtSec: src.fromMs / 1000 - w.segStart, durationMs: length || null, hasAudio: await hasAudioStream(w.path) };
        }
        case "upload": {
          const row = await academyUpload(academyId, src.mediaId);
          if (!row) throw new CreativeRenderError("An upload in this design is no longer available.");
          if (row.kind !== "video" || !row.storageUrl) return null;
          const file = await downloadToTemp(row.storageUrl);
          temps.push(file);
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
      if (!clip || clip.videoId.startsWith("live:") || !isBunnyConfigured()) return null;
      const span = await clipSpan(clip);
      if (!span) return null;
      const start = span.startSec;
      const end = span.endSec;
      if (want === "still") return { redirect: getBunnyProxiedThumbnailUrl(clip.videoId, span.thumbSec ?? start) };
      return windowVideo(clip.sourceRecordingId, getBunnyPlaybackUrl(clip.videoId), start, Math.min(end, start + MAX_BROWSER_WINDOW_MS / 1000));
    }
    case "recording":
    case "frame": {
      const rec = await academyRecording(academyId, src.recordingId);
      const id = videoIdOf(rec?.videoUrl);
      if (!rec || !id || !isBunnyConfigured()) return null;
      if (src.type === "frame" || want === "still") {
        return { redirect: getBunnyProxiedThumbnailUrl(id, (src.type === "frame" ? src.atMs : src.fromMs) / 1000) };
      }
      const to = Math.min(src.toMs, src.fromMs + MAX_BROWSER_WINDOW_MS);
      if (to <= src.fromMs) return null;
      return windowVideo(rec.id, recordingPlaylist(rec.videoUrl), src.fromMs / 1000, to / 1000);
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
      const img = await creativeImageResolver(access.academyId, look)(layer, src, { format: format ?? "post" });
      if (!img || img.width <= 0 || img.height <= 0) return null;
      const png = tintPicture(img, tint, side).toBuffer("image/png");
      rememberTinted(key, png);
      return png;
    })().finally(() => tinting.delete(key));
    tinting.set(key, job);
  }
  return job;
}

/** A window of footage as a small MP4: from Bunny's edge once it has been cut there, else from this server's disk. */
async function windowVideo(recordingId: number | null, videoUrl: string, from: number, to: number): Promise<BrowserMedia> {
  if (recordingId && isBunnyStorageConfigured()) {
    const stored = await reelClipOnBunny(recordingId, videoUrl, from, to);
    if (stored) return { redirect: stored.url };
  }
  const clip = await reelClip(videoUrl, from, to);
  return { file: clip.path, type: "video/mp4" };
}

export type { MediaSource };
