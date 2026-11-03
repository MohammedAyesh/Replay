import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import type { Request, Response } from "express";
import { and, asc, eq, inArray, isNull, or, type SQL } from "drizzle-orm";
import { creativeMusicTracksTable, db, type CreativeMusicTrack } from "@workspace/db";
import {
  MUSIC_LICENSES,
  MUSIC_MAX_DURATION_MS,
  MUSIC_MIN_DURATION_MS,
  MUSIC_MOODS,
  MUSIC_WAVEFORM_PEAKS,
  TEMPLATE_MUSIC,
  hasMusic,
  templateDefaultMusic,
  type MusicMood,
  type Scene,
  type SceneMusic,
} from "@workspace/api-zod";
import { fetchExportObject } from "../backupExport";
import { bunnyStorageUrlFor, deleteBunnyStoragePath, isBunnyStorageConfigured, uploadFileToBunnyStoragePath } from "../bunny";
import { logger } from "../logger";
import { creativeAssetDir, musicPath } from "./renderMedia";

/**
 * Creative hub music library (creative_music_tracks, 0063).
 *
 * Replay's library (scope 'replay') is open to every academy; an academy's
 * own uploads (scope 'academy') only to that academy: every list, file and
 * render goes through usableTrack / tracksFor, which never return another
 * academy's track.
 *
 * Every track is stored the same way: AAC in an .m4a (44.1 kHz stereo), its
 * duration, integrated loudness (EBU R128) and ≈200 waveform peaks measured
 * once when it arrives. Files live in Bunny Storage (creative-music/replay/…
 * or creative-music/<academyId>/…, an authenticated origin only this server
 * reads), on this machine without Storage ("local:…"), or ship with the build
 * ("asset:<key>", assets/creative/music/<key>.m4a, seeded on boot from
 * library.json).
 */

export class MusicError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

const FFMPEG_TIMEOUT_MS = 3 * 60_000;

function run(cmd: string, args: string[], opts: { maxBuffer?: number; encoding?: "buffer" | "utf8" } = {}): Promise<{ stdout: Buffer | string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: FFMPEG_TIMEOUT_MS, maxBuffer: opts.maxBuffer ?? 8 * 1024 * 1024, encoding: (opts.encoding ?? "utf8") as BufferEncoding },
      (error, stdout, stderr) => {
        if (error) { reject(Object.assign(error, { stderr: String(stderr ?? "") })); return; }
        resolve({ stdout: stdout as unknown as Buffer | string, stderr: String(stderr ?? "") });
      });
  });
}

// ── Analysis ─────────────────────────────────────────────────────────────────

/** Duration (ms) of the first audio stream, or null when there is none. */
export async function probeAudio(file: string): Promise<{ durationMs: number } | null> {
  try {
    const { stdout } = await run("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_type,duration:format=duration", "-of", "json", file]);
    const info = JSON.parse(String(stdout)) as { streams?: Array<{ codec_type?: string; duration?: string }>; format?: { duration?: string } };
    const stream = info.streams?.find((s) => s.codec_type === "audio");
    if (!stream) return null;
    const seconds = Number(stream.duration ?? info.format?.duration);
    if (!Number.isFinite(seconds) || seconds <= 0) return null;
    return { durationMs: Math.round(seconds * 1000) };
  } catch {
    return null;
  }
}

/** Integrated loudness (LUFS) by EBU R128, or null when ffmpeg can't say. Silence reads as -70. */
export async function measureLoudness(file: string): Promise<number | null> {
  try {
    const { stderr } = await run("ffmpeg", ["-nostdin", "-hide_banner", "-i", file, "-map", "0:a:0", "-af", "ebur128", "-f", "null", "-"]);
    return parseEbur128(stderr);
  } catch {
    return null;
  }
}

/** The "I: -14.0 LUFS" of ebur128's summary. */
export function parseEbur128(stderr: string): number | null {
  const summary = stderr.lastIndexOf("Summary:");
  const m = /I:\s*(-?\d+(?:\.\d+)?)\s*LUFS/.exec(summary >= 0 ? stderr.slice(summary) : stderr);
  if (!m) return null;
  const v = Number(m[1]);
  return Number.isFinite(v) ? Math.round(v * 10) / 10 : null;
}

