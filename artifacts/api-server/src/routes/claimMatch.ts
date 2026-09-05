import { Router, type IRouter } from "express";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import multer from "multer";
import { unzipSync, strFromU8 } from "fflate";
import { createHash, randomUUID } from "node:crypto";
import { gunzipSync as nodeGunzipSync } from "node:zlib";
import { z } from "zod";
import {
  CreateClaimMatchCorrectionBody,
  GetClaimMatchResponse,
  GetClaimMatchParams,
  GetClaimMatchSegmentParams,
  GetClaimMatchSegmentResponse,
  ListClaimMatchClipsResponse,
  ReplaceTrackingBundleBody,
  UpdateTrackingBundleBody,
  UpdateTrackingBundleResponse,
  GetAdminRecordingPlayerMetricsResponse,
  UpdateClaimMatchProgressBody,
} from "@workspace/api-zod";
import {
  db,
  usersTable,
  recordingsTable,
  fieldsTable,
  recordingTrackingBundlesTable,
  recordingTrackingSegmentsTable,
  claimMatchProgressTable,
  claimMatchCorrectionsTable,
  claimMatchIdentityBindingsTable,
  claimMatchOffPitchSpansTable,
  type TrackingManifest,
  type TrackingPitchModel,
  type TrackingSegmentPayload,
  type TrackingBundleSummary,
  type ClaimEarnedClip,
  type ClaimIdentityBindingRow,
  type ClaimIdentityBindingState,
  type ClaimIdentityResolutionMethod,
  type TrackingIdentity,
} from "@workspace/db";
import { getLocalAccountUserId, getLocalUserId, unauthenticatedResponse } from "../lib/clerkUserBridge";
import { getBunnyProxiedPlaybackUrl } from "../lib/bunny";
import { logger } from "../lib/logger";
import { ensureClaimMomentUserClip } from "./userClips";
import {
  deleteClaimSegment,
  readClaimSegment,
  readCompressedClaimSegment,
  writeClaimSegment,
} from "../lib/claimMatchStorage";
import { isRecordingVisible } from "../lib/recordingVisibility";
import {
  normaliseOffPitchSpans,
  subtractSpans,
  totalSeconds,
  type OffPitchSpan,
} from "./claimOffPitch";

const router: IRouter = Router();

/** identity board result: pieces of tracks that are one person */
const IdentityMapBody = z.object({
  bundleFingerprint: z.string().min(1),
  confirmInvalidations: z.boolean().optional(),
  identities: z.array(z.object({
    id: z.string().min(1),
    name: z.string().nullish(),
    parts: z.array(z.object({
      trackId: z.string().min(1),
      fromFrame: z.number().int().min(0),
      toFrame: z.number().int().min(0),
    })).min(1),
  })),
});
const bundleUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 75 * 1024 * 1024 },
});
const bundleUploadSingle: import("express").RequestHandler = (req, res, next) => {
  bundleUpload.single("bundle")(req, res, (error) => {
    if (!error) {
      next();
      return;
    }
    if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
      res.status(400).json({ error: "The ZIP file exceeds the 75 MB upload limit" });
      return;
    }
    next(error);
  });
};

const MAX_BUNDLE_BYTES = 75 * 1024 * 1024;
const MAX_BUNDLE_UNCOMPRESSED_BYTES = 300 * 1024 * 1024;
const MAX_BUNDLE_ENTRY_BYTES = 40 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1 * 1024 * 1024;
const MAX_SPRITE_BYTES = 40 * 1024 * 1024;
const MAX_BUNDLE_ENTRIES = 512;
const MAX_BUNDLE_SEGMENTS = 256;
const MAX_TRACKING_DURATION_SECONDS = 3 * 60 * 60;
const MAX_TRACKING_FRAMES = 10_000_000;
const MAX_TRACKS_PER_SEGMENT = 10_000;
const MAX_BOXES_PER_SEGMENT = 2_000_000;
const MAX_CROSSINGS_PER_SEGMENT = 250_000;
const MAX_EVENTS_PER_SEGMENT = 250_000;
const PITCH_ASPECT_RATIO_TOLERANCE = 0.01;

function parseId(value: string | string[]): number | null {
  const raw = Array.isArray(value) ? value[0] : value;
  const id = Number.parseInt(raw, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

async function requireAccountUser(req: Parameters<typeof getLocalAccountUserId>[0]): Promise<number | null> {
  const userId = await getLocalAccountUserId(req);
  if (!userId) return null;
  const [user] = await db
    .select({ id: usersTable.id, isGuest: usersTable.isGuest })
    .from(usersTable)
    .where(eq(usersTable.id, userId));
  return user && !user.isGuest ? user.id : null;
}

async function requireAdmin(req: Parameters<typeof getLocalUserId>[0]): Promise<number | null> {
  const userId = await getLocalUserId(req);
  if (!userId) return null;
  const [user] = await db
    .select({ id: usersTable.id, isAdmin: usersTable.isAdmin })
    .from(usersTable)
    .where(eq(usersTable.id, userId));
  return user?.isAdmin ? user.id : null;
}

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : {};
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
      return Number(value);
    }
  }
  return undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value;
    if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  }
  return undefined;
}

function parsePitchModel(input: unknown): { model?: TrackingPitchModel; error?: string } {
  if (input === undefined || input === null) return {};
  const source = asRecord(input);
  const calibrationId = firstString(source.calibrationId, source.calibrationIdentifier, source.calibration_id);
  const fittedAt = firstString(
    source.fittedAt,
    source.fitDate,
    source.fittedDate,
    source.fitted_at,
    source.fit_date,
    source.calibratedAt,
    source.calibrated_at,
  );
  const calibratedAspectRatio = firstNumber(
    source.calibratedAspectRatio,
    source.calibrationAspectRatio,
    source.aspectRatio,
    source.sourceAspectRatio,
    source.calibrated_aspect_ratio,
    source.aspect_ratio,
  );
  const pitchWidthMetres = firstNumber(source.pitchWidthMetres);
  const pitchHeightMetres = firstNumber(source.pitchHeightMetres);
  const rawGrid = source.grid;
  if (!calibrationId) return { error: "Pitch model calibrationId is required" };
  if (!fittedAt || Number.isNaN(Date.parse(fittedAt))) {
    return { error: "Pitch model fittedAt must be a valid date-time" };
  }
  if (calibratedAspectRatio === undefined || calibratedAspectRatio <= 0) {
    return { error: "Pitch model calibratedAspectRatio must be a positive number" };
  }
  if (
    pitchWidthMetres === undefined
    || pitchHeightMetres === undefined
    || pitchWidthMetres <= 0
    || pitchHeightMetres <= 0
  ) {
    return { error: "Pitch model dimensions must be positive numbers" };
  }
  if (!Array.isArray(rawGrid) || rawGrid.length < 2) {
    return { error: "Pitch model grid must contain at least two rows" };
  }
  const grid: TrackingPitchModel["grid"] = [];
  let columnCount: number | null = null;
  for (const rawRow of rawGrid) {
    if (!Array.isArray(rawRow) || rawRow.length < 2) {
      return { error: "Every pitch model grid row must contain at least two points" };
    }
    if (columnCount === null) columnCount = rawRow.length;
    if (rawRow.length !== columnCount) {
      return { error: "Pitch model grid rows must all have the same number of points" };
    }
    const row: Array<{ x: number; y: number }> = [];
    for (const rawPoint of rawRow) {
      const point = asRecord(rawPoint);
      const x = firstNumber(point.x);
      const y = firstNumber(point.y);
      if (
        x === undefined
        || y === undefined
        || x < 0
        || x > pitchWidthMetres
        || y < 0
        || y > pitchHeightMetres
      ) {
        return {
          error: "Pitch model points must be finite and inside the declared pitch dimensions",
        };
      }
      row.push({ x, y });
    }
    grid.push(row);
  }
  return {
    model: {
      calibrationId,
      fittedAt: new Date(fittedAt).toISOString(),
      calibratedAspectRatio,
      pitchWidthMetres,
      pitchHeightMetres,
      grid,
    },
  };
}

function pitchModelSummary(model: TrackingPitchModel | undefined) {
  const stored = model as (TrackingPitchModel & {
    calibrationId?: string;
    fittedAt?: string;
    calibratedAspectRatio?: number;
  }) | undefined;
  return stored
    ? {
        calibrationId: stored.calibrationId ?? null,
        fittedAt: stored.fittedAt ?? null,
        calibratedAspectRatio: stored.calibratedAspectRatio ?? null,
        gridRows: stored.grid.length,
        gridColumns: stored.grid[0]?.length ?? 0,
        pitchWidthMetres: stored.pitchWidthMetres,
        pitchHeightMetres: stored.pitchHeightMetres,
      }
    : null;
}

function pitchModelFramingError(
  model: TrackingPitchModel,
  width: number,
  height: number,
): string | undefined {
  const bundleAspectRatio = width / height;
  const relativeDifference = Math.abs(bundleAspectRatio - model.calibratedAspectRatio)
    / model.calibratedAspectRatio;
  if (relativeDifference <= PITCH_ASPECT_RATIO_TOLERANCE) return undefined;
  return `Pitch model aspect ratio ${model.calibratedAspectRatio.toFixed(4)} does not match bundle aspect ratio ${bundleAspectRatio.toFixed(4)}; the model was fitted for a different crop`;
}

function validatePitchModelForManifest(
  model: TrackingPitchModel | undefined,
  width: number,
  height: number,
): string | undefined {
  if (!model) return undefined;
  const parsed = parsePitchModel(model);
  if (parsed.error || !parsed.model) return parsed.error ?? "Invalid pitch model";
  return pitchModelFramingError(parsed.model, width, height);
}

function manifestForClient(manifest: TrackingManifest): TrackingManifest {
  if (!manifest.pitchModel || !validatePitchModelForManifest(manifest.pitchModel, manifest.width, manifest.height)) {
    return manifest;
  }
  const safeManifest = { ...manifest };
  delete safeManifest.pitchModel;
  return safeManifest;
}

/**
 * The canonical bundle is intentionally small and regular, while this
 * normalizer accepts the common names emitted by tracking pipelines
 * (fps/video_fps, bbox/boundingBox, track_id, and so on). This means an
 * operator can upload Mohammed's JSON directly without hand-editing it.
 */
function normalizeBundle(
  input: unknown,
  segmentIndex = 0,
  segmentName = "segment-01",
  segmentStartFrame = 0,
  segmentEndFrame?: number,
  segmentStartSeconds = 0,
  segmentEndSeconds?: number,
): unknown {
  const source = asRecord(input);
  const metadata = asRecord(source.metadata ?? source.video);
  const dimensions = asRecord(source.dimensions ?? metadata.dimensions);
  const frameRate = firstNumber(source.frameRate, source.fps, source.videoFps, metadata.frameRate, metadata.fps);
  const frameCount = firstNumber(source.frameCount, source.frames, metadata.frameCount, metadata.frames);
  const duration = firstNumber(source.duration, source.videoDuration, metadata.duration, metadata.videoDuration);
  const width = firstNumber(source.width, source.videoWidth, dimensions.width, metadata.width);
  const height = firstNumber(source.height, source.videoHeight, dimensions.height, metadata.height);
  const matchOffset = firstNumber(
    source.matchOffset,
    source.match_offset,
    source.offset,
    metadata.matchOffset,
    metadata.offset,
  ) ?? 0;

  const rawTracks = Array.isArray(source.tracks)
    ? source.tracks
    : Array.isArray(source.players)
      ? source.players
      : [];
  const tracks = rawTracks.map((rawTrack, index) => {
    const track = asRecord(rawTrack);
    const id = firstString(track.id, track.trackId, track.track_id, track.playerId) ?? `track-${index + 1}`;
    const rawBoxes = Array.isArray(track.boxes)
      ? track.boxes
      : Array.isArray(track.bboxes)
        ? track.bboxes
        : Array.isArray(track.boundingBoxes)
          ? track.boundingBoxes
          : Array.isArray(track.detections)
            ? track.detections
            : [];
    const boxes = rawBoxes.map((rawBox, boxIndex) => {
      const box = asRecord(rawBox);
      const xywh = Array.isArray(box.bbox) ? box.bbox : Array.isArray(box.xywh) ? box.xywh : null;
      return {
        frame: Math.max(0, Math.round(firstNumber(box.frame, box.frameIndex, box.index, boxIndex) ?? boxIndex)),
        x: firstNumber(box.x, box.left, xywh?.[0]) ?? 0,
        y: firstNumber(box.y, box.top, xywh?.[1]) ?? 0,
        w: Math.max(0, firstNumber(box.w, box.width, xywh?.[2]) ?? 0),
        h: Math.max(0, firstNumber(box.h, box.height, xywh?.[3]) ?? 0),
      };
    });
    return {
      id,
      label: firstString(track.label, track.name, track.playerName) ?? null,
      startFrame: Math.max(0, Math.round(firstNumber(track.startFrame, track.start, boxes[0]?.frame) ?? 0)),
      endFrame: Math.max(
        0,
        Math.round(firstNumber(track.endFrame, track.end, boxes[boxes.length - 1]?.frame, frameCount) ?? 0),
      ),
      boxes,
    };
  });

  const rawCrossings = Array.isArray(source.crossings)
    ? source.crossings
    : Array.isArray(source.trackCrossings)
      ? source.trackCrossings
      : Array.isArray(source.identityCrossings)
        ? source.identityCrossings
        : [];
  const crossings = rawCrossings.map((rawCrossing) => {
    const crossing = asRecord(rawCrossing);
    return {
      frame: Math.max(0, Math.round(firstNumber(crossing.frame, crossing.frameIndex, crossing.atFrame) ?? 0)),
      trackId: firstString(crossing.trackId, crossing.track_id, crossing.fromTrackId, crossing.from) ?? "",
      otherTrackId: firstString(
        crossing.otherTrackId,
        crossing.other_track_id,
        crossing.toTrackId,
        crossing.to,
      ) ?? "",
      ...(firstNumber(crossing.confidence) !== undefined
        ? { confidence: firstNumber(crossing.confidence) }
        : {}),
    };
  });

  const rawSpans = Array.isArray(source.inPlaySpans)
    ? source.inPlaySpans
    : Array.isArray(source.in_play_spans)
      ? source.in_play_spans
      : Array.isArray(source.playSpans)
        ? source.playSpans
        : [];
  const inPlaySpans = rawSpans.map((rawSpan) => {
    const span = asRecord(rawSpan);
    return {
      start: Math.max(0, firstNumber(span.start, span.startSeconds, span.from) ?? 0),
      end: Math.max(0, firstNumber(span.end, span.endSeconds, span.to) ?? 0),
    };
  });

  const rawEvents = Array.isArray(source.events)
    ? source.events
    : [
        ...(Array.isArray(source.goals) ? source.goals : []),
        ...(Array.isArray(source.shots) ? source.shots : []),
        ...(Array.isArray(source.kickoffs) ? source.kickoffs : []),
      ];
  const events = rawEvents.map((rawEvent) => {
    const event = asRecord(rawEvent);
    return {
      type: firstString(event.type, event.eventType, event.kind) ?? "moment",
      time: Math.max(0, firstNumber(event.time, event.timeSeconds, event.timestamp, event.at) ?? 0),
      label: firstString(event.label, event.title, event.name) ?? null,
      clipId: firstString(event.clipId, event.clip_id) ?? null,
    };
  });

  return {
    version: Math.max(1, Math.round(firstNumber(source.version) ?? 1)),
    segmentIndex,
    name: segmentName,
    startFrame: Math.max(0, Math.round(firstNumber(source.startFrame, source.start_frame) ?? segmentStartFrame)),
    endFrame: Math.max(
      0,
      Math.round(firstNumber(source.endFrame, source.end_frame) ?? segmentEndFrame ?? frameCount ?? 1),
    ),
    startSeconds: Math.max(0, firstNumber(source.startSeconds, source.start_seconds) ?? segmentStartSeconds),
    endSeconds: Math.max(0, firstNumber(source.endSeconds, source.end_seconds) ?? segmentEndSeconds ?? duration ?? 1),
    tracks,
    crossings,
    inPlaySpans,
    events,
    // Kept on the normalized intermediate value for manifest construction.
    _metadata: {
      label: firstString(source.label, source.name, metadata.label) ?? "Match tracking",
      width: Math.max(1, Math.round(width ?? 1920)),
      height: Math.max(1, Math.round(height ?? 1080)),
      frameRate: frameRate ?? 25,
      frameCount: Math.max(1, Math.round(frameCount ?? Math.max(1, (duration ?? 1) * (frameRate ?? 25)))),
      duration: duration ?? 1,
      matchOffset,
    },
  };
}

function parseSegment(
  input: unknown,
  segmentIndex: number,
  segmentName: string,
  startFrame: number,
  endFrame: number,
  startSeconds: number,
  endSeconds: number,
): TrackingSegmentPayload | null {
  const normalized = normalizeBundle(input, segmentIndex, segmentName, startFrame, endFrame, startSeconds, endSeconds) as UnknownRecord;
  const metadata = asRecord(normalized._metadata);
  const result = ReplaceTrackingBundleBody.safeParse({
    ...metadata,
    ...normalized,
  });
  if (!result.success) return null;
  const value = result.data as unknown as TrackingSegmentPayload;
  return {
    ...value,
    segmentIndex,
    name: segmentName,
    startFrame,
    endFrame,
    startSeconds,
    endSeconds,
  };
}

function namespaceSegment(segment: TrackingSegmentPayload): TrackingSegmentPayload {
  const prefix = `s${segment.segmentIndex}:`;
  const namespace = (id: string) => id.startsWith(prefix) ? id : `${prefix}${id}`;
  return {
    ...segment,
    tracks: segment.tracks.map((track) => ({
      ...track,
      id: namespace(track.id),
    })),
    crossings: segment.crossings.map((crossing) => ({
      ...crossing,
      trackId: namespace(crossing.trackId),
      otherTrackId: namespace(crossing.otherTrackId),
    })),
  };
}

export type UploadBundle = {
  manifest: Omit<TrackingManifest, "segments"> & { segments: Array<TrackingManifest["segments"][number] & { file?: string; path?: string }> };
  segments: TrackingSegmentPayload[];
  /**
   * Optional per-segment crop strips for the identity board:
   * { trackId: [{ f: frame, j: base64 jpeg }, ...] }, read from
   * sprites/<segment name>.json in the zip. Stored as their own object so the
   * claim page never downloads them.
   */
  sprites?: Record<number, unknown>;
};

