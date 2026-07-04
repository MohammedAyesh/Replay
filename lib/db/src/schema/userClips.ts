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
  isPublic: boolean("is_public").notNull().default(true),
  likeCount: integer("like_count").notNull().default(0),
  viewCount: integer("view_count").notNull().default(0),
  shareCount: integer("share_count").notNull().default(0),
  score: integer("score").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type UserClipRow = typeof userClipsTable.$inferSelect;
