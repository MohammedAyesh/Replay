import { pgTable, serial, integer, text, numeric, timestamp, jsonb, boolean } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export type CropKeyframe = {
  t: number;
  x: number;
  y: number;
  w: number;
  h: number;
};

export const userClipsTable = pgTable("user_clips", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  videoId: text("video_id").notNull(),
  title: text("title").notNull(),
  startTime: numeric("start_time", { precision: 10, scale: 6 }).notNull(),
  endTime: numeric("end_time", { precision: 10, scale: 6 }).notNull(),
  cropPath: jsonb("crop_path").notNull().$type<CropKeyframe[]>().default([]),
  aspectRatio: text("aspect_ratio").notNull().default("16:9"),
  visibility: text("visibility").notNull().default("private"),
  thumbnailTime: numeric("thumbnail_time", { precision: 10, scale: 3 }),
  likeCount: integer("like_count").notNull().default(0),
  viewCount: integer("view_count").notNull().default(0),
  shareCount: integer("share_count").notNull().default(0),
  score: integer("score").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  /** Status of the server-side MP4 render job: null = never started, pending, done, error */
  exportStatus: text("export_status"),
  /** Bunny Storage CDN URL of the rendered MP4 once exportStatus = 'done' */
  exportedUrl: text("exported_url"),
});

export type UserClipRow = typeof userClipsTable.$inferSelect;
