/**
 * What Replay measured for a player, for their public profile: the per-match
 * figures the match report shows (top speed, goals, shots, passes, touches,
 * dribbles, distance), read straight from match_player_stats_cache.
 *
 * That cache is filled when a match's stats are worked out (the match report
 * and Home read the same rows), so a profile view is one indexed query plus
 * the visibility check -- it never parses tracking segments or ball sidecars.
 */
import { desc, eq, inArray } from "drizzle-orm";
import {
  db,
  fieldsTable,
  footageRequestsTable,
  matchPlayerStatsCacheTable,
  matchRoomsTable,
  recordingsTable,
  type MatchPlayerStatsCacheValue,
} from "@workspace/db";
import { isRecordingVisible } from "./recordingVisibility";
import { logger } from "./logger";

/** Newest matches shown on a profile; older ones are left off rather than read. */
export const MEASURED_MATCH_LIMIT = 50;

export type MeasuredMatch = {
  matchId: number;
  /** the public recordings it was measured on */
  recordingIds: number[];
  date: string;
  startLocal: string;
  fieldName: string | null;
  minutes: number | null;
  distanceKm: number | null;
  topSpeedKmh: number | null;
  touches: number | null;
  passesTried: number | null;
  passesCompleted: number | null;
  shots: number | null;
  goals: number | null;
  dribbles: number | null;
  dribblesWon: number | null;
  dribblesLost: number | null;
};

export type MeasuredTotals = {
  matches: number;
  minutes: number | null;
  distanceKm: number | null;
  topSpeedKmh: number | null;
  touches: number | null;
  passesTried: number | null;
  passesCompleted: number | null;
  shots: number | null;
  goals: number | null;
  dribbles: number | null;
  dribblesWon: number | null;
  dribblesLost: number | null;
};

export type PublicMeasured = { matches: MeasuredMatch[]; totals: MeasuredTotals };

const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const round = (value: number, places: number) => Math.round(value * 10 ** places) / 10 ** places;

/** One cache row as the profile shows it, at the report's precision. */
export function measuredMatch(row: { matchId: number; recordingIds?: number[]; startLocal: string; fieldName: string | null; stats: MatchPlayerStatsCacheValue }): MeasuredMatch {
  const s = row.stats;
  const minutes = num(s.minutes);
  const distanceKm = num(s.distanceKm);
  const topSpeedKmh = num(s.topSpeedKmh);
  return {
    matchId: row.matchId,
    recordingIds: [...(row.recordingIds ?? [])].sort((a, b) => a - b),
    date: row.startLocal.slice(0, 10),
    startLocal: row.startLocal,
    fieldName: row.fieldName,
    minutes: minutes === null ? null : round(minutes, 1),
    distanceKm: distanceKm === null ? null : round(distanceKm, 2),
    topSpeedKmh: topSpeedKmh === null ? null : round(topSpeedKmh, 1),
    touches: num(s.touches),
    passesTried: num(s.passesTried),
    passesCompleted: num(s.passesCompleted),
    shots: num(s.shots),
    goals: num(s.goals),
    dribbles: num(s.dribbles),
    dribblesWon: num(s.dribblesWon),
    dribblesLost: num(s.dribblesLost),
  };
}

/** Sums over the matches that measured each figure; the best top speed; null when nothing measured it. */
export function measuredTotals(matches: MeasuredMatch[]): MeasuredTotals {
  const sum = (key: keyof MeasuredMatch, places = 0): number | null => {
    const values = matches.map((m) => m[key]).filter((v): v is number => typeof v === "number");
    return values.length ? round(values.reduce((a, b) => a + b, 0), places) : null;
  };
  const speeds = matches.map((m) => m.topSpeedKmh).filter((v): v is number => v !== null);
  // "18 of 24 passes" only when every match that counted completions also counted tries.
  const withCompleted = matches.filter((m) => m.passesCompleted !== null);
  const passesTried = withCompleted.length && withCompleted.every((m) => m.passesTried !== null)
    ? withCompleted.reduce((a, m) => a + (m.passesTried as number), 0)
    : null;
  return {
    matches: matches.length,
    minutes: sum("minutes", 1),
    distanceKm: sum("distanceKm", 2),
    topSpeedKmh: speeds.length ? Math.max(...speeds) : null,
    touches: sum("touches"),
    passesTried,
    passesCompleted: sum("passesCompleted"),
    shots: sum("shots"),
    goals: sum("goals"),
    dribbles: sum("dribbles"),
    dribblesWon: sum("dribblesWon"),
    dribblesLost: sum("dribblesLost"),
  };
}

/**
 * The player's measured matches, newest first, keeping only matches with at
 * least one recording the public can see (the same rule the claimed-match
 * rows on the profile use). Null when the cache can't be read.
 */
export async function loadPublicMeasured(userId: number): Promise<PublicMeasured | null> {
  try {
    const rows = await db.select({
      matchId: matchPlayerStatsCacheTable.matchId,
      recordingIds: matchPlayerStatsCacheTable.recordingIds,
      stats: matchPlayerStatsCacheTable.stats,
      startLocal: footageRequestsTable.startLocal,
      fieldName: fieldsTable.name,
    }).from(matchPlayerStatsCacheTable)
      .innerJoin(matchRoomsTable, eq(matchRoomsTable.id, matchPlayerStatsCacheTable.matchId))
      .innerJoin(footageRequestsTable, eq(footageRequestsTable.id, matchRoomsTable.footageRequestId))
      .leftJoin(fieldsTable, eq(fieldsTable.id, matchRoomsTable.fieldId))
      .where(eq(matchPlayerStatsCacheTable.userId, userId))
      .orderBy(desc(footageRequestsTable.startLocal))
      .limit(MEASURED_MATCH_LIMIT);

    const recordingIds = [...new Set(rows.flatMap((row) => row.recordingIds ?? []))];
    const recordings = recordingIds.length
      ? await db.select().from(recordingsTable).where(inArray(recordingsTable.id, recordingIds))
      : [];
    // isRecordingVisible's rule, with the field lookups batched: a hidden field
    // hides everything; otherwise the recording's own visibility toggle decides.
    const fieldIds = [...new Set(recordings.map((recording) => recording.fieldId))];
    const fields = fieldIds.length
      ? await db.select({ id: fieldsTable.id, isHidden: fieldsTable.isHidden }).from(fieldsTable).where(inArray(fieldsTable.id, fieldIds))
      : [];
    const shownFields = new Set(fields.filter((field) => !field.isHidden).map((field) => field.id));
    const visible = new Set<number>();
    for (const recording of recordings) {
      if (!shownFields.has(recording.fieldId)) continue;
      const open = typeof recording.isVisible === "boolean" ? recording.isVisible : await isRecordingVisible(recording);
      if (open) visible.add(recording.id);
    }

    const matches = rows
      .map((row) => ({ ...row, recordingIds: (row.recordingIds ?? []).filter((id) => visible.has(id)) }))
      .filter((row) => row.recordingIds.length > 0)
      .map((row) => measuredMatch(row));
    return { matches, totals: measuredTotals(matches) };
  } catch (error) {
    logger.warn({ userId, err: error }, "Could not read measured stats for profile");
    return null;
  }
}
