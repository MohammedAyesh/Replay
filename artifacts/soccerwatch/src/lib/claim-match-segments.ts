import type { TrackingManifest, TrackingSegment } from "@workspace/api-client-react";

export function segmentIndexAtTime(manifest: TrackingManifest, seconds: number): number {
  const match = manifest.segments.find((segment) =>
    seconds >= segment.startSeconds && seconds <= segment.endSeconds,
  );
  if (match) return match.index;
  return seconds < (manifest.segments[0]?.startSeconds ?? 0)
    ? (manifest.segments[0]?.index ?? 0)
    : (manifest.segments.at(-1)?.index ?? 0);
}

export function retainNearbySegments(
  cache: Record<number, TrackingSegment>,
  currentIndex: number,
  radius = 1,
): Record<number, TrackingSegment> {
  return Object.fromEntries(
    Object.entries(cache).filter(([key]) => Math.abs(Number(key) - currentIndex) <= radius),
  );
}

export function crossedSegmentBoundary(
  previousIndex: number | null,
  currentIndex: number,
): boolean {
  return previousIndex !== null && previousIndex !== currentIndex;
}