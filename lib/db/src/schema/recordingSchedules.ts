import { pgTable, serial, integer, smallint, text, date } from "drizzle-orm/pg-core";
import { fieldsTable } from "./fields";

/**
 * Per-field date-whitelisted time windows.
 * A recording is automatically visible if its date+timeSlot falls within any
 * window defined for its field and exact allowedDate.
 *
 * allowedDate: exact recording date in YYYY-MM-DD format
 * startTime / endTime: "HH:MM" (24-hour)
 */
export const recordingSchedulesTable = pgTable("recording_schedules", {
  id: serial("id").primaryKey(),
  fieldId: integer("field_id").notNull().references(() => fieldsTable.id, { onDelete: "cascade" }),
  // Kept for backwards-compatible database reads; date-based visibility ignores it.
  dayOfWeek: smallint("day_of_week"),
  allowedDate: date("allowed_date", { mode: "string" }),
  startTime: text("start_time").notNull(),      // "HH:MM"
  endTime: text("end_time").notNull(),          // "HH:MM"
  label: text("label"),                        // e.g. "Training", "Match Day"
});

export type RecordingSchedule = typeof recordingSchedulesTable.$inferSelect;
