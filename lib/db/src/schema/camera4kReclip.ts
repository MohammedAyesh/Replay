import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { userClipsTable } from "./userClips";

export type Camera4kSourceProbe = {
  recordingId: number;
  videoId: string;
  recordingDate: string;
  timeSlot: string | null;
  state: "ready" | "unavailable";
  reason: string | null;
};

export const camera4kReclipBatchesTable = pgTable("camera_4k_reclip_batches", {
  id: serial("id").primaryKey(),
  batchKey: text("batch_key").notNull().unique(),
  status: text("status").notNull().default("scheduled")
    .$type<"scheduled" | "running" | "paused" | "completed">(),
  scopeSeeded: boolean("scope_seeded").notNull().default(false),
  paused: boolean("paused").notNull().default(false),
  scopeCutoff: timestamp("scope_cutoff", { withTimezone: true }).notNull(),
  totalCount: integer("total_count").notNull().default(0),
  completedCount: integer("completed_count").notNull().default(0),
  failedCount: integer("failed_count").notNull().default(0),
  skippedCount: integer("skipped_count").notNull().default(0),
  sourceProbeSummary: jsonb("source_probe_summary")
    .$type<Camera4kSourceProbe[]>()
    .notNull()
    .default([]),
  leaseToken: text("lease_token"),
  leaseUntil: timestamp("lease_until", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check("camera_4k_reclip_batches_status_check", sql`${table.status} in ('scheduled', 'running', 'paused', 'completed')`),
  index("camera_4k_reclip_batches_status_idx").on(table.status, table.updatedAt),
]);

export const camera4kReclipItemsTable = pgTable("camera_4k_reclip_items", {
  id: serial("id").primaryKey(),
  batchId: integer("batch_id").notNull()
    .references(() => camera4kReclipBatchesTable.id, { onDelete: "cascade" }),
  clipId: integer("clip_id").notNull()
    .references(() => userClipsTable.id, { onDelete: "cascade" }),
  recordingId: integer("recording_id").notNull(),
  videoId: text("video_id").notNull(),
  status: text("status").notNull().default("pending")
    .$type<"pending" | "running" | "completed" | "failed" | "skipped">(),
  failureReason: text("failure_reason"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  elapsedMs: integer("elapsed_ms"),
  oldDurationSeconds: text("old_duration_seconds"),
  newDurationSeconds: text("new_duration_seconds"),
  oldBytes: bigint("old_bytes", { mode: "number" }),
  newBytes: bigint("new_bytes", { mode: "number" }),
  width: integer("width"),
  height: integer("height"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique("camera_4k_reclip_items_batch_clip_unique").on(table.batchId, table.clipId),
  check("camera_4k_reclip_items_status_check", sql`${table.status} in ('pending', 'running', 'completed', 'failed', 'skipped')`),
  index("camera_4k_reclip_items_batch_status_id_idx").on(table.batchId, table.status, table.id),
]);

export type Camera4kReclipBatch = typeof camera4kReclipBatchesTable.$inferSelect;
export type Camera4kReclipItem = typeof camera4kReclipItemsTable.$inferSelect;
