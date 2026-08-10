import fs from "fs";
import crypto from "crypto";
import { Readable } from "stream";

export const BUNNY_CDN_HOSTNAME = process.env.BUNNY_CDN_HOSTNAME ?? "";
export const BUNNY_API_KEY = process.env.BUNNY_API_KEY ?? "";
export const BUNNY_LIBRARY_ID = process.env.BUNNY_LIBRARY_ID ?? "";

// Strip full URL prefix if user accidentally set the full endpoint URL instead of just the zone name
const _rawStorageZone = process.env.BUNNY_STORAGE_ZONE ?? "";
export const BUNNY_STORAGE_ZONE = _rawStorageZone.replace(/^https?:\/\/[^/]+\//, "").replace(/\/$/, "");
export const BUNNY_STORAGE_API_KEY = process.env.BUNNY_STORAGE_API_KEY ?? "";
export const BUNNY_STORAGE_CDN_URL = process.env.BUNNY_STORAGE_CDN_URL ?? "";
export const BUNNY_STORAGE_HOSTNAME = process.env.BUNNY_STORAGE_HOSTNAME ?? "storage.bunnycdn.com";

export function getBunnyPlaybackUrl(videoId: string): string {
  return `https://${BUNNY_CDN_HOSTNAME}/${videoId}/playlist.m3u8`;
}

export function getBunnyThumbnailUrl(videoId: string, time?: number | null): string {
  const base = `https://${BUNNY_CDN_HOSTNAME}/${videoId}/thumbnail.jpg`;
  return time != null ? `${base}?time=${Math.floor(time)}` : base;
}

/**
 * Playback URL routed through the server-side HLS proxy.
 * Bunny CDN blocks direct browser requests (403) unless the Referer matches
 * the CDN hostname — a constraint the browser cannot satisfy on its own.
 * The HLS proxy (/api/hls-proxy/manifest) adds the correct Referer and
 * rewrites every segment URL so the entire stream stays proxied.
 * Use this for any URL that will be handed to a browser <video> element.
 * Use getBunnyPlaybackUrl() (raw CDN URL) only for server-side FFmpeg calls.
 */
export function getBunnyProxiedPlaybackUrl(videoId: string): string {
  return `/api/hls-proxy/manifest?url=${encodeURIComponent(getBunnyPlaybackUrl(videoId))}`;
}

/**
 * Thumbnail URL routed through the server-side HLS proxy (segment endpoint).
 * Same Referer issue as HLS manifests — the segment proxy handles any Bunny
 * CDN URL, not just video segments, so thumbnails work through it too.
 * Use this for any URL that will be used as an <img src> in the browser.
 */
export function getBunnyProxiedThumbnailUrl(videoId: string, time?: number | null): string {
  return `/api/hls-proxy/segment?url=${encodeURIComponent(getBunnyThumbnailUrl(videoId, time))}`;
}

export function isBunnyConfigured(): boolean {
  return !!BUNNY_CDN_HOSTNAME && !!BUNNY_API_KEY && !!BUNNY_LIBRARY_ID;
}

export function isBunnyStorageConfigured(): boolean {
  return !!BUNNY_STORAGE_ZONE && !!BUNNY_STORAGE_API_KEY && !!BUNNY_STORAGE_CDN_URL;
}

/**
 * Fetch video metadata from the Bunny Stream Management API.
 * Returns duration in seconds (from the `length` field).
 * This is reliable from server-to-server and doesn't depend on CDN access.
 */
export async function getBunnyVideoInfo(videoId: string): Promise<{
  duration: number;
  hasMP4Fallback: boolean;
  availableResolutions: string;
}> {
  const url = `https://video.bunnycdn.com/library/${BUNNY_LIBRARY_ID}/videos/${videoId}`;
  const response = await fetch(url, {
    headers: { AccessKey: BUNNY_API_KEY },
  });
  if (!response.ok) {
    throw new Error(`Bunny API error ${response.status} fetching video info for ${videoId}`);
  }
  const data = await response.json() as {
    length?: number;
    hasMP4Fallback?: boolean;
    availableResolutions?: string;
  };
  const duration = typeof data.length === "number" ? data.length : 0;
  if (!isFinite(duration) || duration <= 0) {
    throw new Error(`Could not determine duration for video ${videoId}: length=${data.length}`);
  }
  return {
    duration,
    hasMP4Fallback: data.hasMP4Fallback === true,
    availableResolutions: typeof data.availableResolutions === "string"
      ? data.availableResolutions
      : "",
  };
}

/**
 * Returns a direct MP4 URL for a specific resolution.
 * Bunny Stream transcodes to multiple MP4 resolutions; 1080p is the target.
 * Fallback: use 720p if available.
 */
export function getBunnyDirectMp4Url(videoId: string, height = 1080): string {
  return `https://${BUNNY_CDN_HOSTNAME}/${videoId}/play_${height}p.mp4`;
}

/**
 * Storage path for a rendered clip export.
 *
 * The path carries an unguessable suffix derived from the clip id, because the
 * export bucket is served by a public pull zone: a bare `clips/<id>.mp4` can be
 * enumerated by counting upwards, which hands out every user's rendered clip
 * regardless of the ownership check on the download route.
 *
 * The suffix is an HMAC of the clip id keyed on CLIP_EXPORT_URL_SECRET (falling
 * back to the storage API key, which is always present wherever exports run) so
 * it is deterministic — no extra column, and re-deriving the URL for an existing
 * clip still works — but not derivable by a client.
 */
function exportPathToken(clipId: number): string {
  const secret = process.env.CLIP_EXPORT_URL_SECRET || BUNNY_STORAGE_API_KEY;
  return crypto
    .createHmac("sha256", secret)
    .update(`clip-export:${clipId}`)
    .digest("hex")
    .slice(0, 24);
}

/** Storage-zone-relative path for a rendered clip export. */
export function getBunnyExportPath(clipId: number): string {
  return `clips/${clipId}-${exportPathToken(clipId)}.mp4`;
}

/** Returns the public CDN URL for a rendered clip export. */
export function getBunnyExportUrl(clipId: number): string {
  const base = BUNNY_STORAGE_CDN_URL.replace(/\/$/, "");
  return `${base}/${getBunnyExportPath(clipId)}`;
}

/**
 * Upload a rendered MP4 to Bunny Storage and return its public CDN URL.
 * Requires BUNNY_STORAGE_ZONE, BUNNY_STORAGE_API_KEY, BUNNY_STORAGE_CDN_URL.
 *
 * The file is streamed, never read into memory: a CRF-16 export of a long
 * selection runs to hundreds of megabytes, and buffering two of those at once
 * is enough to OOM the API process on the 6-vCPU VPS.
 */
export async function uploadToBunnyStorage(filePath: string, clipId: number): Promise<string> {
  const uploadUrl = `https://${BUNNY_STORAGE_HOSTNAME}/${BUNNY_STORAGE_ZONE}/${getBunnyExportPath(clipId)}`;
  const { size } = await fs.promises.stat(filePath);
  const fileStream = Readable.toWeb(fs.createReadStream(filePath)) as ReadableStream;

  const response = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      AccessKey: BUNNY_STORAGE_API_KEY,
      "Content-Type": "video/mp4",
      "Content-Length": String(size),
    },
    body: fileStream,
    // Required by undici whenever the request body is a stream.
    duplex: "half",
  } as RequestInit & { duplex: "half" });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Bunny Storage upload failed: ${response.status} ${response.statusText} — ${text}`,
    );
  }

  return getBunnyExportUrl(clipId);
}

/**
 * Delete a rendered clip export from Bunny Storage. Best-effort.
 *
 * Deletes the legacy `clips/<id>.mp4` path as well as the current
 * HMAC-suffixed one: clips exported before the suffix existed still live at the
 * old, enumerable location, and that is exactly the path worth removing.
 */
export async function deleteBunnyExport(clipId: number): Promise<void> {
  const paths = [getBunnyExportPath(clipId), `clips/${clipId}.mp4`];
  await Promise.allSettled(
    paths.map((p) =>
      fetch(`https://${BUNNY_STORAGE_HOSTNAME}/${BUNNY_STORAGE_ZONE}/${p}`, {
        method: "DELETE",
        headers: { AccessKey: BUNNY_STORAGE_API_KEY },
      }),
    ),
  );
}

