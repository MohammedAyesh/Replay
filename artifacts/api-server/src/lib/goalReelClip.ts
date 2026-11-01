/**
 * The goal reel's cards as small MP4 files (2026-10-31).
 *
 * The first reel streamed each card from the match's HLS through the API's
 * proxy, as the "Is this you?" deck does. On Mohammed's iPhone that stalled or
 * never loaded: per card the phone fetched the master playlist, a two-hour
 * variant playlist and 2-3 segments, all through the proxy, and Safari's
 * media source only buffers what it is about to play, so the cards waiting
 * behind never got ahead. A card is now one short MP4:
 *
 *   - the server reads the variant playlist once per recording (cached), picks
 *     the segments that cover the card, fetches them from Bunny and encodes
 *     exactly the card's seconds, video only, at 1920x540 into a faststart MP4
 *     (~1-2 MB). The first version copied whole segments without encoding:
 *     ~5 MB a card, 3-4 s of it before the card, and 2.7 s to download even
 *     when cached (measured on replayjo.com, 1 Nov);
 *   - the phone downloads that one file into memory ahead of time and plays it
 *     from there, so the next card is already on the phone when it comes up;
 *   - files are kept on disk and shared by everyone in the match.
 *
 * The file starts exactly at the card's start; the route tells the page that
 * offset (video seconds) all the same, so the page never assumes it.
 */
import { createHash, createHmac } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseMasterPlaylist } from "./exportSource";
import {
  BUNNY_STORAGE_API_KEY,
  BUNNY_STORAGE_CDN_URL,
  BUNNY_STORAGE_HOSTNAME,
  BUNNY_STORAGE_ZONE,
  isBunnyStorageConfigured,
  uploadFileToBunnyStoragePath,
} from "./bunny";
import { logger } from "./logger";

/** the lightest rung worth showing: below this a far-side player is a smudge, px (as the deck) */
const MIN_HEIGHT = 600;
const PLAYLIST_TTL_MS = 30 * 60_000;
const CACHE_DIR = path.join(os.tmpdir(), "goal-reel-clips");
const CACHE_MAX_BYTES = 600 * 1024 * 1024;
const MAX_PARALLEL_CUTS = 3;
/** the encoded card: wide enough for a phone that follows the ball across the panorama */
const OUT_WIDTH = 1920;
/** bump to stop serving files cut by an older recipe */
const RECIPE = "v2-1920-crf27";
/**
 * A clip may ask for a keyframe every `gop` frames (the moment popup's tiles,
 * lib/momentTiles.ts: a -5 s step lands anywhere in a tile, and with one
 * keyframe per tile the phone decodes up to ten seconds to get there). It is
 * part of the recipe, so a tile and a goal-reel card are never the same file.
 */
export type ClipRecipe = { gop?: number };
const recipeOf = (r: ClipRecipe | undefined) => (r?.gop ? `${RECIPE}-g${r.gop}` : RECIPE);
const FETCH_TIMEOUT_MS = 20_000;

export type MediaSegment = { url: string; start: number; duration: number };
export type MediaPlaylist = { init: string | null; segments: MediaSegment[] };

/** EXTINF and EXT-X-MAP out of a media playlist, with absolute URLs and start times on the playlist clock. */
export function parseMediaPlaylist(body: string, baseUrl: string): MediaPlaylist {
  const segments: MediaSegment[] = [];
  let init: string | null = null;
  let t = 0;
  let pending: number | null = null;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#EXT-X-MAP:")) {
      const uri = /URI="([^"]+)"/.exec(line)?.[1];
      if (uri) init = new URL(uri, baseUrl).toString();
    } else if (line.startsWith("#EXTINF:")) {
      pending = Number.parseFloat(line.slice(8));
    } else if (!line.startsWith("#") && pending !== null && Number.isFinite(pending)) {
      segments.push({ url: new URL(line, baseUrl).toString(), start: t, duration: pending });
      t += pending;
      pending = null;
    }
  }
  return { init, segments };
}

/** The segments a stretch of the video needs, and where the first one starts. */
export function segmentsFor(playlist: MediaPlaylist, from: number, to: number): { segments: MediaSegment[]; offset: number } {
  const segments = playlist.segments.filter((s) => s.start + s.duration > from && s.start < to);
  return { segments, offset: segments[0]?.start ?? 0 };
}

