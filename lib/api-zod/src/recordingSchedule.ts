export type RecordingScheduleWindow = {
  allowedDate: string | null;
  startTime: string;
  endTime: string;
};

function parseMinutes(time: string): number | null {
  const match = time.match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function nextCalendarDate(date: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) return null;
  parsed.setUTCDate(parsed.getUTCDate() + 1);
  return parsed.toISOString().slice(0, 10);
}

/**
 * Check whether a recording's start timestamp falls in an exact-date field
 * window. A window whose end is earlier than its start continues into the
 * following calendar date; 00:00 remains the exclusive end at midnight.
 */
export function matchesRecordingSchedule(
  date: string,
  timeSlot: string,
  schedules: RecordingScheduleWindow[],
): boolean {
  const recordingMinutes = parseMinutes(timeSlot);
  if (recordingMinutes === null || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;

  return schedules.some((schedule) => {
    if (!schedule.allowedDate) return false;
    const startMinutes = parseMinutes(schedule.startTime);
    const endMinutes = parseMinutes(schedule.endTime);
    if (startMinutes === null || endMinutes === null) return false;

    // 20:00–00:00 means through 23:59 on the selected date, ending at
    // midnight. Other end times earlier than the start roll into tomorrow.
    const crossesMidnight = endMinutes < startMinutes
      || (endMinutes === 0 && startMinutes > 0);
    const windowEnd = crossesMidnight ? endMinutes + 24 * 60 : endMinutes;

    let relativeRecordingMinutes: number;
    if (date === schedule.allowedDate) {
      relativeRecordingMinutes = recordingMinutes;
    } else if (crossesMidnight && date === nextCalendarDate(schedule.allowedDate)) {
      relativeRecordingMinutes = recordingMinutes + 24 * 60;
    } else {
      return false;
    }

    return relativeRecordingMinutes >= startMinutes
      && relativeRecordingMinutes < windowEnd;
  });
}