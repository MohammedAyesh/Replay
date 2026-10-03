import { describe, expect, it } from "vitest";
import { computeMonthlyAttendanceInsights, type AttendanceInsightRecord } from "./academy-attendance-insights";

function record(playerId: number, playerName: string, status: AttendanceInsightRecord["status"]): AttendanceInsightRecord {
  return { playerId, playerName, status };
}

describe("monthly academy attendance insights", () => {
  it("excludes excused marks from the absence-rate denominator while counting them separately", () => {
    const { mostCommitted } = computeMonthlyAttendanceInsights([
      record(1, "Amina", "present"),
      record(1, "Amina", "present"),
      record(1, "Amina", "late"),
      record(1, "Amina", "absent"),
      record(1, "Amina", "excused"),
      record(1, "Amina", "excused"),
    ]);

    expect(mostCommitted).toEqual([expect.objectContaining({
      playerId: 1,
      present: 2,
      late: 1,
      absent: 1,
      excused: 2,
      countedRecords: 4,
      absenceRate: 0.25,
    })]);
  });

  it("requires two non-excused records before including a player", () => {
    const { mostCommitted, mostAbsent } = computeMonthlyAttendanceInsights([
      record(1, "One mark", "present"),
      record(1, "One mark", "excused"),
      record(2, "Excused only", "excused"),
      record(2, "Excused only", "excused"),
      record(3, "Eligible", "present"),
      record(3, "Eligible", "absent"),
    ]);

    expect(mostCommitted.map(({ playerId }) => playerId)).toEqual([3]);
    expect(mostAbsent.map(({ playerId }) => playerId)).toEqual([3]);
  });

  it("orders equal absence rates by name in both lists", () => {
    const { mostCommitted, mostAbsent } = computeMonthlyAttendanceInsights([
      record(9, "Zed", "absent"),
      record(9, "Zed", "present"),
      record(4, "Ada", "absent"),
      record(4, "Ada", "late"),
    ]);

    expect(mostCommitted.map(({ playerName }) => playerName)).toEqual(["Ada", "Zed"]);
    expect(mostAbsent.map(({ playerName }) => playerName)).toEqual(["Ada", "Zed"]);
  });
});