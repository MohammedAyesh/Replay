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
 *     the segments that cover the card, fetches them from Bunny (server to
 *     CDN, fast) and remuxes them, no re-encode, into a faststart MP4 of the
 *     video track only (~3-5 MB on the 2560x720 rung);
 *   - the phone downloads that one file into memory ahead of time and plays it
 *     from there, so the next card is already on the phone when it comes up;
 *   - files are kept on disk and shared by everyone in the match.
 *
 * A segment starts on a keyframe, so the file starts at the first covering
 * segment's start and nothing is re-encoded; the route tells the page that
 * offset (video seconds) so it can seek to the card's own start.
 */
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseMasterPlaylist } from "./exportSource";
import { logger } from "./logger";

/** the lightest rung worth showing: below this a far-side player is a smudge, px (as the deck) */
const MIN_HEIGHT = 600;
const PLAYLIST_TTL_MS = 30 * 60_000;
const CACHE_DIR = path.join(os.tmpdir(), "goal-reel-clips");
const CACHE_MAX_BYTES = 600 * 1024 * 1024;
const MAX_PARALLEL_CUTS = 3;
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
const waiting: Array<() => void> = [];
async function slot<T>(work: () => Promise<T>): Promise<T> {
  if (running >= MAX_PARALLEL_CUTS) await new Promise<void>((r) => waiting.push(r));
  running++;
  try { return await work(); } finally { running--; waiting.shift()?.(); }
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
export function reelClip(videoUrl: string, from: number, to: number): Promise<ReelClip> {
  const id = createHash("sha1").update(`${videoUrl}|${from.toFixed(1)}|${to.toFixed(1)}`).digest("hex").slice(0, 20);
  const existing = inFlight.get(id);
  if (existing) return existing;
  const job = (async (): Promise<ReelClip> => {
    const playlist = await mediaPlaylistFor(videoUrl);
    const { segments, offset } = segmentsFor(playlist, from, to);
    if (!segments.length) throw new Error("no footage at that time");
    const out = path.join(CACHE_DIR, `${id}_${offset.toFixed(3)}.mp4`);
    await fs.promises.mkdir(CACHE_DIR, { recursive: true });
    try {
      const now = new Date();
      await fs.promises.utimes(out, now, now);
      return { path: out, offset };
    } catch { /* not cached yet */ }
    return slot(async () => {
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
          "-i", joined,
          // only as far as the card needs; the front starts on the segment's keyframe
          "-t", String(Math.max(1, to - offset)),
          "-map", "0:v:0", "-an",
          "-c", "copy",
          "-avoid_negative_ts", "make_zero",
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
    });
  })();
  inFlight.set(id, job);
  job.finally(() => inFlight.delete(id)).catch(() => {});
  return job;
}
