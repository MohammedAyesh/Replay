import { pgTable, serial, integer, text, date, timestamp, real, uniqueIndex, index, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { usersTable } from "./users";
import { fieldsTable } from "./fields";
import { userClipsTable } from "./userClips";

export const weeklyHighlightsTable = pgTable("weekly_highlights", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => usersTable.id, { onDelete: "cascade" }),
  fieldId: integer("field_id").notNull().references(() => fieldsTable.id, { onDelete: "cascade" }),
  weekStart: date("week_start", { mode: "string" }).notNull(),
  title: text("title").notNull(),
  clipCount: integer("clip_count").notNull().default(0),
  durationSec: integer("duration_sec").notNull().default(0),
  status: text("status").$type<"draft" | "published">().notNull().default("draft"),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("weekly_highlights_personal_week_unique").on(table.userId, table.weekStart).where(sql`${table.userId} IS NOT NULL`),
  uniqueIndex("weekly_highlights_field_week_unique").on(table.fieldId, table.weekStart).where(sql`${table.userId} IS NULL`),
  index("weekly_highlights_published_week_idx").on(table.status, table.weekStart),
  check("weekly_highlights_status_check", sql`${table.status} IN ('draft', 'published')`),
]);

export const highlightClipsTable = pgTable("highlight_clips", {
  highlightId: integer("highlight_id").notNull().references(() => weeklyHighlightsTable.id, { onDelete: "cascade" }),
  position: integer("position").notNull(),
  clipId: integer("clip_id").notNull().references(() => userClipsTable.id, { onDelete: "cascade" }),
  eventType: text("event_type").$type<"goal" | "assist" | "save" | "tackle">().notNull(),
  minute: integer("minute"),
  videoUrl: text("video_url").notNull(),
  previewUrl: text("preview_url").notNull(),
  youX: real("you_x"),
  youY: real("you_y"),
}, (table) => [
  uniqueIndex("highlight_clips_position_unique").on(table.highlightId, table.position),
  check("highlight_clips_event_type_check", sql`${table.eventType} IN ('goal', 'assist', 'save', 'tackle')`),
  check("highlight_clips_marker_check", sql`(${table.youX} IS NULL OR ${table.youX} BETWEEN 0 AND 1) AND (${table.youY} IS NULL OR ${table.youY} BETWEEN 0 AND 1)`),
]);

export const highlightNoticesTable = pgTable("highlight_notices", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  highlightId: integer("highlight_id").notNull().references(() => weeklyHighlightsTable.id, { onDelete: "cascade" }),
  message: text("message").notNull(),
  status: text("status").$type<"queued" | "copied">().notNull().default("queued"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("highlight_notices_user_highlight_unique").on(table.userId, table.highlightId),
  check("highlight_notices_status_check", sql`${table.status} IN ('queued', 'copied')`),
]);

export type WeeklyHighlight = typeof weeklyHighlightsTable.$inferSelect;
export type HighlightClip = typeof highlightClipsTable.$inferSelect;
export type HighlightNotice = typeof highlightNoticesTable.$inferSelect;
