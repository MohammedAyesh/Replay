import { Router, type IRouter } from "express";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import multer from "multer";
import { unzipSync, strFromU8 } from "fflate";
import { randomUUID } from "node:crypto";
import { gunzipSync as nodeGunzipSync } from "node:zlib";
import { z } from "zod";
import {
  CreateClaimMatchCorrectionBody,
  GetClaimMatchResponse,
  GetClaimMatchParams,
  GetClaimMatchSegmentParams,
  GetClaimMatchSegmentResponse,
  ReplaceTrackingBundleBody,
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
  type TrackingManifest,
  type TrackingSegmentPayload,
  type ClaimEarnedClip,
} from "@workspace/db";
import { getLocalAccountUserId, getLocalUserId, unauthenticatedResponse } from "../lib/clerkUserBridge";
import { getBunnyProxiedPlaybackUrl } from "../lib/bunny";
import { logger } from "../lib/logger";
import {
  deleteClaimSegment,
  readClaimSegment,
  readCompressedClaimSegment,
  writeClaimSegment,
} from "../lib/claimMatchStorage";

const router: IRouter = Router();

/** identity board result: pieces of tracks that are one person */
const IdentityMapBody = z.object({
  identities: z.array(z.object({
    id: z.string().min(1),
    name: z.string().nullish(),
    parts: z.array(z.object({
      trackId: z.string().min(1),
      fromFrame: z.number().int().min(0),
      toFrame: z.number().int().min(0),
    })).min(1),
  })).max(200),
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
  return values.find((value): value is string => typeof value === "string" && value.trim() !== "");
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

function entryNamesForSegment(
  entry: UnknownRecord,
  index: number,
  name: string,
): string[] {
  const declared = firstString(entry.file, entry.path);
  const candidates = [declared, `segments/${name}.json`, `segments/${name}.json.gz`, `segment-${String(index + 1).padStart(2, "0")}.json`, `${name}.json`]
    .filter((value): value is string => Boolean(value));
  return candidates;
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

function parseUploadedBundle(input: unknown): UploadBundle | null {
  const source = asRecord(input);
  const rawMetadata = asRecord(source.manifest ?? input);
  const rawSegments = Array.isArray(rawMetadata.segments) ? rawMetadata.segments : [];
  if (rawSegments.length > 0) {
    const segments: TrackingSegmentPayload[] = [];
    for (let index = 0; index < rawSegments.length; index++) {
      const entry = asRecord(rawSegments[index]);
      const startFrame = Math.max(0, Math.round(firstNumber(entry.startFrame, entry.start_frame) ?? 0));
      const endFrame = Math.max(startFrame, Math.round(firstNumber(entry.endFrame, entry.end_frame) ?? startFrame));
      const startSeconds = Math.max(0, firstNumber(entry.startSeconds, entry.start_seconds) ?? 0);
      const endSeconds = Math.max(startSeconds, firstNumber(entry.endSeconds, entry.end_seconds) ?? 0);
      const payload = asRecord(entry.payload).tracks ? entry.payload : entry;
      const segment = parseSegment(payload, index, firstString(entry.name) ?? `segment-${String(index + 1).padStart(2, "0")}`, startFrame, endFrame, startSeconds, endSeconds);
      if (!segment) return null;
      segments.push(namespaceSegment(segment));
    }
    const firstSegment = segments[0];
    return {
      manifest: {
        version: Math.max(1, Math.round(firstNumber(rawMetadata.version) ?? 1)),
        label: firstString(rawMetadata.label, rawMetadata.name) ?? "Match tracking",
        width: Math.max(1, Math.round(firstNumber(rawMetadata.width) ?? 1920)),
        height: Math.max(1, Math.round(firstNumber(rawMetadata.height) ?? 1080)),
        frameRate: firstNumber(rawMetadata.frameRate, rawMetadata.fps) ?? 25,
        frameCount: Math.max(1, Math.round(firstNumber(rawMetadata.frameCount, rawMetadata.frames) ?? (segments.at(-1)?.endFrame ?? 0) + 1)),
        duration: Math.max(firstNumber(rawMetadata.duration) ?? 0, segments.at(-1)?.endSeconds ?? 0) || 1,
        matchOffset: firstNumber(rawMetadata.matchOffset, rawMetadata.match_offset) ?? 0,
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
    };
  }

  const legacy = parseSegment(input, 0, "segment-01", 0, Math.max(0, Math.round(firstNumber(source.frameCount, source.frames) ?? 0) - 1), 0, firstNumber(source.duration) ?? 1);
  if (!legacy) return null;
  const sourceMeta = asRecord((normalizeBundle(input) as UnknownRecord)._metadata);
  const segment = namespaceSegment(legacy);
  return {
    manifest: {
      version: Math.max(1, Math.round(firstNumber(source.version) ?? 1)),
      label: firstString(source.label, source.name) ?? "Match tracking",
      width: Math.max(1, Math.round(firstNumber(source.width) ?? firstNumber(sourceMeta.width) ?? 1920)),
      height: Math.max(1, Math.round(firstNumber(source.height) ?? firstNumber(sourceMeta.height) ?? 1080)),
      frameRate: firstNumber(source.frameRate, source.fps) ?? firstNumber(sourceMeta.frameRate) ?? 25,
      frameCount: Math.max(1, Math.round(firstNumber(source.frameCount, source.frames) ?? firstNumber(sourceMeta.frameCount) ?? segment.endFrame + 1)),
      duration: firstNumber(source.duration) ?? firstNumber(sourceMeta.duration) ?? segment.endSeconds,
      matchOffset: firstNumber(source.matchOffset, source.match_offset) ?? 0,
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
  };
}

function parseZipBundleDetailed(buffer: Buffer): { upload: UploadBundle | null; error: string | null } {
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
    const startSeconds = Math.max(0, firstNumber(entry.startSeconds, entry.start_seconds) ?? startFrame / (firstNumber(rawManifest.frameRate, rawManifest.fps) ?? 25));
    const endSeconds = Math.max(startSeconds, firstNumber(entry.endSeconds, entry.end_seconds) ?? endFrame / (firstNumber(rawManifest.frameRate, rawManifest.fps) ?? 25));
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

    const spriteCandidates = [
      `sprites/${name}.json`,
      `sprites/segment-${String(index + 1).padStart(2, "0")}.json`,
    ];
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

  const unexpectedEntry = Object.keys(entries).find((name) => !selectedEntries.has(name));
  if (unexpectedEntry) {
    return { upload: null, error: `The ZIP contains an unexpected file: ${unexpectedEntry}` };
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
        width: Math.max(1, Math.round(firstNumber(rawManifest.width) ?? 1920)),
        height: Math.max(1, Math.round(firstNumber(rawManifest.height) ?? 1080)),
        frameRate: firstNumber(rawManifest.frameRate, rawManifest.fps) ?? 25,
        frameCount: Math.max(1, Math.round(firstNumber(rawManifest.frameCount, rawManifest.frames) ?? segments.at(-1)!.endFrame + 1)),
        duration: Math.max(firstNumber(rawManifest.duration) ?? 0, segments.at(-1)!.endSeconds),
        matchOffset: firstNumber(rawManifest.matchOffset, rawManifest.match_offset) ?? 0,
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
    answeredAnchorCount: 0,
    acceptedAnchorCount: 0,
    unresolvedMoments: [],
    clipsUnlocked: row?.clipsUnlocked ?? 0,
    correctionCount: row?.correctionCount ?? 0,
    completed: row?.completed ?? false,
    earnedClips: row?.earnedClips ?? [],
    completionReason: row?.completed ? "coverage-threshold" : "keep-confirming",
    playerStats: {
      confirmedSeconds: 0,
      coveragePercent: row?.claimedPercent ?? 0,
      answeredMoments: 0,
      acceptedMoments: 0,
      trackedSegments: 0,
      totalSegments: 0,
      matchedEvents: 0,
    },
    updatedAt: row?.updatedAt.toISOString() ?? new Date().toISOString(),
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

async function getDemoRecordingId(): Promise<number | null> {
  const [bundle] = await db
    .select({ recordingId: recordingTrackingBundlesTable.recordingId })
    .from(recordingTrackingBundlesTable)
    .orderBy(asc(recordingTrackingBundlesTable.recordingId))
    .limit(1);
  return bundle?.recordingId ?? null;
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
  });

  res.json({ recordingId, reset: true });
});

function getMomentClips(
  segments: TrackingSegmentPayload[],
  momentSeconds: number,
  existing: ClaimEarnedClip[],
): ClaimEarnedClip[] {
  const newClips = segments.flatMap((segment) => segment.events)
    .filter((event) => ["goal", "shot", "kickoff", "second-half", "second_half"].includes(event.type.toLowerCase()))
    .filter((event) => Math.abs(event.time - momentSeconds) <= 12)
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

type DerivedClaimState = {
  coverageSeconds: number;
  coveragePercent: number;
  answeredAnchorCount: number;
  acceptedAnchorCount: number;
  unresolvedMoments: number[];
  clipsUnlocked: number;
  correctionCount: number;
  completed: boolean;
  completionReason: string;
  earnedClips: ClaimEarnedClip[];
  playerStats: {
    confirmedSeconds: number;
    coveragePercent: number;
    answeredMoments: number;
    acceptedMoments: number;
    trackedSegments: number;
    totalSegments: number;
    matchedEvents: number;
  };
};

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
  segments: TrackingSegmentPayload[],
): Set<string> {
  return new Set([
    ...segments.flatMap((segment) => segment.tracks.map((track) => track.id)),
    ...(manifest.identities ?? []).map((identity) => identity.id),
  ]);
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
  segments: TrackingSegmentPayload[],
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
  const identity = manifest.identities?.find((item) => item.id === trackId);
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

export function deriveClaimState(
  manifest: TrackingManifest,
  segments: TrackingSegmentPayload[],
  corrections: typeof claimMatchCorrectionsTable.$inferSelect[],
): DerivedClaimState {
  const active = corrections.filter((row) => !row.undone);
  const anchorAnswers = latestAnchorAnswers(corrections);
  const nonAnchorAnswers = active.filter((row) => !row.answerMethod.startsWith("anchor-"));
  const accepted = [...nonAnchorAnswers, ...anchorAnswers].filter(isAcceptedClaimAnswer);
  const acceptedAnchorCount = anchorAnswers.filter(isAcceptedClaimAnswer).length;
  const intervals = accepted.flatMap((row) => trackIntervalsForId(manifest, segments, row.chosenTrackId));
  const sorted = intervals
    .map((interval) => ({
      startSeconds: Math.max(0, Math.min(manifest.duration, interval.startSeconds)),
      endSeconds: Math.max(0, Math.min(manifest.duration, interval.endSeconds)),
    }))
    .filter((interval) => interval.endSeconds > interval.startSeconds)
    .sort((a, b) => a.startSeconds - b.startSeconds);
  let coveredSeconds = 0;
  let end = 0;
  for (const interval of sorted) {
    if (interval.startSeconds > end) {
      coveredSeconds += interval.endSeconds - interval.startSeconds;
      end = interval.endSeconds;
    } else if (interval.endSeconds > end) {
      coveredSeconds += interval.endSeconds - end;
      end = interval.endSeconds;
    }
  }
  const coveragePercent = Math.min(100, Math.round((coveredSeconds / Math.max(manifest.duration, 0.001)) * 10000) / 100);
  const unresolvedMoments = anchorAnswers
    .filter((row) => row.answerMethod === "anchor-no" || row.answerMethod === "anchor-skip")
    .map((row) => row.momentSeconds)
    .sort((a, b) => a - b);
  const requiredAnchors = manifest.duration < 120 ? 1 : 3;
  const requiredCoverage = manifest.duration < 120 ? 55 : 60;
  const completed = acceptedAnchorCount >= requiredAnchors && coveragePercent >= requiredCoverage;
  const earnedClips = accepted.reduce(
    (all, row) => getMomentClips(segments, row.momentSeconds, all),
    [] as ClaimEarnedClip[],
  );
  const acceptedTrackIds = new Set<string>();
  for (const row of accepted) {
    acceptedTrackIds.add(row.chosenTrackId);
    const identity = manifest.identities?.find((item) => item.id === row.chosenTrackId);
    for (const part of identity?.parts ?? []) acceptedTrackIds.add(part.trackId);
  }
  const trackedSegments = segments.filter((segment) =>
    segment.tracks.some((track) => acceptedTrackIds.has(track.id)),
  ).length;
  const matchedEvents = segments
    .flatMap((segment) => segment.events)
    .filter((event) => sorted.some((interval) =>
      event.time >= interval.startSeconds && event.time <= interval.endSeconds,
    ))
    .length;
  return {
    coverageSeconds: Math.round(coveredSeconds * 100) / 100,
    coveragePercent,
    answeredAnchorCount: anchorAnswers.length,
    acceptedAnchorCount,
    unresolvedMoments: Array.from(new Set(unresolvedMoments)).slice(0, 50),
    clipsUnlocked: earnedClips.length,
    correctionCount: active.length,
    completed,
    completionReason: completed ? "coverage-threshold" : "keep-confirming",
    earnedClips,
    playerStats: {
      confirmedSeconds: Math.round(coveredSeconds * 100) / 100,
      coveragePercent,
      answeredMoments: anchorAnswers.length,
      acceptedMoments: acceptedAnchorCount,
      trackedSegments,
      totalSegments: segments.length,
      matchedEvents,
    },
  };
}

function progressWithDerived(
  row: typeof claimMatchProgressTable.$inferSelect | null,
  recordingId: number,
  derived: DerivedClaimState,
) {
  return {
    ...toProgress(row, recordingId),
    claimedPercent: derived.coveragePercent,
    coverageSeconds: derived.coverageSeconds,
    coveragePercent: derived.coveragePercent,
    answeredAnchorCount: derived.answeredAnchorCount,
    acceptedAnchorCount: derived.acceptedAnchorCount,
    unresolvedMoments: derived.unresolvedMoments,
    clipsUnlocked: derived.clipsUnlocked,
    correctionCount: derived.correctionCount,
    completed: derived.completed,
    earnedClips: derived.earnedClips,
    completionReason: derived.completionReason,
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

function formatMoment(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

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
  const row = await getRecordingBundle(params.data.id);
  if (!row?.bundle?.manifest) {
    res.status(404).json({ error: "Recording or tracking bundle not found" });
    return;
  }
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
  const segments = await readBundleSegments(row.bundle.id);
  const derived = deriveClaimState(row.bundle.manifest, segments, corrections);

  res.json(GetClaimMatchResponse.parse({
    recording: toRecording(row.recording, row.fieldName ?? null),
    // Bundles uploaded before videoStartSeconds existed have no value for it.
    // Default to 0 rather than failing the response, but that default is a
    // guess and it is almost always wrong on a recording longer than the
    // tracked window.
    manifest: { ...row.bundle.manifest, videoStartSeconds: row.bundle.manifest.videoStartSeconds ?? 0 },
    progress: progressWithDerived(progress ?? null, params.data.id, derived),
    corrections: corrections.map(toCorrection),
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
  const row = await getRecordingBundle(params.data.id);
  if (!row?.bundle?.manifest) {
    res.status(404).json({ error: "Recording or tracking bundle not found" });
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
  const row = await getRecordingBundle(params.data.id);
  if (!row?.bundle?.manifest) {
    res.status(404).json({ error: "Recording or tracking bundle not found" });
    return;
  }
  const segments = await readBundleSegments(row.bundle.id);
  const corrections = await getClaimCorrections(userId, params.data.id);
  const derived = deriveClaimState(row.bundle.manifest, segments, corrections);
  const nextStage = derived.completed
    ? "done"
    : body.data.stage === "done"
      ? "picker"
      : body.data.stage;
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
      clipsUnlocked: derived.clipsUnlocked,
      correctionCount: derived.correctionCount,
      completed: derived.completed,
      earnedClips: derived.earnedClips,
    })
    .onConflictDoUpdate({
      target: [claimMatchProgressTable.userId, claimMatchProgressTable.recordingId],
      set: {
        currentTrackId: body.data.currentTrackId ?? null,
        confirmedFromSeconds: body.data.confirmedFromSeconds,
        currentPositionSeconds: body.data.currentPositionSeconds,
        claimedPercent: derived.coveragePercent,
        clipsUnlocked: derived.clipsUnlocked,
        correctionCount: derived.correctionCount,
        completed: sql`${claimMatchProgressTable.completed} OR ${derived.completed}`,
        stage: sql`CASE WHEN ${claimMatchProgressTable.completed} OR ${derived.completed} THEN 'done' ELSE ${nextStage} END`,
        earnedClips: derived.earnedClips,
        updatedAt: new Date(),
      },
    })
    .returning();
  const responseCompleted = completionSurvivesConcurrentProgress(saved.completed, derived.completed);
  const responseDerived = responseCompleted && !derived.completed
    ? { ...derived, completed: true, completionReason: "coverage-threshold" }
    : derived;
  res.json(progressWithDerived(saved, params.data.id, responseDerived));
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
  const row = await getRecordingBundle(params.data.id);
  if (!row?.bundle) {
    res.status(404).json({ error: "Recording or tracking bundle not found" });
    return;
  }
  const segments = await readBundleSegments(row.bundle.id);
  const trackIds = knownClaimTrackIds(row.bundle.manifest, segments);
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
  const derived = deriveClaimState(row.bundle.manifest, segments, allCorrections);
  const nextStage = derived.completed
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
      clipsUnlocked: derived.clipsUnlocked,
      correctionCount: derived.correctionCount,
      completed: derived.completed,
      earnedClips: derived.earnedClips,
    })
    .onConflictDoUpdate({
      target: [claimMatchProgressTable.userId, claimMatchProgressTable.recordingId],
      set: {
        currentTrackId: isAnchorNoAnswer ? null : body.data.chosenTrackId,
        confirmedFromSeconds: body.data.momentSeconds,
        currentPositionSeconds: body.data.momentSeconds,
        claimedPercent: derived.coveragePercent,
        clipsUnlocked: derived.clipsUnlocked,
        correctionCount: derived.correctionCount,
        completed: sql`${claimMatchProgressTable.completed} OR ${derived.completed}`,
        stage: sql`CASE WHEN ${claimMatchProgressTable.completed} OR ${derived.completed} THEN 'done' ELSE ${nextStage} END`,
        earnedClips: derived.earnedClips,
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
  if (!correction.undone) {
    await db
      .update(claimMatchCorrectionsTable)
      .set({ undone: true })
      .where(eq(claimMatchCorrectionsTable.id, correctionId));
    await db
      .update(claimMatchProgressTable)
      .set({
        correctionCount: sql`GREATEST(0, ${claimMatchProgressTable.correctionCount} - 1)`,
        updatedAt: new Date(),
      })
      .where(and(
        eq(claimMatchProgressTable.userId, userId),
        eq(claimMatchProgressTable.recordingId, correction.recordingId),
      ));
  }
  const bundleRow = await getRecordingBundle(correction.recordingId);
  if (bundleRow?.bundle) {
    const [segments, corrections] = await Promise.all([
      readBundleSegments(bundleRow.bundle.id),
      getClaimCorrections(userId, correction.recordingId),
    ]);
    const derived = deriveClaimState(bundleRow.bundle.manifest, segments, corrections);
    await db
      .update(claimMatchProgressTable)
      .set({
        claimedPercent: derived.coveragePercent,
        clipsUnlocked: derived.clipsUnlocked,
        correctionCount: derived.correctionCount,
        completed: derived.completed,
        earnedClips: derived.earnedClips,
        stage: derived.completed ? "done" : "picker",
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
  if (!Number.isInteger(manifest.width) || manifest.width < 1 || manifest.width > 10_000) {
    return "Manifest width must be between 1 and 10000 pixels";
  }
  if (!Number.isInteger(manifest.height) || manifest.height < 1 || manifest.height > 10_000) {
    return "Manifest height must be between 1 and 10000 pixels";
  }
  if (!Number.isFinite(manifest.frameRate) || manifest.frameRate <= 0 || manifest.frameRate > 240) {
    return "Manifest frame rate must be greater than 0 and no more than 240";
  }
  if (!Number.isInteger(manifest.frameCount) || manifest.frameCount < 1 || manifest.frameCount > MAX_TRACKING_FRAMES) {
    return `Manifest frame count must be between 1 and ${MAX_TRACKING_FRAMES}`;
  }
  if (!Number.isFinite(manifest.duration) || manifest.duration <= 0 || manifest.duration > MAX_TRACKING_DURATION_SECONDS) {
    return `Manifest duration must be greater than 0 and no more than ${MAX_TRACKING_DURATION_SECONDS / 3600} hours`;
  }
  const videoStartSeconds = manifest.videoStartSeconds ?? 0;
  if (!Number.isFinite(videoStartSeconds) || videoStartSeconds < 0 || videoStartSeconds > MAX_TRACKING_DURATION_SECONDS) {
    return "Manifest video start must be between 0 and 10800 seconds";
  }
  if (segments.length > MAX_BUNDLE_SEGMENTS) {
    return `The bundle contains too many segments (maximum ${MAX_BUNDLE_SEGMENTS})`;
  }
  if (manifest.segmentCount !== segments.length || manifest.segments.length !== segments.length) {
    return "Manifest segment count does not match the uploaded files";
  }
  const ranges = [...manifest.segments].sort((a, b) => a.index - b.index);
  let totalTracks = 0;
  for (let index = 0; index < ranges.length; index++) {
    const range = ranges[index];
    const segment = segments[index];
    if (range.index !== index || segment.segmentIndex !== index) return "Segment indexes must be sequential starting at zero";
    if (range.startFrame !== segment.startFrame || range.endFrame !== segment.endFrame) return `Segment ${index + 1} frame range does not match its file`;
    if (index === 0 && range.startFrame !== 0) return "The first segment must start at frame 0";
    if (index > 0 && range.startFrame !== ranges[index - 1].endFrame + 1) return "Segment frame ranges must be continuous with no gaps";
    if (
      range.startFrame < 0
      || range.endFrame < range.startFrame
      || range.endFrame >= manifest.frameCount
      || range.endFrame - range.startFrame + 1 > MAX_TRACKING_FRAMES
    ) {
      return `Segment ${index + 1} frame range is outside the manifest bounds`;
    }
    if (
      !Number.isFinite(range.startSeconds)
      || !Number.isFinite(range.endSeconds)
      || range.startSeconds < 0
      || range.endSeconds < range.startSeconds
      || range.endSeconds > manifest.duration
    ) {
      return `Segment ${index + 1} time range is outside the manifest duration`;
    }
    const ids = new Set(segment.tracks.map((track) => track.id));
    if (segment.tracks.length > MAX_TRACKS_PER_SEGMENT) {
      return `Segment ${index + 1} contains too many tracks (maximum ${MAX_TRACKS_PER_SEGMENT})`;
    }
    const boxCount = segment.tracks.reduce((count, track) => count + track.boxes.length, 0);
    if (boxCount > MAX_BOXES_PER_SEGMENT) {
      return `Segment ${index + 1} contains too many tracking frames (maximum ${MAX_BOXES_PER_SEGMENT})`;
    }
    if (segment.crossings.length > MAX_CROSSINGS_PER_SEGMENT) {
      return `Segment ${index + 1} contains too many crossings (maximum ${MAX_CROSSINGS_PER_SEGMENT})`;
    }
    if (segment.events.length > MAX_EVENTS_PER_SEGMENT) {
      return `Segment ${index + 1} contains too many events (maximum ${MAX_EVENTS_PER_SEGMENT})`;
    }
    totalTracks += segment.tracks.length;
    if (totalTracks > MAX_TRACKS_PER_SEGMENT * MAX_BUNDLE_SEGMENTS) {
      return "The bundle contains too many tracks";
    }
    for (const track of segment.tracks) {
      if (
        track.startFrame < 0
        || track.endFrame < track.startFrame
        || track.endFrame >= manifest.frameCount
        || track.boxes.some((box) => (
          box.frame < 0
          || box.frame >= manifest.frameCount
          || !Number.isFinite(box.x)
          || !Number.isFinite(box.y)
          || !Number.isFinite(box.w)
          || !Number.isFinite(box.h)
          || box.w <= 0
          || box.h <= 0
        ))
      ) {
        return `Segment ${index + 1} contains a track or box outside its frame range`;
      }
    }
    if (segment.crossings.some((crossing) => !ids.has(crossing.trackId) || !ids.has(crossing.otherTrackId))) {
      return `Segment ${index + 1} contains a crossing for a track that is not in that segment`;
    }
    if (segment.crossings.some((crossing) => crossing.frame < 0 || crossing.frame >= manifest.frameCount)) {
      return `Segment ${index + 1} contains a crossing outside the manifest frame range`;
    }
    if (segment.events.some((event) => !Number.isFinite(event.time) || event.time < 0 || event.time > manifest.duration)) {
      return `Segment ${index + 1} contains an event outside the manifest duration`;
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
    const manifest: TrackingManifest = {
      ...upload.manifest,
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
      return [bundle];
    });
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
  const startSeconds = firstNumber((req.body as UnknownRecord | undefined)?.videoStartSeconds);
  if (startSeconds === undefined || startSeconds < 0) {
    res.status(400).json({ error: "videoStartSeconds must be a non-negative number" });
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
  const manifest: TrackingManifest = {
    ...existing.manifest,
    videoStartSeconds: startSeconds,
  };
  const [saved] = await db
    .update(recordingTrackingBundlesTable)
    .set({ manifest, updatedAt: new Date(), uploadedBy: adminId })
    .where(eq(recordingTrackingBundlesTable.id, existing.id))
    .returning({ updatedAt: recordingTrackingBundlesTable.updatedAt });
  res.json({
    recordingId,
    videoStartSeconds: manifest.videoStartSeconds,
    updatedAt: saved?.updatedAt?.toISOString() ?? new Date().toISOString(),
  });
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
  const upload = parsedZip ? parsedZip.upload : parseUploadedBundle(req.body);

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
      error: parsedZip?.error ?? "Invalid tracking bundle. Upload a ZIP containing manifest.json and every segment JSON file.",
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
  const row = await getRecordingBundle(params.data.id);
  const manifestSegment = row?.bundle?.manifest?.segments.find((segment) => segment.index === params.data.segmentIndex);
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
 * load time, so identity survives segment boundaries and re-uploads of the
 * same bundle keep it as long as track ids are stable.
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
  const manifest: TrackingManifest = { ...row.bundle.manifest, identities: body.data.identities };
  await db
    .update(recordingTrackingBundlesTable)
    .set({ manifest, updatedAt: new Date() })
    .where(eq(recordingTrackingBundlesTable.recordingId, recordingId));
  res.json({ recordingId, identities: body.data.identities.length });
});

export default router;