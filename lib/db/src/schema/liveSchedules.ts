import { pgTable, serial, text, boolean, timestamp } from "drizzle-orm/pg-core";

export const liveSchedulesTable = pgTable("live_schedules", {
  id: serial("id").primaryKey(),
  camera: text("camera").notNull(), // "camera1" | "camera2"
  startTime: text("start_time").notNull(), // "HH:MM" 24-hour
  endTime: text("end_time").notNull(),     // "HH:MM" 24-hour
  daysOfWeek: text("days_of_week").notNull().default(""), // comma-separated e.g. "monday,wednesday" — empty = every day
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type LiveSchedule = typeof liveSchedulesTable.$inferSelect;
