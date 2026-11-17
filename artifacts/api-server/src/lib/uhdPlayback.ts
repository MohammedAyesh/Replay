import { storagePullZoneBase } from "./bunny";

const VIDEO_GUID = /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const HIT_TTL_MS = 5 * 60_000;
const MISS_TTL_MS = 30_000;
const MAX_CACHE_SIZE = 512;
const WINDOW_CACHE_TTL_MS = 5 * 60_000;
const MAX_WINDOW_CACHE_SIZE = 256;
export const UHD_PLAYBACK_MAX_WINDOW_MS = 180_000;
export const UHD_PLAYBACK_PADDING_MS = 5_000;
export const STORAGE_RENDITIONS = ["8k", "4k", "h264"] as const;
export type StorageRendition = typeof STORAGE_RENDITIONS[number];

type CacheEntry = { playlist: string | null; expiresAt: number };
const playlistCache = new Map<string, CacheEntry>();
type WindowEntry = { playlist: string; startMs: number; endMs: number; expiresAt: number };
const windowCache = new Map<string, WindowEntry>();
const playlistRequests = new Map<string, Promise<string | null>>();

export type UhdPlaylistWindow = {
  playlist: string;
  startMs: number;
  endMs: number;
};

export class UhdPlaylistRequestError extends Error {
  constructor(readonly status: number, readonly rendition: StorageRendition = "4k") {
    super(`${rendition.toUpperCase()} playlist request returned HTTP ${status}`);
    this.name = "UhdPlaylistRequestError";
  }
}

export function normalizeUhdVideoGuid(value: string | null | undefined): string | null {
  const guid = value?.trim() ?? "";
  if (!VIDEO_GUID.test(guid)) return null;
  const compact = guid.replace(/-/g, "").toLowerCase();
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
}

export function uhdPlaybackUrl(videoGuid: string | null | undefined): string | null {
  const guid = normalizeUhdVideoGuid(videoGuid);
  return guid ? `/api/hls-proxy/uhd/${encodeURIComponent(guid)}.m3u8` : null;
}

export function storagePlaybackUrl(
  videoGuid: string | null | undefined,
  rendition: StorageRendition,
): string | null {
  const guid = normalizeUhdVideoGuid(videoGuid);
  if (!guid) return null;
  if (rendition === "4k") return uhdPlaybackUrl(guid);
  return `/api/hls-proxy/storage/${encodeURIComponent(guid)}/${rendition}.m3u8`;
}

export function storagePlaybackProxyUrl(
  videoGuid: string | null | undefined,
  rendition: StorageRendition,
): string | null {
  const guid = normalizeUhdVideoGuid(videoGuid);
  if (!guid) return null;
  if (rendition === "4k") return uhdPlaybackUrl(guid);
  return `/api/hls-proxy/storage/${encodeURIComponent(guid)}/${rendition}.m3u8`;
}

export function storageThumbnailProxyUrl(videoGuid: string | null | undefined): string | null {
  const guid = normalizeUhdVideoGuid(videoGuid);
  return guid ? `/api/hls-proxy/storage/${encodeURIComponent(guid)}/thumb.jpg` : null;
}

export function uhdPlaybackWindowUrl(
  videoGuid: string | null | undefined,
  fromMs: number,
  toMs: number,
): string | null {
  const url = uhdPlaybackUrl(videoGuid);
  if (!url || !isValidUhdWindow(fromMs, toMs)) return null;
  const query = new URLSearchParams({ fromMs: String(fromMs), toMs: String(toMs) });
  return `${url}?${query.toString()}`;
}

export function isValidUhdWindow(fromMs: number, toMs: number): boolean {
  return Number.isSafeInteger(fromMs)
    && Number.isSafeInteger(toMs)
    && fromMs >= 0
    && toMs > fromMs
    && toMs - fromMs <= UHD_PLAYBACK_MAX_WINDOW_MS;
}

