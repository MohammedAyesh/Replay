import { describe, expect, it } from "vitest";
import { matchesRecordingSchedule } from "./recordingVisibility";

describe("recording visibility schedules", () => {
  const schedules = [
    { allowedDate: "2026-09-02", startTime: "18:00", endTime: "20:00" },
  ];

  it("requires the exact date and keeps the end of the window exclusive", () => {
    expect(matchesRecordingSchedule("2026-09-02", "18:00", schedules)).toBe(true);
    expect(matchesRecordingSchedule("2026-09-02", "19:59", schedules)).toBe(true);
    expect(matchesRecordingSchedule("2026-09-02", "20:00", schedules)).toBe(false);
    expect(matchesRecordingSchedule("2026-09-01", "19:00", schedules)).toBe(false);
  });

  it("does not make recordings public when no exact-date schedule exists", () => {
    expect(matchesRecordingSchedule("2026-09-02", "19:00", [])).toBe(false);
    expect(matchesRecordingSchedule("2026-09-02", "not-a-time", schedules)).toBe(false);
  });
});