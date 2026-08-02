import { pgTable, serial, integer, smallint, text } from "drizzle-orm/pg-core";
import { fieldsTable } from "./fields";

/**
 * Per-field recurring time windows.
 * A recording is automatically visible if its date+timeSlot falls within any
 * window defined for its field.
 *
 * dayOfWeek: 0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat, null=every day
 * startTime / endTime: "HH:MM" (24-hour)
 */
export const recordingSchedulesTable = pgTable("recording_schedules", {
  id: serial("id").primaryKey(),
  fieldId: integer("field_id").notNull().references(() => fieldsTable.id, { onDelete: "cascade" }),
  dayOfWeek: smallint("day_of_week"),          // null = any day
  startTime: text("start_time").notNull(),      // "HH:MM"
  endTime: text("end_time").notNull(),          // "HH:MM"
  label: text("label"),                        // e.g. "Training", "Match Day"
});

export type RecordingSchedule = typeof recordingSchedulesTable.$inferSelect;
