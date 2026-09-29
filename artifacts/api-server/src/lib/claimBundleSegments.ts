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
  value?: ClaimBundleSegments;
  settled: boolean;
};

// Pending reads occupy a cache slot too, so a third large bundle cannot load
// while two cached or in-flight bundles are already resident.
const cache = new Map<string, CacheEntry>();
let admissionTail: Promise<void> = Promise.resolve();

function acquireAdmission(): Promise<() => void> {
  let release!: () => void;
  const queued = new Promise<void>((resolve) => { release = resolve; });
  const previous = admissionTail;
  admissionTail = previous.then(() => queued);
  return previous.then(() => release);
}

function promote(key: string, entry: CacheEntry): void {
  cache.delete(key);
  cache.set(key, entry);
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
 * Cached entries and pending reads share the same two-slot limit.
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

  return reserveAndStart().then(({ request }) => request);

  async function reserveAndStart(): Promise<{ request: Promise<ClaimBundleSegments> }> {
    const release = await acquireAdmission();
    try {
      const raced = cache.get(key);
      if (raced) {
        promote(key, raced);
        return { request: raced.promise };
      }

      while (cache.size >= MAX_CACHED_BUNDLES) {
        const leastRecentlyUsed = cache.keys().next().value;
        if (leastRecentlyUsed === undefined) break;
        const entry = cache.get(leastRecentlyUsed);
        if (!entry) continue;

        if (!entry.settled) {
          await entry.promise.catch(() => undefined);
          if (cache.get(leastRecentlyUsed) !== entry || cache.keys().next().value !== leastRecentlyUsed) {
            continue;
          }
        }
        cache.delete(leastRecentlyUsed);
      }

      // Existing-key requests can arrive while this caller waits for a slot.
      const afterWait = cache.get(key);
      if (afterWait) {
        promote(key, afterWait);
        return { request: afterWait.promise };
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
          entry.value = value;
          entry.settled = true;
          logger.info(loadMetrics(bundleId, startedAt), "Claim bundle segments loaded");
          resolveRequest(value);
        })
        .catch((error: unknown) => {
          if (cache.get(key) === entry) cache.delete(key);
          logger.error(loadMetrics(bundleId, startedAt), "Claim bundle segments load failed");
          rejectRequest(error);
        });

      return { request };
    } finally {
      release();
    }
  }
}