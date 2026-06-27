import { pgTable, serial, integer, text, date, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { fieldsTable } from "./fields";

export const recordingsTable = pgTable("recordings", {
  id: serial("id").primaryKey(),
  fieldId: integer("field_id").notNull().references(() => fieldsTable.id),
  court: text("court").notNull(),
  date: date("date", { mode: "string" }).notNull(),
  timeSlot: text("time_slot").notNull(),
  duration: text("duration").notNull(),
  score: text("score"),
  videoUrl: text("video_url").notNull().default(""),
  highlightMoment: text("highlight_moment"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertRecordingSchema = createInsertSchema(recordingsTable).omit({ id: true, createdAt: true });
export type InsertRecording = z.infer<typeof insertRecordingSchema>;
export type Recording = typeof recordingsTable.$inferSelect;
