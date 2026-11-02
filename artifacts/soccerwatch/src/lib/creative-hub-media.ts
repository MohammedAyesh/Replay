import type { MediaSource } from "@workspace/api-zod";

/**
 * Turns a scene media source into a URL the browser can load. Owned by the
 * Engine work (server: …/creative/media/*). CONTRACT (frozen):
 *   creativeMediaUrl(academyId, src, want): string | null
 *     want "still" → an image (a thumbnail for clips/recordings), "video" → playable video.
 */
export function creativeMediaUrl(_academyId: number, _src: MediaSource, _want: "still" | "video"): string | null {
  return null;
}