/** `count` peaks 0..1 (the loudest sample of each slice, scaled so the loudest slice is 1). */
export function peaksFromSamples(samples: Float32Array, count = MUSIC_WAVEFORM_PEAKS): number[] {
  if (!samples.length || count < 1) return [];
  const out = new Array<number>(count).fill(0);
  const per = samples.length / count;
  for (let i = 0; i < count; i++) {
    const from = Math.floor(i * per);
    const to = Math.max(from + 1, Math.floor((i + 1) * per));
    let peak = 0;
    for (let j = from; j < to && j < samples.length; j++) {
      const v = Math.abs(samples[j]);
      if (v > peak) peak = v;
    }
    out[i] = peak;
  }
  const max = Math.max(...out);
  return out.map((v) => (max > 0 ? Math.round((v / max) * 1000) / 1000 : 0));
}

const WAVEFORM_RATE = 2000;

export async function waveformPeaks(file: string, count = MUSIC_WAVEFORM_PEAKS): Promise<number[]> {
  try {
    const { stdout } = await run("ffmpeg", [
      "-nostdin", "-hide_banner", "-loglevel", "error", "-i", file, "-map", "0:a:0", "-ac", "1", "-ar", String(WAVEFORM_RATE), "-f", "f32le", "-",
    ], { encoding: "buffer", maxBuffer: Math.ceil((MUSIC_MAX_DURATION_MS / 1000 + 60) * WAVEFORM_RATE * 4) });
    const buf = stdout as Buffer;
    const samples = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
    return peaksFromSamples(samples, count);
  } catch {
    return [];
  }
}

export type MusicFacts = { durationMs: number; loudnessLufs: number | null; waveform: number[] };

export async function analyzeMusic(file: string): Promise<MusicFacts | null> {
  const probe = await probeAudio(file);
  if (!probe) return null;
  const [loudnessLufs, waveform] = await Promise.all([measureLoudness(file), waveformPeaks(file)]);
  return { durationMs: probe.durationMs, loudnessLufs, waveform };
}

/** Any audio file → AAC .m4a, 44.1 kHz stereo, at most MUSIC_MAX_DURATION_MS (artwork and video dropped). */
export async function transcodeMusic(input: string, out: string): Promise<void> {
  await run("ffmpeg", [
    "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", input,
    "-map", "0:a:0", "-vn", "-sn", "-dn", "-map_metadata", "-1",
    "-t", String(MUSIC_MAX_DURATION_MS / 1000),
    "-c:a", "aac", "-b:a", "192k", "-ar", "44100", "-ac", "2", "-movflags", "+faststart", out,
  ]);
}

// ── Files ────────────────────────────────────────────────────────────────────

export function localMusicDir(): string {
  return process.env.CREATIVE_MUSIC_DIR || path.join(os.tmpdir(), "replay-creative-music");
}

/** assets/creative/music (CREATIVE_MUSIC_ASSET_DIR overrides it, for tests). */
export function musicAssetDir(): string {
  return process.env.CREATIVE_MUSIC_ASSET_DIR || path.join(creativeAssetDir(), "music");
}

const STORED = /^creative-music\/(replay|\d+)\/[0-9a-f-]{36}\.m4a$/;
const ASSET_KEY = /^[a-z0-9][a-z0-9/_-]{0,119}$/;

const scopeDir = (t: Pick<CreativeMusicTrack, "scope" | "academyId">) => (t.scope === "replay" ? "replay" : String(t.academyId));

type Located = { kind: "local"; file: string } | { kind: "asset"; file: string } | { kind: "bunny"; rel: string };

/** Where a track's file is, only if its path is one of ours for its own scope (never an arbitrary path from a row). */
export function locateMusic(t: Pick<CreativeMusicTrack, "path" | "scope" | "academyId">): Located | null {
  if (t.path.startsWith("asset:")) {
    const key = t.path.slice("asset:".length);
    if (t.scope !== "replay" || !ASSET_KEY.test(key) || key.includes("..")) return null;
    const file = path.join(musicAssetDir(), `${key}.m4a`);
    return fs.existsSync(file) ? { kind: "asset", file } : null;
  }
  const local = t.path.startsWith("local:");
  const rel = local ? t.path.slice("local:".length) : t.path;
  const m = STORED.exec(rel);
  if (!m || m[1] !== scopeDir(t)) return null;
  return local ? { kind: "local", file: path.join(localMusicDir(), rel) } : { kind: "bunny", rel };
}