export function summarizeTrackingSegments(segments: TrackingSegmentPayload[]): TrackingBundleSummary {
  return {
    segments: segments.map((segment) => ({
      segmentIndex: segment.segmentIndex,
      startFrame: segment.startFrame,
      endFrame: segment.endFrame,
      startSeconds: segment.startSeconds,
      endSeconds: segment.endSeconds,
      tracks: segment.tracks.map((track) => ({
        id: track.id,
        startFrame: track.startFrame,
        endFrame: track.endFrame,
      })),
      events: segment.events,
    })),
  };
}

/**
 * A bundle fingerprint is the identity-board version anchor. It intentionally
 * excludes object paths and identity edits, but includes every track id and
 * frame range, so replacing the tracking data invalidates an old map.
 */
export function trackingBundleFingerprint(
  manifest: Pick<TrackingManifest, "version" | "width" | "height" | "frameRate" | "frameCount" | "duration">,
  segments: Array<{
    segmentIndex: number;
    startFrame: number;
    endFrame: number;
    tracks: Array<{ id: string; startFrame: number; endFrame: number }>;
  }>,
): string {
  const payload = {
    version: manifest.version,
    width: manifest.width,
    height: manifest.height,
    frameRate: manifest.frameRate,
    frameCount: manifest.frameCount,
    duration: manifest.duration,
    segments: segments.map((segment) => ({
      segmentIndex: segment.segmentIndex,
      startFrame: segment.startFrame,
      endFrame: segment.endFrame,
      tracks: segment.tracks.map((track) => ({
        id: track.id,
        startFrame: track.startFrame,
        endFrame: track.endFrame,
      })).sort((a, b) => a.id.localeCompare(b.id)),
    })).sort((a, b) => a.segmentIndex - b.segmentIndex),
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function entryNamesForSegment(
  entry: UnknownRecord,
  index: number,
  name: string,
): string[] {
  const declared = firstString(entry.file, entry.path);
  const candidates = [declared, `segments/${name}.json`, `segments/${name}.json.gz`, `segment-${String(index + 1).padStart(2, "0")}.json`, `${name}.json`]
    .filter((value): value is string => Boolean(value));
  return [...new Set(candidates)];
}

class BundleParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BundleParseError";
  }
}

function isSafeBundleEntryName(name: string): boolean {
  if (!name || name.length > 255 || name.startsWith("/") || name.includes("\\")) return false;
  return name.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

function unzipBundleEntries(buffer: Buffer): Record<string, Uint8Array> {
  if (buffer.byteLength > MAX_BUNDLE_BYTES) {
    throw new BundleParseError("The ZIP file exceeds the 75 MB upload limit");
  }

  let entryCount = 0;
  let totalUncompressedBytes = 0;
  const names = new Set<string>();
  try {
    return unzipSync(buffer, {
      filter: (file) => {
        entryCount++;
        if (entryCount > MAX_BUNDLE_ENTRIES) {
          throw new BundleParseError(`The ZIP contains too many files (maximum ${MAX_BUNDLE_ENTRIES})`);
        }
        if (!isSafeBundleEntryName(file.name)) {
          throw new BundleParseError(`The ZIP contains an unsafe file path: ${file.name}`);
        }
        if (names.has(file.name)) {
          throw new BundleParseError(`The ZIP contains a duplicate file: ${file.name}`);
        }
        names.add(file.name);
        if (file.compression !== 0 && file.compression !== 8) {
          throw new BundleParseError(`The ZIP uses an unsupported compression method for ${file.name}`);
        }
        if (!Number.isSafeInteger(file.originalSize) || file.originalSize > MAX_BUNDLE_ENTRY_BYTES) {
          throw new BundleParseError(`ZIP entry ${file.name} exceeds the ${MAX_BUNDLE_ENTRY_BYTES / (1024 * 1024)} MB decompressed limit`);
        }
        totalUncompressedBytes += file.originalSize;
        if (totalUncompressedBytes > MAX_BUNDLE_UNCOMPRESSED_BYTES) {
          throw new BundleParseError("The ZIP exceeds the 300 MB total decompressed limit");
        }
        return true;
      },
    }) as Record<string, Uint8Array>;
  } catch (error) {
    if (error instanceof BundleParseError) throw error;
    throw new BundleParseError("The ZIP could not be safely decompressed");
  }
}

export function parseUploadedBundleDetailed(input: unknown): { upload: UploadBundle | null; error: string | null } {
  const source = asRecord(input);
  const rawMetadata = asRecord(source.manifest ?? input);
  const nestedMetadata = asRecord(rawMetadata.metadata ?? rawMetadata.video);
  const dimensions = asRecord(rawMetadata.dimensions ?? nestedMetadata.dimensions);
  const suppliedFrameRate = firstNumber(
    rawMetadata.frameRate,
    rawMetadata.fps,
    rawMetadata.videoFps,
    nestedMetadata.frameRate,
    nestedMetadata.fps,
  );
  const suppliedWidth = firstNumber(
    rawMetadata.width,
    rawMetadata.videoWidth,
    dimensions.width,
    nestedMetadata.width,
  );
  const suppliedHeight = firstNumber(
    rawMetadata.height,
    rawMetadata.videoHeight,
    dimensions.height,
    nestedMetadata.height,
  );
  if (suppliedFrameRate === undefined) return { upload: null, error: "Manifest frame rate is required" };
  if (suppliedWidth === undefined) return { upload: null, error: "Manifest width is required" };
  if (suppliedHeight === undefined) return { upload: null, error: "Manifest height is required" };
  const pitchModel = parsePitchModel(
    rawMetadata.pitchModel
      ?? rawMetadata.pitch_model
      ?? nestedMetadata.pitchModel
      ?? nestedMetadata.pitch_model,
  );
  if (pitchModel.error) return { upload: null, error: pitchModel.error };
  if (pitchModel.model) {
    const framingError = pitchModelFramingError(pitchModel.model, suppliedWidth, suppliedHeight);
    if (framingError) return { upload: null, error: framingError };
  }
  const rawSegments = Array.isArray(rawMetadata.segments) ? rawMetadata.segments : [];
  if (rawSegments.length > 0) {
    const segments: TrackingSegmentPayload[] = [];
    for (let index = 0; index < rawSegments.length; index++) {
      const entry = asRecord(rawSegments[index]);
      const startFrame = Math.max(0, Math.round(firstNumber(entry.startFrame, entry.start_frame) ?? 0));
      const endFrame = Math.max(startFrame, Math.round(firstNumber(entry.endFrame, entry.end_frame) ?? startFrame));
      const startSeconds = Math.max(0, firstNumber(entry.startSeconds, entry.start_seconds) ?? startFrame / suppliedFrameRate);
      const endSeconds = Math.max(startSeconds, firstNumber(entry.endSeconds, entry.end_seconds) ?? (endFrame + 1) / suppliedFrameRate);
      const payload = asRecord(entry.payload).tracks ? entry.payload : entry;
      const segment = parseSegment(payload, index, firstString(entry.name) ?? `segment-${String(index + 1).padStart(2, "0")}`, startFrame, endFrame, startSeconds, endSeconds);
      if (!segment) return {
        upload: null,
        error: `Segment ${index + 1} does not match the tracking schema`,
      };
      segments.push(namespaceSegment(segment));
    }
    const firstSegment = segments[0];
    return { upload: {
      manifest: {
        version: Math.max(1, Math.round(firstNumber(rawMetadata.version) ?? 1)),
        label: firstString(rawMetadata.label, rawMetadata.name) ?? "Match tracking",
        width: Math.max(1, Math.round(suppliedWidth)),
        height: Math.max(1, Math.round(suppliedHeight)),
        frameRate: suppliedFrameRate,
        frameCount: Math.max(1, Math.round(firstNumber(rawMetadata.frameCount, rawMetadata.frames) ?? (segments.at(-1)?.endFrame ?? 0) + 1)),
        duration: Math.max(firstNumber(rawMetadata.duration) ?? 0, segments.at(-1)?.endSeconds ?? 0) || 1,
        matchOffset: firstNumber(rawMetadata.matchOffset, rawMetadata.match_offset) ?? 0,
         ...(pitchModel.model ? { pitchModel: pitchModel.model } : {}),
        videoStartSeconds: Math.max(0, firstNumber(
          rawMetadata.videoStartSeconds,
          rawMetadata.video_start_seconds,
          rawMetadata.videoOffset,
          rawMetadata.offsetSec,
        ) ?? 0),
        segmentCount: segments.length,
        segments: segments.map((segment) => ({
          index: segment.segmentIndex,
          name: segment.name,
          startFrame: segment.startFrame,
          endFrame: segment.endFrame,
          startSeconds: segment.startSeconds,
          endSeconds: segment.endSeconds,
          objectPath: "",
        })),
      },
      segments,
    }, error: null };
  }

  const legacy = parseSegment(input, 0, "segment-01", 0, Math.max(0, Math.round(firstNumber(source.frameCount, source.frames) ?? 0) - 1), 0, firstNumber(source.duration) ?? 1);
  if (!legacy) {
    return {
      upload: null,
      error: "The request body does not contain a valid tracking segment",
    };
  }
  const sourceMeta = asRecord((normalizeBundle(input) as UnknownRecord)._metadata);
  const segment = namespaceSegment(legacy);
  return { upload: {
    manifest: {
      version: Math.max(1, Math.round(firstNumber(source.version) ?? 1)),
      label: firstString(source.label, source.name) ?? "Match tracking",
      width: Math.max(1, Math.round(suppliedWidth)),
      height: Math.max(1, Math.round(suppliedHeight)),
      frameRate: suppliedFrameRate,
      frameCount: Math.max(1, Math.round(firstNumber(source.frameCount, source.frames) ?? firstNumber(sourceMeta.frameCount) ?? segment.endFrame + 1)),
      duration: firstNumber(source.duration) ?? firstNumber(sourceMeta.duration) ?? segment.endSeconds,
      matchOffset: firstNumber(source.matchOffset, source.match_offset) ?? 0,
       ...(pitchModel.model ? { pitchModel: pitchModel.model } : {}),
      videoStartSeconds: Math.max(0, firstNumber(
        source.videoStartSeconds, source.video_start_seconds, source.videoOffset,
      ) ?? 0),
      segmentCount: 1,
      segments: [{
        index: 0,
        name: segment.name,
        startFrame: segment.startFrame,
        endFrame: segment.endFrame,
        startSeconds: segment.startSeconds,
        endSeconds: segment.endSeconds,
        objectPath: "",
      }],
    },
    segments: [segment],
  }, error: null };
}

export function parseZipBundleDetailed(buffer: Buffer): { upload: UploadBundle | null; error: string | null } {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipBundleEntries(buffer);
  } catch (error) {
    return {
      upload: null,
      error: error instanceof BundleParseError ? error.message : "The ZIP could not be safely decompressed",
    };
  }

  const manifestNames = ["manifest.json", "tracking-manifest.json"].filter((name) => Boolean(entries[name]));
  if (manifestNames.length > 1) {
    return { upload: null, error: "The ZIP contains duplicate manifest files" };
  }
  const manifestName = manifestNames[0];
  if (!manifestName) {
    return { upload: null, error: "The ZIP is missing manifest.json" };
  }
  if (entries[manifestName].byteLength > MAX_MANIFEST_BYTES) {
    return { upload: null, error: "The manifest exceeds the 1 MB decompressed limit" };
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(strFromU8(entries[manifestName]));
  } catch {
    return { upload: null, error: "The manifest is not valid JSON" };
  }
  const rawManifest = asRecord(manifest);
  const zipFrameRate = firstNumber(rawManifest.frameRate, rawManifest.fps, rawManifest.videoFps);
  const zipWidth = firstNumber(rawManifest.width, rawManifest.videoWidth);
  const zipHeight = firstNumber(rawManifest.height, rawManifest.videoHeight);
  if (zipFrameRate === undefined) return { upload: null, error: "Manifest frame rate is required" };
  if (zipWidth === undefined) return { upload: null, error: "Manifest width is required" };
  if (zipHeight === undefined) return { upload: null, error: "Manifest height is required" };
  const pitchModel = parsePitchModel(rawManifest.pitchModel ?? rawManifest.pitch_model);
  if (pitchModel.error) return { upload: null, error: pitchModel.error };
  if (pitchModel.model) {
    const framingError = pitchModelFramingError(pitchModel.model, zipWidth, zipHeight);
    if (framingError) return { upload: null, error: framingError };
  }
  const rawSegments = Array.isArray(rawManifest.segments) ? rawManifest.segments : [];
  if (rawSegments.length === 0) {
    return { upload: null, error: "The manifest must list at least one segment" };
  }
  if (rawSegments.length > MAX_BUNDLE_SEGMENTS) {
    return { upload: null, error: `The bundle contains too many segments (maximum ${MAX_BUNDLE_SEGMENTS})` };
  }
  const declaredSegmentCount = firstNumber(rawManifest.segmentCount);
  if (
    declaredSegmentCount !== undefined
    && (!Number.isInteger(declaredSegmentCount) || declaredSegmentCount !== rawSegments.length)
  ) {
    return { upload: null, error: "Manifest segment count does not match the uploaded files" };
  }

  const selectedEntries = new Set([manifestName]);
  const segments: TrackingSegmentPayload[] = [];
  const sprites: Record<number, unknown> = {};
  for (let index = 0; index < rawSegments.length; index++) {
    const entry = asRecord(rawSegments[index]);
    const startFrame = Math.max(0, Math.round(firstNumber(entry.startFrame, entry.start_frame) ?? 0));
    const endFrame = Math.max(startFrame, Math.round(firstNumber(entry.endFrame, entry.end_frame) ?? startFrame));
    const startSeconds = Math.max(0, firstNumber(entry.startSeconds, entry.start_seconds) ?? startFrame / zipFrameRate);
    const endSeconds = Math.max(startSeconds, firstNumber(entry.endSeconds, entry.end_seconds) ?? (endFrame + 1) / zipFrameRate);
    const name = firstString(entry.name) ?? `segment-${String(index + 1).padStart(2, "0")}`;
    if (!isSafeBundleEntryName(name) || name.includes("/")) {
      return { upload: null, error: `Segment ${index + 1} has an unsafe name` };
    }

    const matchingEntries = entryNamesForSegment(entry, index, name)
      .filter((candidate) => Boolean(entries[candidate]));
    if (matchingEntries.length > 1) {
      return { upload: null, error: `Segment ${index + 1} has duplicate data files` };
    }
    const jsonEntry = matchingEntries[0];
    if (!jsonEntry) {
      return { upload: null, error: `Segment ${index + 1} is missing its JSON file` };
    }
    if (selectedEntries.has(jsonEntry)) {
      return { upload: null, error: `Segment ${index + 1} reuses a data file already assigned to another bundle entry` };
    }
    selectedEntries.add(jsonEntry);

    let segmentSource: unknown;
    try {
      const bytes = entries[jsonEntry];
      segmentSource = jsonEntry.endsWith(".gz")
        ? JSON.parse(new TextDecoder().decode(gunzipForZip(bytes)))
        : JSON.parse(strFromU8(bytes));
    } catch (error) {
      if (error instanceof BundleParseError) {
        return { upload: null, error: error.message };
      }
      return { upload: null, error: `Segment ${index + 1} is not valid JSON or gzip` };
    }
    const segment = parseSegment(segmentSource, index, name, startFrame, endFrame, startSeconds, endSeconds);
    if (!segment) {
      return { upload: null, error: `Segment ${index + 1} does not match the tracking schema` };
    }
    segments.push(namespaceSegment(segment));

    const spriteCandidates = [...new Set([
      `sprites/${name}.json`,
      `sprites/segment-${String(index + 1).padStart(2, "0")}.json`,
    ])];
    const matchingSpriteEntries = spriteCandidates.filter((candidate) => Boolean(entries[candidate]));
    if (matchingSpriteEntries.length > 1) {
      return { upload: null, error: `Segment ${index + 1} has duplicate sprite files` };
    }
    const spriteEntry = matchingSpriteEntries[0];
    if (spriteEntry) {
      if (selectedEntries.has(spriteEntry)) {
        return { upload: null, error: `Segment ${index + 1} reuses a sprite file already assigned to another bundle entry` };
      }
      selectedEntries.add(spriteEntry);
      try {
        const raw = JSON.parse(strFromU8(entries[spriteEntry])) as Record<string, unknown>;
        const prefix = `s${index}:`;
        const namespaced: Record<string, unknown> = {};
        for (const [trackId, strips] of Object.entries(raw)) {
          namespaced[trackId.startsWith(prefix) ? trackId : `${prefix}${trackId}`] = strips;
        }
        sprites[index] = namespaced;
      } catch {
        // A broken optional sprite file does not invalidate tracking data.
      }
    }
  }

  const declaredFrameCount = firstNumber(rawManifest.frameCount, rawManifest.frames);
  if (declaredFrameCount !== undefined && (!Number.isInteger(declaredFrameCount) || declaredFrameCount < 1)) {
    return { upload: null, error: "Manifest frame count must be a positive integer" };
  }
  const lastSegment = segments.at(-1)!;
  if (declaredFrameCount !== undefined && declaredFrameCount < lastSegment.endFrame + 1) {
    return { upload: null, error: "Manifest frame count is smaller than the uploaded segment coverage" };
  }
  const declaredDuration = firstNumber(rawManifest.duration);
  if (declaredDuration !== undefined && (!Number.isFinite(declaredDuration) || declaredDuration <= 0)) {
    return { upload: null, error: "Manifest duration must be a positive number" };
  }
  if (declaredDuration !== undefined && declaredDuration < lastSegment.endSeconds) {
    return { upload: null, error: "Manifest duration is shorter than the uploaded segment coverage" };
  }

  return {
    upload: {
      sprites,
      manifest: {
        version: Math.max(1, Math.round(firstNumber(rawManifest.version) ?? 1)),
        label: firstString(rawManifest.label, rawManifest.name) ?? "Match tracking",
         width: Math.max(1, Math.round(zipWidth)),
         height: Math.max(1, Math.round(zipHeight)),
         frameRate: zipFrameRate,
        frameCount: Math.max(1, Math.round(firstNumber(rawManifest.frameCount, rawManifest.frames) ?? segments.at(-1)!.endFrame + 1)),
        duration: Math.max(firstNumber(rawManifest.duration) ?? 0, segments.at(-1)!.endSeconds),
        matchOffset: firstNumber(rawManifest.matchOffset, rawManifest.match_offset) ?? 0,
         ...(pitchModel.model ? { pitchModel: pitchModel.model } : {}),
        videoStartSeconds: Math.max(0, firstNumber(
          rawManifest.videoStartSeconds,
          rawManifest.video_start_seconds,
          rawManifest.videoOffset,
          rawManifest.offsetSec,
        ) ?? 0),
        segmentCount: segments.length,
        segments: segments.map((segment) => ({
          index: segment.segmentIndex,
          name: segment.name,
          startFrame: segment.startFrame,
          endFrame: segment.endFrame,
          startSeconds: segment.startSeconds,
          endSeconds: segment.endSeconds,
          objectPath: "",
        })),
      },
      segments,
    },
    error: null,
  };
}