function cachedPlaylist(guid: string): string | null | undefined {
  const entry = playlistCache.get(guid);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    playlistCache.delete(guid);
    return undefined;
  }
  playlistCache.delete(guid);
  playlistCache.set(guid, entry);
  return entry.playlist;
}

function rememberPlaylist(guid: string, playlist: string | null, ttl: number): void {
  playlistCache.delete(guid);
  playlistCache.set(guid, { playlist, expiresAt: Date.now() + ttl });
  while (playlistCache.size > MAX_CACHE_SIZE) {
    const oldest = playlistCache.keys().next().value;
    if (oldest === undefined) break;
    playlistCache.delete(oldest);
  }
}

function cachedWindow(key: string): UhdPlaylistWindow | null | undefined {
  const entry = windowCache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    windowCache.delete(key);
    return undefined;
  }
  windowCache.delete(key);
  windowCache.set(key, entry);
  return { playlist: entry.playlist, startMs: entry.startMs, endMs: entry.endMs };
}

function rememberWindow(key: string, window: UhdPlaylistWindow): void {
  windowCache.delete(key);
  windowCache.set(key, { ...window, expiresAt: Date.now() + WINDOW_CACHE_TTL_MS });
  while (windowCache.size > MAX_WINDOW_CACHE_SIZE) {
    const oldest = windowCache.keys().next().value;
    if (oldest === undefined) break;
    windowCache.delete(oldest);
  }
}

type PlaylistSegment = { startMs: number; endMs: number; lines: string[]; uri: string };

