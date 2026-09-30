import { eq } from "drizzle-orm";
import { matchesRecordingSchedule } from "@workspace/api-zod";
import { db, fieldsTable, recordingSchedulesTable } from "@workspace/db";

export { matchesRecordingSchedule } from "@workspace/api-zod";

export type RecordingVisibilityFields = {
  fieldId: number;
  date: string;
  timeSlot: string;
  isVisible?: boolean;
};

export type RecordingVisibilitySchedule = {
  allowedDate: string | null;
  startTime: string;
  endTime: string;
};

export async function isRecordingVisible(recording: RecordingVisibilityFields): Promise<boolean> {
  const [field] = await db
    .select({ isHidden: fieldsTable.isHidden })
    .from(fieldsTable)
    .where(eq(fieldsTable.id, recording.fieldId));
  if (!field || field.isHidden) return false;

  // An explicit admin visibility toggle overrides the field's date/time
  // schedule. A hidden recording stays hidden; partial legacy callers without
  // the toggle still use the schedule rule.
  if (recording.isVisible === true) return true;
  if (recording.isVisible === false) return false;

  const schedules = await db
    .select({
      allowedDate: recordingSchedulesTable.allowedDate,
      startTime: recordingSchedulesTable.startTime,
      endTime: recordingSchedulesTable.endTime,
    })
    .from(recordingSchedulesTable)
    .where(eq(recordingSchedulesTable.fieldId, recording.fieldId));
  return matchesRecordingSchedule(recording.date, recording.timeSlot, schedules);
}