export function parseZipBundle(buffer: Buffer): UploadBundle | null {
  return parseZipBundleDetailed(buffer).upload;
}

function gunzipForZip(bytes: Uint8Array): Uint8Array {
  try {
    return nodeGunzipSync(bytes, { maxOutputLength: MAX_BUNDLE_ENTRY_BYTES });
  } catch {
    throw new BundleParseError(`A gzipped segment is invalid or exceeds the ${MAX_BUNDLE_ENTRY_BYTES / (1024 * 1024)} MB decompressed limit`);
  }
}

function recordingIdFromRequest(value: string | string[]): number | null {
  const id = parseId(value);
  return id;
}

function toRecording(
  recording: typeof recordingsTable.$inferSelect,
  fieldName: string | null,
) {
  let clientVideoUrl = recording.videoUrl;
  try {
    const parsed = new URL(recording.videoUrl);
    if (parsed.hostname.endsWith(".b-cdn.net") && parsed.pathname.endsWith(".m3u8")) {
      clientVideoUrl = `/api/hls-proxy/manifest?url=${encodeURIComponent(recording.videoUrl)}`;
    }
  } catch {
    // Non-URL sources (for example an internal MP4) are already browser-safe.
  }
  return {
    id: recording.id,
    fieldId: recording.fieldId,
    court: recording.court,
    date: recording.date,
    timeSlot: recording.timeSlot,
    duration: recording.duration,
    score: recording.score ?? null,
    videoUrl: clientVideoUrl,
    highlightMoment: recording.highlightMoment ?? null,
    fieldName,
  };
}

function toProgress(row: typeof claimMatchProgressTable.$inferSelect | null, recordingId: number) {
  return {
    recordingId,
    currentTrackId: row?.currentTrackId ?? null,
    stage: row?.stage ?? "find",
    confirmedFromSeconds: row?.confirmedFromSeconds ?? 0,
    currentPositionSeconds: row?.currentPositionSeconds ?? 0,
    claimedPercent: row?.claimedPercent ?? 0,
    coverageSeconds: 0,
    coveragePercent: row?.claimedPercent ?? 0,
    offPitchSeconds: 0,
    answeredAnchorCount: 0,
    acceptedAnchorCount: 0,
    unresolvedMoments: [],
    conflictMoments: [],
    identityBinding: null,
    clipsUnlocked: row?.clipsUnlocked ?? 0,
    correctionCount: row?.correctionCount ?? 0,
    completed: row?.completed ?? false,
    earnedClips: row?.earnedClips ?? [],
    completionReason: row?.completed ? "coverage-threshold" : "keep-confirming",
    playerStats: {
      confirmedSeconds: 0,
      minutesPlayed: 0,
      coveragePercent: row?.claimedPercent ?? 0,
      answeredMoments: 0,
      acceptedMoments: 0,
      trackedSegments: 0,
      totalSegments: 0,
      matchedEvents: 0,
      heatmap: { coordinateSpace: "camera" as const, cells: [] },
      distanceMetres: null,
      averageSpeedMetresPerSecond: null,
      touches: unavailablePlayerMetric(),
      passes: unavailablePlayerMetric(),
      shots: unavailablePlayerMetric(),
      dribbles: unavailablePlayerMetric(),
    },
    adminPlayerStats: {
      topSpeedMetresPerSecond: null,
      topSpeedUsableTimeFraction: null,
    },
    updatedAt: row?.updatedAt.toISOString() ?? new Date().toISOString(),
  };
}

