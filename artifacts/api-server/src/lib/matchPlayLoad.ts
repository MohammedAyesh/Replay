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
  dribbleEvents,
  kitOptions,
  parseBallSidecar,
  resolveTouches,
  type BallSidecar,
  type BundleEvent,
  type Dribble,
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
  /** every track's torso colour, from the ball sidecars */
  kits: Map<string, Lab>;
  /** goals and shots on target from the bundle (goals.py), tracking seconds */
  events: BundleEvent[];
  /** take-ons, sided by shirt colour alone (matchPlay.dribbleEvents) */
  dribbles: Dribble[];
};

/** Bumped whenever what is derived here changes, so cached results are rebuilt. */
const DERIVE_VERSION = 2;

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
  const key = `${DERIVE_VERSION}:${bundle.id}:${bundle.updatedAt.toISOString()}:${manifest.pitchModel?.calibrationId ?? "-"}`;
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
  const kits = new Map<string, Lab>();
  for (const sc of sidecars) for (const [id, v] of Object.entries(sc?.kits ?? {})) kits.set(id, [v[0], v[1], v[2]]);
  const events: BundleEvent[] = (segments ?? []).flatMap((segment) =>
    (segment.events ?? []).filter((e) => typeof e.time === "number" && Number.isFinite(e.time)).map((e) => ({ type: String(e.type), t: e.time })));
  let dribbles: Dribble[] = [];
  if (segments && resolved.touches.length) {
    try {
      dribbles = dribbleEvents(manifest, segments, resolved.touches, kits, null);
    } catch (error) {
      logger.warn({ recordingId, err: error }, "Could not read dribbles");
    }
  }
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
    kits,
    events,
    dribbles,
  };
  playCache.set(recordingId, { key, data, at: Date.now() });
  if (playCache.size > MAX_CACHED) {
    const oldest = [...playCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) playCache.delete(oldest[0]);
  }
  return data;
}
