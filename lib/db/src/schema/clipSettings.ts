import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const clipSettingsTable = pgTable("clip_settings", {
  id: serial("id").primaryKey(),
  introVideoUrl: text("intro_video_url"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ClipSettings = typeof clipSettingsTable.$inferSelect;