function refererFor(url: string): string {
  try { return `https://${new URL(url).hostname}/`; } catch { return "https://iframe.mediadelivery.net/"; }
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, { headers: { Referer: refererFor(url) }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  const body = await response.text();
  if (!response.ok || !body.trimStart().startsWith("#EXTM3U")) throw new Error(`playlist ${response.status} ${url}`);
  return body;
}

async function fetchBytes(url: string): Promise<Buffer> {
  const response = await fetch(url, { headers: { Referer: refererFor(url) }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`segment ${response.status} ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

const playlists = new Map<string, { at: number; value: Promise<MediaPlaylist> }>();

/** The variant playlist of the lightest rung at least MIN_HEIGHT tall (cached per recording). */
export function mediaPlaylistFor(videoUrl: string): Promise<MediaPlaylist> {
  const hit = playlists.get(videoUrl);
  if (hit && Date.now() - hit.at < PLAYLIST_TTL_MS) return hit.value;
  const value = (async () => {
    const master = await fetchText(videoUrl);
    const variants = parseMasterPlaylist(master);
    if (!variants.length) return parseMediaPlaylist(master, videoUrl); // already a media playlist
    const tall = variants.filter((v) => v.height >= MIN_HEIGHT).sort((a, b) => a.height - b.height);
    const pick = tall[0] ?? [...variants].sort((a, b) => b.height - a.height)[0]!;
    const variantUrl = new URL(pick.uri, videoUrl).toString();
    return parseMediaPlaylist(await fetchText(variantUrl), variantUrl);
  })();
  playlists.set(videoUrl, { at: Date.now(), value });
  value.catch(() => playlists.delete(videoUrl));
  if (playlists.size > 50) playlists.delete(playlists.keys().next().value!);
  return value;
}

function runFfmpeg(args: string[], timeoutMs = 60_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    proc.stderr.on("data", (d: Buffer) => { err = (err + d.toString()).slice(-2000); });
    const timer = setTimeout(() => { proc.kill("SIGKILL"); reject(new Error("ffmpeg timed out")); }, timeoutMs);
    proc.on("error", (e) => { clearTimeout(timer); reject(e); });
    proc.on("close", (code) => { clearTimeout(timer); if (code === 0) resolve(); else reject(new Error(`ffmpeg exit ${code}: ${err}`)); });
  });
}

let running = 0;
/** a card a page is waiting for goes before a card cut ahead of time */
type Waiter = { id: string; go: () => void };
const waitingNow: Waiter[] = [];
const waitingLater: Waiter[] = [];
const urgent = new Set<string>();
async function slot<T>(id: string, work: () => Promise<T>, ahead: boolean): Promise<T> {
  const later = ahead && !urgent.has(id);
  if (running >= MAX_PARALLEL_CUTS) await new Promise<void>((go) => (later ? waitingLater : waitingNow).push({ id, go }));
  running++;
  try { return await work(); } finally { running--; urgent.delete(id); (waitingNow.shift() ?? waitingLater.shift())?.go(); }
}
/** a page now waits for a card that was queued to be cut ahead: move it to the front */
function promote(id: string): void {
  urgent.add(id);
  const k = waitingLater.findIndex((w) => w.id === id);
  if (k >= 0) waitingNow.push(...waitingLater.splice(k, 1));
}

async function pruneCache(): Promise<void> {
  try {
    const files = await Promise.all((await fs.promises.readdir(CACHE_DIR)).filter((f) => f.endsWith(".mp4")).map(async (f) => {
      const p = path.join(CACHE_DIR, f);
      const st = await fs.promises.stat(p);
      return { p, size: st.size, at: st.atimeMs || st.mtimeMs };
    }));
    let total = files.reduce((s, f) => s + f.size, 0);
    for (const f of files.sort((a, b) => a.at - b.at)) {
      if (total <= CACHE_MAX_BYTES) break;
      await fs.promises.rm(f.p, { force: true });
      total -= f.size;
    }
  } catch { /* the cache is best-effort */ }
}

export type ReelClip = { path: string; offset: number };
const inFlight = new Map<string, Promise<ReelClip>>();

/** One card as an MP4 on disk: the segments covering [from, to] (video seconds), remuxed. */
export function reelClip(videoUrl: string, from: number, to: number, opts: { ahead?: boolean } & ClipRecipe = {}): Promise<ReelClip> {
  const id = createHash("sha1").update(`${recipeOf(opts)}|${videoUrl}|${from.toFixed(1)}|${to.toFixed(1)}`).digest("hex").slice(0, 20);
  const existing = inFlight.get(id);
  if (existing) {
    if (!opts.ahead) promote(id);
    return existing;
  }
  const job = (async (): Promise<ReelClip> => {
    const playlist = await mediaPlaylistFor(videoUrl);
    const { segments, offset: firstSegment } = segmentsFor(playlist, from, to);
    if (!segments.length) throw new Error("no footage at that time");
    // the file starts at the card's own start (or the first footage there is)
    const offset = Math.max(from, firstSegment);
    const out = path.join(CACHE_DIR, `${id}.mp4`);
    await fs.promises.mkdir(CACHE_DIR, { recursive: true });
    try {
      const now = new Date();
      await fs.promises.utimes(out, now, now);
      return { path: out, offset };
    } catch { /* not cached yet */ }
    return slot(id, async () => {
      const started = Date.now();
      const parts = await Promise.all([
        ...(playlist.init ? [fetchBytes(playlist.init)] : []),
        ...segments.map((s) => fetchBytes(s.url)),
      ]);
      const joined = path.join(CACHE_DIR, `${id}.${playlist.init ? "m4s" : "ts"}`);
      const tmp = `${out}.part.mp4`;
      await fs.promises.writeFile(joined, Buffer.concat(parts));
      try {
        await runFfmpeg([
          "-nostdin", "-loglevel", "error", "-y",
          "-threads", "2",
          "-i", joined,
          // exactly the card: decoding runs from the segment's keyframe, the file starts at `offset`
          "-ss", (offset - firstSegment).toFixed(3),
          "-t", Math.max(1, to - offset).toFixed(3),
          "-map", "0:v:0", "-an",
          "-vf", `scale=${OUT_WIDTH}:-2`,
          "-c:v", "libx264", "-preset", "veryfast", "-crf", "27",
          "-maxrate", "3M", "-bufsize", "6M",
          ...(opts.gop ? ["-g", String(opts.gop), "-keyint_min", String(opts.gop), "-sc_threshold", "0"] : []),
          "-pix_fmt", "yuv420p", "-profile:v", "high",
          "-movflags", "+faststart",
          "-f", "mp4", tmp,
        ]);
        await fs.promises.rename(tmp, out);
      } finally {
        await fs.promises.rm(joined, { force: true });
        await fs.promises.rm(tmp, { force: true });
      }
      logger.info({ segments: segments.length, ms: Date.now() - started }, "goal reel clip cut");
      void pruneCache();
      return { path: out, offset };
    }, opts.ahead === true);
  })();
  inFlight.set(id, job);
  job.finally(() => inFlight.delete(id)).catch(() => {});
  return job;
}

/* ---------------------------------------------------- stored on Bunny (1 Nov) */

/**
 * Cards live on Bunny Storage and play from its pull zone (replayjo.b-cdn.net:
 * public, CORS-readable, Range-capable, checked from replayjo.com on 1 Nov).
 * Our server cuts a card once, ever; every phone after that downloads it from
 * Bunny's edge, never through this server (~15 Mbit/s from Replit against
 * ~20-45 from the edge, measured the same day). The object name is an HMAC of
 * the card, so a card's address cannot be guessed from the match.
 */
export type StoredReelClip = { url: string; offset: number };

const listed = new Map<number, { at: number; names: Promise<Set<string>> }>();
const LIST_TTL_MS = 5 * 60_000;

function storedName(recordingId: number, videoUrl: string, from: number, to: number, recipe?: ClipRecipe): string {
  const secret = BUNNY_STORAGE_API_KEY || "replay-goal-reel";
  return `${createHmac("sha256", secret).update(`${recipeOf(recipe)}|${recordingId}|${videoUrl}|${from.toFixed(1)}|${to.toFixed(1)}`).digest("hex").slice(0, 32)}.mp4`;
}

const reelDir = (recordingId: number) => `reel/${recordingId}`;
/**
 * The storage zone's public pull zone. Not BUNNY_STORAGE_CDN_URL: on
 * production that is storage.bunnycdn.com, the authenticated origin, which
 * answers a phone with 401 (found live on 1 Nov; routes/clipIntro.ts says the
 * same). galaxyfield's pull zone is replayjo.b-cdn.net.
 */
export function reelCdnBase(): string {
  const set = (process.env.BUNNY_REEL_CDN_URL ?? "").trim();
  if (set) return set.replace(/\/$/, "");
  const storageCdn = BUNNY_STORAGE_CDN_URL.trim();
  try {
    if (storageCdn && new URL(storageCdn).hostname.endsWith(".b-cdn.net")) return storageCdn.replace(/\/$/, "");
  } catch { /* not a URL */ }
  return "https://replayjo.b-cdn.net";
}
const cdnUrl = (remotePath: string) => `${reelCdnBase()}/${remotePath}`;

/** The card files already stored for a recording (one Storage listing, cached). */
function storedNames(recordingId: number): Promise<Set<string>> {
  const hit = listed.get(recordingId);
  if (hit && Date.now() - hit.at < LIST_TTL_MS) return hit.names;
  const names = (async () => {
    const response = await fetch(`https://${BUNNY_STORAGE_HOSTNAME}/${BUNNY_STORAGE_ZONE}/${reelDir(recordingId)}/`, {
      headers: { AccessKey: BUNNY_STORAGE_API_KEY, Accept: "application/json" },
      signal: AbortSignal.timeout(8_000),
    });
    if (response.status === 404) return new Set<string>();
    if (!response.ok) throw new Error(`storage listing ${response.status}`);
    const rows = (await response.json()) as Array<{ ObjectName?: string; IsDirectory?: boolean }>;
    return new Set(rows.filter((r) => !r.IsDirectory && r.ObjectName).map((r) => r.ObjectName!));
  })();
  listed.set(recordingId, { at: Date.now(), names });
  names.catch(() => listed.delete(recordingId));
  return names;
}

