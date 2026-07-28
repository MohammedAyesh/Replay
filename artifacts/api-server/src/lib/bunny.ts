import fs from "fs";

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
export async function getBunnyVideoInfo(videoId: string): Promise<{ duration: number }> {
  const url = `https://video.bunnycdn.com/library/${BUNNY_LIBRARY_ID}/videos/${videoId}`;
  const response = await fetch(url, {
    headers: { AccessKey: BUNNY_API_KEY },
  });
  if (!response.ok) {
    throw new Error(`Bunny API error ${response.status} fetching video info for ${videoId}`);
  }
  const data = await response.json() as { length?: number };
  const duration = typeof data.length === "number" ? data.length : 0;
  if (!isFinite(duration) || duration <= 0) {
    throw new Error(`Could not determine duration for video ${videoId}: length=${data.length}`);
  }
  return { duration };
}

/**
 * Returns a direct MP4 URL for a specific resolution.
 * Bunny Stream transcodes to multiple MP4 resolutions; 1080p is the target.
 * Fallback: use 720p if available.
 */
export function getBunnyDirectMp4Url(videoId: string, height = 1080): string {
  return `https://${BUNNY_CDN_HOSTNAME}/${videoId}/play_${height}p.mp4`;
}

/** Returns the public CDN URL for a rendered clip export. */
export function getBunnyExportUrl(clipId: number): string {
  const base = BUNNY_STORAGE_CDN_URL.replace(/\/$/, "");
  return `${base}/clips/${clipId}.mp4`;
}

/**
 * Upload a rendered MP4 to Bunny Storage and return its public CDN URL.
 * Requires BUNNY_STORAGE_ZONE, BUNNY_STORAGE_API_KEY, BUNNY_STORAGE_CDN_URL.
 */
export async function uploadToBunnyStorage(filePath: string, clipId: number): Promise<string> {
  const uploadUrl = `https://${BUNNY_STORAGE_HOSTNAME}/${BUNNY_STORAGE_ZONE}/clips/${clipId}.mp4`;
  const fileBuffer = await fs.promises.readFile(filePath);

  const response = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      AccessKey: BUNNY_STORAGE_API_KEY,
      "Content-Type": "video/mp4",
    },
    body: fileBuffer,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Bunny Storage upload failed: ${response.status} ${response.statusText} — ${text}`,
    );
  }

  return getBunnyExportUrl(clipId);
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
