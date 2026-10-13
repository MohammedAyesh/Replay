import { createHash } from "node:crypto";
import { Router, type IRouter } from "express";
import { desc, eq, like, or } from "drizzle-orm";
import { db, recordingsTable, recordingTrackingBundlesTable } from "@workspace/db";
import { canViewBunnyVideo, canViewRecording, extractBunnyVideoId } from "../lib/publicFootage";
import { parseBallSidecar } from "../lib/matchPlay";
import { phasesFromProvenance } from "../lib/matchFlow";
import { loadRecordingPlay } from "../lib/matchPlayLoad";
import type { TrackingManifest } from "@workspace/db";

export type BallPathPayload = {
  v: 1;
  samples: Array<[number, number, number]>;
  gameSpans: Array<[number, number]>;
  cameraSpans: Array<[number, number]>;
  coverage: number;
};

type BundleRow = { id: number; recordingId: number; updatedAt: Date; videoUrl: string };
type CachedPath = { payload: BallPathPayload; etag: string; expiresAt: number };
type CachedNegative = { expiresAt: number };
const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, CachedPath>();
const negativeCache = new Map<string, CachedNegative>();
const inFlight = new Map<string, Promise<CachedPath>>();
const POSITIVE_CACHE_LIMIT = 12;
const NEGATIVE_CACHE_LIMIT = 500;

function getLru<T extends { expiresAt: number }>(store: Map<string, T>, key: string, now: number): T | undefined {
  const entry = store.get(key);
  if (!entry || entry.expiresAt <= now) {
    store.delete(key);
    return undefined;
  }
  store.delete(key);
  store.set(key, entry);
  return entry;
}

function setLru<T extends { expiresAt: number }>(store: Map<string, T>, key: string, entry: T, limit: number, now: number): void {
  for (const [storedKey, storedValue] of store) {
    if (storedValue.expiresAt <= now) store.delete(storedKey);
  }
  store.delete(key);
  store.set(key, entry);
  while (store.size > limit) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

function mergeIntervals(intervals: Array<[number, number]>, gap = 0): Array<[number, number]> {
  const sorted = intervals.filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b > a)
    .sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [];
  for (const span of sorted) {
    const last = out[out.length - 1];
    if (last && (span[0] <= last[1] || span[0] - last[1] < gap)) last[1] = Math.max(last[1], span[1]);
    else out.push([span[0], span[1]]);
  }
  return out;
}

export function selectNewestBundle<T extends { videoUrl: string; id: number; updatedAt: Date }>(
  rows: T[],
  guid: string,
): T | null {
  return rows.find((row) => extractBunnyVideoId(row.videoUrl) === guid) ?? null;
}

export function buildBallPath(
  manifest: TrackingManifest,
  sidecars: Array<unknown>,
  inPlaySpans?: Array<[number, number]> | null,
): BallPathPayload | null {
  const fps = manifest.frameRate;
  if (!(fps > 0) || !(manifest.width > 0) || !(manifest.height > 0)) return null;
  const offset = manifest.videoStartSeconds ?? 0;
  const samples = sidecars.flatMap((raw, i) => {
    const parsed = parseBallSidecar(raw, i);
    return (parsed?.ball ?? []).map(([frame, x, y]) => [
      Math.round((frame / fps + offset) * 100) / 100,
      Math.round((x / manifest.width) * 1000) / 1000,
      Math.round((y / manifest.height) * 1000) / 1000,
    ] as [number, number, number]);
  }).sort((a, b) => a[0] - b[0]);
  if (!samples.length) return null;
  const phases = phasesFromProvenance(manifest.provenance);
  const phaseSpans = (phases ?? [])
    .filter((phase) => phase.kind === "game")
    .map((phase) => [phase.start, phase.end] as [number, number]);
  const trackingSpans = phaseSpans.length
    ? phaseSpans
    : inPlaySpans?.length
      ? inPlaySpans
      : manifest.duration > 0
        ? [[0, manifest.duration] as [number, number]]
        : [];
  const gameSpans = mergeIntervals(trackingSpans.map(([start, end]) => [
    Math.round((start + offset) * 100) / 100,
    Math.round((end + offset) * 100) / 100,
  ]));
  const cameraSpans = mergeIntervals(gameSpans, 20);
  const total = gameSpans.reduce((sum, [a, b]) => sum + b - a, 0);
  const covered = mergeIntervals(samples.map(([t]) => [t - 0.5, t + 0.5]))
    .reduce((sum, [a, b]) => sum + gameSpans.reduce((inside, [start, end]) =>
      inside + Math.max(0, Math.min(b, end) - Math.max(a, start)), 0), 0);
  return { v: 1, samples, gameSpans, cameraSpans, coverage: total ? Math.min(1, covered / total) : 0 };
}