/** Already on Bunny? Then its address, without cutting anything. */
export async function storedReelClip(recordingId: number, videoUrl: string, from: number, to: number, recipe?: ClipRecipe): Promise<StoredReelClip | null> {
  if (!isBunnyStorageConfigured()) return null;
  const name = storedName(recordingId, videoUrl, from, to, recipe);
  try {
    return (await storedNames(recordingId)).has(name) ? { url: cdnUrl(`${reelDir(recordingId)}/${name}`), offset: from } : null;
  } catch {
    return null;
  }
}

const uploading = new Map<string, Promise<StoredReelClip>>();

/**
 * The card on Bunny: cut it here (reelClip) and upload it, once. Null when
 * Storage is not configured (development), where the API serves the file.
 */
export async function reelClipOnBunny(
  recordingId: number, videoUrl: string, from: number, to: number, opts: { ahead?: boolean } & ClipRecipe = {},
): Promise<StoredReelClip | null> {
  if (!isBunnyStorageConfigured()) return null;
  const known = await storedReelClip(recordingId, videoUrl, from, to, opts);
  if (known) return known;
  const name = storedName(recordingId, videoUrl, from, to, opts);
  const remotePath = `${reelDir(recordingId)}/${name}`;
  const running = uploading.get(remotePath);
  if (running) {
    // a page now waits for a card queued ahead: its cut goes first
    if (!opts.ahead) void reelClip(videoUrl, from, to, { gop: opts.gop }).catch(() => {});
    return running;
  }
  const job = (async () => {
    const clip = await reelClip(videoUrl, from, to, opts);
    await uploadFileToBunnyStoragePath(clip.path, remotePath);
    (await storedNames(recordingId).catch(() => new Set<string>())).add(name);
    await fs.promises.rm(clip.path, { force: true });
    return { url: cdnUrl(remotePath), offset: clip.offset };
  })();
  uploading.set(remotePath, job);
  job.finally(() => uploading.delete(remotePath)).catch(() => {});
  return job;
}
