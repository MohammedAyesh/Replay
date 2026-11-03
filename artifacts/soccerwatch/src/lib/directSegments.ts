/**
 * Recorded video plays from Bunny's CDN, not through the app server.
 *
 * Every player still asks this server for the playlist, so the server checks
 * the viewer may see the video. A `direct=1` flag asks it to leave the segment
 * lines pointing at Bunny. The server grants it only on replayjo.com, the page
 * Bunny accepts as a Referer; on a preview host it quietly returns the fully
 * proxied playlist, so the flag is always safe to send.
 *
 * Players keep the plain proxied URL as their fallback when the direct one
 * fails (withoutDirectSegments).
 */

const OWNER_SHARE_MANIFEST = /^(?:.*\/)?(?:api\/)?w\/[^/?#]+\/manifest\.m3u8(?:\?|$)/;

/** True for a playlist URL this app's server can hand out with direct segments. */
export function canPlayDirect(url: string | null | undefined): boolean {
  if (!url) return false;
  return url.includes("/api/hls-proxy/manifest?") || OWNER_SHARE_MANIFEST.test(url);
}

/** The same playlist with segments straight from Bunny, or the URL unchanged. */
export function withDirectSegments(url: string): string;
export function withDirectSegments(url: string | null | undefined): string | null | undefined;
export function withDirectSegments(url: string | null | undefined): string | null | undefined {
  if (!url || !canPlayDirect(url) || /[?&]direct=1(?:&|$)/.test(url)) return url;
  return `${url}${url.includes("?") ? "&" : "?"}direct=1`;
}

/** The fully proxied playlist: the fallback for a direct one that failed. */
export function withoutDirectSegments(url: string): string {
  return url
    .replace(/([?&])direct=1&/, "$1")
    .replace(/[?&]direct=1$/, "");
}