function toIdentityBinding(row: ClaimIdentityBindingRow | null) {
  if (!row) return null;
  return {
    id: row.id,
    personId: row.personId,
    trackingBundleId: row.trackingBundleId,
    bundleFingerprint: row.bundleFingerprint,
    resolutionMethod: row.resolutionMethod as ClaimIdentityResolutionMethod,
    supportCount: row.supportCount,
    acceptedAnswerCount: row.acceptedAnswerCount,
    supportPercent: row.supportPercent,
    vouchedFragments: canonicalVouchedFragments(row.vouchedFragments),
    state: row.state as ClaimIdentityBindingState,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toCorrection(row: typeof claimMatchCorrectionsTable.$inferSelect) {
  return {
    id: row.id,
    clientId: row.clientId,
    recordingId: row.recordingId,
    momentSeconds: row.momentSeconds,
    rejectedTrackId: row.rejectedTrackId ?? null,
    chosenTrackId: row.chosenTrackId,
    answerMethod: row.answerMethod,
    questionCount: row.questionCount,
    undone: row.undone,
    createdAt: row.createdAt.toISOString(),
  };
}

async function getRecordingBundle(recordingId: number) {
  const [row] = await db
    .select({
      recording: recordingsTable,
      fieldName: fieldsTable.name,
      bundle: recordingTrackingBundlesTable,
    })
    .from(recordingsTable)
    .leftJoin(fieldsTable, eq(fieldsTable.id, recordingsTable.fieldId))
    .leftJoin(
      recordingTrackingBundlesTable,
      eq(recordingTrackingBundlesTable.recordingId, recordingsTable.id),
    )
    .where(eq(recordingsTable.id, recordingId));
  return row ?? null;
}

async function getVisibleRecordingBundle(recordingId: number) {
  const row = await getRecordingBundle(recordingId);
  if (!row || !(await isRecordingVisible(row.recording))) return null;
  return row;
}

async function getClaimMatchBundleForRequest(
  req: Parameters<typeof getLocalUserId>[0],
  recordingId: number,
) {
  const row = await getRecordingBundle(recordingId);
  if (!row) {
    return { row: null, error: "Recording not found", code: "recording_not_found" as const };
  }
  if (!row.bundle?.manifest) {
    return {
      row,
      error: "No tracking bundle has been uploaded for this recording",
      code: "tracking_bundle_missing" as const,
    };
  }
  // Admins use this read path to validate a bundle before player visibility is
  // enabled. Ordinary account users remain subject to the recording schedule.
  if (await requireAdmin(req)) return { row, error: null, code: null };
  if (!(await isRecordingVisible(row.recording))) {
    return {
      row,
      error: "Recording is not visible to players yet",
      code: "recording_not_visible" as const,
    };
  }
  return { row, error: null, code: null };
}

async function getDemoRecordingId(): Promise<number | null> {
  const bundles = await db
    .select({ recordingId: recordingTrackingBundlesTable.recordingId })
    .from(recordingTrackingBundlesTable)
    .orderBy(asc(recordingTrackingBundlesTable.recordingId));
  for (const candidate of bundles) {
    if (await getVisibleRecordingBundle(candidate.recordingId)) return candidate.recordingId;
  }
  return null;
}

async function getBundleSegments(bundleId: number) {
  return db
    .select()
    .from(recordingTrackingSegmentsTable)
    .where(eq(recordingTrackingSegmentsTable.bundleId, bundleId))
    .orderBy(asc(recordingTrackingSegmentsTable.segmentIndex));
}

async function readBundleSegments(bundleId: number): Promise<TrackingSegmentPayload[]> {
  const rows = await getBundleSegments(bundleId);
  const segments: TrackingSegmentPayload[] = [];
  for (const row of rows) {
    const body = await readClaimSegment(row.objectPath);
    segments.push(JSON.parse(body.toString("utf8")) as TrackingSegmentPayload);
  }
  return segments;
}

function stateSegmentsFromSummary(summary: TrackingBundleSummary): TrackingBundleSummary["segments"] {
  return summary.segments;
}

async function getClaimStateSegments(
  bundle: typeof recordingTrackingBundlesTable.$inferSelect,
): Promise<TrackingBundleSummary["segments"]> {
  if (bundle.manifest.summary?.segments?.length) {
    return stateSegmentsFromSummary(bundle.manifest.summary);
  }
  // Older bundles have no index yet. They are read once for compatibility;
  // every newly stored bundle carries the compact summary above.
  return readBundleSegments(bundle.id);
}

async function manifestWithBundleFingerprint(
  bundle: typeof recordingTrackingBundlesTable.$inferSelect,
): Promise<TrackingManifest> {
  const existing = bundle.manifest.provenance?.bundleFingerprint;
  if (typeof existing === "string" && existing.length > 0) return bundle.manifest;
  const segments = bundle.manifest.summary?.segments?.length
    ? bundle.manifest.summary.segments
    : await readBundleSegments(bundle.id);
  return {
    ...bundle.manifest,
    provenance: {
      ...(bundle.manifest.provenance ?? {}),
      bundleFingerprint: trackingBundleFingerprint(bundle.manifest, segments),
    },
  };
}

// The demo deliberately resolves to the first real uploaded bundle. It never
// manufactures a recording or synthetic player metrics, so Mohammed's sample
// can be opened through one stable URL after an admin uploads it.
router.get("/claim-match/demo", async (req, res): Promise<void> => {
  const userId = await requireAccountUser(req);
  if (!userId) {
    unauthenticatedResponse(res, req, "Authenticated account required");
    return;
  }
  const recordingId = await getDemoRecordingId();
  if (!recordingId) {
    res.status(404).json({ error: "No tracking bundle has been uploaded yet" });
    return;
  }
  res.redirect(307, `/api/recordings/${recordingId}/claim-match`);
});

router.post("/claim-match/demo/reset", async (req, res): Promise<void> => {
  const userId = await requireAccountUser(req);
  if (!userId) {
    unauthenticatedResponse(res, req, "Authenticated account required");
    return;
  }
  const recordingId = await getDemoRecordingId();
  if (!recordingId) {
    res.status(404).json({ error: "No tracking bundle has been uploaded yet" });
    return;
  }

  await db.transaction(async (tx) => {
    await tx
      .delete(claimMatchCorrectionsTable)
      .where(and(
        eq(claimMatchCorrectionsTable.userId, userId),
        eq(claimMatchCorrectionsTable.recordingId, recordingId),
      ));
    await tx
      .delete(claimMatchProgressTable)
      .where(and(
        eq(claimMatchProgressTable.userId, userId),
        eq(claimMatchProgressTable.recordingId, recordingId),
      ));
    await tx
      .delete(claimMatchIdentityBindingsTable)
      .where(and(
        eq(claimMatchIdentityBindingsTable.userId, userId),
        eq(claimMatchIdentityBindingsTable.recordingId, recordingId),
      ));
    await tx
      .delete(claimMatchOffPitchSpansTable)
      .where(and(
        eq(claimMatchOffPitchSpansTable.userId, userId),
        eq(claimMatchOffPitchSpansTable.recordingId, recordingId),
      ));
  });

  res.json({ recordingId, reset: true });
});

router.get("/claim-match/clips", async (req, res): Promise<void> => {
  const userId = await requireAccountUser(req);
  if (!userId) {
    unauthenticatedResponse(res, req, "Authenticated account required");
    return;
  }

  const rows = await db
    .select({
      progress: claimMatchProgressTable,
      bindingState: claimMatchIdentityBindingsTable.state,
      recording: recordingsTable,
      fieldName: fieldsTable.name,
      bundleManifest: recordingTrackingBundlesTable.manifest,
    })
    .from(claimMatchProgressTable)
    .innerJoin(recordingsTable, eq(recordingsTable.id, claimMatchProgressTable.recordingId))
    .leftJoin(fieldsTable, eq(fieldsTable.id, recordingsTable.fieldId))
    .leftJoin(
      recordingTrackingBundlesTable,
      eq(recordingTrackingBundlesTable.recordingId, claimMatchProgressTable.recordingId),
    )
    .leftJoin(
      claimMatchIdentityBindingsTable,
      and(
        eq(claimMatchIdentityBindingsTable.userId, userId),
        eq(claimMatchIdentityBindingsTable.recordingId, claimMatchProgressTable.recordingId),
      ),
    )
    .where(eq(claimMatchProgressTable.userId, userId))
    .orderBy(desc(claimMatchProgressTable.updatedAt));

  const visibleRows = (await Promise.all(rows.map(async (row) => (
    await isRecordingVisible(row.recording) ? row : null
  )))).filter((row): row is (typeof rows)[number] => row !== null);

  const groups = (await Promise.all(visibleRows.map(async ({ progress, bindingState, recording, fieldName, bundleManifest }) => {
    if (bindingState !== "confirmed") return null;
    const clips = bundleManifest
      ? await materializeClaimMoments(userId, recording, bundleManifest, progress.earnedClips ?? [])
      : progress.earnedClips ?? [];
    if (clips.some((clip, index) => clip.userClipId !== (progress.earnedClips?.[index]?.userClipId))) {
      await db
        .update(claimMatchProgressTable)
        .set({ earnedClips: clips, updatedAt: new Date() })
        .where(eq(claimMatchProgressTable.id, progress.id));
    }
    return {
      recordingId: recording.id,
      recordingLabel: `${fieldName ?? "Match"} · ${recording.court}`,
      fieldName: fieldName ?? "Match",
      date: recording.date,
      clips,
    };
  })))
    .filter((group): group is NonNullable<typeof group> => group !== null && group.clips.length > 0);

  res.json(ListClaimMatchClipsResponse.parse(groups));
});

type ClaimStateSegment = TrackingBundleSummary["segments"][number];

function getMomentClips(
  segments: ClaimStateSegment[],
  momentSeconds: number,
  existing: ClaimEarnedClip[],
  playerIntervals: Array<{ startSeconds: number; endSeconds: number }> = [],
): ClaimEarnedClip[] {
  const newClips = segments.flatMap((segment) => segment.events)
    .filter((event) => ["goal", "shot", "kickoff", "second-half", "second_half"].includes(event.type.toLowerCase()))
    .filter((event) => Math.abs(event.time - momentSeconds) <= 12)
    .filter((event) => playerIntervals.length === 0 || playerIntervals.some((interval) =>
      event.time >= interval.startSeconds && event.time <= interval.endSeconds,
    ))
    .map((event) => ({
      id: event.clipId ?? `claim-${event.type}-${Math.round(event.time)}`,
      title: event.label ?? `${event.type.replace(/[-_]/g, " ")} at ${formatMoment(event.time)}`,
      momentSeconds: event.time,
      kind: event.type,
      status: "ready",
    }));
  const byId = new Map(existing.map((clip) => [clip.id, clip]));
  for (const clip of newClips) byId.set(clip.id, clip);
  return Array.from(byId.values()).sort((a, b) => a.momentSeconds - b.momentSeconds);
}

async function materializeClaimMoments(
  userId: number,
  recording: typeof recordingsTable.$inferSelect,
  manifest: TrackingManifest,
  clips: ClaimEarnedClip[],
): Promise<ClaimEarnedClip[]> {
  return Promise.all(clips.map(async (clip) => {
    if (clip.userClipId) return clip;
    try {
      const materialized = await ensureClaimMomentUserClip({
        userId,
        recording,
        moment: clip,
        videoStartSeconds: manifest.videoStartSeconds,
        trackingDuration: manifest.duration,
      });
      return { ...clip, userClipId: materialized.userClipId };
    } catch (error) {
      // A tracking event can still be displayed when its recording is not a
      // Bunny Stream asset. It simply cannot become a playable user clip yet.
      logger.warn(
        { error, userId, recordingId: recording.id, momentId: clip.id },
        "Could not materialize claim moment as a user clip",
      );
      return clip;
    }
  }));
}

type DerivedClaimState = {
  coverageSeconds: number;
  coveragePercent: number;
  offPitchSeconds: number;
  humanVouchedSeconds: number;
  inferredSeconds: number;
  vouchedFragments: ClaimVouchedFragment[];
  answeredAnchorCount: number;
  acceptedAnchorCount: number;
  unresolvedMoments: number[];
  conflictMoments: number[];
  identityResolution: ResolvedClaimIdentity | null;
  clipsUnlocked: number;
  correctionCount: number;
  completed: boolean;
  completionReason: string;
  earnedClips: ClaimEarnedClip[];
  playerStats: {
    confirmedSeconds: number;
    minutesPlayed: number;
    coveragePercent: number;
    answeredMoments: number;
    acceptedMoments: number;
    trackedSegments: number;
    totalSegments: number;
    matchedEvents: number;
    heatmap: {
      coordinateSpace: "pitch" | "camera";
      cells: Array<{ x: number; y: number; weight: number }>;
    };
    distanceMetres: number | null;
    averageSpeedMetresPerSecond: number | null;
    touches: UnavailablePlayerMetric;
    passes: UnavailablePlayerMetric;
    shots: UnavailablePlayerMetric;
    dribbles: UnavailablePlayerMetric;
  };
  adminPlayerStats: {
    topSpeedMetresPerSecond: number | null;
    topSpeedUsableTimeFraction: number | null;
  };
};

type UnavailablePlayerMetric = {
  value: null;
  available: false;
  unavailableReason: "ball_tracking_and_possession_attribution_unavailable";
};

export type ClaimVouchedFragment = {
  trackId: string;
  fromFrame: number;
  toFrame: number;
};

function unavailablePlayerMetric(): UnavailablePlayerMetric {
  return {
    value: null,
    available: false,
    unavailableReason: "ball_tracking_and_possession_attribution_unavailable",
  };
}

const EMPTY_ANCHOR_TRACK = "__none__";

export function isAcceptedClaimAnswer(row: typeof claimMatchCorrectionsTable.$inferSelect): boolean {
  return !row.undone
    && row.chosenTrackId !== EMPTY_ANCHOR_TRACK
    && row.answerMethod !== "anchor-no"
    && row.answerMethod !== "anchor-skip";
}

export function completionSurvivesConcurrentProgress(
  existingCompleted: boolean,
  derivedCompleted: boolean,
): boolean {
  return existingCompleted || derivedCompleted;
}

export function knownClaimTrackIds(
  manifest: TrackingManifest,
  segments: ClaimStateSegment[],
): Set<string> {
  return new Set([
    ...segments.flatMap((segment) => segment.tracks.map((track) => track.id)),
    ...(manifest.identities ?? []).map((identity) => identity.id),
  ]);
}

function usableIdentityMap(manifest: TrackingManifest): TrackingIdentity[] {
  const identities = manifest.identities;
  const provenance = manifest.provenance;
  if (!identities?.length) return [];
  if (
    typeof provenance?.bundleFingerprint !== "string"
    || typeof provenance.identityMapBundleFingerprint !== "string"
    || provenance.bundleFingerprint !== provenance.identityMapBundleFingerprint
  ) {
    return [];
  }
  return identities;
}

function canonicalIdentityParts(parts: TrackingIdentity["parts"]): string[] {
  return parts
    .map((part) => JSON.stringify([part.trackId, part.fromFrame, part.toFrame]))
    .sort();
}

function personPartsForResolution(manifest: TrackingManifest, personId: string): string[] {
  const identity = usableIdentityMap(manifest).find((item) => item.id === personId);
  return identity ? canonicalIdentityParts(identity.parts) : [];
}

function canonicalVouchedFragments(
  fragments: ClaimVouchedFragment[] | null | undefined,
): ClaimVouchedFragment[] {
  const unique = new Map<string, ClaimVouchedFragment>();
  for (const fragment of fragments ?? []) {
    const fromFrame = Math.max(0, Math.round(fragment.fromFrame));
    const toFrame = Math.max(fromFrame, Math.round(fragment.toFrame));
    const normalized = { trackId: fragment.trackId, fromFrame, toFrame };
    unique.set(JSON.stringify([normalized.trackId, normalized.fromFrame, normalized.toFrame]), normalized);
  }
  return [...unique.values()].sort((a, b) =>
    a.trackId.localeCompare(b.trackId) || a.fromFrame - b.fromFrame || a.toFrame - b.toFrame);
}

function fragmentOverlap(a: ClaimVouchedFragment, b: ClaimVouchedFragment): boolean {
  return a.trackId === b.trackId && a.fromFrame <= b.toFrame && b.fromFrame <= a.toFrame;
}

export function vouchedFragmentsOverlap(
  left: ClaimVouchedFragment[] | null | undefined,
  right: ClaimVouchedFragment[] | null | undefined,
): boolean {
  return canonicalVouchedFragments(left).some((a) =>
    canonicalVouchedFragments(right).some((b) => fragmentOverlap(a, b)));
}

/**
 * A map update is safe when every frame that a player directly vouched for
 * still belongs to the same identity row. Unvouched parts are intentionally
 * ignored, so regrouping can continue around the protected fragments.
 */
export function identityMapMovesVouchedFragment(
  binding: Pick<ClaimIdentityBindingRow, "personId" | "vouchedFragments">,
  incomingIdentities: TrackingIdentity[],
): boolean {
  return canonicalVouchedFragments(binding.vouchedFragments).some((fragment) => {
    const overlappingParts = incomingIdentities.flatMap((identity) =>
      identity.parts
        .filter((part) =>
          part.trackId === fragment.trackId
          && part.fromFrame <= fragment.toFrame
          && part.toFrame >= fragment.fromFrame)
        .map((part) => ({ ...part, identityId: identity.id })));
    if (overlappingParts.some((part) => part.identityId !== binding.personId)) return true;
    const ownerParts = overlappingParts
      .filter((part) => part.identityId === binding.personId)
      .sort((a, b) => a.fromFrame - b.fromFrame);
    let coveredThrough = fragment.fromFrame - 1;
    for (const part of ownerParts) {
      if (part.fromFrame > coveredThrough + 1) return true;
      coveredThrough = Math.max(coveredThrough, Math.min(fragment.toFrame, part.toFrame));
      if (coveredThrough >= fragment.toFrame) return false;
    }
    return true;
  });
}

/** @deprecated Use identityMapMovesVouchedFragment; person rows are no longer frozen. */
export function identityMapInvalidatesBinding(
  binding: Pick<ClaimIdentityBindingRow, "personId" | "personParts">,
  incomingIdentities: TrackingIdentity[],
): boolean {
  const identity = incomingIdentities.find((item) => item.id === binding.personId);
  if (!identity) return true;
  const incomingParts = canonicalIdentityParts(identity.parts);
  return incomingParts.length !== binding.personParts.length
    || incomingParts.some((part, index) => part !== binding.personParts[index]);
}

function resolvePersonForTrack(
  manifest: TrackingManifest,
  chosenTrackId: string,
  momentSeconds?: number,
): { personId: string; resolutionMethod: ClaimIdentityResolutionMethod } {
  const identities = usableIdentityMap(manifest);
  const direct = identities.find((identity) => identity.id === chosenTrackId);
  if (direct) return { personId: direct.id, resolutionMethod: "identity-map" };
  const frame = momentSeconds === undefined
    ? undefined
    : Math.max(0, Math.round(momentSeconds * Math.max(manifest.frameRate, 0.001)));
  const mapped = identities.find((identity) =>
    identity.parts.some((part) =>
      part.trackId === chosenTrackId
      && (frame === undefined || (frame >= part.fromFrame && frame <= part.toFrame))),
  );
  if (mapped) return { personId: mapped.id, resolutionMethod: "identity-map" };
  return { personId: chosenTrackId, resolutionMethod: "track-fallback" };
}

export type ResolvedClaimIdentity = {
  personId: string;
  resolutionMethod: ClaimIdentityResolutionMethod;
  supportCount: number;
  acceptedAnswerCount: number;
  supportPercent: number;
  conflictMoments: number[];
};

type IdentityCandidateSupport = {
  count: number;
  latestCreatedAt: number;
  resolutionMethod: ClaimIdentityResolutionMethod;
};

type ClaimIdentityEvidence = {
  usableAnswers: typeof claimMatchCorrectionsTable.$inferSelect[];
  rankedCandidates: Array<[string, IdentityCandidateSupport]>;
};

function claimIdentityEvidence(
  manifest: TrackingManifest,
  segments: ClaimStateSegment[],
  accepted: typeof claimMatchCorrectionsTable.$inferSelect[],
): ClaimIdentityEvidence {
  const knownTrackIds = new Set(segments.flatMap((segment) => segment.tracks.map((track) => track.id)));
  const identities = usableIdentityMap(manifest);
  for (const identity of identities) {
    knownTrackIds.add(identity.id);
  }
  const usableAnswers = accepted.filter((row) =>
    knownTrackIds.has(row.chosenTrackId)
    || trackIntervalsForId(manifest, segments, row.chosenTrackId).length > 0,
  );
  const candidates = new Map<string, IdentityCandidateSupport>();
  for (const row of usableAnswers) {
    const resolved = resolvePersonForTrack(manifest, row.chosenTrackId, row.momentSeconds);
    const previous = candidates.get(resolved.personId);
    candidates.set(resolved.personId, {
      count: (previous?.count ?? 0) + 1,
      latestCreatedAt: Math.max(previous?.latestCreatedAt ?? 0, row.createdAt.getTime()),
      resolutionMethod: previous?.resolutionMethod ?? resolved.resolutionMethod,
    });
  }
  const rankedCandidates = [...candidates.entries()]
    .sort(([personA, a], [personB, b]) =>
      b.count - a.count
      || b.latestCreatedAt - a.latestCreatedAt
      || personA.localeCompare(personB),
    );
  return { usableAnswers, rankedCandidates };
}

function ambiguousClaimMoments(evidence: ClaimIdentityEvidence): number[] {
  const winner = evidence.rankedCandidates[0];
  if (!winner || evidence.rankedCandidates[1]?.[1].count !== winner[1].count) return [];
  return [...new Set(evidence.usableAnswers.map((row) => row.momentSeconds))]
    .sort((a, b) => a - b)
    .slice(0, 50);
}

export function resolveClaimIdentity(
  manifest: TrackingManifest,
  segments: ClaimStateSegment[],
  accepted: typeof claimMatchCorrectionsTable.$inferSelect[],
): ResolvedClaimIdentity | null {
  const { usableAnswers, rankedCandidates } = claimIdentityEvidence(manifest, segments, accepted);
  if (usableAnswers.length === 0) return null;

  // A tie is not evidence. Do not let deterministic ordering turn equal
  // support into a person assignment; the user must answer again.
  const winner = rankedCandidates[0];
  if (!winner || rankedCandidates[1]?.[1].count === winner[1].count) return null;

  const [personId, support] = winner;
  const conflictMoments = usableAnswers
     .filter((row) => resolvePersonForTrack(manifest, row.chosenTrackId, row.momentSeconds).personId !== personId)
    .map((row) => row.momentSeconds)
    .sort((a, b) => a - b);
  return {
    personId,
    resolutionMethod: support.resolutionMethod,
    supportCount: support.count,
    // This count describes the resolved person, not every accepted answer
    // that happened to be submitted while resolving the claim. Conflicting
    // answers remain visible through conflictMoments and supportPercent.
    acceptedAnswerCount: support.count,
    supportPercent: Math.round((support.count / usableAnswers.length) * 10000) / 100,
    conflictMoments: [...new Set(conflictMoments)].slice(0, 50),
  };
}

function latestAnchorAnswers(
  rows: typeof claimMatchCorrectionsTable.$inferSelect[],
): typeof claimMatchCorrectionsTable.$inferSelect[] {
  const latestByMoment = new Map<number, typeof claimMatchCorrectionsTable.$inferSelect>();
  for (const row of rows) {
    if (row.undone || !row.answerMethod.startsWith("anchor-")) continue;
    const previous = latestByMoment.get(row.momentSeconds);
    if (
      !previous
      || row.createdAt.getTime() > previous.createdAt.getTime()
      || (row.createdAt.getTime() === previous.createdAt.getTime() && row.id > previous.id)
    ) {
      latestByMoment.set(row.momentSeconds, row);
    }
  }
  return Array.from(latestByMoment.values());
}

function trackIntervalsForId(
  manifest: TrackingManifest,
  segments: ClaimStateSegment[],
  trackId: string,
): Array<{ startSeconds: number; endSeconds: number }> {
  const frameRate = Math.max(manifest.frameRate, 0.001);
  const intervals: Array<{ startSeconds: number; endSeconds: number }> = [];
  for (const segment of segments) {
    const track = segment.tracks.find((item) => item.id === trackId);
    if (track) {
      intervals.push({
        startSeconds: Math.max(0, track.startFrame / frameRate),
        endSeconds: Math.min(manifest.duration, (track.endFrame + 1) / frameRate),
      });
    }
  }
  const identity = usableIdentityMap(manifest).find((item) => item.id === trackId);
  if (identity) {
    for (const part of identity.parts) {
      for (const segment of segments) {
        const track = segment.tracks.find((item) => item.id === part.trackId);
        if (!track) continue;
        const startFrame = Math.max(track.startFrame, part.fromFrame);
        const endFrame = Math.min(track.endFrame, part.toFrame);
        if (endFrame >= startFrame) {
          intervals.push({
            startSeconds: Math.max(0, startFrame / frameRate),
            endSeconds: Math.min(manifest.duration, (endFrame + 1) / frameRate),
          });
        }
      }
    }
  }
  return intervals;
}

function boxForFrame(
  boxes: TrackingSegmentPayload["tracks"][number]["boxes"],
  frame: number,
): number {
  let bestIndex = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  boxes.forEach((box, index) => {
    const distance = Math.abs(box.frame - frame);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  });
  return bestIndex;
}

/**
 * Capture the actual uninterrupted detection run containing an accepted
 * answer. Track start/end summaries are not sufficient here: a track may
 * disappear for several frames and return later.
 */
export function vouchedFragmentForAnswer(
  manifest: TrackingManifest,
  fullSegments: TrackingSegmentPayload[],
  answer: Pick<typeof claimMatchCorrectionsTable.$inferSelect, "momentSeconds" | "chosenTrackId">,
): ClaimVouchedFragment | null {
  const frameRate = Math.max(manifest.frameRate, 0.001);
  const targetFrame = Math.max(0, Math.round(answer.momentSeconds * frameRate));
  const identities = usableIdentityMap(manifest);
  const directTrack = fullSegments
    .flatMap((segment) => segment.tracks)
    .find((track) => track.id === answer.chosenTrackId);
  const identity = identities.find((item) => item.id === answer.chosenTrackId);
  const possibleParts = identity?.parts.filter((part) =>
    targetFrame >= part.fromFrame && targetFrame <= part.toFrame) ?? [];

  let selectedTrack: TrackingSegmentPayload["tracks"][number] | undefined = directTrack;
  let selectedPart: TrackingIdentity["parts"][number] | undefined;
  if (!selectedTrack && possibleParts.length > 0) {
    for (const part of possibleParts) {
      const track = fullSegments
        .flatMap((segment) => segment.tracks)
        .find((candidate) =>
          candidate.id === part.trackId
          && candidate.boxes.some((box) => box.frame >= part.fromFrame && box.frame <= part.toFrame));
      if (track) {
        selectedTrack = track;
        selectedPart = part;
        break;
      }
    }
  }
  if (!selectedTrack) {
    // A browser can answer with an identity id even when the frame is just
    // outside a persisted part due to rounding. Fall back to the closest
    // source track that contributes to that identity.
    const parts = identity?.parts ?? [];
    for (const part of parts) {
      const track = fullSegments.flatMap((segment) => segment.tracks).find((candidate) => candidate.id === part.trackId);
      if (track) {
        selectedTrack = track;
        selectedPart = part;
        break;
      }
    }
  }
  if (!selectedTrack) return null;

  const boxes = [...selectedTrack.boxes]
    .filter((box) => !selectedPart || (box.frame >= selectedPart.fromFrame && box.frame <= selectedPart.toFrame))
    .sort((a, b) => a.frame - b.frame);
  const index = boxForFrame(boxes, targetFrame);
  if (index < 0) return null;

  let start = index;
  let end = index;
  while (start > 0 && boxes[start].frame - boxes[start - 1].frame <= 1) start -= 1;
  while (end + 1 < boxes.length && boxes[end + 1].frame - boxes[end].frame <= 1) end += 1;
  return {
    trackId: selectedTrack.id,
    fromFrame: boxes[start].frame,
    toFrame: boxes[end].frame,
  };
}

function unionFragmentSeconds(
  manifest: TrackingManifest,
  fragments: ClaimVouchedFragment[],
): number {
  const frameRate = Math.max(manifest.frameRate, 0.001);
  const intervals = canonicalVouchedFragments(fragments)
    .map((fragment) => ({
      start: Math.max(0, fragment.fromFrame / frameRate),
      end: Math.min(manifest.duration, (fragment.toFrame + 1) / frameRate),
    }))
    .filter((interval) => interval.end > interval.start)
    .sort((a, b) => a.start - b.start);
  let total = 0;
  let end = 0;
  for (const interval of intervals) {
    if (interval.start > end) {
      total += interval.end - interval.start;
      end = interval.end;
    } else if (interval.end > end) {
      total += interval.end - end;
      end = interval.end;
    }
  }
  return Math.round(total * 100) / 100;
}

type PositionSample = { frame: number; x: number; y: number };
type MappedPosition = PositionSample & { pitchX: number; pitchY: number; nx: number; ny: number };

function interpolatePitchPosition(
  x: number,
  y: number,
  manifest: TrackingManifest,
): { x: number; y: number } | null {
  const model = manifest.pitchModel;
  if (!model || model.grid.length < 2 || model.grid[0].length < 2) return null;
  const columns = model.grid[0].length;
  if (model.grid.some((row) => row.length !== columns || row.length < 2)) return null;
  const u = Math.max(0, Math.min(1, x / Math.max(manifest.width, 1)));
  const v = Math.max(0, Math.min(1, y / Math.max(manifest.height, 1)));
  const column = u * (columns - 1);
  const row = v * (model.grid.length - 1);
  const left = Math.floor(column);
  const top = Math.floor(row);
  const right = Math.min(columns - 1, left + 1);
  const bottom = Math.min(model.grid.length - 1, top + 1);
  const tx = column - left;
  const ty = row - top;
  const topLeft = model.grid[top][left];
  const topRight = model.grid[top][right];
  const bottomLeft = model.grid[bottom][left];
  const bottomRight = model.grid[bottom][right];
  return {
    x: (topLeft.x * (1 - tx) + topRight.x * tx) * (1 - ty)
      + (bottomLeft.x * (1 - tx) + bottomRight.x * tx) * ty,
    y: (topLeft.y * (1 - tx) + topRight.y * tx) * (1 - ty)
      + (bottomLeft.y * (1 - tx) + bottomRight.y * tx) * ty,
  };
}

function hasUsablePitchModel(manifest: TrackingManifest): boolean {
  const model = manifest.pitchModel;
  if (!model || model.grid.length < 2 || model.grid[0].length < 2) return false;
  const columns = model.grid[0].length;
  if (!model.grid.every((row) => row.length === columns && row.length >= 2)) return false;
  return !validatePitchModelForManifest(model, manifest.width, manifest.height);
}

function acceptedPositionSamples(
  manifest: TrackingManifest,
  fullSegments: TrackingSegmentPayload[],
  accepted: typeof claimMatchCorrectionsTable.$inferSelect[],
): PositionSample[] {
  const rangesByTrack = new Map<string, Array<[number, number]>>();
  const addRange = (trackId: string, fromFrame: number, toFrame: number) => {
    if (toFrame < fromFrame) return;
    (rangesByTrack.get(trackId) ?? (rangesByTrack.set(trackId, []), rangesByTrack.get(trackId)!))
      .push([fromFrame, toFrame]);
  };
  for (const row of accepted) {
    const identity = manifest.identities?.find((item) => item.id === row.chosenTrackId);
    if (identity) {
      identity.parts.forEach((part) => addRange(part.trackId, part.fromFrame, part.toFrame));
      continue;
    }
    for (const segment of fullSegments) {
      const track = segment.tracks.find((item) => item.id === row.chosenTrackId);
      if (track) addRange(track.id, track.startFrame, track.endFrame);
    }
  }

  const byFrame = new Map<number, PositionSample>();
  for (const segment of fullSegments) {
    for (const track of segment.tracks) {
      const ranges = rangesByTrack.get(track.id);
      if (!ranges?.length) continue;
      for (const box of track.boxes) {
        if (
          ranges.some(([fromFrame, toFrame]) => box.frame >= fromFrame && box.frame <= toFrame)
          && !byFrame.has(box.frame)
        ) {
          byFrame.set(box.frame, {
            frame: box.frame,
            // The bottom centre is the player's ground contact proxy. The box
            // centre is at chest height and creates a systematic pitch error.
            x: box.x + box.w / 2,
            y: box.y + box.h,
          });
        }
      }
    }
  }
  const ordered = [...byFrame.values()].sort((a, b) => a.frame - b.frame);
  const step = Math.max(1, Math.round(manifest.frameRate / 10));
  const sampled: PositionSample[] = [];
  for (const sample of ordered) {
    const previous = sampled.at(-1);
    if (!previous || sample.frame - previous.frame >= step) sampled.push(sample);
  }
  return sampled;
}

type SpeedSummary = {
  topSpeedMetresPerSecond: number | null;
  topSpeedUsableTimeFraction: number | null;
};

function topSpeedSummary(
  manifest: TrackingManifest,
  mapped: MappedPosition[],
  coveredSeconds: number,
): SpeedSummary {
  if (!hasUsablePitchModel(manifest) || mapped.length < 2) {
    return { topSpeedMetresPerSecond: null, topSpeedUsableTimeFraction: coveredSeconds > 0 ? 0 : null };
  }

  const maxDirectGapSeconds = Math.max(0.2, 3 / Math.max(manifest.frameRate, 0.001));
  const intervals = mapped.slice(1).map((current, index) => {
    const previous = mapped[index];
    const seconds = (current.frame - previous.frame) / Math.max(manifest.frameRate, 0.001);
    const distance = Math.hypot(current.pitchX - previous.pitchX, current.pitchY - previous.pitchY);
    const speed = seconds > 0 ? distance / seconds : Number.POSITIVE_INFINITY;
    const valid = seconds > 0
      && seconds <= maxDirectGapSeconds
      && speed <= 11
      // Image-space y increases toward the camera, so the far third is ny < 1/3.
      && previous.ny >= 1 / 3
      && current.ny >= 1 / 3;
    return { seconds, distance, speed, valid };
  });

  // A rejected sample invalidates its surrounding speed window. This prevents
  // an erroneous spike from being clipped into an apparently plausible sprint.
  for (let index = 0; index < intervals.length; index++) {
    if (!intervals[index].valid) {
      if (intervals[index - 1]) intervals[index - 1].valid = false;
      if (intervals[index + 1]) intervals[index + 1].valid = false;
    }
  }
  for (let index = 1; index < intervals.length; index++) {
    const previous = intervals[index - 1];
    const current = intervals[index];
    if (!previous.valid || !current.valid) continue;
    const elapsed = Math.max((previous.seconds + current.seconds) / 2, 0.001);
    if (Math.abs(current.speed - previous.speed) / elapsed > 10) {
      previous.valid = false;
      current.valid = false;
      if (intervals[index - 2]) intervals[index - 2].valid = false;
      if (intervals[index + 1]) intervals[index + 1].valid = false;
    }
  }

  const usableSeconds = intervals.reduce(
    (total, interval) => total + (interval.valid ? interval.seconds : 0),
    0,
  );
  let topSpeed: number | null = null;
  for (let start = 0; start < intervals.length; start++) {
    if (!intervals[start].valid) continue;
    let elapsed = 0;
    let distance = 0;
    for (let end = start; end < intervals.length && intervals[end].valid; end++) {
      const interval = intervals[end];
      if (elapsed + interval.seconds >= 1) {
        const remaining = 1 - elapsed;
        distance += interval.distance * (remaining / interval.seconds);
        const average = distance;
        topSpeed = topSpeed === null ? average : Math.max(topSpeed, average);
        break;
      }
      elapsed += interval.seconds;
      distance += interval.distance;
    }
  }
  return {
    topSpeedMetresPerSecond: topSpeed === null ? null : Math.round(topSpeed * 100) / 100,
    topSpeedUsableTimeFraction: coveredSeconds > 0
      ? Math.min(1, Math.max(0, Math.round((usableSeconds / coveredSeconds) * 10_000) / 10_000))
      : null,
  };
}

function buildPlayerMetrics(
  manifest: TrackingManifest,
  fullSegments: TrackingSegmentPayload[] | undefined,
  accepted: typeof claimMatchCorrectionsTable.$inferSelect[],
  coveredSeconds: number,
  coveragePercent: number,
  answeredMoments: number,
  acceptedMoments: number,
  trackedSegments: number,
  totalSegments: number,
  matchedEvents: number,
  humanVouchedSeconds: number,
  inferredSeconds: number,
  offPitchSpans: OffPitchSpan[],
) {
  const base = {
    confirmedSeconds: Math.round(coveredSeconds * 100) / 100,
    minutesPlayed: Math.round((coveredSeconds / 60) * 100) / 100,
    coveragePercent,
    answeredMoments,
    acceptedMoments,
    trackedSegments,
    totalSegments,
    matchedEvents,
  };
  const usablePitchModel = hasUsablePitchModel(manifest);
  const coordinateSpace = usablePitchModel ? "pitch" as const : "camera" as const;
  if (!fullSegments) {
    return {
      ...base,
      heatmap: { coordinateSpace, cells: [] },
      distanceMetres: null,
      averageSpeedMetresPerSecond: null,
      touches: unavailablePlayerMetric(),
      passes: unavailablePlayerMetric(),
      shots: unavailablePlayerMetric(),
      dribbles: unavailablePlayerMetric(),
      adminPlayerStats: {
        topSpeedMetresPerSecond: null,
        topSpeedUsableTimeFraction: null,
      },
    };
  }

  const raw = acceptedPositionSamples(manifest, fullSegments, accepted)
    .filter((sample) => !offPitchSpans.some((span) => {
      const seconds = sample.frame / Math.max(manifest.frameRate, 0.001);
      return seconds >= span.fromSeconds && seconds < span.toSeconds;
    }));
  const mapped: MappedPosition[] = [];
  for (const sample of raw) {
    const pitch = interpolatePitchPosition(sample.x, sample.y, manifest);
    if (usablePitchModel && !pitch) continue;
    const pitchX = pitch?.x ?? sample.x;
    const pitchY = pitch?.y ?? sample.y;
    mapped.push({
      ...sample,
      pitchX,
      pitchY,
      nx: usablePitchModel
        ? Math.max(0, Math.min(1, pitchX / manifest.pitchModel!.pitchWidthMetres))
        : Math.max(0, Math.min(1, sample.x / Math.max(manifest.width, 1))),
      ny: usablePitchModel
        ? Math.max(0, Math.min(1, pitchY / manifest.pitchModel!.pitchHeightMetres))
        : Math.max(0, Math.min(1, sample.y / Math.max(manifest.height, 1))),
    });
  }

  const smoothed: MappedPosition[] = [];
  const smoothingSeconds = 0.35;
  const maxGapSeconds = 2;
  for (const sample of mapped) {
    const previous = smoothed.at(-1);
    const gapSeconds = previous ? (sample.frame - previous.frame) / Math.max(manifest.frameRate, 0.001) : 0;
    if (!previous || gapSeconds > maxGapSeconds) {
      smoothed.push(sample);
      continue;
    }
    const alpha = 1 - Math.exp(-gapSeconds / smoothingSeconds);
    smoothed.push({
      ...sample,
      pitchX: previous.pitchX + (sample.pitchX - previous.pitchX) * alpha,
      pitchY: previous.pitchY + (sample.pitchY - previous.pitchY) * alpha,
      nx: previous.nx + (sample.nx - previous.nx) * alpha,
      ny: previous.ny + (sample.ny - previous.ny) * alpha,
    });
  }

  const bins = new Map<string, number>();
  let totalWeight = 0;
  for (let index = 0; index < smoothed.length; index++) {
    const sample = smoothed[index];
    const previous = smoothed[index - 1];
    const gapSeconds = previous ? (sample.frame - previous.frame) / Math.max(manifest.frameRate, 0.001) : 1 / Math.max(manifest.frameRate, 0.001);
    const weight = previous && gapSeconds <= maxGapSeconds ? Math.max(0, gapSeconds) : 1 / Math.max(manifest.frameRate, 0.001);
    const column = Math.min(11, Math.floor(sample.nx * 12));
    const row = Math.min(7, Math.floor(sample.ny * 8));
    const key = `${column}:${row}`;
    bins.set(key, (bins.get(key) ?? 0) + weight);
    totalWeight += weight;
  }
  const heatmap = {
    coordinateSpace,
    cells: [...bins.entries()]
      .map(([key, weight]) => {
        const [column, row] = key.split(":").map(Number);
        return {
          x: (column + 0.5) / 12,
          y: (row + 0.5) / 8,
          weight: totalWeight > 0 ? Math.round((weight / totalWeight) * 10000) / 10000 : 0,
        };
      })
      .sort((a, b) => b.weight - a.weight),
  };
  let distanceMetres: number | null = null;
  if (usablePitchModel) {
    distanceMetres = 0;
    for (let index = 1; index < smoothed.length; index++) {
      const previous = smoothed[index - 1];
      const current = smoothed[index];
      const gapSeconds = (current.frame - previous.frame) / Math.max(manifest.frameRate, 0.001);
      if (gapSeconds <= maxGapSeconds) {
        distanceMetres += Math.hypot(current.pitchX - previous.pitchX, current.pitchY - previous.pitchY);
      }
    }
    distanceMetres = Math.round(distanceMetres);
  }
  const averageSpeedMetresPerSecond = distanceMetres === null
    ? null
    : coveredSeconds > 0
      ? Math.round((distanceMetres / coveredSeconds) * 100) / 100
      : 0;
  const speedSummary = topSpeedSummary(manifest, mapped, coveredSeconds);
  return {
    ...base,
    heatmap,
    distanceMetres,
    averageSpeedMetresPerSecond,
    touches: unavailablePlayerMetric(),
    passes: unavailablePlayerMetric(),
    shots: unavailablePlayerMetric(),
    dribbles: unavailablePlayerMetric(),
    adminPlayerStats: speedSummary,
  };
}

export function deriveClaimState(
  manifest: TrackingManifest,
  segments: ClaimStateSegment[],
  corrections: typeof claimMatchCorrectionsTable.$inferSelect[],
  fullSegments?: TrackingSegmentPayload[],
  declaredOffPitchSpans: OffPitchSpan[] = [],
): DerivedClaimState {
  const offPitchSpans = normaliseOffPitchSpans(declaredOffPitchSpans, manifest.duration);
  const offPitchSeconds = totalSeconds(offPitchSpans);
  const isOffPitch = (seconds: number) => offPitchSpans.some((span) =>
    seconds >= span.fromSeconds && seconds < span.toSeconds);
  const active = corrections.filter((row) => !row.undone);
  const anchorAnswers = latestAnchorAnswers(corrections).filter((row) => !isOffPitch(row.momentSeconds));
  const nonAnchorAnswers = active.filter((row) =>
    !row.answerMethod.startsWith("anchor-") && !isOffPitch(row.momentSeconds));
  const accepted = [...nonAnchorAnswers, ...anchorAnswers].filter(isAcceptedClaimAnswer);
  const identityEvidence = claimIdentityEvidence(manifest, segments, accepted);
  const identityResolution = resolveClaimIdentity(manifest, segments, accepted);
  const resolvedPersonId = identityResolution?.personId ?? null;
  const acceptedForPerson = accepted.filter((row) =>
    resolvedPersonId !== null
    && resolvePersonForTrack(manifest, row.chosenTrackId, row.momentSeconds).personId === resolvedPersonId,
  );
  const acceptedAnchorCount = anchorAnswers.filter((row) =>
    isAcceptedClaimAnswer(row)
    && resolvedPersonId !== null
    && resolvePersonForTrack(manifest, row.chosenTrackId, row.momentSeconds).personId === resolvedPersonId,
  ).length;
  const intervals = acceptedForPerson.flatMap((row) => {
    const resolved = resolvePersonForTrack(manifest, row.chosenTrackId);
    return trackIntervalsForId(manifest, segments, resolved.personId);
  });
  const sorted = intervals
    .map((interval) => ({
      startSeconds: Math.max(0, Math.min(manifest.duration, interval.startSeconds)),
      endSeconds: Math.max(0, Math.min(manifest.duration, interval.endSeconds)),
    }))
    .filter((interval) => interval.endSeconds > interval.startSeconds)
    .sort((a, b) => a.startSeconds - b.startSeconds);
  const attributed = subtractSpans(
    normaliseOffPitchSpans(sorted.map((interval) => ({
      fromSeconds: interval.startSeconds,
      toSeconds: interval.endSeconds,
    })), manifest.duration),
    offPitchSpans,
  );
  const coveredSeconds = totalSeconds(attributed);
  const coverageDenominator = Math.max(manifest.duration - offPitchSeconds, 1);
  const coveragePercent = Math.min(100, Math.round((coveredSeconds / coverageDenominator) * 10000) / 100);
  const vouchedFragments = fullSegments
    ? acceptedForPerson
      .map((row) => vouchedFragmentForAnswer(manifest, fullSegments, row))
      .filter((fragment): fragment is ClaimVouchedFragment => fragment !== null)
    : [];
  const humanVouchedSeconds = totalSeconds(subtractSpans(
    canonicalVouchedFragments(vouchedFragments).map((fragment) => ({
      fromSeconds: Math.max(0, fragment.fromFrame / Math.max(manifest.frameRate, 0.001)),
      toSeconds: Math.min(manifest.duration, (fragment.toFrame + 1) / Math.max(manifest.frameRate, 0.001)),
    })),
    offPitchSpans,
  ));
  const inferredSeconds = Math.max(0, Math.round((coveredSeconds - humanVouchedSeconds) * 100) / 100);
  const unresolvedMoments = anchorAnswers
    .filter((row) => row.answerMethod === "anchor-no" || row.answerMethod === "anchor-skip")
    .map((row) => row.momentSeconds)
    .sort((a, b) => a - b);
  const conflictMoments = identityResolution?.conflictMoments ?? ambiguousClaimMoments(identityEvidence);
  const requiredAnchors = manifest.duration < 120 ? 1 : 3;
  const requiredCoverage = manifest.duration < 120 ? 55 : 60;
  const completed = identityResolution !== null
    && acceptedAnchorCount >= requiredAnchors
    && coveragePercent >= requiredCoverage;
  const attributedIntervals = attributed.map((interval) => ({
    startSeconds: interval.fromSeconds,
    endSeconds: interval.toSeconds,
  }));
  const earnedClips = acceptedForPerson.reduce(
    (all, row) => getMomentClips(segments, row.momentSeconds, all, attributedIntervals),
    [] as ClaimEarnedClip[],
  );
  const acceptedTrackIds = new Set<string>();
  for (const row of acceptedForPerson) {
    const personId = resolvePersonForTrack(manifest, row.chosenTrackId, row.momentSeconds).personId;
    acceptedTrackIds.add(personId);
    const identity = usableIdentityMap(manifest).find((item) => item.id === personId);
    for (const part of identity?.parts ?? []) acceptedTrackIds.add(part.trackId);
    if (!identity) acceptedTrackIds.add(row.chosenTrackId);
  }
  const trackedSegments = segments.filter((segment) =>
    segment.tracks.some((track) => acceptedTrackIds.has(track.id)),
  ).length;
  const matchedEvents = segments
    .flatMap((segment) => segment.events)
    .filter((event) => attributedIntervals.some((interval) =>
      event.time >= interval.startSeconds && event.time <= interval.endSeconds,
    ))
    .length;
  const playerMetrics = buildPlayerMetrics(
    manifest,
    fullSegments,
    acceptedForPerson,
    coveredSeconds,
    coveragePercent,
    anchorAnswers.length,
    acceptedAnchorCount,
    trackedSegments,
    segments.length,
    matchedEvents,
    humanVouchedSeconds,
    inferredSeconds,
    offPitchSpans,
  );
  const { adminPlayerStats, ...playerStats } = playerMetrics;
  return {
    coverageSeconds: Math.round(coveredSeconds * 100) / 100,
    coveragePercent,
    offPitchSeconds,
    humanVouchedSeconds,
    inferredSeconds,
    vouchedFragments: canonicalVouchedFragments(vouchedFragments),
    answeredAnchorCount: anchorAnswers.length,
    acceptedAnchorCount,
    unresolvedMoments: Array.from(new Set(unresolvedMoments)).slice(0, 50),
    conflictMoments,
    identityResolution,
    clipsUnlocked: earnedClips.length,
    correctionCount: active.length,
    completed,
    completionReason: identityResolution === null && accepted.length > 0
        ? "identity-unresolved"
        : conflictMoments.length > 0
          ? "identity-conflicts"
        : completed ? "coverage-threshold" : "keep-confirming",
    earnedClips,
    playerStats,
    adminPlayerStats,
  };
}

function progressWithDerived(
  row: typeof claimMatchProgressTable.$inferSelect | null,
  recordingId: number,
  derived: DerivedClaimState,
  binding: ClaimIdentityBindingRow | null,
  takenFragments: Array<ClaimVouchedFragment & { ownedByCurrentUser: boolean }> = [],
) {
  const completed = shouldKeepClaimCompleted(
    Boolean(row?.completed),
    derived.conflictMoments.length === 0 && derived.completed,
    binding?.state ?? null,
  );
  const storedClipsById = new Map((row?.earnedClips ?? []).map((clip) => [clip.id, clip]));
  const earnedClips = derived.earnedClips.map((clip) => ({
    ...clip,
    ...(storedClipsById.get(clip.id)?.userClipId
      ? { userClipId: storedClipsById.get(clip.id)?.userClipId }
      : {}),
  }));
  return {
    ...toProgress(row, recordingId),
    claimedPercent: derived.coveragePercent,
    coverageSeconds: derived.coverageSeconds,
    coveragePercent: derived.coveragePercent,
    offPitchSeconds: derived.offPitchSeconds,
    humanVouchedSeconds: derived.humanVouchedSeconds,
    inferredSeconds: derived.inferredSeconds,
    vouchedFragments: derived.vouchedFragments,
    takenFragments,
    answeredAnchorCount: derived.answeredAnchorCount,
    acceptedAnchorCount: derived.acceptedAnchorCount,
    unresolvedMoments: derived.unresolvedMoments,
    conflictMoments: derived.conflictMoments,
    identityBinding: toIdentityBinding(binding),
    clipsUnlocked: earnedClips.length,
    correctionCount: derived.correctionCount,
    completed,
    earnedClips,
    completionReason: derived.identityResolution === null
      ? derived.completionReason
      : derived.conflictMoments.length > 0
        ? "identity-conflicts"
        : completed ? "coverage-threshold" : derived.completionReason,
    playerStats: derived.playerStats,
  };
}

async function getClaimCorrections(userId: number, recordingId: number) {
  return db
    .select()
    .from(claimMatchCorrectionsTable)
    .where(and(
      eq(claimMatchCorrectionsTable.userId, userId),
      eq(claimMatchCorrectionsTable.recordingId, recordingId),
    ))
    .orderBy(desc(claimMatchCorrectionsTable.createdAt));
}

async function getClaimOffPitchSpans(userId: number, recordingId: number) {
  return db
    .select()
    .from(claimMatchOffPitchSpansTable)
    .where(and(
      eq(claimMatchOffPitchSpansTable.userId, userId),
      eq(claimMatchOffPitchSpansTable.recordingId, recordingId),
    ))
    .orderBy(asc(claimMatchOffPitchSpansTable.fromSeconds), asc(claimMatchOffPitchSpansTable.createdAt));
}

function toOffPitchSpan(row: typeof claimMatchOffPitchSpansTable.$inferSelect) {
  return {
    id: row.id,
    clientId: row.clientId,
    fromSeconds: row.fromSeconds,
    toSeconds: row.toSeconds,
    createdAt: row.createdAt.toISOString(),
  };
}

async function getTakenClaimFragments(recordingId: number, userId: number) {
  const bindings = await db
    .select({
      userId: claimMatchIdentityBindingsTable.userId,
      state: claimMatchIdentityBindingsTable.state,
      vouchedFragments: claimMatchIdentityBindingsTable.vouchedFragments,
    })
    .from(claimMatchIdentityBindingsTable)
    .where(eq(claimMatchIdentityBindingsTable.recordingId, recordingId));
  return bindings
    .filter((binding) =>
      ["pending", "confirmed", "disputed", "needs_resolution"].includes(binding.state)
      && (binding.vouchedFragments?.length ?? 0) > 0)
    .flatMap((binding) => canonicalVouchedFragments(binding.vouchedFragments).map((fragment) => ({
      ...fragment,
      ownedByCurrentUser: binding.userId === userId,
    })));
}

function isBindingUniqueViolation(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: string }).code === "23505";
}