const router: IRouter = Router();
router.get("/videos/:guid/ball-path", async (req, res): Promise<void> => {
  const guid = req.params.guid;
  if (!guid || !(await canViewBunnyVideo(req, guid))) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const now = Date.now();
  if (getLru(negativeCache, guid, now)) {
    res.status(404).json({ error: "No analysed ball path" });
    return;
  }
  const candidates = await db.select({
    id: recordingTrackingBundlesTable.id,
    recordingId: recordingTrackingBundlesTable.recordingId,
    updatedAt: recordingTrackingBundlesTable.updatedAt,
    videoUrl: recordingsTable.videoUrl,
  }).from(recordingTrackingBundlesTable)
    .innerJoin(recordingsTable, eq(recordingsTable.id, recordingTrackingBundlesTable.recordingId))
    .where(or(
      like(recordingsTable.videoUrl, `%/${guid}/%`),
      eq(recordingsTable.videoUrl, guid),
    ))
    .orderBy(desc(recordingTrackingBundlesTable.updatedAt));
  const rows = candidates.filter((row) => extractBunnyVideoId(row.videoUrl) === guid);
  if (!rows.length) {
    setLru(negativeCache, guid, { expiresAt: now + CACHE_TTL_MS }, NEGATIVE_CACHE_LIMIT, now);
    res.status(404).json({ error: "No analysed ball path" });
    return;
  }
  let row: BundleRow | undefined;
  for (const candidate of rows) {
    if (await canViewRecording(req, candidate.recordingId)) {
      row = candidate;
      break;
    }
  }
  if (!row) {
    // Visibility is caller-specific; never let an inaccessible row poison
    // another viewer's result for this video GUID.
    res.status(404).json({ error: "No analysed ball path" });
    return;
  }

  const bundleKey = `${row.id}:${row.updatedAt.toISOString()}`;
  let cached = getLru(cache, bundleKey, now);
  if (!cached) {
    let work = inFlight.get(bundleKey);
    if (!work) {
      work = (async (): Promise<CachedPath> => {
        const [bundle] = await db.select({ manifest: recordingTrackingBundlesTable.manifest })
          .from(recordingTrackingBundlesTable)
          .where(eq(recordingTrackingBundlesTable.id, row!.id))
          .limit(1);
        if (!bundle) throw new Error("Selected tracking bundle disappeared");
        const play = await loadRecordingPlay(row!.recordingId, { keepSegments: false });
        const payload = play ? buildBallPath(bundle.manifest, play.sidecars, play.inPlay) : null;
        if (!payload) throw new Error("No ball data");
        const etag = `"${createHash("sha256").update(JSON.stringify(payload)).digest("hex")}"`;
        return { payload, etag, expiresAt: Date.now() + CACHE_TTL_MS };
      })();
      inFlight.set(bundleKey, work);
      void work.finally(() => {
        if (inFlight.get(bundleKey) === work) inFlight.delete(bundleKey);
      }).catch(() => undefined);
    }
    try {
      cached = await work;
      setLru(cache, bundleKey, cached, POSITIVE_CACHE_LIMIT, Date.now());
    } catch {
      res.status(404).json({ error: "No ball data" });
      return;
    }
  }
  res.setHeader("Cache-Control", "private, max-age=3600");
  res.setHeader("ETag", cached.etag);
  if (req.headers["if-none-match"] === cached.etag) {
    res.status(304).end();
    return;
  }
  res.json(cached.payload);
});
export default router;
