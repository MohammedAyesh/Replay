const BUNNY_HOST_RE = /^(?:[a-z0-9-]+\.b-cdn\.net|video\.bunnycdn\.com)$/i;

/**
 * Build a same-origin Bunny MP4 URL for the progressive
 * fallback. Keep HLS itself on the manifest proxy; this is only used after
 * the HLS source has had its retry.
 */
export function getBunnyMp4FallbackSource(manifestUrl: string): string | undefined {
  try {
    const manifest = new URL(manifestUrl);
    if (!BUNNY_HOST_RE.test(manifest.hostname)) return undefined;

    const parts = manifest.pathname.split("/").filter(Boolean);
    if (parts[0]?.toLowerCase() === "vod") return undefined;
    const videoId = parts.find((part) =>
      /^(?:[a-f0-9]{32}|[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})$/i.test(part),
    ) ?? parts[0];
    if (!videoId || !/^[a-z0-9-]{1,128}$/i.test(videoId)) return undefined;

    const mp4Url = new URL(`/${videoId}/play_720p.mp4`, manifest.origin);
    // The server checks access, then sends a replayjo.com page to the CDN
    // file and any other page to the range-relaying segment route.
    return `/api/hls-proxy/mp4?url=${encodeURIComponent(mp4Url.toString())}`;
  } catch {
    return undefined;
  }
}