function fragmentIdentityId(basePersonId: string, fragments: ClaimVouchedFragment[]): string {
  const digest = createHash("sha256")
    .update(JSON.stringify(canonicalVouchedFragments(fragments)))
    .digest("hex")
    .slice(0, 16);
  return `claim:${basePersonId}:${digest}`;
}

function subtractVouchedFragments(
  parts: TrackingIdentity["parts"],
  claimed: ClaimVouchedFragment[],
): TrackingIdentity["parts"] {
  const result: TrackingIdentity["parts"] = [];
  for (const part of parts) {
    let ranges: Array<{ fromFrame: number; toFrame: number }> = [{
      fromFrame: part.fromFrame,
      toFrame: part.toFrame,
    }];
    for (const fragment of claimed.filter((item) => item.trackId === part.trackId)) {
      const next: typeof ranges = [];
      for (const range of ranges) {
        if (fragment.toFrame < range.fromFrame || fragment.fromFrame > range.toFrame) {
          next.push(range);
          continue;
        }
        if (range.fromFrame < fragment.fromFrame) {
          next.push({ fromFrame: range.fromFrame, toFrame: fragment.fromFrame - 1 });
        }
        if (fragment.toFrame < range.toFrame) {
          next.push({ fromFrame: fragment.toFrame + 1, toFrame: range.toFrame });
        }
      }
      ranges = next;
    }
    result.push(...ranges.map((range) => ({ trackId: part.trackId, ...range })));
  }
  return result;
}

