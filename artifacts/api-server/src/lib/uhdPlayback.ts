import { storagePullZoneBase } from "./bunny";

const VIDEO_GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HIT_TTL_MS = 10 * 60_000;
const MISS_TTL_MS = 2 * 60_000;
const MAX_CACHE_SIZE = 512;

type CacheEntry = { playlist: string | null; expiresAt: number };
const playlistCache = new Map<string, CacheEntry>();

export function normalizeUhdVideoGuid(value: string | null | undefined): string | null {
  const guid = value?.trim() ?? "";
  return VIDEO_GUID.test(guid) ? guid.toLowerCase() : null;
}

export function uhdPlaybackUrl(videoGuid: string | null | undefined): string | null {
  const guid = normalizeUhdVideoGuid(videoGuid);
  return guid ? `/api/hls-proxy/uhd/${encodeURIComponent(guid)}.m3u8` : null;
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

export function uhdMediaUrl(videoGuid: string): string {
  const guid = normalizeUhdVideoGuid(videoGuid);
  if (!guid) throw new Error("Invalid Bunny video guid");
  return `${storagePullZoneBase()}/vod/${guid}/4k.mp4`;
}

export function rewriteUhdPlaylist(
  playlist: string,
  videoGuid: string,
  mediaUrl = uhdMediaUrl(videoGuid),
): string {
  return playlist
    .replace(/URI=(["'])\.?\/?4k\.mp4\1/gi, (_match, quote: string) => `URI=${quote}${mediaUrl}${quote}`)
    .replace(/^([ \t]*)\.?\/?4k\.mp4([ \t]*)$/gim, (_match, leading: string, trailing: string) =>
      `${leading}${mediaUrl}${trailing}`);
}

/**
 * Fetches and caches the public Storage pull-zone playlist. A 404/410 is
 * cached briefly because vps1 may not have uploaded the original yet.
 */
export async function getUhdPlaylist(videoGuid: string): Promise<string | null> {
  const guid = normalizeUhdVideoGuid(videoGuid);
  if (!guid) return null;

  const cached = cachedPlaylist(guid);
  if (cached !== undefined) return cached;

  const url = `${storagePullZoneBase()}/vod/${guid}/4k.m3u8`;
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (response.status === 404 || response.status === 410) {
    try { await response.body?.cancel(); } catch { /* closed upstream */ }
    rememberPlaylist(guid, null, MISS_TTL_MS);
    return null;
  }
  if (!response.ok) {
    try { await response.body?.cancel(); } catch { /* closed upstream */ }
    throw new Error(`4K playlist request returned HTTP ${response.status}`);
  }

  const playlist = await response.text();
  if (!playlist.trimStart().startsWith("#EXTM3U")) {
    throw new Error("Storage pull zone returned an invalid 4K HLS playlist");
  }
  rememberPlaylist(guid, playlist, HIT_TTL_MS);
  return playlist;
}

export async function hasUhdPlaylist(videoGuid: string): Promise<boolean> {
  try {
    return Boolean(await getUhdPlaylist(videoGuid));
  } catch {
    return false;
  }
}
