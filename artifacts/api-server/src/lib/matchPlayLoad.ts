/**
 * A recording's ball play, loaded once: the bundle's segments and ball
 * sidecars, the camera's pitch model, and every touch resolved to a track.
 *
 * Resolving needs every segment's boxes (tens of MB of JSON for a two-hour
 * game), so the result is cached per recording and keyed on everything that
 * could change it: the bundle row's updatedAt (a re-upload or an extras
 * attach) and the camera's calibration id.
 */
import { mergeSpans, phasesFromProvenance } from "./matchFlow";
import { asc, eq } from "drizzle-orm";
import {
  db,
  recordingTrackingBundlesTable,
  recordingTrackingSegmentsTable,
  type TrackingManifest,
  type TrackingSegmentPayload,
} from "@workspace/db";

import { createHash } from "node:crypto";
import { cameraForRecording, manifestWithPitchModel } from "./cameraPitchModel";
import { claimObjectPath, readClaimSegment, writeClaimSegment } from "./claimMatchStorage";
import { logger } from "./logger";
import { hasUsablePitchModel } from "./pitchModel";
import {
  directionFromData,
  dribbleEvents,
  dropTeleports,
  kitOptions,
  bibKit,
  type BibKit,
  parseBallSidecar,
  pitchDirection,
  resolveTouches,
  type PitchDirection,
  type BallSidecar,
  type BundleEvent,
  type DirectionData,
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
  /** the bib colour when one side wears bibs (matchPlay.bibKit), else null */
  bib?: BibKit | null;
  segments: TrackingSegmentPayload[] | null;
  /** every track's torso colour, from the ball sidecars */
  kits: Map<string, Lab>;
  /** goals and shots on target from the bundle (goals.py), tracking seconds */
  events: BundleEvent[];
  /** dribbles (runs past an opponent), sided by shirt colour alone (matchPlay.dribbleEvents) */
  dribbles: Dribble[];
  /** ball-tracker jumps dropped before touches were resolved (matchPlay.dropTeleports) */
  teleports: number;
  /** ball in play, tracking seconds, merged across segments; null when segments were not read */
  inPlay: Array<[number, number]> | null;
  /** before / game / break / after, tracking seconds (manifest.provenance.phases); null on older bundles */
  phases: Array<{ kind: string; start: number; end: number }> | null;
  /**
   * which end each side attacks, from the minimap (matchPlay.pitchDirection);
   * read while the segments are in hand so compact loads have it too. Null when
   * the minimap cannot tell.
   */
  direction?: PitchDirection | null;
};

/** Bumped whenever what is derived here changes, so cached results are rebuilt. */
const DERIVE_VERSION = 7; // 7: bibs judged by their place on the colour plane (bibCore)

// Each entry holds the whole match's tracking: rec 410's 61 MB of segments parse
// to ~150 MB. Six of them, the bundle cache and two ffmpeg renders could reach the
// 4 GiB Autoscale limit, and the instance was killed three times (1–4 Nov 2026).
const MAX_CACHED = Math.min(16, Math.max(1, Number.parseInt(process.env.MATCH_PLAY_CACHE_MAX ?? "", 10) || 3));
export const playCache = new Map<number, { key: string; data: RecordingPlay; at: number }>();
const playLoads = new Map<string, Promise<RecordingPlay | null>>();

/** Keep derived play data cached while using the latest bundle manifest. */
export function withFreshManifest(cached: RecordingPlay, manifest: TrackingManifest): RecordingPlay {
  return { ...cached, manifest };
}

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

