import { pgTable, serial, integer, text, numeric, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";

export const userClipsTable = pgTable("user_clips", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  videoId: text("video_id").notNull(),
  title: text("title").notNull(),
  startTime: numeric("start_time", { precision: 10, scale: 6 }).notNull(),
  endTime: numeric("end_time", { precision: 10, scale: 6 }).notNull(),
  cropX: numeric("crop_x", { precision: 10, scale: 6 }).notNull().default("0"),
  cropY: numeric("crop_y", { precision: 10, scale: 6 }).notNull().default("0"),
  cropW: numeric("crop_w", { precision: 10, scale: 6 }).notNull().default("1"),
  cropH: numeric("crop_h", { precision: 10, scale: 6 }).notNull().default("1"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertUserClipSchema = createInsertSchema(userClipsTable).omit({ id: true, createdAt: true });
export type InsertUserClip = z.infer<typeof insertUserClipSchema>;
export type UserClipRow = typeof userClipsTable.$inferSelect;
