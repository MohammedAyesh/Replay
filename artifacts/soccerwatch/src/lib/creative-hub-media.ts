import type { MediaSource } from "@workspace/api-zod";
import { apiUrl } from "@/lib/academy-studio-api";

/**
 * Turns a scene media source into a URL the browser can load. Owned by the
 * Engine work (server: GET …/creative/media, routes/academyCreativeRender.ts).
 * CONTRACT (frozen):
 *   creativeMediaUrl(academyId, src, want): string | null
 *     want "still" → an image (a thumbnail for clips/recordings), "video" → playable video.
 *
 * The server checks the source belongs to the academy, then redirects to the
 * thumbnail / crest / upload, or serves a short MP4 of a clip or recording
 * window (no sound in previews; the export keeps the sound). A {{binding}}
 * must be resolved first (resolveSource with the scene's data): it gives null.
 */
export function creativeMediaUrl(academyId: number, src: MediaSource, want: "still" | "video"): string | null {
  if (src.type === "binding") return null;
  // Frames and pictures have no video; ask for the still whatever the slot is.
  const w = src.type === "clip" || src.type === "recording" || src.type === "upload" ? want : "still";
  const qs = new URLSearchParams({ src: JSON.stringify(src), want: w });
  return apiUrl(`/academy/console/academies/${academyId}/creative/media?${qs.toString()}`);
}
