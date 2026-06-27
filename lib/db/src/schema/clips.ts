import { pgTable, serial, integer, text } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { recordingsTable } from "./recordings";

export const clipsTable = pgTable("clips", {
  id: serial("id").primaryKey(),
  recordingId: integer("recording_id").notNull().references(() => recordingsTable.id),
  rank: integer("rank").notNull().default(0),
  momentLabel: text("moment_label").notNull(),
  playerTags: text("player_tags").array().notNull().default([]),
  likeCount: integer("like_count").notNull().default(0),
});

export const insertClipSchema = createInsertSchema(clipsTable).omit({ id: true });
export type InsertClip = z.infer<typeof insertClipSchema>;
export type Clip = typeof clipsTable.$inferSelect;
