const BUNNY_HOST_RE = /^(?:[a-z0-9-]+\.b-cdn\.net|video\.bunnycdn\.com)$/i;

/**
 * Build a same-origin, range-proxied Bunny MP4 URL for the progressive
 * fallback. Keep HLS itself on the manifest proxy; this is only used after
 * the HLS source has had its retry.
 */
export function getBunnyMp4FallbackSource(manifestUrl: string): string | undefined {
  try {
    const manifest = new URL(manifestUrl);
    if (!BUNNY_HOST_RE.test(manifest.hostname)) return undefined;

    const videoId = manifest.pathname.split("/").filter(Boolean)[0];
    if (!videoId || !/^[a-z0-9-]{1,128}$/i.test(videoId)) return undefined;

    const mp4Url = new URL(`/${videoId}/play_720p.mp4`, manifest.origin);
    return `/api/hls-proxy/segment?url=${encodeURIComponent(mp4Url.toString())}`;
  } catch {
    return undefined;
  }
}
