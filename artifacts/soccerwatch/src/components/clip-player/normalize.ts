import type { CropKeyframe } from "@/lib/cropFrame";

/**
 * Convert recorded keyframe times from seconds since clip start to the
 * normalized 0..1 timeline used by the API and FFmpeg exporter.
 */
export function normalizeClipKeyframes(
  keyframes: CropKeyframe[],
  clipDuration: number,
): CropKeyframe[] {
  const duration = Math.max(0.1, clipDuration);
  if (keyframes.length === 0) return keyframes;
  return keyframes.map((keyframe) => ({
    ...keyframe,
    t: Math.max(0, Math.min(1, keyframe.t / duration)),
  }));
}