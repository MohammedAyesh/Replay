import { pgTable, serial, integer, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { recordingsTable } from "./recordings";
import { usersTable } from "./users";

export const recordingViewsTable = pgTable("recording_views", {
  id: serial("id").primaryKey(),
  recordingId: integer("recording_id").notNull().references(() => recordingsTable.id, { onDelete: "cascade" }),
  viewerUserId: integer("viewer_user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  viewCount: integer("view_count").notNull().default(1),
  watchedSeconds: integer("watched_seconds").notNull().default(0),
  firstViewedAt: timestamp("first_viewed_at", { withTimezone: true }).notNull().defaultNow(),
  lastViewedAt: timestamp("last_viewed_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("recording_views_recording_viewer_unique").on(table.recordingId, table.viewerUserId),
  index("recording_views_recording_last_viewed_idx").on(table.recordingId, table.lastViewedAt),
]);

export const insertRecordingViewSchema = createInsertSchema(recordingViewsTable)
  .omit({ id: true, firstViewedAt: true, lastViewedAt: true });
export type InsertRecordingView = z.infer<typeof insertRecordingViewSchema>;
export type RecordingView = typeof recordingViewsTable.$inferSelect;