function splitUhdPlaylist(playlist: string): { header: string[]; segments: PlaylistSegment[]; mediaSequence: number } | null {
  const lines = playlist.replace(/\r/g, "").split("\n");
  const header: string[] = [];
  const segments: PlaylistSegment[] = [];
  const implicitRangeEnds = new Map<string, number>();
  let pending: string[] = [];
  let active: string[] | null = null;
  let durationMs = 0;
  let startMs = 0;
  let mediaSequence = 0;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("#EXTINF:")) {
      const match = line.match(/^#EXTINF:([\d.]+)/);
      if (!match) return null;
      durationMs = Number(match[1]) * 1000;
      if (!Number.isFinite(durationMs) || durationMs <= 0) return null;
      active = [...pending, line];
      pending = [];
      continue;
    }

    if (active) {
      active.push(line);
      if (line.startsWith("#")) continue;

      const uri = line;
      const rangeIndex = active.findIndex((entry) => entry.startsWith("#EXT-X-BYTERANGE:"));
      if (rangeIndex >= 0) {
        const range = active[rangeIndex]!.match(/^#EXT-X-BYTERANGE:(\d+)(?:@(\d+))?$/);
        if (!range) return null;
        const length = Number(range[1]);
        const offset = range[2] === undefined ? (implicitRangeEnds.get(uri) ?? 0) : Number(range[2]);
        if (!Number.isSafeInteger(length) || length <= 0 || !Number.isSafeInteger(offset) || offset < 0) return null;
        implicitRangeEnds.set(uri, offset + length);
        active[rangeIndex] = `#EXT-X-BYTERANGE:${length}@${offset}`;
      }

      segments.push({ startMs, endMs: startMs + durationMs, lines: active, uri });
      startMs += durationMs;
      active = null;
      continue;
    }

    if (segments.length === 0) {
      if (/^#EXT-X-MEDIA-SEQUENCE:(\d+)/i.test(line)) {
        mediaSequence = Number(line.match(/^#EXT-X-MEDIA-SEQUENCE:(\d+)/i)?.[1] ?? 0);
      }
      // These describe the first media segment, not the whole playlist.
      if (/^#EXT-X-(?:PROGRAM-DATE-TIME|DISCONTINUITY|GAP)(?::|$)/i.test(line)) {
        pending.push(line);
      } else {
        header.push(line);
      }
    } else if (line !== "#EXT-X-ENDLIST") {
      pending.push(line);
    }
  }

  if (active || !segments.length) return null;
  return { header, segments, mediaSequence };
}

export function windowUhdPlaylist(
  playlist: string,
  fromMs: number,
  toMs: number,
  paddingMs = UHD_PLAYBACK_PADDING_MS,
): UhdPlaylistWindow | null {
  if (!isValidUhdWindow(fromMs, toMs) || !Number.isSafeInteger(paddingMs) || paddingMs < 0) return null;
  const parsed = splitUhdPlaylist(playlist);
  if (!parsed) return null;
  const firstTime = Math.max(0, fromMs - paddingMs);
  const lastTime = Math.min(parsed.segments.at(-1)!.endMs, toMs + paddingMs);
  if (lastTime <= firstTime) return null;

  const firstIndex = parsed.segments.findIndex((segment) => segment.endMs > firstTime);
  if (firstIndex < 0) return null;
  let lastIndex = firstIndex;
  while (lastIndex + 1 < parsed.segments.length && parsed.segments[lastIndex]!.startMs < lastTime) {
    lastIndex += 1;
  }

  const header = parsed.header.filter((line) =>
    !/^#EXT-X-(?:MEDIA-SEQUENCE|START):/i.test(line));
  const sequenceIndex = parsed.header.findIndex((line) => /^#EXT-X-MEDIA-SEQUENCE:/i.test(line));
  if (sequenceIndex >= 0) {
    header.splice(Math.min(sequenceIndex, header.length), 0, `#EXT-X-MEDIA-SEQUENCE:${parsed.mediaSequence + firstIndex}`);
  }

  const selected = parsed.segments.slice(firstIndex, lastIndex + 1);
  const output = [...header, ...selected.flatMap((segment) => segment.lines), "#EXT-X-ENDLIST", ""].join("\n");
  return {
    playlist: output,
    startMs: Math.round(parsed.segments[firstIndex]!.startMs),
    endMs: Math.round(parsed.segments[lastIndex]!.endMs),
  };
}

export async function getUhdPlaylistWindow(
  videoGuid: string,
  fromMs: number,
  toMs: number,
): Promise<UhdPlaylistWindow | null> {
  const guid = normalizeUhdVideoGuid(videoGuid);
  if (!guid || !isValidUhdWindow(fromMs, toMs)) return null;
  const key = `${guid}:4k:${fromMs}:${toMs}`;
  const cached = cachedWindow(key);
  if (cached !== undefined) return cached;
  const source = await getStoragePlaylist(guid, "4k");
  if (!source) return null;
  const window = windowUhdPlaylist(source, fromMs, toMs);
  if (window) rememberWindow(key, window);
  return window;
}

export async function getStoragePlaylistWindow(
  videoGuid: string,
  rendition: StorageRendition,
  fromMs: number,
  toMs: number,
): Promise<UhdPlaylistWindow | null> {
  const guid = normalizeUhdVideoGuid(videoGuid);
  if (!guid || !isValidUhdWindow(fromMs, toMs)) return null;
  const key = `${guid}:${rendition}:${fromMs}:${toMs}`;
  const cached = cachedWindow(key);
  if (cached !== undefined) return cached;
  const source = await getStoragePlaylist(guid, rendition);
  if (!source) return null;
  const window = windowUhdPlaylist(source, fromMs, toMs);
  if (window) rememberWindow(key, window);
  return window;
}

export function uhdMediaUrl(videoGuid: string): string {
  return storageRenditionMediaUrl(videoGuid, "4k");
}

export function uhdPlaylistUrl(videoGuid: string): string {
  return storageRenditionPlaylistUrl(videoGuid, "4k");
}

export function storageRenditionMediaUrl(videoGuid: string, rendition: StorageRendition): string {
  const guid = normalizeUhdVideoGuid(videoGuid);
  if (!guid) throw new Error("Invalid Bunny video guid");
  return `${storagePullZoneBase()}/vod/${guid}/${rendition}.mp4`;
}

export function storageRenditionPlaylistUrl(videoGuid: string, rendition: StorageRendition): string {
  const guid = normalizeUhdVideoGuid(videoGuid);
  if (!guid) throw new Error("Invalid Bunny video guid");
  return `${storagePullZoneBase()}/vod/${guid}/${rendition}.m3u8`;
}

export function isStreamlessStorageVideoUrl(value: string | null | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return /\/vod\/(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/(?:8k|4k|h264)\.m3u8$/i
      .test(url.pathname);
  } catch {
    return false;
  }
}

export function rewriteUhdPlaylist(
  playlist: string,
  videoGuid: string,
  mediaUrl = uhdMediaUrl(videoGuid),
): string {
  return rewriteStoragePlaylist(playlist, "4k", mediaUrl);
}

export function rewriteStoragePlaylist(
  playlist: string,
  rendition: StorageRendition,
  mediaUrl: string,
): string {
  const fileReference = new RegExp(`(?:[^"'\\\\s]*\\/)?${rendition}\\.mp4(?:\\?[^"'\\\\s]*)?`, "i");
  return playlist
    .replace(/URI=(["'])([^"']+)\1/gi, (match, quote: string, uri: string) =>
      fileReference.test(uri) ? `URI=${quote}${mediaUrl}${quote}` : match)
    .replace(/^([ \t]*)(\S+)([ \t]*)$/gm, (match, leading: string, uri: string, trailing: string) =>
      !uri.startsWith("#") && fileReference.test(uri) ? `${leading}${mediaUrl}${trailing}` : match);
}

/**
 * Fetches and caches the public Storage pull-zone playlist. A 404/410 is
 * cached briefly because vps1 may not have uploaded the original yet.
 */
export async function getUhdPlaylist(videoGuid: string): Promise<string | null> {
  return getStoragePlaylist(videoGuid, "4k");
}

export async function getStoragePlaylist(
  videoGuid: string,
  rendition: StorageRendition,
): Promise<string | null> {
  const guid = normalizeUhdVideoGuid(videoGuid);
  if (!guid) return null;
  const key = `${guid}:${rendition}`;

  const cached = cachedPlaylist(key);
  if (cached !== undefined) return cached;

  const existingRequest = playlistRequests.get(key);
  if (existingRequest) return existingRequest;

  const request = fetchAndCacheStoragePlaylist(guid, rendition, key);
  playlistRequests.set(key, request);
  try {
    return await request;
  } finally {
    if (playlistRequests.get(key) === request) playlistRequests.delete(key);
  }
}

async function fetchAndCacheStoragePlaylist(
  guid: string,
  rendition: StorageRendition,
  cacheKey: string,
): Promise<string | null> {
  const url = storageRenditionPlaylistUrl(guid, rendition);
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (response.status === 404 || response.status === 410) {
    try { await response.body?.cancel(); } catch { /* closed upstream */ }
    rememberPlaylist(cacheKey, null, MISS_TTL_MS);
    return null;
  }
  if (!response.ok) {
    try { await response.body?.cancel(); } catch { /* closed upstream */ }
    throw new UhdPlaylistRequestError(response.status, rendition);
  }

  const playlist = await response.text();
  if (!playlist.trimStart().startsWith("#EXTM3U")) {
    throw new Error(`Storage pull zone returned an invalid ${rendition.toUpperCase()} HLS playlist`);
  }
  rememberPlaylist(cacheKey, playlist, HIT_TTL_MS);
  return playlist;
}

export async function hasUhdPlaylist(videoGuid: string): Promise<boolean> {
  try {
    return Boolean(await getUhdPlaylist(videoGuid));
  } catch {
    return false;
  }
}

export async function hasStoragePlaylist(
  videoGuid: string,
  rendition: StorageRendition,
): Promise<boolean> {
  try {
    return Boolean(await getStoragePlaylist(videoGuid, rendition));
  } catch {
    return false;
  }
}
