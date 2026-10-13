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

type BundleRow = { id: number; recordingId: number; updatedAt: Date };
type CachedPath = { payload: BallPathPayload | null; etag?: string; error?: string; expiresAt: number };
const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, CachedPath>();
const inFlight = new Map<string, Promise<CachedPath>>();

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

export function selectNewestBundle<T extends { videoUrl: string; id: number; manifest: TrackingManifest; updatedAt: Date }>(
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
  let cached = cache.get(guid);
  if (!cached || cached.expiresAt <= now) {
    cache.delete(guid);
    let work = inFlight.get(guid);
    if (!work) {
      work = (async (): Promise<CachedPath> => {
        const rows = await db.select({
          id: recordingTrackingBundlesTable.id,
          recordingId: recordingTrackingBundlesTable.recordingId,
          updatedAt: recordingTrackingBundlesTable.updatedAt,
        }).from(recordingTrackingBundlesTable)
          .innerJoin(recordingsTable, eq(recordingsTable.id, recordingTrackingBundlesTable.recordingId))
          .where(or(
            like(recordingsTable.videoUrl, `%/${guid}/%`),
            eq(recordingsTable.videoUrl, guid),
          ))
          .orderBy(desc(recordingTrackingBundlesTable.updatedAt));
        const row = (await Promise.all(rows.map(async (candidate) => ({
          candidate,
          visible: await canViewRecording(req, candidate.recordingId),
        })))).find(({ visible }) => visible)?.candidate;
        if (!row) return { payload: null, error: "No analysed ball path", expiresAt: Date.now() + CACHE_TTL_MS };
        const [bundle] = await db.select({ manifest: recordingTrackingBundlesTable.manifest })
          .from(recordingTrackingBundlesTable)
          .where(eq(recordingTrackingBundlesTable.id, row.id))
          .limit(1);
        if (!bundle) return { payload: null, error: "No analysed ball path", expiresAt: Date.now() + CACHE_TTL_MS };
        const play = await loadRecordingPlay(row.recordingId, { keepSegments: false });
        const payload = play ? buildBallPath(bundle.manifest, play.sidecars, play.inPlay) : null;
        if (!payload) return { payload: null, error: "No ball data", expiresAt: Date.now() + CACHE_TTL_MS };
        const etag = `"${createHash("sha256").update(JSON.stringify(payload)).digest("hex")}"`;
        return { payload, etag, expiresAt: Date.now() + CACHE_TTL_MS };
      })();
      inFlight.set(guid, work);
      void work.finally(() => {
        if (inFlight.get(guid) === work) inFlight.delete(guid);
      }).catch(() => undefined);
    }
    try {
      cached = await work;
      cache.set(guid, cached);
    } catch {
      res.status(500).json({ error: "Could not prepare ball path" });
      return;
    }
  }
  if (!cached.payload) {
    res.status(404).json({ error: cached.error ?? "No analysed ball path" });
    return;
  }
  res.setHeader("Cache-Control", "private, max-age=3600");
  res.setHeader("ETag", cached.etag!);
  if (req.headers["if-none-match"] === cached.etag) {
    res.status(304).end();
    return;
  }
  res.json(cached.payload);
});
export default router;
