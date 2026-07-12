import fs from "fs";

export const BUNNY_CDN_HOSTNAME = process.env.BUNNY_CDN_HOSTNAME ?? "";
export const BUNNY_API_KEY = process.env.BUNNY_API_KEY ?? "";
export const BUNNY_LIBRARY_ID = process.env.BUNNY_LIBRARY_ID ?? "";

export const BUNNY_STORAGE_ZONE = process.env.BUNNY_STORAGE_ZONE ?? "";
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
