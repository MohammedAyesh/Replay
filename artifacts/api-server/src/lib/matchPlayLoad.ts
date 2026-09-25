/**
 * A recording's ball play, loaded once: the bundle's segments and ball
 * sidecars, the camera's pitch model, and every touch resolved to a track.
 *
 * Resolving needs every segment's boxes (tens of MB of JSON for a two-hour
 * game), so the result is cached per recording and keyed on everything that
 * could change it: the bundle row's updatedAt (a re-upload or an extras
 * attach) and the camera's calibration id.
 */
import { asc, eq } from "drizzle-orm";
import {
  db,
  recordingTrackingBundlesTable,
  recordingTrackingSegmentsTable,
  type TrackingManifest,
  type TrackingSegmentPayload,
} from "@workspace/db";

import { cameraForRecording, manifestWithPitchModel } from "./cameraPitchModel";
import { readClaimSegment } from "./claimMatchStorage";
import { logger } from "./logger";
import { hasUsablePitchModel } from "./pitchModel";
import {
  kitOptions,
  parseBallSidecar,
  resolveTouches,
  type BallSidecar,
  type Lab,
  type Touch,
} from "./matchPlay";

export type RecordingPlay = {
  recordingId: number;
  manifest: TrackingManifest;
  fps: number;
  hasBall: boolean;
  hasPitch: boolean;
  hasKits: boolean;
  sidecars: Array<BallSidecar | null>;
  touches: Touch[];
  rejected: { noTrack: number; tooFar: number };
  kitOptions: Array<{ lab: Lab; secs: number }>;
  segments: TrackingSegmentPayload[] | null;
};

const MAX_CACHED = 6;
export const playCache = new Map<number, { key: string; data: RecordingPlay; at: number }>();

async function readSidecar(path: string | undefined, index: number): Promise<BallSidecar | null> {
  if (!path) return null;
  try {
    const body = await readClaimSegment(path);
    return parseBallSidecar(JSON.parse(body.toString("utf8")), index);
  } catch (error) {
    logger.warn({ path, err: error }, "Could not read ball sidecar");
    return null;
  }
}

/**
 * Null when the recording has no bundle. `keepSegments` holds the parsed
 * segments on the result (the match page's distance and speed need them too);
 * without it they are dropped once touches are resolved, to keep the cache small.
 */
export async function loadRecordingPlay(recordingId: number, opts: { keepSegments?: boolean } = {}): Promise<RecordingPlay | null> {
  const [bundle] = await db
    .select()
    .from(recordingTrackingBundlesTable)
    .where(eq(recordingTrackingBundlesTable.recordingId, recordingId));
  if (!bundle) return null;
  const camera = await cameraForRecording(recordingId);
  const manifest = manifestWithPitchModel(bundle.manifest, camera.pitchModel, camera.cameraId);
  const key = `${bundle.id}:${bundle.updatedAt.toISOString()}:${manifest.pitchModel?.calibrationId ?? "-"}`;
  const cached = playCache.get(recordingId);
  if (cached && cached.key === key && (!opts.keepSegments || cached.data.segments)) {
    cached.at = Date.now();
    return cached.data;
  }

  const sidecars: Array<BallSidecar | null> = [];
  for (const segment of manifest.segments) sidecars[segment.index] = await readSidecar(segment.ballPath, segment.index);
  const hasBall = sidecars.some((sc) => sc && sc.touches.length > 0);

  let segments: TrackingSegmentPayload[] | null = null;
  if (hasBall || opts.keepSegments) {
    const rows = await db
      .select()
      .from(recordingTrackingSegmentsTable)
      .where(eq(recordingTrackingSegmentsTable.bundleId, bundle.id))
      .orderBy(asc(recordingTrackingSegmentsTable.segmentIndex));
    segments = [];
    for (const row of rows) {
      const body = await readClaimSegment(row.objectPath);
      segments.push(JSON.parse(body.toString("utf8")) as TrackingSegmentPayload);
    }
  }
  const resolved = hasBall && segments
    ? resolveTouches(manifest, segments, sidecars)
    : { touches: [], rejected: { noTrack: 0, tooFar: 0 } };
  const data: RecordingPlay = {
    recordingId,
    manifest,
    fps: manifest.frameRate > 0 ? manifest.frameRate : 20,
    hasBall,
    hasPitch: hasUsablePitchModel(manifest),
    hasKits: sidecars.some((sc) => sc && Object.keys(sc.kits).length > 0),
    sidecars,
    touches: resolved.touches,
    rejected: resolved.rejected,
    kitOptions: kitOptions(sidecars),
    segments: opts.keepSegments ? segments : null,
  };
  playCache.set(recordingId, { key, data, at: Date.now() });
  if (playCache.size > MAX_CACHED) {
    const oldest = [...playCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) playCache.delete(oldest[0]);
  }
  return data;
}
