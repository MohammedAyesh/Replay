import { eq } from "drizzle-orm";
import { matchesRecordingSchedule } from "@workspace/api-zod";
import { db, recordingSchedulesTable } from "@workspace/db";

export { matchesRecordingSchedule } from "@workspace/api-zod";

export type RecordingVisibilityFields = {
  fieldId: number;
  date: string;
  timeSlot: string;
};

export type RecordingVisibilitySchedule = {
  allowedDate: string | null;
  startTime: string;
  endTime: string;
};

export async function isRecordingVisible(recording: RecordingVisibilityFields): Promise<boolean> {
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