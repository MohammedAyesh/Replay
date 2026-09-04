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
  /**
   * Bunny Storage path of the share-card poster, once one has been generated.
   *
   * A path, not a URL: Bunny Storage is an authenticated origin, so the poster
   * is always served through the API's own proxy and the public URL is derived
   * from the clip id at request time. Storing a URL here would bake the CDN host
   * into every row.
   *
   * Null means "not generated yet". Generation is lazy — first share, not
   * export — because most clips are never shared and a poster costs a seek
   * against an hour-long source.
   */
  posterPath: text("poster_path"),
  /** Absolute position in the source video the poster was taken from, in
   *  seconds. Kept for diagnosis: a poster that looks wrong is usually a poster
   *  taken from the wrong second. */
  posterAtSec: numeric("poster_at_sec", { precision: 10, scale: 3 }),
});

export type UserClipRow = typeof userClipsTable.$inferSelect;