async function splitDisjointClaimantIdentity(
  bundle: typeof recordingTrackingBundlesTable.$inferSelect,
  owner: ClaimIdentityBindingRow,
  claimantFragments: ClaimVouchedFragment[],
): Promise<{ ownerPersonId: string; claimantPersonId: string }> {
  const ownerFragments = canonicalVouchedFragments(owner.vouchedFragments);
  const currentFragments = canonicalVouchedFragments(claimantFragments);
  const basePersonId = owner.personId;
  const ownerPersonId = fragmentIdentityId(basePersonId, ownerFragments);
  const claimantPersonId = fragmentIdentityId(basePersonId, currentFragments);
  const identities = usableIdentityMap(bundle.manifest);
  const baseIdentity = identities.find((identity) => identity.id === basePersonId);
  const allClaimed = [...ownerFragments, ...currentFragments];
  const inferredParts = subtractVouchedFragments(baseIdentity?.parts ?? [], allClaimed);
  const nextIdentities = identities.filter((identity) => identity.id !== basePersonId);
  nextIdentities.push(
    {
      id: ownerPersonId,
      name: baseIdentity?.name ?? "Claimed fragment",
      parts: ownerFragments.map((fragment) => ({
        trackId: fragment.trackId,
        fromFrame: fragment.fromFrame,
        toFrame: fragment.toFrame,
      })),
    },
    {
      id: claimantPersonId,
      name: baseIdentity?.name ?? "Claimed fragment",
      parts: currentFragments.map((fragment) => ({
        trackId: fragment.trackId,
        fromFrame: fragment.fromFrame,
        toFrame: fragment.toFrame,
      })),
    },
  );
  if (inferredParts.length > 0) {
    nextIdentities.push({
      id: `${basePersonId}:inferred`,
      name: baseIdentity?.name ?? "Inferred remainder",
      parts: inferredParts,
    });
  }
  await db
    .update(recordingTrackingBundlesTable)
    .set({
      manifest: {
        ...bundle.manifest,
        identities: nextIdentities,
      },
    })
    .where(eq(recordingTrackingBundlesTable.id, bundle.id));
  await db
    .update(claimMatchIdentityBindingsTable)
    .set({ personId: ownerPersonId, updatedAt: new Date() })
    .where(eq(claimMatchIdentityBindingsTable.id, owner.id));
  return { ownerPersonId, claimantPersonId };
}

async function identityBindingsTableExists(): Promise<boolean> {
  try {
    const result = await db.execute(sql`select to_regclass('public.claim_match_identity_bindings') as name`);
    return Boolean((result.rows[0] as { name?: string | null } | undefined)?.name);
  } catch {
    return false;
  }
}

export function completionAllowed(
  derived: DerivedClaimState,
  binding: ClaimIdentityBindingRow | null,
): boolean {
  return derived.completed
    && derived.conflictMoments.length === 0
    && binding?.state === "confirmed";
}

export function shouldKeepClaimCompleted(
  existingCompleted: boolean,
  derivedCompleted: boolean,
  bindingState: string | null,
): boolean {
  if (existingCompleted) {
    return bindingState === "confirmed" || bindingState === "pending";
  }
  return derivedCompleted && bindingState === "confirmed";
}

/**
 * Turn the current answer set into the user's one recording binding. This is
 * intentionally called on reads as well as writes: an admin transfer and a
 * bundle replacement must be reflected without waiting for another answer.
 */
export async function syncIdentityBinding(
  userId: number,
  recordingId: number,
  bundle: typeof recordingTrackingBundlesTable.$inferSelect,
  derived: DerivedClaimState,
  allowNeedsResolutionRecovery = false,
): Promise<ClaimIdentityBindingRow | null> {
  const [existing] = await db
    .select()
    .from(claimMatchIdentityBindingsTable)
    .where(and(
      eq(claimMatchIdentityBindingsTable.userId, userId),
      eq(claimMatchIdentityBindingsTable.recordingId, recordingId),
    ));
  if (existing?.state === "needs_resolution" && !allowNeedsResolutionRecovery) {
    return existing;
  }
  const resolution = derived.identityResolution;
  if (!resolution) {
    if (!existing || existing.state === "needs_resolution") return existing ?? null;
    const [released] = await db
      .update(claimMatchIdentityBindingsTable)
      .set({ state: "released", updatedAt: new Date() })
      .where(eq(claimMatchIdentityBindingsTable.id, existing.id))
      .returning();
    return released ?? existing;
  }

  const vouchedFragments = canonicalVouchedFragments(
    derived.vouchedFragments.length > 0 ? derived.vouchedFragments : existing?.vouchedFragments,
  );

  const [owner] = await db
    .select()
    .from(claimMatchIdentityBindingsTable)
    .where(and(
      eq(claimMatchIdentityBindingsTable.recordingId, recordingId),
      eq(claimMatchIdentityBindingsTable.personId, resolution.personId),
      eq(claimMatchIdentityBindingsTable.state, "confirmed"),
    ));
  let resolvedPersonId = resolution.personId;
  if (
    owner
    && owner.userId !== userId
    && vouchedFragments.length > 0
    && owner.vouchedFragments.length > 0
    && !vouchedFragmentsOverlap(owner.vouchedFragments, vouchedFragments)
  ) {
    // The database keeps one confirmed binding per (recording, person). When
    // two people vouch for disjoint pieces of an inferred row, split that row
    // into fragment identities first. The unvouched remainder is left as a
    // normal inferred row and remains regroupable.
    const split = await splitDisjointClaimantIdentity(bundle, owner, vouchedFragments);
    resolvedPersonId = split.claimantPersonId;
  }
  const state: ClaimIdentityBindingState = resolution.conflictMoments.length > 0
    ? "pending"
    : owner && owner.userId !== userId && resolvedPersonId === resolution.personId
      ? "disputed"
      : "confirmed";
  const values = {
    userId,
    recordingId,
    personId: resolvedPersonId,
    trackingBundleId: bundle.id,
    bundleFingerprint: typeof bundle.manifest.provenance?.bundleFingerprint === "string"
      ? bundle.manifest.provenance.bundleFingerprint
      : "legacy",
    // Kept only for backwards-compatible reads of old rows. It is not used
    // for protection; vouchedFragments is the lock unit.
    personParts: personPartsForResolution(bundle.manifest, resolution.personId),
    vouchedFragments,
    resolutionMethod: resolution.resolutionMethod,
    supportCount: resolution.supportCount,
    acceptedAnswerCount: resolution.acceptedAnswerCount,
    supportPercent: resolution.supportPercent,
    state,
    resolvedAt: new Date(),
    updatedAt: new Date(),
  };
  try {
    const [saved] = await db
      .insert(claimMatchIdentityBindingsTable)
      .values(values)
      .onConflictDoUpdate({
        target: [claimMatchIdentityBindingsTable.userId, claimMatchIdentityBindingsTable.recordingId],
        set: values,
      })
      .returning();
    return saved ?? existing ?? null;
  } catch (error) {
    // Two claimants can resolve the same person at the same time. The
    // confirmed-person partial index makes only one winner possible; the
    // loser is retained as a visible dispute instead of getting a 500.
    if (!isBindingUniqueViolation(error) || state !== "confirmed") throw error;
    const [saved] = await db
      .insert(claimMatchIdentityBindingsTable)
      .values({ ...values, state: "disputed" })
      .onConflictDoUpdate({
        target: [claimMatchIdentityBindingsTable.userId, claimMatchIdentityBindingsTable.recordingId],
        set: { ...values, state: "disputed" },
      })
      .returning();
    return saved ?? existing ?? null;
  }
}

async function markBindingsNeedsResolution(recordingId: number): Promise<void> {
  try {
    await db
      .update(claimMatchIdentityBindingsTable)
      .set({ state: "needs_resolution", updatedAt: new Date() })
      .where(eq(claimMatchIdentityBindingsTable.recordingId, recordingId));
  } catch (error) {
    // Keep bundle replacement usable while an older development database is
    // waiting for migration 0018. New claim reads still fail explicitly if
    // they require the missing binding table.
    if ((error as { code?: string })?.code !== "42P01") throw error;
    logger.warn({ recordingId }, "Claim identity binding table is not migrated yet");
  }
}

router.get("/admin/recordings/:id/player-metrics", async (req, res): Promise<void> => {
  const adminId = await requireAdmin(req);
  if (!adminId) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const recordingId = parseId(req.params.id);
  if (!recordingId) {
    res.status(400).json({ error: "Invalid recording id" });
    return;
  }
  const row = await getRecordingBundle(recordingId);
  if (!row?.bundle?.manifest) {
    res.status(404).json({ error: "Recording or tracking bundle not found" });
    return;
  }
  const [corrections, fullSegments, offPitchRows] = await Promise.all([
    db
      .select()
      .from(claimMatchCorrectionsTable)
      .where(eq(claimMatchCorrectionsTable.recordingId, recordingId))
      .orderBy(desc(claimMatchCorrectionsTable.createdAt)),
    readBundleSegments(row.bundle.id),
    db
      .select()
      .from(claimMatchOffPitchSpansTable)
      .where(eq(claimMatchOffPitchSpansTable.recordingId, recordingId)),
  ]);
  const correctionsByUser = new Map<number, typeof corrections>();
  for (const correction of corrections) {
    const existing = correctionsByUser.get(correction.userId) ?? [];
    existing.push(correction);
    correctionsByUser.set(correction.userId, existing);
  }
  const userIds = [...correctionsByUser.keys()];
  const users = userIds.length
    ? await db
      .select({ id: usersTable.id, name: usersTable.name, email: usersTable.email })
      .from(usersTable)
      .where(inArray(usersTable.id, userIds))
    : [];
  const usersById = new Map(users.map((user) => [user.id, user]));
  const manifest = await manifestWithBundleFingerprint(row.bundle);
  const segments = await getClaimStateSegments(row.bundle);
  const offPitchByUser = new Map<number, OffPitchSpan[]>();
  for (const row of offPitchRows) {
    const existing = offPitchByUser.get(row.userId) ?? [];
    existing.push(row);
    offPitchByUser.set(row.userId, existing);
  }
  const players = [...correctionsByUser.entries()]
    .map(([userId, userCorrections]) => {
      const derived = deriveClaimState(
        manifest,
        segments,
        userCorrections,
        fullSegments,
        normaliseOffPitchSpans(offPitchByUser.get(userId) ?? [], manifest.duration),
      );
      const user = usersById.get(userId);
      return {
        userId,
        displayName: user?.name ?? `User ${userId}`,
        email: user?.email ?? "unknown",
        playerStats: derived.playerStats,
        ...derived.adminPlayerStats,
      };
    })
    .sort((a, b) => a.displayName.localeCompare(b.displayName));

  res.json(GetAdminRecordingPlayerMetricsResponse.parse({
    recordingId,
    pitchModel: pitchModelSummary(manifest.pitchModel),
    players,
  }));
});

