import { eq } from "drizzle-orm";
import { db, recordingSchedulesTable } from "@workspace/db";

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

/** The shared public-recording rule: an exact date and time window on the field. */
export function matchesRecordingSchedule(
  date: string,
  timeSlot: string,
  schedules: RecordingVisibilitySchedule[],
): boolean {
  if (schedules.length === 0) return false;
  const [recordingHour, recordingMinute] = timeSlot.split(":").map(Number);
  if (!Number.isInteger(recordingHour) || !Number.isInteger(recordingMinute)) return false;
  const recordingMinutes = recordingHour * 60 + recordingMinute;

  return schedules.some((schedule) => {
    const [startHour, startMinute] = schedule.startTime.split(":").map(Number);
    const [endHour, endMinute] = schedule.endTime.split(":").map(Number);
    if (
      !Number.isInteger(startHour)
      || !Number.isInteger(startMinute)
      || !Number.isInteger(endHour)
      || !Number.isInteger(endMinute)
    ) return false;
    return schedule.allowedDate === date
      && recordingMinutes >= startHour * 60 + startMinute
      && recordingMinutes < endHour * 60 + endMinute;
  });
}

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