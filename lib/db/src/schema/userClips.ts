import { pgTable, serial, integer, text, numeric, timestamp, jsonb, boolean } from "drizzle-orm/pg-core";
import { usersTable } from "./users";
import { fieldsTable } from "./fields";
import { academiesTable } from "./academies";

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
  /**
   * Academy this clip was created under, if any (set client-side from the
   * page context — field-detail or the academy's live view — at creation
   * time). Drives which branding intro gets prepended on export/playback.
   * Nullable and set-null-on-delete: losing the academy just stops the intro
   * from playing, it never blocks or cascades into deleting the clip itself.
   */
  academyId: integer("academy_id").references(() => academiesTable.id, { onDelete: "set null" }),
  visibility: text("visibility").notNull().default("private"),
  thumbnailTime: numeric("thumbnail_time", { precision: 10, scale: 3 }),
  likeCount: integer("like_count").notNull().default(0),
  viewCount: integer("view_count").notNull().default(0),
  shareCount: integer("share_count").notNull().default(0),
  score: integer("score").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  /** Admin-hidden clips are excluded from all public feeds */
  isHidden: boolean("is_hidden").notNull().default(false),
  /** Status of the server-side MP4 render job: null = never started, pending, done, error */
  exportStatus: text("export_status"),
  /** Bunny Storage CDN URL of the rendered MP4 once exportStatus = 'done' */
  exportedUrl: text("exported_url"),
});

export type UserClipRow = typeof userClipsTable.$inferSelect;