function formatMoment(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

async function disputeResponse(binding: ClaimIdentityBindingRow) {
  const [recordingRow] = await db
    .select({
      recording: recordingsTable,
      fieldName: fieldsTable.name,
    })
    .from(recordingsTable)
    .leftJoin(fieldsTable, eq(fieldsTable.id, recordingsTable.fieldId))
    .where(eq(recordingsTable.id, binding.recordingId));
  const [claimant] = await db
    .select({ id: usersTable.id, name: usersTable.name, email: usersTable.email })
    .from(usersTable)
    .where(eq(usersTable.id, binding.userId));
  const [owner] = await db
    .select({ id: usersTable.id, name: usersTable.name })
    .from(claimMatchIdentityBindingsTable)
    .innerJoin(usersTable, eq(usersTable.id, claimMatchIdentityBindingsTable.userId))
    .where(and(
      eq(claimMatchIdentityBindingsTable.recordingId, binding.recordingId),
      eq(claimMatchIdentityBindingsTable.personId, binding.personId),
      eq(claimMatchIdentityBindingsTable.state, "confirmed"),
    ));
  return {
    id: binding.id,
    recordingId: binding.recordingId,
    recordingLabel: `${recordingRow?.fieldName ?? "Match"} · ${recordingRow?.recording.court ?? ""}`.trim(),
    claimantUserId: binding.userId,
    claimantName: claimant?.name ?? `User ${binding.userId}`,
    claimantEmail: claimant?.email ?? "",
    personId: binding.personId,
    resolutionMethod: binding.resolutionMethod,
    supportCount: binding.supportCount,
    acceptedAnswerCount: binding.acceptedAnswerCount,
    supportPercent: binding.supportPercent,
    state: binding.state,
    currentOwnerUserId: owner?.id ?? null,
    currentOwnerName: owner?.name ?? null,
    createdAt: binding.createdAt.toISOString(),
    updatedAt: binding.updatedAt.toISOString(),
  };
}

router.get("/admin/claim-match/disputes", async (req, res): Promise<void> => {
  const adminId = await requireAdmin(req);
  if (!adminId) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const rows = await db
    .select()
    .from(claimMatchIdentityBindingsTable)
    .where(inArray(claimMatchIdentityBindingsTable.state, ["disputed", "pending"]))
    .orderBy(desc(claimMatchIdentityBindingsTable.createdAt));
  res.json(await Promise.all(rows.map(disputeResponse)));
});

router.patch("/admin/claim-match/disputes/:id", async (req, res): Promise<void> => {
  const adminId = await requireAdmin(req);
  if (!adminId) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const disputeId = parseId(req.params.id);
  const parsed = z.object({ winnerUserId: z.number().int().positive() }).safeParse(req.body);
  if (!disputeId || !parsed.success) {
    res.status(400).json({ error: "A valid winnerUserId is required" });
    return;
  }
  const [dispute] = await db
    .select()
    .from(claimMatchIdentityBindingsTable)
    .where(eq(claimMatchIdentityBindingsTable.id, disputeId));
  if (!dispute || dispute.state !== "disputed") {
    res.status(404).json({ error: "Dispute not found" });
    return;
  }
  const [owner] = await db
    .select()
    .from(claimMatchIdentityBindingsTable)
    .where(and(
      eq(claimMatchIdentityBindingsTable.recordingId, dispute.recordingId),
      eq(claimMatchIdentityBindingsTable.personId, dispute.personId),
      eq(claimMatchIdentityBindingsTable.state, "confirmed"),
    ));
  if (parsed.data.winnerUserId !== dispute.userId && parsed.data.winnerUserId !== owner?.userId) {
    res.status(400).json({ error: "Winner must be the claimant or current owner" });
    return;
  }
  await db.transaction(async (tx) => {
    await tx
      .update(claimMatchIdentityBindingsTable)
      .set({ state: "rejected", updatedAt: new Date() })
      .where(and(
        eq(claimMatchIdentityBindingsTable.recordingId, dispute.recordingId),
        eq(claimMatchIdentityBindingsTable.personId, dispute.personId),
        eq(claimMatchIdentityBindingsTable.state, "disputed"),
      ));
    if (owner && owner.userId !== parsed.data.winnerUserId) {
      await tx
        .update(claimMatchIdentityBindingsTable)
        .set({ state: "released", updatedAt: new Date() })
        .where(eq(claimMatchIdentityBindingsTable.id, owner.id));
    }
    await tx
      .update(claimMatchIdentityBindingsTable)
      .set({ state: "confirmed", updatedAt: new Date() })
      .where(eq(claimMatchIdentityBindingsTable.id, parsed.data.winnerUserId === dispute.userId ? dispute.id : owner!.id));
  });
  const [updated] = await db
    .select()
    .from(claimMatchIdentityBindingsTable)
    .where(eq(claimMatchIdentityBindingsTable.id, parsed.data.winnerUserId === dispute.userId ? dispute.id : owner!.id));
  res.json(await disputeResponse(updated ?? dispute));
});

router.get("/admin/recordings/:id/claim-match/bindings", async (req, res): Promise<void> => {
  const adminId = await requireAdmin(req);
  if (!adminId) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const recordingId = parseId(req.params.id);
  if (!recordingId) {
    res.status(400).json({ error: "Invalid recording id" });
    return;
  }
  const bindings = await db
    .select({
      binding: claimMatchIdentityBindingsTable,
      claimantName: usersTable.name,
    })
    .from(claimMatchIdentityBindingsTable)
    .innerJoin(usersTable, eq(usersTable.id, claimMatchIdentityBindingsTable.userId))
    .where(eq(claimMatchIdentityBindingsTable.recordingId, recordingId));
  res.json(bindings.map(({ binding, claimantName }) => ({
    ...toIdentityBinding(binding),
    claimantName: claimantName ?? `User ${binding.userId}`,
    claimedAt: binding.createdAt.toISOString(),
  })));
});

/**
 * Explicit escape hatch for an administrator. Releasing a binding clears its
 * fragment locks, allowing the next identity-map save to regroup those source
 * frames normally. It does not delete the claimant's answers or audit row.
 */
router.post("/admin/claim-match/bindings/:id/release", async (req, res): Promise<void> => {
  const adminId = await requireAdmin(req);
  if (!adminId) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const bindingId = parseId(req.params.id);
  if (!bindingId) {
    res.status(400).json({ error: "Invalid binding id" });
    return;
  }
  const [released] = await db
    .update(claimMatchIdentityBindingsTable)
    .set({
      state: "released",
      vouchedFragments: [],
      updatedAt: new Date(),
    })
    .where(eq(claimMatchIdentityBindingsTable.id, bindingId))
    .returning();
  if (!released) {
    res.status(404).json({ error: "Identity binding not found" });
    return;
  }
  res.json(toIdentityBinding(released));
});

router.get("/recordings/:id/claim-match", async (req, res): Promise<void> => {
  const userId = await requireAccountUser(req);
  if (!userId) {
    unauthenticatedResponse(res, req, "Authenticated account required");
    return;
  }
  const params = GetClaimMatchParams.safeParse({ id: recordingIdFromRequest(req.params.id) });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const access = await getClaimMatchBundleForRequest(req, params.data.id);
  if (access.error) {
    res.status(404).json({ error: access.error ?? "Recording not found", code: access.code ?? "recording_not_found" });
    return;
  }
  const row = access.row;
  if (!row?.bundle?.manifest) {
    res.status(404).json({ error: "No tracking bundle has been uploaded for this recording", code: "tracking_bundle_missing" });
    return;
  }
  const bundle = row.bundle;
  const [progress] = await db
    .select()
    .from(claimMatchProgressTable)
    .where(and(
      eq(claimMatchProgressTable.userId, userId),
      eq(claimMatchProgressTable.recordingId, params.data.id),
    ));
  const corrections = await db
    .select()
    .from(claimMatchCorrectionsTable)
    .where(and(
      eq(claimMatchCorrectionsTable.userId, userId),
      eq(claimMatchCorrectionsTable.recordingId, params.data.id),
    ))
    .orderBy(desc(claimMatchCorrectionsTable.createdAt));
  const storedOffPitchSpans = await getClaimOffPitchSpans(userId, params.data.id);
  const manifest = await manifestWithBundleFingerprint(bundle);
  const segments = await getClaimStateSegments(bundle);
  const offPitchSpans = normaliseOffPitchSpans(storedOffPitchSpans, manifest.duration);
  let derived = deriveClaimState(manifest, segments, corrections, undefined, offPitchSpans);
  if (corrections.some(isAcceptedClaimAnswer) || progress?.completed || derived.completed) {
    // Vouched fragments are exact detection runs, so a claim read must use
    // full boxes whenever the user has accepted an identity answer.
    derived = deriveClaimState(
      manifest,
      segments,
      corrections,
      await readBundleSegments(bundle.id),
      offPitchSpans,
    );
  }
  const binding = await syncIdentityBinding(userId, params.data.id, bundle, derived);
  const takenFragments = await getTakenClaimFragments(params.data.id, userId);
  const canAward = completionAllowed(derived, binding);
  const earnedClips = canAward
    ? await materializeClaimMoments(userId, row.recording, manifest, derived.earnedClips)
    : [];
  if (canAward && earnedClips.length !== derived.earnedClips.length) {
    derived = { ...derived, earnedClips };
  } else if (!canAward) {
    derived = { ...derived, earnedClips: [] };
  }

  res.json(GetClaimMatchResponse.parse({
    recording: toRecording(row.recording, row.fieldName ?? null),
    // Bundles uploaded before videoStartSeconds existed have no value for it.
    // Default to 0 rather than failing the response, but that default is a
    // guess and it is almost always wrong on a recording longer than the
    // tracked window.
    manifest: { ...manifestForClient(manifest), videoStartSeconds: manifest.videoStartSeconds ?? 0 },
    progress: progressWithDerived(progress ?? null, params.data.id, derived, binding, takenFragments),
    corrections: corrections.map(toCorrection),
    offPitchSpans: storedOffPitchSpans.map(toOffPitchSpan),
    offPitchSeconds: derived.offPitchSeconds,
  }));
});

router.get("/recordings/:id/claim-match/segments/:segmentIndex", async (req, res): Promise<void> => {
  const userId = await requireAccountUser(req);
  if (!userId) {
    unauthenticatedResponse(res, req, "Authenticated account required");
    return;
  }
  const params = GetClaimMatchSegmentParams.safeParse({
    id: recordingIdFromRequest(req.params.id),
    segmentIndex: Number.parseInt(Array.isArray(req.params.segmentIndex) ? req.params.segmentIndex[0] : req.params.segmentIndex, 10),
  });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const access = await getClaimMatchBundleForRequest(req, params.data.id);
  if (access.error) {
    res.status(404).json({ error: access.error ?? "Recording not found", code: access.code ?? "recording_not_found" });
    return;
  }
  const row = access.row;
  if (!row?.bundle?.manifest) {
    res.status(404).json({ error: "No tracking bundle has been uploaded for this recording", code: "tracking_bundle_missing" });
    return;
  }
  const manifestSegment = row.bundle.manifest.segments.find((segment) => segment.index === params.data.segmentIndex);
  if (!manifestSegment) {
    res.status(404).json({ error: "Tracking segment not found" });
    return;
  }
  try {
    const compressed = await readCompressedClaimSegment(manifestSegment.objectPath);
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Encoding", "gzip");
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.setHeader("Content-Length", String(compressed.byteLength));
    res.status(200).send(compressed);
  } catch {
    res.status(404).json({ error: "Tracking segment not found" });
  }
});

router.patch("/recordings/:id/claim-match", async (req, res): Promise<void> => {
  const userId = await requireAccountUser(req);
  if (!userId) {
    unauthenticatedResponse(res, req, "Authenticated account required");
    return;
  }
  const params = GetClaimMatchParams.safeParse({ id: recordingIdFromRequest(req.params.id) });
  const body = UpdateClaimMatchProgressBody.safeParse(req.body);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const row = await getVisibleRecordingBundle(params.data.id);
  if (!row?.bundle?.manifest) {
    res.status(404).json({ error: "Recording or tracking bundle not found" });
    return;
  }
  const segments = await getClaimStateSegments(row.bundle);
  const corrections = await getClaimCorrections(userId, params.data.id);
  const manifest = await manifestWithBundleFingerprint(row.bundle);
  const storedOffPitchSpans = await getClaimOffPitchSpans(userId, params.data.id);
  const offPitchSpans = normaliseOffPitchSpans(storedOffPitchSpans, manifest.duration);
  let derived = deriveClaimState(manifest, segments, corrections, undefined, offPitchSpans);
  if (corrections.some(isAcceptedClaimAnswer) || derived.completed) {
    derived = deriveClaimState(
      manifest,
      segments,
      corrections,
      await readBundleSegments(row.bundle.id),
      offPitchSpans,
    );
  }
  const binding = await syncIdentityBinding(userId, params.data.id, row.bundle, derived, true);
  const takenFragments = await getTakenClaimFragments(params.data.id, userId);
  const isCompleted = completionAllowed(derived, binding);
  const earnedClips = isCompleted
    ? await materializeClaimMoments(userId, row.recording, manifest, derived.earnedClips)
    : [];
  const nextStage = isCompleted
    ? "done"
    : body.data.stage === "done"
      ? "picker"
      : body.data.stage;
  const responseDerived = {
    ...derived,
    completed: isCompleted,
    completionReason: derived.identityResolution === null
      ? derived.completionReason
      : derived.conflictMoments.length > 0
        ? "identity-conflicts"
        : isCompleted ? "coverage-threshold" : derived.completionReason,
    earnedClips,
  };
  const [existingProgress] = await db
    .select({ completed: claimMatchProgressTable.completed })
    .from(claimMatchProgressTable)
    .where(and(
      eq(claimMatchProgressTable.userId, userId),
      eq(claimMatchProgressTable.recordingId, params.data.id),
    ));
  const stickyCompleted = shouldKeepClaimCompleted(
    existingProgress?.completed ?? false,
    isCompleted,
    binding?.state ?? null,
  );
  const [saved] = await db
    .insert(claimMatchProgressTable)
    .values({
      userId,
      recordingId: params.data.id,
      currentTrackId: body.data.currentTrackId ?? null,
      stage: nextStage,
      confirmedFromSeconds: body.data.confirmedFromSeconds,
      currentPositionSeconds: body.data.currentPositionSeconds,
      claimedPercent: derived.coveragePercent,
      clipsUnlocked: earnedClips.length,
      correctionCount: derived.correctionCount,
      completed: stickyCompleted,
      earnedClips,
    })
    .onConflictDoUpdate({
      target: [claimMatchProgressTable.userId, claimMatchProgressTable.recordingId],
      set: {
        currentTrackId: body.data.currentTrackId ?? null,
        confirmedFromSeconds: body.data.confirmedFromSeconds,
        currentPositionSeconds: body.data.currentPositionSeconds,
        claimedPercent: derived.coveragePercent,
         clipsUnlocked: earnedClips.length,
        correctionCount: derived.correctionCount,
         completed: sql`${claimMatchProgressTable.completed} OR ${stickyCompleted}`,
         stage: sql`CASE WHEN (${claimMatchProgressTable.completed} OR ${stickyCompleted}) THEN 'done' ELSE ${nextStage} END`,
        earnedClips,
        updatedAt: new Date(),
      },
    })
    .returning();
  const responseCompleted = completionSurvivesConcurrentProgress(saved.completed, isCompleted);
  res.json(progressWithDerived(
    saved,
    params.data.id,
    responseCompleted && !responseDerived.completed
      ? { ...responseDerived, completed: true }
      : responseDerived,
    binding,
    takenFragments,
  ));
});

router.post("/recordings/:id/claim-match/corrections", async (req, res): Promise<void> => {
  const userId = await requireAccountUser(req);
  if (!userId) {
    unauthenticatedResponse(res, req, "Authenticated account required");
    return;
  }
  const params = GetClaimMatchParams.safeParse({ id: recordingIdFromRequest(req.params.id) });
  const body = CreateClaimMatchCorrectionBody.safeParse(req.body);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const row = await getVisibleRecordingBundle(params.data.id);
  if (!row?.bundle) {
    res.status(404).json({ error: "Recording or tracking bundle not found" });
    return;
  }
  const segments = await getClaimStateSegments(row.bundle);
  const manifest = await manifestWithBundleFingerprint(row.bundle);
  const storedOffPitchSpans = await getClaimOffPitchSpans(userId, params.data.id);
  const offPitchSpans = normaliseOffPitchSpans(storedOffPitchSpans, manifest.duration);
  const trackIds = knownClaimTrackIds(manifest, segments);
  const isAnchorNoAnswer = body.data.answerMethod === "anchor-no" || body.data.answerMethod === "anchor-skip";
  if (
    (isAnchorNoAnswer
      ? body.data.chosenTrackId !== EMPTY_ANCHOR_TRACK
      : !trackIds.has(body.data.chosenTrackId)) ||
    (body.data.rejectedTrackId !== undefined &&
      body.data.rejectedTrackId !== null &&
      !trackIds.has(body.data.rejectedTrackId))
  ) {
    res.status(400).json({ error: "Correction references an unknown track" });
    return;
  }

  const [existing] = await db
    .select()
    .from(claimMatchCorrectionsTable)
    .where(and(
      eq(claimMatchCorrectionsTable.userId, userId),
      eq(claimMatchCorrectionsTable.recordingId, params.data.id),
      eq(claimMatchCorrectionsTable.clientId, body.data.clientId),
    ));
  if (existing) {
    res.status(200).json(toCorrection(existing));
    return;
  }

  const [created] = await db
    .insert(claimMatchCorrectionsTable)
    .values({
      userId,
      recordingId: params.data.id,
      clientId: body.data.clientId,
      momentSeconds: body.data.momentSeconds,
      rejectedTrackId: body.data.rejectedTrackId,
      chosenTrackId: body.data.chosenTrackId,
      answerMethod: body.data.answerMethod,
      questionCount: body.data.questionCount,
    })
    .returning();
  const allCorrections = await getClaimCorrections(userId, params.data.id);
  const derived = deriveClaimState(
    manifest,
    segments,
    allCorrections,
    await readBundleSegments(row.bundle.id),
    offPitchSpans,
  );
  const binding = await syncIdentityBinding(userId, params.data.id, row.bundle, derived);
  const isCompleted = completionAllowed(derived, binding);
  const [existingProgress] = await db
    .select({ completed: claimMatchProgressTable.completed })
    .from(claimMatchProgressTable)
    .where(and(
      eq(claimMatchProgressTable.userId, userId),
      eq(claimMatchProgressTable.recordingId, params.data.id),
    ));
  const stickyCompleted = shouldKeepClaimCompleted(
    existingProgress?.completed ?? false,
    isCompleted,
    binding?.state ?? null,
  );
  const earnedClips = isCompleted
    ? await materializeClaimMoments(userId, row.recording, manifest, derived.earnedClips)
    : [];
  const nextStage = stickyCompleted
    ? "done"
    : body.data.answerMethod.startsWith("anchor-")
      ? "picker"
      : "following";
  await db
    .insert(claimMatchProgressTable)
    .values({
      userId,
      recordingId: params.data.id,
      currentTrackId: isAnchorNoAnswer ? null : body.data.chosenTrackId,
      stage: nextStage,
      confirmedFromSeconds: body.data.momentSeconds,
      currentPositionSeconds: body.data.momentSeconds,
      claimedPercent: derived.coveragePercent,
       clipsUnlocked: earnedClips.length,
      correctionCount: derived.correctionCount,
       completed: isCompleted,
      earnedClips,
    })
    .onConflictDoUpdate({
      target: [claimMatchProgressTable.userId, claimMatchProgressTable.recordingId],
      set: {
        currentTrackId: isAnchorNoAnswer ? null : body.data.chosenTrackId,
        confirmedFromSeconds: body.data.momentSeconds,
        currentPositionSeconds: body.data.momentSeconds,
        claimedPercent: derived.coveragePercent,
         clipsUnlocked: earnedClips.length,
        correctionCount: derived.correctionCount,
          completed: sql`${claimMatchProgressTable.completed} OR ${stickyCompleted}`,
          stage: sql`CASE WHEN (${claimMatchProgressTable.completed} OR ${stickyCompleted}) THEN 'done' ELSE ${nextStage} END`,
        earnedClips,
        updatedAt: new Date(),
      },
    });

  res.status(201).json(toCorrection(created));
});

router.delete("/claim-match/corrections/:correctionId", async (req, res): Promise<void> => {
  const userId = await requireAccountUser(req);
  if (!userId) {
    unauthenticatedResponse(res, req, "Authenticated account required");
    return;
  }
  const correctionId = parseId(req.params.correctionId);
  if (!correctionId) {
    res.status(400).json({ error: "Invalid correction id" });
    return;
  }
  const [correction] = await db
    .select()
    .from(claimMatchCorrectionsTable)
    .where(eq(claimMatchCorrectionsTable.id, correctionId));
  if (!correction) {
    res.status(404).json({ error: "Correction not found" });
    return;
  }
  if (correction.userId !== userId) {
    res.status(403).json({ error: "Correction belongs to another user" });
    return;
  }
  const bundleRow = await getVisibleRecordingBundle(correction.recordingId);
  if (!bundleRow?.bundle) {
    res.status(404).json({ error: "Recording or tracking bundle not found" });
    return;
  }
  if (!correction.undone) {
    await db
      .update(claimMatchCorrectionsTable)
      .set({ undone: true, updatedAt: new Date() })
      .where(eq(claimMatchCorrectionsTable.id, correctionId));
  }
  {
    const [segments, corrections, existingProgress] = await Promise.all([
      getClaimStateSegments(bundleRow.bundle),
      getClaimCorrections(userId, correction.recordingId),
      db
        .select()
        .from(claimMatchProgressTable)
        .where(and(
          eq(claimMatchProgressTable.userId, userId),
          eq(claimMatchProgressTable.recordingId, correction.recordingId),
        ))
        .then((rows) => rows[0] ?? null),
    ]);
    const manifest = await manifestWithBundleFingerprint(bundleRow.bundle);
    const storedOffPitchSpans = await getClaimOffPitchSpans(userId, correction.recordingId);
    const derived = deriveClaimState(
      manifest,
      segments,
      corrections,
      await readBundleSegments(bundleRow.bundle.id),
      normaliseOffPitchSpans(storedOffPitchSpans, manifest.duration),
    );
    const binding = await syncIdentityBinding(userId, correction.recordingId, bundleRow.bundle, derived);
    const isCompleted = completionAllowed(derived, binding);
    const stickyCompleted = shouldKeepClaimCompleted(
      existingProgress?.completed ?? false,
      isCompleted,
      binding?.state ?? null,
    );
    const storedClipsById = new Map((existingProgress?.earnedClips ?? []).map((clip) => [clip.id, clip]));
    const earnedClips = isCompleted
      ? await materializeClaimMoments(
        userId,
        bundleRow.recording,
        manifest,
        derived.earnedClips.map((clip) => ({
          ...clip,
          ...(storedClipsById.get(clip.id)?.userClipId
            ? { userClipId: storedClipsById.get(clip.id)?.userClipId }
            : {}),
        })),
      )
      : [];
    await db
      .update(claimMatchProgressTable)
      .set({
        claimedPercent: derived.coveragePercent,
        clipsUnlocked: earnedClips.length,
        correctionCount: derived.correctionCount,
        completed: stickyCompleted,
        earnedClips,
        stage: stickyCompleted ? "done" : "picker",
        updatedAt: new Date(),
      })
      .where(and(
        eq(claimMatchProgressTable.userId, userId),
        eq(claimMatchProgressTable.recordingId, correction.recordingId),
      ));
  }
  res.json(toCorrection({ ...correction, undone: true }));
});

export function validateUploadBundle(upload: UploadBundle): string | null {
  const { manifest, segments } = upload;
  if (manifest.segmentCount !== segments.length || manifest.segments.length !== segments.length) {
    return "Manifest segment count does not match the uploaded files";
  }
  const ranges = [...manifest.segments].sort((a, b) => a.index - b.index);
  for (let index = 0; index < ranges.length; index++) {
    const range = ranges[index];
    const segment = segments[index];
    if (range.index !== index || segment.segmentIndex !== index) return "Segment indexes must be sequential starting at zero";
    if (range.startFrame !== segment.startFrame || range.endFrame !== segment.endFrame) return `Segment ${index + 1} frame range does not match its file`;
    if (index === 0 && range.startFrame !== 0) return "The first segment must start at frame 0";
    if (index > 0 && range.startFrame !== ranges[index - 1].endFrame + 1) return "Segment frame ranges must be continuous with no gaps";
    if (range.endFrame < range.startFrame || range.endSeconds < range.startSeconds) return "Segment ranges must have a positive length";
    const ids = new Set(segment.tracks.map((track) => track.id));
    if (segment.crossings.some((crossing) => !ids.has(crossing.trackId) || !ids.has(crossing.otherTrackId))) {
      return `Segment ${index + 1} contains a crossing for a track that is not in that segment`;
    }
  }
  if (ranges.at(-1)?.endFrame !== manifest.frameCount - 1) return "Segment frame coverage must end at the manifest frame count";
  return null;
}

async function cleanupClaimObjects(paths: Iterable<string>, context: string): Promise<void> {
  const uniquePaths = [...new Set(paths)].filter(Boolean);
  if (uniquePaths.length === 0) return;
  const results = await Promise.allSettled(uniquePaths.map((path) => deleteClaimSegment(path)));
  const failed = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failed.length > 0) {
    logger.warn({ count: failed.length, context }, "Some Claim Match bundle objects could not be cleaned up");
  }
}