/**
 * Upload a buffer to Bunny Storage at a given path and return its public CDN URL.
 */
export async function uploadBufferToBunnyStorage(
  buffer: Buffer,
  remotePath: string,
  contentType: string,
): Promise<string> {
  const uploadUrl = `https://${BUNNY_STORAGE_HOSTNAME}/${BUNNY_STORAGE_ZONE}/${remotePath}`;

  const response = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      AccessKey: BUNNY_STORAGE_API_KEY,
      "Content-Type": contentType,
    },
    body: buffer,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Bunny Storage upload failed: ${response.status} ${response.statusText} — ${text}`,
    );
  }

  const base = BUNNY_STORAGE_CDN_URL.replace(/\/$/, "");
  return `${base}/${remotePath}`;
}

/** Upload the single admin-selected clip intro video. */
export async function uploadClipIntroToBunnyStorage(
  buffer: Buffer,
  contentType: string,
): Promise<string> {
  const remotePath = "clip-intro/intro.mp4";
  const uploadUrl = `https://${BUNNY_STORAGE_HOSTNAME}/${BUNNY_STORAGE_ZONE}/${remotePath}`;
  const response = await fetch(uploadUrl, {
    method: "PUT",
    headers: { AccessKey: BUNNY_STORAGE_API_KEY, "Content-Type": contentType },
    body: buffer,
  });
  if (!response.ok) {
    throw new Error(`Bunny Storage upload failed: ${response.status}`);
  }
  return `${BUNNY_STORAGE_CDN_URL.replace(/\/$/, "")}/${remotePath}`;
}
