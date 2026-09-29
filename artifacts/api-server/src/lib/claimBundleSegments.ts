import type { TrackingSegmentPayload } from "@workspace/db";
import { logger } from "./logger";

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
type CacheEntry = {
  promise: Promise<ClaimBundleSegments>;
  settled: boolean;
};

// Limit completed parsed bundles without making one storage read wait on
// another. Multiple pending reads may temporarily put the map over this size.
const cache = new Map<string, CacheEntry>();

function promote(key: string, entry: CacheEntry): void {
  cache.delete(key);
  cache.set(key, entry);
}

function settledEntryCount(): number {
  let count = 0;
  for (const entry of cache.values()) if (entry.settled) count++;
  return count;
}

function evictLeastRecentlyUsedSettled(): boolean {
  for (const [key, entry] of cache) {
    if (entry.settled) {
      cache.delete(key);
      return true;
    }
  }
  return false;
}

function trimSettledEntries(): void {
  while (settledEntryCount() > MAX_CACHED_BUNDLES) {
    if (!evictLeastRecentlyUsedSettled()) return;
  }
}

function loadMetrics(bundleId: string | number, startedAt: number) {
  return {
    bundleId,
    loadDurationMs: Math.max(0, Date.now() - startedAt),
    heapUsedMB: Math.round((process.memoryUsage().heapUsed / (1024 * 1024)) * 100) / 100,
  };
}

/**
 * Return parsed segments and their track index for a bundle version.
 *
 * The caller supplies a key that changes when the bundle is replaced. Cache
 * hits are promoted to most-recently-used; concurrent misses share one read.
 * At most two completed bundles are retained. Pending reads are shared by key
 * but do not block other misses; their count may temporarily exceed the limit.
 */
export function loadClaimBundleSegments(
  key: string,
  load: () => Promise<TrackingSegmentPayload[]>,
  bundleId: string | number = key,
): Promise<ClaimBundleSegments> {
  const existing = cache.get(key);
  if (existing) {
    promote(key, existing);
    return existing.promise;
  }

  while (settledEntryCount() >= MAX_CACHED_BUNDLES) {
    if (!evictLeastRecentlyUsedSettled()) break;
  }

  const startedAt = Date.now();
  let resolveRequest!: (value: ClaimBundleSegments) => void;
  let rejectRequest!: (error: unknown) => void;
  const request = new Promise<ClaimBundleSegments>((resolve, reject) => {
    resolveRequest = resolve;
    rejectRequest = reject;
  });
  const entry: CacheEntry = { promise: request, settled: false };
  cache.set(key, entry);

  void Promise.resolve()
    .then(load)
    .then((segments) => {
      const readonlySegments = segments as unknown as readonly CachedTrackingSegment[];
      const tracksById = new Map<string, CachedTrack>();
      for (const segment of readonlySegments) {
        for (const track of segment.tracks) tracksById.set(track.id, track);
      }

      const value: ClaimBundleSegments = { segments: readonlySegments, tracksById };
      entry.settled = true;
      promote(key, entry);
      trimSettledEntries();
      logger.info(loadMetrics(bundleId, startedAt), "Claim bundle segments loaded");
      resolveRequest(value);
    })
    .catch((error: unknown) => {
      if (cache.get(key) === entry) cache.delete(key);
      logger.error(
        {
          ...loadMetrics(bundleId, startedAt),
          error: error instanceof Error ? error.message : String(error),
        },
        "Claim bundle segments load failed",
      );
      rejectRequest(error);
    });

  return request;
}