/** Keep a transcoded .m4a; returns the path the row stores. */
export async function storeMusicFile(t: Pick<CreativeMusicTrack, "scope" | "academyId">, file: string): Promise<string> {
  const rel = `creative-music/${scopeDir(t)}/${randomUUID()}.m4a`;
  if (isBunnyStorageConfigured()) {
    await uploadFileToBunnyStoragePath(file, rel);
    return rel;
  }
  const dest = path.join(localMusicDir(), rel);
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  await fs.promises.copyFile(file, dest);
  return `local:${rel}`;
}

/** Best effort: a deleted track's file goes (bundled files stay). */
export async function deleteMusicFile(t: Pick<CreativeMusicTrack, "path" | "scope" | "academyId">): Promise<void> {
  const where = locateMusic(t);
  try {
    if (where?.kind === "local") await fs.promises.rm(where.file, { force: true });
    else if (where?.kind === "bunny" && isBunnyStorageConfigured()) await deleteBunnyStoragePath(where.rel);
  } catch (err) {
    logger.warn({ err, trackId: (t as { id?: number }).id }, "Creative music: deleting a file failed");
  }
}

/** A local file for ffmpeg: the file itself, or a temp download (pushed to `temps`) from Storage. */
export async function musicFileForRender(t: CreativeMusicTrack, temps: string[]): Promise<string | null> {
  const where = locateMusic(t);
  if (!where) return null;
  if (where.kind !== "bunny") return fs.existsSync(where.file) ? where.file : null;
  const response = await fetchExportObject(bunnyStorageUrlFor(where.rel)).catch(() => null);
  if (!response?.ok || !response.body) {
    await response?.body?.cancel().catch(() => {});
    return null;
  }
  const file = path.join(os.tmpdir(), `creative-music-${randomUUID()}.m4a`);
  temps.push(file);
  await pipeline(Readable.fromWeb(response.body as never), fs.createWriteStream(file));
  return file;
}

/** Stream a track: audio/mp4, Range answered (local files by sendFile, Storage by passing Range on). */
export async function sendMusicFile(req: Request, res: Response, t: CreativeMusicTrack): Promise<void> {
  const where = locateMusic(t);
  if (!where) { res.status(404).json({ error: "Not found" }); return; }
  res.setHeader("Cache-Control", "private, max-age=3600");
  if (where.kind !== "bunny") {
    if (!fs.existsSync(where.file)) { res.status(404).json({ error: "Not found" }); return; }
    res.sendFile(where.file, { headers: { "Content-Type": t.mime || "audio/mp4" }, cacheControl: false }, (err) => {
      if (err && !res.headersSent) res.status(500).json({ error: "Couldn't send the file" });
    });
    return;
  }
  const range = typeof req.headers.range === "string" ? req.headers.range : undefined;
  const abort = new AbortController();
  res.once("close", () => { if (!res.writableEnded) abort.abort(); });
  const upstream = await fetchExportObject(bunnyStorageUrlFor(where.rel), { range, signal: abort.signal }).catch(() => null);
  if (!upstream || (!upstream.ok && upstream.status !== 416) || !upstream.body) {
    await upstream?.body?.cancel().catch(() => {});
    res.status(upstream?.status === 404 ? 404 : 502).json({ error: upstream?.status === 404 ? "Not found" : "The file isn't reachable right now. Try again in a minute." });
    return;
  }
  res.status(upstream.status);
  res.setHeader("Content-Type", t.mime || "audio/mp4");
  for (const header of ["content-length", "content-range", "accept-ranges"]) {
    const value = upstream.headers.get(header);
    if (value) res.setHeader(header, value);
  }
  if (!upstream.headers.get("accept-ranges")) res.setHeader("Accept-Ranges", "bytes");
  const stream = Readable.fromWeb(upstream.body as never);
  stream.on("error", () => res.destroy());
  stream.pipe(res);
}

// ── Rows ─────────────────────────────────────────────────────────────────────

export const isMood = (v: unknown): v is MusicMood => typeof v === "string" && (MUSIC_MOODS as readonly string[]).includes(v);

/** Tracks one academy may use: Replay's and its own. */
const visibleTo = (academyId: number): SQL =>
  or(eq(creativeMusicTracksTable.scope, "replay"), and(eq(creativeMusicTracksTable.scope, "academy"), eq(creativeMusicTracksTable.academyId, academyId)))!;

