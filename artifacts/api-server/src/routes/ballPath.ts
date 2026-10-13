import { createHash } from "node:crypto";
import { Router, type IRouter } from "express";
import { desc, eq } from "drizzle-orm";
import { db, recordingsTable, recordingTrackingBundlesTable } from "@workspace/db";
import { canViewBunnyVideo, extractBunnyVideoId } from "../lib/publicFootage";
import { readClaimSegment } from "../lib/claimMatchStorage";
import { parseBallSidecar } from "../lib/matchPlay";
import { phasesFromProvenance } from "../lib/matchFlow";
import type { TrackingManifest } from "@workspace/db";

export type BallPathPayload = {
  v: 1;
  samples: Array<[number, number, number]>;
  gameSpans: Array<[number, number]>;
  coverage: number;
};

type BundleRow = { id: number; manifest: TrackingManifest; updatedAt: Date };
const CACHE_LIMIT = 12;
const cache = new Map<string, { payload: BallPathPayload; etag: string; used: number }>();

function mergeIntervals(intervals: Array<[number, number]>): Array<[number, number]> {
  const sorted = intervals.filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b > a)
    .sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [];
  for (const span of sorted) {
    const last = out[out.length - 1];
    if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
    else out.push([...span]);
  }
  return out;
}

export function selectNewestBundle<T extends { videoUrl: string; bundle: BundleRow }>(
  rows: T[],
  guid: string,
): T | null {
  return rows.find((row) => extractBunnyVideoId(row.videoUrl) === guid) ?? null;
}

export function buildBallPath(manifest: TrackingManifest, sidecars: Array<unknown>): BallPathPayload | null {
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
  const gameSpans = mergeIntervals((phases ?? [])
    .filter((phase) => phase.kind === "game")
    .map((phase) => [Math.round((phase.start + offset) * 100) / 100, Math.round((phase.end + offset) * 100) / 100]));
  const total = gameSpans.reduce((sum, [a, b]) => sum + b - a, 0);
  const covered = mergeIntervals(samples.map(([t]) => [t - 0.5, t + 0.5]))
    .reduce((sum, [a, b]) => sum + gameSpans.reduce((inside, [start, end]) =>
      inside + Math.max(0, Math.min(b, end) - Math.max(a, start)), 0), 0);
  return { v: 1, samples, gameSpans, coverage: total ? Math.min(1, covered / total) : 0 };
}

function cachedBundlePath(bundle: BundleRow, payload: BallPathPayload): { payload: BallPathPayload; etag: string } {
  const key = `${bundle.id}:${bundle.updatedAt.toISOString()}`;
  const cached = cache.get(key);
  if (cached) {
    cached.used = Date.now();
    return cached;
  }
  const etag = `"${createHash("sha256").update(JSON.stringify(payload)).digest("hex")}"`;
  cache.set(key, { payload, etag, used: Date.now() });
  while (cache.size > CACHE_LIMIT) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].used - b[1].used)[0];
    if (oldest) cache.delete(oldest[0]);
  }
  return cache.get(key)!;
}

const router: IRouter = Router();
router.get("/videos/:guid/ball-path", async (req, res): Promise<void> => {
  const guid = req.params.guid;
  if (!guid || !(await canViewBunnyVideo(req, guid))) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const rows = await db.select({
    videoUrl: recordingsTable.videoUrl,
    id: recordingTrackingBundlesTable.id,
    manifest: recordingTrackingBundlesTable.manifest,
    updatedAt: recordingTrackingBundlesTable.updatedAt,
  }).from(recordingTrackingBundlesTable)
    .innerJoin(recordingsTable, eq(recordingsTable.id, recordingTrackingBundlesTable.recordingId))
    .orderBy(desc(recordingTrackingBundlesTable.updatedAt));
  const row = rows.find((item) => extractBunnyVideoId(item.videoUrl) === guid);
  if (!row) {
    res.status(404).json({ error: "No analysed ball path" });
    return;
  }
  const key = `${row.id}:${row.updatedAt.toISOString()}`;
  let cached = cache.get(key);
  if (!cached) {
    const sidecars = await Promise.all(row.manifest.segments.map(async (segment) => {
      if (!segment.ballPath) return null;
      try { return JSON.parse((await readClaimSegment(segment.ballPath)).toString("utf8")); } catch { return null; }
    }));
    const payload = buildBallPath(row.manifest, sidecars);
    if (!payload) {
      res.status(404).json({ error: "No ball data" });
      return;
    }
    cached = cachedBundlePath(row, payload);
  } else cached.used = Date.now();
  res.setHeader("Cache-Control", "private, max-age=3600");
  res.setHeader("ETag", cached.etag);
  if (req.headers["if-none-match"] === cached.etag) {
    res.status(304).end();
    return;
  }
  res.json(cached.payload);
});
export default router;
