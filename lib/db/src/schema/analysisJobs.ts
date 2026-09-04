import {
  pgTable,
  serial,
  integer,
  text,
  timestamp,
  jsonb,
  doublePrecision,
  index,
} from "drizzle-orm/pg-core";
import { recordingsTable } from "./recordings";
import { usersTable } from "./users";

/**
 * A run of the tracking pipeline, queued from the admin console and executed on
 * the GPU workstation.
 *
 * The queue exists because the pipeline is not a request. A football hour takes
 * roughly six GPU-hours, the machine that can do it is somebody's desktop, and
 * that desktop is asleep about as often as it is awake. So the admin console
 * writes a row, the workstation asks for work whenever it is running, and the
 * console reports where the row has got to. Nothing in the web request path
 * waits for any of it.
 */
export type AnalysisJobStatus =
  | "queued"
  | "claimed"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export type AnalysisJobParams = {
  /** Seconds per analysed chunk. The pipeline wants the whole GPU per chunk. */
  chunkSeconds?: number;
  /** Cap on chunks, for a deliberately short trial run. */
  maxChunks?: number;
  /** Free-form knobs passed through to the workstation without interpretation. */
  [key: string]: unknown;
};

export const analysisJobsTable = pgTable(
  "analysis_jobs",
  {
    id: serial("id").primaryKey(),
    /**
     * Where the finished bundle lands. Normally the first source, but kept
     * separate because a match assembled from several hourly recordings is
     * still claimed against one of them.
     */
    recordingId: integer("recording_id")
      .notNull()
      .references(() => recordingsTable.id, { onDelete: "cascade" }),
    /**
     * The recordings to analyse, in playing order. Stored as an ordered array
     * rather than a join table because the order is the meaning: hours arrive
     * as separate recordings and concatenating them in the wrong sequence
     * produces a bundle whose timeline is silently wrong.
     */
    sourceRecordingIds: jsonb("source_recording_ids")
      .notNull()
      .$type<number[]>()
      .default([]),
    /**
     * Kick-off, in seconds from the start of the concatenated source. This is
     * the number the operator actually knows ("the match starts 18 minutes into
     * the first hour"); the pipeline turns it into the manifest's matchOffset.
     */
    matchStartSeconds: doublePrecision("match_start_seconds").notNull().default(0),
    status: text("status").notNull().default("queued").$type<AnalysisJobStatus>(),
    /** Worker-supplied label for what it is doing now: "analysing chunk 3 of 6". */
    stage: text("stage"),
    progress: doublePrecision("progress").notNull().default(0),
    params: jsonb("params").notNull().$type<AnalysisJobParams>().default({}),
    workerId: text("worker_id"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    /**
     * Last sign of life from the worker holding this job. A job whose heartbeat
     * has gone quiet is returned to the queue rather than left claimed forever,
     * which is what happens when the desktop reboots mid-run.
     */
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    /**
     * The recordings that have received a bundle from this job so far.
     *
     * A match recorded as separate hours is analysed as one continuous thing -
     * that is the only way an identity survives the hour boundary - but the
     * claim page plays a single recording, so the result comes back split: one
     * bundle per source, each with its own offset into its own video. This is
     * the record of which of those have landed.
     */
    bundleRecordingIds: jsonb("bundle_recording_ids")
      .notNull()
      .$type<number[]>()
      .default([]),
    attempts: integer("attempts").notNull().default(0),
    error: text("error"),
    createdBy: integer("created_by").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    statusCreatedIdx: index("analysis_jobs_status_created_idx").on(
      table.status,
      table.createdAt,
    ),
    recordingIdx: index("analysis_jobs_recording_idx").on(table.recordingId),
  }),
);

/**
 * One row per workstation, so the console can say "the PC has not been seen
 * since 14:02" instead of showing a queue that appears stuck for no reason.
 * The worker writes here on every poll, whether or not it takes work.
 */
export const analysisWorkersTable = pgTable("analysis_workers", {
  id: text("id").primaryKey(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  status: text("status").notNull().default("idle"),
  currentJobId: integer("current_job_id"),
  version: text("version"),
  note: text("note"),
});

export type AnalysisJobRow = typeof analysisJobsTable.$inferSelect;
export type AnalysisWorkerRow = typeof analysisWorkersTable.$inferSelect;