/** Run `task` over `items`, at most `limit` at a time, keeping the order of the results. */
async function mapLimit<T, R>(items: readonly T[], limit: number, task: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      out[index] = await task(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Objects read from storage at once while loading a play (was one after another). */
const READ_CONCURRENCY = 4;

/* ------------------------------------------------------------ saved plays
 *
 * A compact play (everything above but the segments) is a few hundred KB, but
 * deriving it reads and parses every segment of the match: rec 410's 61 MB,
 * 8.9 s for the match page's GET /m/:code/replay on an instance that had not
 * seen it (2026-11-04), during which the parse blocks every other request on
 * that instance. Autoscale starts instances often and each keeps only
 * MATCH_PLAY_CACHE_MAX plays, so most match pages paid it.
 *
 * So the first compact load of a play saves it to object storage, and every
 * later compact load on any instance reads that instead. The name carries the
 * cache key and PLAY_DERIVE_SOURCE, a hash of every source file this derivation
 * runs (build.mjs), so a new bundle, a new calibration or any change to the
 * code computes and saves it afresh: a saved play is never older than the code.
 * Without PLAY_DERIVE_SOURCE (tests, a bare tsx run) nothing is saved or read.
 * Loads that keep the segments always derive them, as before.
 */

const SNAPSHOT_VERSION = 1;
const SNAPSHOT_READ_TIMEOUT_MS = 15_000;

type PlaySnapshotData = Omit<RecordingPlay, "manifest" | "segments" | "kits" | "direction"> & {
  kits: Array<[string, Lab]>;
  direction: DirectionData | null;
};
type PlaySnapshot = { v: number; key: string; source: string; data: PlaySnapshotData };

function deriveSource(): string | null {
  const value = process.env.PLAY_DERIVE_SOURCE;
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function snapshotPath(recordingId: number, key: string, source: string): string {
  const name = createHash("sha256").update(`${key}|${source}`).digest("hex").slice(0, 32);
  return `play-snapshots/${recordingId}/${name}.json`;
}

/**
 * True when JSON keeps every value as it is: no NaN or infinity (JSON writes
 * null), no undefined in an array, nothing but plain arrays and objects. An
 * undefined object property is dropped, which every reader treats alike. A play that fails this is not
 * saved, so a saved play always reads back equal to the one derived.
 */
export function jsonSafe(value: unknown, depth = 0): boolean {
  if (depth > 64) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (value === undefined) return true;
  if (Array.isArray(value)) {
    // an array gap or undefined reads back as null
    for (let i = 0; i < value.length; i++) if (value[i] === undefined || !jsonSafe(value[i], depth + 1)) return false;
    return true;
  }
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    for (const k in value) if (!jsonSafe((value as Record<string, unknown>)[k], depth + 1)) return false;
    return true;
  }
  return false;
}

/** The saved form of a compact play; null when it cannot be saved exactly. */
export function toSnapshotData(play: RecordingPlay): PlaySnapshotData | null {
  if (play.direction && !play.direction.data) return null;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { manifest, segments, kits, direction, ...rest } = play;
  const data: PlaySnapshotData = {
    ...rest,
    // a sparse sidecar list reads back with null in its gaps, which every reader treats alike
    sidecars: Array.from(rest.sidecars, (sc) => sc ?? null),
    kits: [...kits.entries()],
    direction: direction?.data ?? null,
  };
  return jsonSafe(data) ? data : null;
}

/** A compact play from its saved form, with the manifest just read. */
export function fromSnapshotData(data: PlaySnapshotData, manifest: TrackingManifest): RecordingPlay {
  return {
    ...data,
    manifest,
    segments: null,
    kits: new Map(data.kits),
    direction: data.direction ? directionFromData(data.direction) : null,
  };
}

async function readSnapshot(recordingId: number, key: string, source: string): Promise<PlaySnapshotData | null> {
  let body: Buffer;
  try {
    body = await readClaimSegment(claimObjectPath(snapshotPath(recordingId, key, source)), SNAPSHOT_READ_TIMEOUT_MS);
  } catch {
    return null; // not saved yet (or storage unreachable): derive it
  }
  try {
    const snap = JSON.parse(body.toString("utf8")) as PlaySnapshot;
    if (snap?.v !== SNAPSHOT_VERSION || snap.key !== key || snap.source !== source || !snap.data) return null;
    return snap.data;
  } catch (error) {
    logger.warn({ recordingId, err: error }, "Unreadable saved play; deriving it");
    return null;
  }
}

async function writeSnapshot(play: RecordingPlay, key: string, source: string): Promise<void> {
  const data = toSnapshotData(play);
  if (!data) {
    logger.warn({ recordingId: play.recordingId }, "Play not saved: it does not survive JSON exactly");
    return;
  }
  const snap: PlaySnapshot = { v: SNAPSHOT_VERSION, key, source, data };
  const { compressedBytes } = await writeClaimSegment(snapshotPath(play.recordingId, key, source), snap);
  logger.info({ recordingId: play.recordingId, compressedBytes }, "Saved compact play");
}

function remember(recordingId: number, key: string, data: RecordingPlay): void {
  playCache.set(recordingId, { key, data, at: Date.now() });
  if (playCache.size > MAX_CACHED) {
    const oldest = [...playCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) playCache.delete(oldest[0]);
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
    return withFreshManifest(cached.data, manifest);
  }
  const loadKey = `${key}:${opts.keepSegments ? "segments" : "compact"}`;
  const pending = playLoads.get(loadKey);
  if (pending) return pending;

  const work = (async (): Promise<RecordingPlay> => {
  const source = opts.keepSegments ? null : deriveSource();
  if (source) {
    const saved = await readSnapshot(recordingId, key, source);
    if (saved) {
      const data = fromSnapshotData(saved, manifest);
      remember(recordingId, key, data);
      return data;
    }
  }
  const sidecars: Array<BallSidecar | null> = [];
  const read = await mapLimit(manifest.segments, READ_CONCURRENCY, (segment) => readSidecar(segment.ballPath, segment.index));
  manifest.segments.forEach((segment, i) => { sidecars[segment.index] = read[i]; });
  // the ball tracker's jumps onto a boot or a head make touches that never
  // happened; drop them before anything reads a touch
  let teleports = 0;
  if (manifest.pitchModel) {
    for (let k = 0; k < sidecars.length; k++) {
      const cleaned = dropTeleports(sidecars[k] ?? null, manifest);
      sidecars[k] = cleaned.sidecar;
      teleports += cleaned.teleports;
    }
  }
  const hasBall = sidecars.some((sc) => sc && sc.touches.length > 0);

  let segments: TrackingSegmentPayload[] | null = null;
  if (hasBall || opts.keepSegments) {
    const rows = await db
      .select()
      .from(recordingTrackingSegmentsTable)
      .where(eq(recordingTrackingSegmentsTable.bundleId, bundle.id))
      .orderBy(asc(recordingTrackingSegmentsTable.segmentIndex));
    segments = await mapLimit(rows, READ_CONCURRENCY, async (row) => {
      const body = await readClaimSegment(row.objectPath);
      return JSON.parse(body.toString("utf8")) as TrackingSegmentPayload;
    });
  }
  const resolved = hasBall && segments
    ? resolveTouches(manifest, segments, sidecars)
    : { touches: [], rejected: { noTrack: 0, tooFar: 0 } };
  const kits = new Map<string, Lab>();
  for (const sc of sidecars) for (const [id, v] of Object.entries(sc?.kits ?? {})) kits.set(id, [v[0], v[1], v[2]]);
  const events: BundleEvent[] = (segments ?? []).flatMap((segment) =>
    (segment.events ?? []).filter((e) => typeof e.time === "number" && Number.isFinite(e.time)).map((e) => ({ type: String(e.type), t: e.time })));
  const inPlay: Array<[number, number]> | null = segments
    ? mergeSpans(segments.flatMap((segment) => (segment.inPlaySpans ?? [])
      .filter((span) => Number.isFinite(span.start) && Number.isFinite(span.end))
      .map((span) => [span.start, span.end] as [number, number])))
    : null;
  let direction: PitchDirection | null = null;
  if (segments) {
    try {
      direction = pitchDirection({ manifest, sidecars, segments, kits, bib: bibKit(sidecars), inPlay });
    } catch (error) {
      logger.warn({ recordingId, err: error }, "Could not read the attacking direction");
    }
  }
  let dribbles: Dribble[] = [];
  if (segments && resolved.touches.length) {
    try {
      // with bibs on one side, a dribble's opponents and its outcome follow the
      // bib line rather than raw shirt distance
      const bib = bibKit(sidecars);
      dribbles = dribbleEvents(manifest, segments, resolved.touches, kits, bib ? { a: bib.lab, b: bib.lab, bib } : null, direction);
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
    bib: bibKit(sidecars),
    segments: opts.keepSegments ? segments : null,
    kits,
    events,
    dribbles,
    teleports,
    inPlay,
    phases: phasesFromProvenance(manifest.provenance),
    direction,
  };
  remember(recordingId, key, data);
  if (source) {
    // in the background: the page that asked does not wait for the upload
    void writeSnapshot(data, key, source).catch((error) => logger.warn({ recordingId, err: error }, "Could not save the compact play"));
  }
  return data;
  })();
  playLoads.set(loadKey, work);
  try {
    return await work;
  } finally {
    if (playLoads.get(loadKey) === work) playLoads.delete(loadKey);
  }
}