export async function storeUploadBundle(recordingId: number, adminId: number, upload: UploadBundle) {
  const validationError = validateUploadBundle(upload);
  if (validationError) throw new Error(validationError);
  const [previousBundle] = await db
    .select({ id: recordingTrackingBundlesTable.id, manifest: recordingTrackingBundlesTable.manifest })
    .from(recordingTrackingBundlesTable)
    .where(eq(recordingTrackingBundlesTable.recordingId, recordingId));
  const previousObjectPaths = previousBundle?.manifest.segments.flatMap((segment) => [
    segment.objectPath,
    ...(segment.spritesPath ? [segment.spritesPath] : []),
  ]) ?? [];
  const storedSegments: Array<{
    segment: TrackingSegmentPayload;
    objectPath: string;
    compressedBytes: number;
  }> = [];
  const spritePaths: Record<number, string> = {};
  try {
    for (const segment of upload.segments) {
      const stored = await writeClaimSegment(`${recordingId}/${randomUUID()}-${segment.segmentIndex}.json.gz`, segment);
      storedSegments.push({ segment, ...stored });
      const strips = upload.sprites?.[segment.segmentIndex];
      if (strips) {
        const storedSprites = await writeClaimSegment(`${recordingId}/${randomUUID()}-${segment.segmentIndex}-sprites.json.gz`, strips);
        spritePaths[segment.segmentIndex] = storedSprites.objectPath;
      }
    }
    const bundleFingerprint = trackingBundleFingerprint(upload.manifest, upload.segments);
    const manifest: TrackingManifest = {
      ...upload.manifest,
       provenance: {
         ...(upload.manifest.provenance ?? {}),
         bundleFingerprint,
         identityMapBundleFingerprint: undefined,
       },
      summary: summarizeTrackingSegments(upload.segments),
      videoStartSeconds: Math.max(0, upload.manifest.videoStartSeconds ?? 0),
      segmentCount: storedSegments.length,
      segments: storedSegments.map(({ segment, objectPath }) => ({
        index: segment.segmentIndex,
        name: segment.name,
        startFrame: segment.startFrame,
        endFrame: segment.endFrame,
        startSeconds: segment.startSeconds,
        endSeconds: segment.endSeconds,
        objectPath,
        ...(spritePaths[segment.segmentIndex] ? { spritesPath: spritePaths[segment.segmentIndex] } : {}),
      })),
    };
    const bindingsTableExists = await identityBindingsTableExists();
    const [saved] = await db.transaction(async (tx) => {
      const [bundle] = await tx
        .insert(recordingTrackingBundlesTable)
        .values({ recordingId, manifest, uploadedBy: adminId })
        .onConflictDoUpdate({
          target: recordingTrackingBundlesTable.recordingId,
          set: { manifest, uploadedBy: adminId, updatedAt: new Date() },
        })
        .returning();
      await tx.delete(recordingTrackingSegmentsTable).where(eq(recordingTrackingSegmentsTable.bundleId, bundle.id));
      await tx.insert(recordingTrackingSegmentsTable).values(storedSegments.map(({ segment, objectPath, compressedBytes }) => ({
        bundleId: bundle.id,
        segmentIndex: segment.segmentIndex,
        name: segment.name,
        startFrame: segment.startFrame,
        endFrame: segment.endFrame,
        startSeconds: segment.startSeconds,
        endSeconds: segment.endSeconds,
        objectPath,
        compressedBytes,
        trackCount: segment.tracks.length,
        crossingCount: segment.crossings.length,
      })));
      if (bindingsTableExists) {
        await tx
          .update(claimMatchIdentityBindingsTable)
          .set({ state: "needs_resolution", updatedAt: new Date() })
          .where(eq(claimMatchIdentityBindingsTable.recordingId, recordingId));
      } else {
        logger.warn({ recordingId }, "Claim identity binding table is not migrated yet");
      }
      // Track IDs are bundle-relative. A completed progress row from the
      // previous bundle cannot be carried across replacement, otherwise the
      // sticky-completion rule would bypass fresh identity review.
      await tx
        .update(claimMatchProgressTable)
        .set({
          completed: false,
          stage: "picker",
          clipsUnlocked: 0,
          earnedClips: [],
          updatedAt: new Date(),
        })
        .where(eq(claimMatchProgressTable.recordingId, recordingId));
      return [bundle];
    });
    if (previousBundle?.manifest.pitchModel || manifest.pitchModel) {
      const previousModel = previousBundle?.manifest.pitchModel;
      const nextModel = manifest.pitchModel;
      logger.info({
        recordingId,
        adminId,
        previousCalibrationId: previousModel?.calibrationId ?? null,
        nextCalibrationId: nextModel?.calibrationId ?? null,
        previousFittedAt: previousModel?.fittedAt ?? null,
        nextFittedAt: nextModel?.fittedAt ?? null,
        action: previousModel && nextModel ? "replace" : nextModel ? "attach" : "remove",
      }, "Tracking bundle pitch model changed during bundle upload");
    }
    await cleanupClaimObjects(previousObjectPaths, "successful replacement");
    return {
      recordingId,
      label: manifest.label,
      duration: manifest.duration,
      trackCount: storedSegments.reduce((sum, item) => sum + item.segment.tracks.length, 0),
      crossingCount: storedSegments.reduce((sum, item) => sum + item.segment.crossings.length, 0),
      segmentCount: storedSegments.length,
      frameCoverage: `0-${manifest.frameCount - 1} (${manifest.frameCount} frames)`,
      videoStartSeconds: manifest.videoStartSeconds,
      segmentRanges: manifest.segments,
      pitchModel: pitchModelSummary(manifest.pitchModel),
      uploadedAt: saved.updatedAt.toISOString(),
    };
  } catch (error) {
    const newObjectPaths = [
      ...storedSegments.map((segment) => segment.objectPath),
      ...Object.values(spritePaths),
    ];
    await cleanupClaimObjects(newObjectPaths, "failed replacement");
    throw error;
  }
}

router.patch("/admin/recordings/:id/tracking-bundle", async (req, res): Promise<void> => {
  const adminId = await requireAdmin(req);
  if (!adminId) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const recordingId = parseId(req.params.id);
  if (!recordingId) {
    res.status(400).json({ error: "Invalid recording id" });
    return;
  }
  const body = UpdateTrackingBundleBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const hasPitchModel = Object.prototype.hasOwnProperty.call(req.body, "pitchModel");
  if (body.data.videoStartSeconds === undefined && !hasPitchModel) {
    res.status(400).json({ error: "Provide videoStartSeconds or pitchModel" });
    return;
  }
  const [existing] = await db
    .select({ id: recordingTrackingBundlesTable.id, manifest: recordingTrackingBundlesTable.manifest })
    .from(recordingTrackingBundlesTable)
    .where(eq(recordingTrackingBundlesTable.recordingId, recordingId));
  if (!existing) {
    res.status(404).json({ error: "Tracking bundle not found" });
    return;
  }
  let pitchModel = existing.manifest.pitchModel;
  if (hasPitchModel) {
    if (body.data.pitchModel === null) {
      pitchModel = undefined;
    } else {
      const parsedPitchModel = parsePitchModel(body.data.pitchModel);
      if (parsedPitchModel.error || !parsedPitchModel.model) {
        res.status(400).json({ error: parsedPitchModel.error ?? "Invalid pitch model" });
        return;
      }
      const framingError = pitchModelFramingError(
        parsedPitchModel.model,
        existing.manifest.width,
        existing.manifest.height,
      );
      if (framingError) {
        res.status(400).json({ error: framingError });
        return;
      }
      pitchModel = parsedPitchModel.model;
    }
  }
  const manifest: TrackingManifest = {
    ...existing.manifest,
    ...(body.data.videoStartSeconds === undefined
      ? {}
      : { videoStartSeconds: body.data.videoStartSeconds }),
  };
  if (hasPitchModel) {
    if (pitchModel) manifest.pitchModel = pitchModel;
    else delete manifest.pitchModel;
  }
  const [saved] = await db
    .update(recordingTrackingBundlesTable)
    .set({ manifest, updatedAt: new Date(), uploadedBy: adminId })
    .where(eq(recordingTrackingBundlesTable.id, existing.id))
    .returning({ updatedAt: recordingTrackingBundlesTable.updatedAt });
  if (hasPitchModel) {
    logger.info({
      recordingId,
      adminId,
      previousCalibrationId: existing.manifest.pitchModel?.calibrationId ?? null,
      nextCalibrationId: manifest.pitchModel?.calibrationId ?? null,
      action: pitchModel ? "attach" : "remove",
    }, "Admin changed tracking bundle pitch model");
  }
  res.json(UpdateTrackingBundleResponse.parse({
    recordingId,
    videoStartSeconds: manifest.videoStartSeconds ?? 0,
    pitchModel: pitchModelSummary(manifest.pitchModel),
    updatedAt: saved?.updatedAt?.toISOString() ?? new Date().toISOString(),
  }));
});

router.put("/admin/recordings/:id/tracking-bundle", bundleUploadSingle, async (req, res): Promise<void> => {
  const adminId = await requireAdmin(req);
  if (!adminId) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const recordingId = parseId(req.params.id);
  if (!recordingId) {
    res.status(400).json({ error: "Invalid recording id" });
    return;
  }
  const [recording] = await db
    .select({ id: recordingsTable.id })
    .from(recordingsTable)
    .where(eq(recordingsTable.id, recordingId));
  if (!recording) {
    res.status(404).json({ error: "Recording not found" });
    return;
  }
  const parsedZip = req.file?.buffer ? parseZipBundleDetailed(req.file.buffer) : null;
  const parsedBody = parsedZip ? null : parseUploadedBundleDetailed(req.body);
  const upload = parsedZip?.upload ?? parsedBody?.upload ?? null;

  // Where the tracked window starts inside the video is a property of THIS
  // pairing of bundle and recording, not of the bundle - the same tracking can
  // be attached to a differently-trimmed video. So an explicit form field wins
  // over whatever the bundle happened to carry. Getting this wrong does not
  // fail loudly: it draws every box against footage from another part of the
  // match, which looks like broken tracking rather than a wrong number.
  const overrideStart = firstNumber(
    (req.body as UnknownRecord | undefined)?.videoStartSeconds,
  );
  if (upload && overrideStart !== undefined) {
    upload.manifest.videoStartSeconds = Math.max(0, overrideStart);
  }
  if (!upload) {
    res.status(400).json({
      error: parsedZip?.error ?? parsedBody?.error ?? "Invalid tracking bundle. Include manifest metadata and segment tracking data.",
    });
    return;
  }
  const validationError = validateUploadBundle(upload);
  if (validationError) {
    res.status(400).json({ error: validationError });
    return;
  }
  try {
    res.json(await storeUploadBundle(recordingId, adminId, upload));
  } catch (error) {
    logger.error({ recordingId, err: error }, "Could not persist Claim Match tracking bundle");
    res.status(500).json({ error: "Could not save the tracking bundle. The previous bundle was kept." });
  }
});

/**
 * GET /recordings/:id/claim-match/sprites/:segmentIndex
 * Crop strips for the identity board, one object per segment. Only present
 * when the bundle zip carried sprites/<segment>.json.
 */
router.get("/recordings/:id/claim-match/sprites/:segmentIndex", async (req, res): Promise<void> => {
  const userId = await requireAccountUser(req);
  if (!userId) {
    unauthenticatedResponse(res, req, "Authenticated account required");
    return;
  }
  const params = GetClaimMatchSegmentParams.safeParse({
    id: recordingIdFromRequest(req.params.id),
    segmentIndex: Number.parseInt(Array.isArray(req.params.segmentIndex) ? req.params.segmentIndex[0] : req.params.segmentIndex, 10),
  });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const access = await getClaimMatchBundleForRequest(req, params.data.id);
  if (access.error) {
    res.status(404).json({ error: access.error ?? "Recording not found", code: access.code ?? "recording_not_found" });
    return;
  }
  if (!access.row?.bundle?.manifest) {
    res.status(404).json({ error: "No tracking bundle has been uploaded for this recording", code: "tracking_bundle_missing" });
    return;
  }
  const manifestSegment = access.row.bundle.manifest.segments.find((segment) => segment.index === params.data.segmentIndex);
  const spritesPath = (manifestSegment as { spritesPath?: string } | undefined)?.spritesPath;
  if (!spritesPath) {
    res.status(404).json({ error: "No sprites for this segment" });
    return;
  }
  try {
    const compressed = await readCompressedClaimSegment(spritesPath);
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Encoding", "gzip");
    res.setHeader("Cache-Control", "private, max-age=86400");
    res.setHeader("Content-Length", String(compressed.byteLength));
    res.status(200).send(compressed);
  } catch {
    res.status(404).json({ error: "Sprites not found" });
  }
});

/**
 * PUT /admin/recordings/:id/identities
 * The identity board's result: which track pieces are one person. Stored on
 * the manifest (jsonb, no migration); the claim page merges tracks from it at
 * load time, so identity survives segment boundaries. A re-save may regroup
 * unvouched pieces, but it cannot move a human-vouched source fragment. An
 * administrator must explicitly release that fragment first.
 */
router.put("/admin/recordings/:id/identities", async (req, res): Promise<void> => {
  const adminId = await requireAdmin(req);
  if (!adminId) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const recordingId = parseId(req.params.id);
  if (!recordingId) {
    res.status(400).json({ error: "Invalid recording id" });
    return;
  }
  const body = IdentityMapBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const row = await getRecordingBundle(recordingId);
  if (!row?.bundle?.manifest) {
    res.status(404).json({ error: "Recording or tracking bundle not found" });
    return;
  }
  const currentFingerprint = row.bundle.manifest.summary?.segments?.length
    ? trackingBundleFingerprint(row.bundle.manifest, row.bundle.manifest.summary.segments)
    : trackingBundleFingerprint(row.bundle.manifest, await readBundleSegments(row.bundle.id));
  if (body.data.bundleFingerprint !== currentFingerprint) {
    res.status(409).json({
      error: "This identity map was built from a different tracking bundle. Reload the identity board before saving.",
      currentBundleFingerprint: currentFingerprint,
    });
    return;
  }
  const storedFingerprint = row.bundle.manifest.provenance?.bundleFingerprint;
  if (typeof storedFingerprint === "string" && storedFingerprint !== currentFingerprint) {
    res.status(409).json({
      error: "The tracking bundle changed while this identity map was open. Reload the identity board before saving.",
      currentBundleFingerprint: currentFingerprint,
    });
    return;
  }
  const existingBindings = await db
    .select({
      id: claimMatchIdentityBindingsTable.id,
      personId: claimMatchIdentityBindingsTable.personId,
      vouchedFragments: claimMatchIdentityBindingsTable.vouchedFragments,
      state: claimMatchIdentityBindingsTable.state,
    })
    .from(claimMatchIdentityBindingsTable)
    .where(eq(claimMatchIdentityBindingsTable.recordingId, recordingId));
  const lockedBindings = existingBindings.filter((binding) =>
    binding.state !== "released"
    && identityMapMovesVouchedFragment(binding, body.data.identities),
  );
  const preview = req.query.preview === "true" || req.query.preview === "1";
  const lockSummary = {
    lockedClaims: lockedBindings.length,
    lockedFragments: lockedBindings.reduce(
      (count, binding) => count + (binding.vouchedFragments?.length ?? 0),
      0,
    ),
    requiresRelease: lockedBindings.length > 0,
  };
  if (preview) {
    res.json({
      recordingId,
      identities: body.data.identities.length,
      bundleFingerprint: currentFingerprint,
      ...lockSummary,
    });
    return;
  }
  if (lockedBindings.length > 0) {
    res.status(409).json({
      error: "This edit moves a human-vouched fragment. Release the affected claim fragment before regrouping it.",
      ...lockSummary,
      lockedBindingIds: lockedBindings.map((binding) => binding.id),
    });
    return;
  }
  const manifest: TrackingManifest = {
    ...row.bundle.manifest,
    identities: body.data.identities,
    provenance: {
      ...(row.bundle.manifest.provenance ?? {}),
      bundleFingerprint: currentFingerprint,
      identityMapBundleFingerprint: currentFingerprint,
    },
  };
  await db.transaction(async (tx) => {
    await tx
      .update(recordingTrackingBundlesTable)
      .set({ manifest, updatedAt: new Date() })
      .where(eq(recordingTrackingBundlesTable.recordingId, recordingId));
  });
  res.json({
    recordingId,
    identities: body.data.identities.length,
    bundleFingerprint: currentFingerprint,
    ...lockSummary,
  });
});

export default router;