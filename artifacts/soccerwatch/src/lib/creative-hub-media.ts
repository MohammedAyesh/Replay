import { useQuery } from "@tanstack/react-query";
import type { CreativeFormat, CreativeStyle, MediaSource, PlateAspect, ResolvedTint } from "@workspace/api-zod";
import { apiUrl, call } from "@/lib/academy-studio-api";

/**
 * Turns a scene media source into a URL the browser can load. Owned by the
 * Engine work (server: GET …/creative/media, routes/academyCreativeRender.ts).
 * CONTRACT (frozen; `variant` is an additive optional argument):
 *   creativeMediaUrl(academyId, src, want, variant?): string | null
 *     want "still" → an image (a thumbnail for clips/recordings), "video" → playable video.
 *     variant.format → which file a background plate uses (post / story)
 *     variant.tint   → the still recoloured on the server exactly as the export recolours it
 *
 * The server checks the source belongs to the academy, then redirects to the
 * thumbnail / crest / upload, or serves a short MP4 of a clip or recording
 * window (no sound in previews; the export keeps the sound). A {{binding}}
 * must be resolved first (resolveSource with the scene's data): it gives null.
 */
export function creativeMediaUrl(academyId: number, src: MediaSource, want: "still" | "video", variant?: MediaVariant): string | null {
  if (src.type === "binding") return null;
  // Frames and pictures have no video; ask for the still whatever the slot is.
  const w = src.type === "clip" || src.type === "recording" || src.type === "upload" ? want : "still";
  const qs = new URLSearchParams({ src: JSON.stringify(src), want: w });
  const url = apiUrl(`/academy/console/academies/${academyId}/creative/media?${qs.toString()}`);
  return variant ? withMediaVariant(url, variant) : url;
}

export type CreativePlaybackSource = { kind: "camera-4k" | "stream"; url: string };

/** The source list is authorized by the same owner-scoped media route. */
export function creativePlaybackSourcesUrl(
  academyId: number,
  src: Extract<MediaSource, { type: "recording" }>,
): string | null {
  const url = creativeMediaUrl(academyId, src, "video");
  if (!url) return null;
  const at = url.indexOf("?");
  if (at < 0) return `${url}?sources=1`;
  const qs = new URLSearchParams(url.slice(at + 1));
  qs.set("sources", "1");
  return `${url.slice(0, at)}?${qs.toString()}`;
}

/**
 * format: the scene format (a plate's post / story file).
 * tint: recolour the still on the server.
 * size: the longest side the browser needs, in pixels (tinted stills only; bucketed so caches hit).
 */
export type MediaVariant = { format?: CreativeFormat; tint?: ResolvedTint | null; size?: number };

const SIZE_BUCKETS = [384, 768, 1280, 1920];
export const sizeBucket = (px: number) => SIZE_BUCKETS.find((b) => b >= px) ?? SIZE_BUCKETS[SIZE_BUCKETS.length - 1]!;

/**
 * Adds format / tint to a …/creative/media URL (any other URL comes back as
 * it is). A tint only applies to stills. SceneCanvas uses this on whatever its
 * mediaUrl prop returns, so every caller previews plates and tints the same way.
 */
export function withMediaVariant(url: string | null, variant: MediaVariant): string | null {
  if (!url) return url;
  const at = url.indexOf("?");
  if (at < 0 || !url.slice(0, at).endsWith("/creative/media")) return url;
  const qs = new URLSearchParams(url.slice(at + 1));
  if (variant.format) qs.set("format", variant.format);
  const tint = variant.tint;
  if (tint && qs.get("want") !== "video") {
    qs.set("tint", tint.color.replace(/^#/, ""));
    if (tint.mode !== "color") qs.set("tintMode", tint.mode);
    if (tint.amount < 1) qs.set("tintAmount", String(Math.round(tint.amount * 100) / 100));
    if (variant.size) qs.set("size", String(sizeBucket(variant.size)));
  }
  return `${url.slice(0, at)}?${qs.toString()}`;
}

export type BackgroundPlate = { key: string; n: number; aspects: PlateAspect[] };

/** GET …/creative/artwork/backgrounds?style= → the background plates shipped for a style (often none). */
export function useCreativeBackgrounds(academyId: number, style: CreativeStyle | null) {
  return useQuery({
    queryKey: ["creative", academyId, "backgrounds", style ?? ""],
    enabled: !!style,
    staleTime: 10 * 60_000,
    queryFn: () =>
      call<{ style: CreativeStyle; plates: BackgroundPlate[] }>(`/academy/console/academies/${academyId}/creative/artwork/backgrounds?style=${style}`)
        .then((r) => r.plates),
  });
}