/** Active tracks for an academy's console, Replay's first (in library order), then its own (newest first). */
export async function tracksFor(academyId: number, filter: { scope?: "replay" | "academy"; mood?: MusicMood } = {}): Promise<CreativeMusicTrack[]> {
  const where: SQL[] = [visibleTo(academyId), eq(creativeMusicTracksTable.status, "active")];
  if (filter.scope === "replay") where.push(eq(creativeMusicTracksTable.scope, "replay"));
  if (filter.scope === "academy") where.push(eq(creativeMusicTracksTable.scope, "academy"));
  if (filter.mood) where.push(eq(creativeMusicTracksTable.mood, filter.mood));
  const rows = await db.select().from(creativeMusicTracksTable).where(and(...where))
    .orderBy(asc(creativeMusicTracksTable.scope), asc(creativeMusicTracksTable.id)).limit(500);
  const replay = rows.filter((r) => r.scope === "replay");
  const own = rows.filter((r) => r.scope === "academy").sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id - a.id);
  return [...replay, ...own];
}

/** Replay's active library in its order (template defaults pick from it). */
export async function replayLibrary(): Promise<CreativeMusicTrack[]> {
  return db.select().from(creativeMusicTracksTable)
    .where(and(eq(creativeMusicTracksTable.scope, "replay"), eq(creativeMusicTracksTable.status, "active")))
    .orderBy(asc(creativeMusicTracksTable.id)).limit(500);
}

/** One track this academy may use (Replay's or its own, and not hidden), or null. */
export async function usableTrack(academyId: number, trackId: number): Promise<CreativeMusicTrack | null> {
  if (!Number.isSafeInteger(trackId) || trackId < 1) return null;
  const [row] = await db.select().from(creativeMusicTracksTable)
    .where(and(eq(creativeMusicTracksTable.id, trackId), visibleTo(academyId), eq(creativeMusicTracksTable.status, "active")));
  return row ?? null;
}

/** An academy's own track (for edit / delete), or null. */
export async function ownTrack(academyId: number, trackId: number): Promise<CreativeMusicTrack | null> {
  const [row] = await db.select().from(creativeMusicTracksTable)
    .where(and(eq(creativeMusicTracksTable.id, trackId), eq(creativeMusicTracksTable.scope, "academy"), eq(creativeMusicTracksTable.academyId, academyId)));
  return row ?? null;
}

export async function replayTrack(trackId: number): Promise<CreativeMusicTrack | null> {
  const [row] = await db.select().from(creativeMusicTracksTable)
    .where(and(eq(creativeMusicTracksTable.id, trackId), eq(creativeMusicTracksTable.scope, "replay"), isNull(creativeMusicTracksTable.academyId)));
  return row ?? null;
}

/** A track as the console lists it (never the storage path). `academyId`: whose console asks (the file URL is under it). */
export function trackView(t: CreativeMusicTrack, academyId: number | null) {
  return {
    trackId: t.id,
    /** Bundled tracks: their asset key (designs saved before the library name them by it). */
    key: t.key,
    scope: t.scope as "replay" | "academy",
    title: t.title,
    artist: t.artist,
    mood: t.mood as MusicMood,
    bpm: t.bpm,
    durationMs: t.durationMs,
    loudnessLufs: t.loudnessLufs,
    waveform: Array.isArray(t.waveform) ? t.waveform : [],
    license: t.license,
    status: t.status as "active" | "hidden",
    mine: t.scope === "academy" && academyId !== null && t.academyId === academyId,
    createdAt: t.createdAt.toISOString(),
    url: academyId !== null
      ? `/api/academy/console/academies/${academyId}/creative/music/${t.id}/file`
      : `/api/admin/creative/music/${t.id}/file`,
  };
}
export type MusicTrackView = ReturnType<typeof trackView>;

export function cleanText(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.replace(/\s+/g, " ").trim().slice(0, max);
  return t || null;
}

export function cleanBpm(v: unknown): number | null {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= 30 && n <= 300 ? n : null;
}

/** Audio types an upload may be. Phones label the same file many ways, so the extension counts too. */
const UPLOAD_MIME = new Set(["audio/mpeg", "audio/mp3", "audio/mp4", "audio/x-m4a", "audio/m4a", "audio/aac", "audio/x-aac", "audio/aacp", "audio/wav", "audio/x-wav", "audio/wave", "audio/vnd.wave"]);
const UPLOAD_EXT = /\.(mp3|m4a|aac|wav)$/i;

