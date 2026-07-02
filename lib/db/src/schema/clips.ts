import { pgTable, serial, integer, text } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { recordingsTable } from "./recordings";
import { usersTable } from "./users";

export const clipsTable = pgTable("clips", {
  id: serial("id").primaryKey(),
  recordingId: integer("recording_id").notNull().references(() => recordingsTable.id),
  creatorId: integer("creator_id").references(() => usersTable.id, { onDelete: "set null" }),
  rank: integer("rank").notNull().default(0),
  momentLabel: text("moment_label").notNull(),
  playerTags: text("player_tags").array().notNull().default([]),
  likeCount: integer("like_count").notNull().default(0),
  bunnyVideoId: text("bunny_video_id"),
  bunnyPlaybackUrl: text("bunny_playback_url"),
});

export const insertClipSchema = createInsertSchema(clipsTable).omit({ id: true });
export type InsertClip = z.infer<typeof insertClipSchema>;
export type Clip = typeof clipsTable.$inferSelect;
