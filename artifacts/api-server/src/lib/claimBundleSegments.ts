import type { TrackingSegmentPayload } from "@workspace/db";

/**
 * Cached tracking data is shared across requests, so callers must treat every
 * nested value as immutable. This is a type-level guard; freezing every object
 * in a large tracking bundle would add substantial startup work.
 */
export type DeepReadonly<T> =
  T extends (...args: never[]) => unknown ? T
    : T extends readonly (infer Item)[] ? readonly DeepReadonly<Item>[]
      : T extends object ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
        : T;

export type CachedTrackingSegment = DeepReadonly<TrackingSegmentPayload>;
export type CachedTrack = CachedTrackingSegment["tracks"][number];

export type ClaimBundleSegments = {
  readonly segments: readonly CachedTrackingSegment[];
  readonly tracksById: ReadonlyMap<string, CachedTrack>;
};

const MAX_CACHED_BUNDLES = 2;
const cache = new Map<string, ClaimBundleSegments>();
const inFlight = new Map<string, Promise<ClaimBundleSegments>>();

/**
 * Return parsed segments and their track index for a bundle version.
 *
 * The caller supplies a key that changes when the bundle is replaced. Cache
 * hits are promoted to most-recently-used; concurrent misses share one read.
 */
export function loadClaimBundleSegments(
  key: string,
  load: () => Promise<TrackingSegmentPayload[]>,
): Promise<ClaimBundleSegments> {
  const cached = cache.get(key);
  if (cached) {
    cache.delete(key);
    cache.set(key, cached);
    return Promise.resolve(cached);
  }

  const pending = inFlight.get(key);
  if (pending) return pending;

  let request: Promise<ClaimBundleSegments>;
  request = Promise.resolve()
    .then(load)
    .then((segments) => {
      const readonlySegments = segments as unknown as readonly CachedTrackingSegment[];
      const tracksById = new Map<string, CachedTrack>();
      for (const segment of readonlySegments) {
        for (const track of segment.tracks) tracksById.set(track.id, track);
      }

      const value: ClaimBundleSegments = { segments: readonlySegments, tracksById };
      cache.set(key, value);
      while (cache.size > MAX_CACHED_BUNDLES) {
        const leastRecentlyUsed = cache.keys().next().value;
        if (leastRecentlyUsed === undefined) break;
        cache.delete(leastRecentlyUsed);
      }
      return value;
    })
    .finally(() => {
      if (inFlight.get(key) === request) inFlight.delete(key);
    });
  inFlight.set(key, request);
  return request;
}