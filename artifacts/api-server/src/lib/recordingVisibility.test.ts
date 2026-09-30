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

  it("treats 00:00 as the end of an evening window", () => {
    const evening = [
      { allowedDate: "2026-09-17", startTime: "20:00", endTime: "00:00" },
    ];
    expect(matchesRecordingSchedule("2026-09-17", "20:00", evening)).toBe(true);
    expect(matchesRecordingSchedule("2026-09-17", "22:00", evening)).toBe(true);
    expect(matchesRecordingSchedule("2026-09-17", "23:59", evening)).toBe(true);
    expect(matchesRecordingSchedule("2026-09-17", "00:00", evening)).toBe(false);
    expect(matchesRecordingSchedule("2026-09-18", "00:00", evening)).toBe(false);
  });

  it("matches overnight windows on both dates without exposing earlier same-day recordings", () => {
    const overnight = [
      { allowedDate: "2026-09-17", startTime: "23:00", endTime: "01:00" },
    ];
    expect(matchesRecordingSchedule("2026-09-17", "22:59", overnight)).toBe(false);
    expect(matchesRecordingSchedule("2026-09-17", "23:00", overnight)).toBe(true);
    expect(matchesRecordingSchedule("2026-09-17", "23:59", overnight)).toBe(true);
    expect(matchesRecordingSchedule("2026-09-18", "00:00", overnight)).toBe(true);
    expect(matchesRecordingSchedule("2026-09-18", "00:59", overnight)).toBe(true);
    expect(matchesRecordingSchedule("2026-09-18", "01:00", overnight)).toBe(false);
    expect(matchesRecordingSchedule("2026-09-17", "00:30", overnight)).toBe(false);
  });
});