export function isMusicUpload(file: { mimetype?: string; originalname?: string }): boolean {
  const ext = UPLOAD_EXT.test(file.originalname ?? "");
  const mime = UPLOAD_MIME.has((file.mimetype ?? "").toLowerCase());
  // A known extension is enough when the browser said nothing useful.
  return ext && (mime || !file.mimetype || file.mimetype === "application/octet-stream" || file.mimetype.startsWith("audio/"));
}

/** Title from a file name when the form left it empty ("my_song-final.mp3" → "my song final"). */
export function titleFromFileName(name: string | undefined): string {
  const base = (name ?? "").replace(/\.[a-z0-9]{2,4}$/i, "").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  return base.slice(0, 80) || "Untitled";
}

/**
 * Turn an uploaded file into a track: transcode to .m4a, measure it, refuse
 * what isn't usable (no sound, too short / long), store it and add the row.
 * The upload itself is left for the caller to delete.
 */
export async function addTrack(input: {
  scope: "replay" | "academy";
  academyId: number | null;
  uploadPath: string;
  title: string;
  artist: string | null;
  mood: MusicMood;
  bpm: number | null;
  license: string;
  createdBy: number | null;
}): Promise<CreativeMusicTrack> {
  const before = await probeAudio(input.uploadPath);
  if (!before) throw new MusicError("That file isn't music we can read. Use an MP3, M4A, AAC or WAV file.");
  if (before.durationMs > MUSIC_MAX_DURATION_MS + 1000) throw new MusicError(`Music can be at most ${MUSIC_MAX_DURATION_MS / 60_000} minutes long.`);
  if (before.durationMs < MUSIC_MIN_DURATION_MS) throw new MusicError(`That's too short for a soundtrack. Use at least ${MUSIC_MIN_DURATION_MS / 1000} seconds.`);
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "creative-music-up-"));
  try {
    const out = path.join(dir, "track.m4a");
    try {
      await transcodeMusic(input.uploadPath, out);
    } catch {
      throw new MusicError("That file isn't music we can read. Use an MP3, M4A, AAC or WAV file.");
    }
    const facts = await analyzeMusic(out);
    if (!facts) throw new MusicError("That file isn't music we can read. Use an MP3, M4A, AAC or WAV file.");
    if (facts.loudnessLufs !== null && facts.loudnessLufs <= -60) throw new MusicError("That file is silent.");
    const scope = { scope: input.scope, academyId: input.scope === "replay" ? null : input.academyId };
    const stored = await storeMusicFile(scope, out);
    try {
      const [row] = await db.insert(creativeMusicTracksTable).values({
        ...scope,
        title: input.title,
        artist: input.artist,
        mood: input.mood,
        bpm: input.bpm,
        durationMs: facts.durationMs,
        path: stored,
        mime: "audio/mp4",
        loudnessLufs: facts.loudnessLufs,
        waveform: facts.waveform,
        license: input.license,
        status: "active",
        createdBy: input.createdBy,
      }).returning();
      return row;
    } catch (err) {
      await deleteMusicFile({ path: stored, ...scope });
      throw err;
    }
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// ── Replay's bundled library ─────────────────────────────────────────────────

type LibraryEntry = { key: string; title: string; artist?: string; mood: string; bpm?: number; license?: string };

/**
 * Add the tracks of assets/creative/music/library.json the table doesn't have
 * yet (matched on key). Rows already there are left exactly as they are, so an
 * admin's edits (title, mood, hidden) survive every boot. Returns how many were added.
 */
export async function seedReplayMusic(dir = musicAssetDir()): Promise<number> {
  let entries: LibraryEntry[] = [];
  try {
    const raw = JSON.parse(await fs.promises.readFile(path.join(dir, "library.json"), "utf8")) as { tracks?: LibraryEntry[] };
    entries = Array.isArray(raw.tracks) ? raw.tracks : [];
  } catch {
    return 0;
  }
  const valid = entries.filter((e) => e && typeof e.key === "string" && ASSET_KEY.test(e.key) && !e.key.includes("..") && isMood(e.mood) && typeof e.title === "string");
  if (!valid.length) return 0;
  const have = new Set((await db.select({ key: creativeMusicTracksTable.key }).from(creativeMusicTracksTable)
    .where(inArray(creativeMusicTracksTable.key, valid.map((e) => e.key)))).map((r) => r.key));
  let added = 0;
  for (const e of valid) {
    if (have.has(e.key)) continue;
    const file = path.join(dir, `${e.key}.m4a`);
    if (!fs.existsSync(file)) continue;
    const facts = await analyzeMusic(file);
    if (!facts) { logger.warn({ key: e.key }, "Creative music: a bundled track can't be read"); continue; }
    const inserted = await db.insert(creativeMusicTracksTable).values({
      scope: "replay",
      academyId: null,
      key: e.key,
      title: e.title.slice(0, 80),
      artist: e.artist?.slice(0, 80) ?? "Replay",
      mood: e.mood,
      bpm: cleanBpm(e.bpm),
      durationMs: facts.durationMs,
      path: `asset:${e.key}`,
      mime: "audio/mp4",
      loudnessLufs: facts.loudnessLufs,
      waveform: facts.waveform,
      license: e.license || MUSIC_LICENSES.generated,
      status: "active",
    }).onConflictDoNothing().returning({ id: creativeMusicTracksTable.id });
    added += inserted.length;
  }
  return added;
}

let seeding: Promise<number> | null = null;

/** seedReplayMusic once per process (boot, and the first library request); never throws. */
export function ensureReplayMusic(): Promise<number> {
  if (!seeding) {
    seeding = seedReplayMusic().catch((err) => {
      logger.warn({ err: (err as Error)?.message }, "Creative music: seeding the library failed");
      seeding = null;
      return 0;
    });
  }
  return seeding;
}

// ── Rendering ────────────────────────────────────────────────────────────────

/** A scene's soundtrack resolved to a local file, with what the mix needs to know. */
export type ResolvedMusic = { path: string; durationMs: number | null; loudnessLufs: number | null };

/**
 * The file a scene's music plays, for this academy only: trackId must be
 * Replay's or the academy's own and active; trackKey (designs from before the
 * library) is a bundled file. Anything else plays no music (the export keeps
 * the footage's sound, or silence).
 */
export async function resolveSceneMusic(academyId: number, music: SceneMusic | undefined, temps: string[]): Promise<ResolvedMusic | null> {
  if (!hasMusic(music)) return null;
  if (music.trackId !== undefined) {
    const track = await usableTrack(academyId, music.trackId);
    if (!track) return null;
    const file = await musicFileForRender(track, temps);
    return file ? { path: file, durationMs: track.durationMs, loudnessLufs: track.loudnessLufs } : null;
  }
  const file = music.trackKey ? musicPath(music.trackKey) : null;
  if (!file) return null;
  const [row] = await db.select({ durationMs: creativeMusicTracksTable.durationMs, loudnessLufs: creativeMusicTracksTable.loudnessLufs })
    .from(creativeMusicTracksTable).where(and(eq(creativeMusicTracksTable.key, music.trackKey!), eq(creativeMusicTracksTable.scope, "replay")));
  return { path: file, durationMs: row?.durationMs ?? null, loudnessLufs: row?.loudnessLufs ?? null };
}

/**
 * A video made from a template starts with a soundtrack of the template's
 * mood (TEMPLATE_MUSIC: goal → hype, training → fun, talk → chill, low and
 * ducked) when Replay's library has one. A scene that already has music, a
 * still, or another template is returned as it is; so is any failure.
 */
export async function sceneWithDefaultMusic(scene: Scene, templateKey: string | null | undefined, library?: CreativeMusicTrack[]): Promise<Scene> {
  if (scene.durationMs === undefined || scene.music || !templateKey || !TEMPLATE_MUSIC[templateKey]) return scene;
  try {
    if (!library) await ensureReplayMusic();
    const tracks = library ?? await replayLibrary();
    const music = templateDefaultMusic(templateKey, tracks.map((t) => ({ trackId: t.id, mood: t.mood })));
    return music ? { ...scene, music } : scene;
  } catch (err) {
    logger.warn({ err: (err as Error)?.message, templateKey }, "Creative music: default track lookup failed");
    return scene;
  }
}

/** Newest-first list for /admin (hidden included). */
export async function adminLibrary(): Promise<CreativeMusicTrack[]> {
  return db.select().from(creativeMusicTracksTable).where(eq(creativeMusicTracksTable.scope, "replay"))
    .orderBy(asc(creativeMusicTracksTable.status), asc(creativeMusicTracksTable.id)).limit(500);
}
