import type { TrackingManifest, TrackingSegment } from "@workspace/api-client-react";

export function segmentIndexAtTime(manifest: TrackingManifest, seconds: number): number {
  const ordered = [...manifest.segments].sort((a, b) => a.startSeconds - b.startSeconds);
  const match = ordered.find((segment, position) =>
    seconds >= segment.startSeconds
      && (seconds < segment.endSeconds || position === ordered.length - 1),
  );
  if (match) return match.index;
  // A small clock seam can exist between compressed segment files. Assign it
  // to the segment that starts next, rather than falling through to the final
  // segment and jumping the player to the wrong end of the match.
  const next = ordered.find((segment) => seconds < segment.startSeconds);
  return next?.index ?? (ordered.at(-1)?.index ?? 0);
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