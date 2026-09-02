import {
  pgTable,
  serial,
  integer,
  text,
  timestamp,
  jsonb,
  doublePrecision,
  boolean,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { recordingsTable } from "./recordings";
import { usersTable } from "./users";

export type ClaimEarnedClip = {
  id: string;
  title: string;
  momentSeconds: number;
  kind: string;
  status: string;
  /** The real user_clips row created for this accepted match moment. */
  userClipId?: number;
};

export type TrackingSegmentPayload = {
  version: number;
  segmentIndex: number;
  name: string;
  startFrame: number;
  endFrame: number;
  startSeconds: number;
  endSeconds: number;
  tracks: Array<{
    id: string;
    label?: string | null;
    startFrame: number;
    endFrame: number;
    boxes: Array<{ frame: number; x: number; y: number; w: number; h: number }>;
  }>;
  crossings: Array<{
    frame: number;
    trackId: string;
    otherTrackId: string;
    confidence?: number;
  }>;
  inPlaySpans: Array<{ start: number; end: number }>;
  events: Array<{
    type: string;
    time: number;
    label?: string | null;
    clipId?: string | null;
  }>;
};

export type TrackingManifest = {
  version: number;
  label: string;
  width: number;
  height: number;
  frameRate: number;
  frameCount: number;
  duration: number;
  /**
   * Display only: added to tracking time so the clock reads like the wider
   * match. Never use it to seek - that was the bug that put every box on empty
   * grass, because one field was being asked to be two different things.
   */
  matchOffset: number;
  /**
   * Where tracking frame 0 sits inside the video file, in seconds. The recording
   * is often longer than the tracked window.
   */
  videoStartSeconds: number;
  segmentCount: number;
  segments: Array<{
    index: number;
    name: string;
    startFrame: number;
    endFrame: number;
    startSeconds: number;
    endSeconds: number;
    objectPath: string;
    /** crop strips for the identity board, when the bundle carried them */
    spritesPath?: string;
  }>;
  /**
   * Optional camera-to-pitch calibration. Grid rows run from the top of the
   * image to the bottom and columns from left to right; each point is a pitch
   * position in metres at that image-grid location.
   */
  pitchModel?: TrackingPitchModel;
  /**
   * The identity board's result: pieces of tracks that are one person.
   * Track ids are segment-namespaced ("s2:t41"); frames are absolute. Optional,
   * set by PUT /admin/recordings/:id/identities. The claim page merges tracks
   * from it at load time.
   */
  identities?: TrackingIdentity[];
  /** How the bundle was produced (linker, parameters, measurements). Free-form. */
  provenance?: Record<string, unknown>;
  /** Small server-side index used for coverage and completion calculations. */
  summary?: TrackingBundleSummary;
};

export type TrackingPitchModel = {
  calibrationId: string;
  fittedAt: string;
  calibratedAspectRatio: number;
  pitchWidthMetres: number;
  pitchHeightMetres: number;
  grid: Array<Array<{ x: number; y: number }>>;
};

export type TrackingIdentity = {
  id: string;
  name?: string | null;
  parts: Array<{ trackId: string; fromFrame: number; toFrame: number }>;
};

export type TrackingBundleSummary = {
  segments: Array<{
    segmentIndex: number;
    startFrame: number;
    endFrame: number;
    startSeconds: number;
    endSeconds: number;
    tracks: Array<{
      id: string;
      startFrame: number;
      endFrame: number;
    }>;
    events: TrackingSegmentPayload["events"];
  }>;
};

export const recordingTrackingBundlesTable = pgTable(
  "recording_tracking_bundles",
  {
    id: serial("id").primaryKey(),
    recordingId: integer("recording_id")
      .notNull()
      .references(() => recordingsTable.id, { onDelete: "cascade" }),
    manifest: jsonb("manifest").notNull().$type<TrackingManifest>(),
    uploadedBy: integer("uploaded_by").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    recordingUnique: uniqueIndex("recording_tracking_bundles_recording_unique").on(
      table.recordingId,
    ),
  }),
);

export const recordingTrackingSegmentsTable = pgTable(
  "recording_tracking_segments",
  {
    id: serial("id").primaryKey(),
    bundleId: integer("bundle_id")
      .notNull()
      .references(() => recordingTrackingBundlesTable.id, { onDelete: "cascade" }),
    segmentIndex: integer("segment_index").notNull(),
    name: text("name").notNull(),
    startFrame: integer("start_frame").notNull(),
    endFrame: integer("end_frame").notNull(),
    startSeconds: doublePrecision("start_seconds").notNull(),
    endSeconds: doublePrecision("end_seconds").notNull(),
    objectPath: text("object_path").notNull(),
    compressedBytes: integer("compressed_bytes").notNull().default(0),
    trackCount: integer("track_count").notNull().default(0),
    crossingCount: integer("crossing_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    bundleIndexUnique: uniqueIndex("recording_tracking_segments_bundle_index_unique").on(
      table.bundleId,
      table.segmentIndex,
    ),
  }),
);

export const claimMatchProgressTable = pgTable(
  "claim_match_progress",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    recordingId: integer("recording_id")
      .notNull()
      .references(() => recordingsTable.id, { onDelete: "cascade" }),
    currentTrackId: text("current_track_id"),
    stage: text("stage").notNull().default("find"),
    confirmedFromSeconds: doublePrecision("confirmed_from_seconds").notNull().default(0),
    currentPositionSeconds: doublePrecision("current_position_seconds").notNull().default(0),
    claimedPercent: doublePrecision("claimed_percent").notNull().default(0),
    clipsUnlocked: integer("clips_unlocked").notNull().default(0),
    correctionCount: integer("correction_count").notNull().default(0),
    completed: boolean("completed").notNull().default(false),
    earnedClips: jsonb("earned_clips")
      .notNull()
      .$type<ClaimEarnedClip[]>()
      .default([]),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userRecordingUnique: uniqueIndex("claim_match_progress_user_recording_unique").on(
      table.userId,
      table.recordingId,
    ),
  }),
);

export const claimMatchCorrectionsTable = pgTable(
  "claim_match_corrections",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    recordingId: integer("recording_id")
      .notNull()
      .references(() => recordingsTable.id, { onDelete: "cascade" }),
    clientId: text("client_id").notNull(),
    momentSeconds: doublePrecision("moment_seconds").notNull(),
    rejectedTrackId: text("rejected_track_id"),
    chosenTrackId: text("chosen_track_id").notNull(),
    answerMethod: text("answer_method").notNull(),
    questionCount: integer("question_count").notNull().default(0),
    undone: boolean("undone").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    clientUnique: uniqueIndex("claim_match_corrections_client_unique").on(
      table.userId,
      table.recordingId,
      table.clientId,
    ),
  }),
);

export type TrackingBundleRow = typeof recordingTrackingBundlesTable.$inferSelect;
export type TrackingSegmentRow = typeof recordingTrackingSegmentsTable.$inferSelect;
export type ClaimMatchProgressRow = typeof claimMatchProgressTable.$inferSelect;
export type ClaimMatchCorrectionRow = typeof claimMatchCorrectionsTable.$inferSelect;