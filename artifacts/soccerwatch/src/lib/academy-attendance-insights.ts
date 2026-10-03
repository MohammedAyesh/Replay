export type AttendanceInsightStatus = "present" | "late" | "absent" | "excused";

export interface AttendanceInsightRecord {
  playerId: number;
  playerName: string;
  status: AttendanceInsightStatus | null | undefined;
}

export interface MonthlyPlayerAttendanceInsight {
  playerId: number;
  playerName: string;
  present: number;
  late: number;
  absent: number;
  excused: number;
  countedRecords: number;
  absenceRate: number;
}

export interface MonthlyAttendanceInsights {
  mostCommitted: MonthlyPlayerAttendanceInsight[];
  mostAbsent: MonthlyPlayerAttendanceInsight[];
}

const MIN_COUNTED_RECORDS = 2;
const LIST_LIMIT = 5;

function comparePlayersByName(left: MonthlyPlayerAttendanceInsight, right: MonthlyPlayerAttendanceInsight) {
  return left.playerName.localeCompare(right.playerName, "en", { sensitivity: "base" })
    || left.playerId - right.playerId;
}

function compareAbsenceRate(left: MonthlyPlayerAttendanceInsight, right: MonthlyPlayerAttendanceInsight) {
  return left.absent * right.countedRecords - right.absent * left.countedRecords;
}

export function computeMonthlyAttendanceInsights(
  records: readonly AttendanceInsightRecord[],
): MonthlyAttendanceInsights {
  const totals = new Map<number, Omit<MonthlyPlayerAttendanceInsight, "countedRecords" | "absenceRate">>();

  for (const record of records) {
    if (!record.status) continue;
    const total = totals.get(record.playerId) ?? {
      playerId: record.playerId,
      playerName: record.playerName,
      present: 0,
      late: 0,
      absent: 0,
      excused: 0,
    };
    total[record.status] += 1;
    totals.set(record.playerId, total);
  }

  const eligible = [...totals.values()].flatMap((total) => {
    const countedRecords = total.present + total.late + total.absent;
    if (countedRecords < MIN_COUNTED_RECORDS) return [];
    return [{
      ...total,
      countedRecords,
      absenceRate: total.absent / countedRecords,
    }];
  });

  return {
    mostCommitted: [...eligible]
      .sort((left, right) => compareAbsenceRate(left, right) || comparePlayersByName(left, right))
      .slice(0, LIST_LIMIT),
    mostAbsent: [...eligible]
      .sort((left, right) => compareAbsenceRate(right, left) || comparePlayersByName(left, right))
      .slice(0, LIST_LIMIT),
  };
}