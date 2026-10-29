/**
 * The match as one timeline, for the sofa layout's Moments tab.
 *
 * Built only from what the report already has, never invented:
 *   - the goals: chances the players confirmed (`replay.review`, else `replay.goals`);
 *   - "Goal?" rows: open chances the goal detector found (source "goal"), answerable in place;
 *   - other open chances (shots, events): shown under the Chances filter only, because
 *     a match can have dozens of them;
 *   - the viewer's own moments from his report: top speed, dribbles won, shots;
 *   - flags players dropped during the match (room.marks).
 * Rejected chances are left out. A goal in the viewer's report that no confirmed
 * goal or open chance matches is left out too: only a confirmed goal counts.
 *
 * Times are seconds into the booking, the base the watch links and the goal
 * list use. Anything before kick-off or after the booked end (a flag dropped
 * early, a chance in the over-run) keeps its real time and is marked "before"
 * or "after" instead of being squeezed into the match.
 *
 * The running score is shown only when it can be trusted: two teams, one game,
 * every confirmed goal has a side, AND the captain has entered a score that the
 * confirmed goals add up to. Confirmed goals alone are only a suggestion (the
 * detector misses goals), so without an entered score there is no score at all.
 *
 * "Mine" never invents a scorer: a goal is his when the tracker named him, or
 * when his own report has a goal at that time for his team. A shot of his only
 * marks an open chance of his team, never a confirmed goal.
 */

import type { MatchMark, MatchReplay, TeamSide } from "@/lib/match-api";
import { minuteMark } from "@/lib/match-report";

export type TimelineGoalRow = MatchReplay["goals"][number];

export type TimelineKind = "goal" | "likely" | "chance" | "sprint" | "dribble" | "shot" | "flag";
export type TimelineFilter = "all" | "goals" | "chances" | "mine";
/** start = first team's column, end = second team's, centre = no team (flags) */
export type TimelineSide = "start" | "end" | "centre";

export type TimelineEvent = {
  id: string;
  kind: TimelineKind;
  /** seconds into the booking */
  at: number;
  minute: number;
  team: TeamSide | null;
  side: TimelineSide;
  mine: boolean;
  /** the scorer (goals), when known */
  scorer: { playerId: number; name: string } | null;
  ownGoal: boolean;
  /** where it falls against the booked match */
  phase: "before" | "during" | "after";
  /** the score after this goal, when the running score is shown */
  score: { a: number; b: number } | null;
  /** the review row, for answering a "Goal?" in place */
  row: TimelineGoalRow | null;
  speedKmh: number | null;
  flag: { kind: string; byName: string | null } | null;
};

export type Timeline = {
  events: TimelineEvent[];
  /** 2 = a column per team, 1 = one column (three teams) */
  columns: 1 | 2;
  /** the score at full time, when the running score is shown */
  finalScore: { a: number; b: number } | null;
};

export type TimelineMe = {
  playerId: number;
  team: string | null;
  topSpeedKmh: number | null;
  report: {
    goalTimes: number[];
    topSpeedAt: number | null;
    dribbleWonTimes: number[];
    shotTimes?: number[];
  } | null;
} | null;

export type TimelineInput = {
  /** every chance with its status: replay.review, else replay.goals */
  review: TimelineGoalRow[];
  teamCount: 2 | 3;
  gameCount: number;
  roomScore: { a: number; b: number } | null;
  /** the booked length; null = unknown, nothing is "after" */
  durationSeconds: number | null;
  me: TimelineMe;
  marks: MatchMark[];
};

/** A goal in the viewer's report within this many seconds of a chance is that chance. */
const SAME_GOAL_SECONDS = 20;
/** A shot this close to a chance is that chance, not a second event. */
const SAME_SHOT_SECONDS = 5;
/** His own moments this close together are one moment (footage analysed twice). */
const SAME_MOMENT_SECONDS = 2;

const KIND_ORDER: Record<TimelineKind, number> = { goal: 0, likely: 1, chance: 2, shot: 3, sprint: 4, dribble: 5, flag: 6 };

const statusOf = (row: TimelineGoalRow) => row.status ?? "confirmed";

function asSide(team: string | null | undefined): TeamSide | null {
  return team === "A" || team === "B" || team === "C" ? team : null;
}

/** Times sorted, with near-duplicates (within SAME_MOMENT_SECONDS) dropped. */
function distinctTimes(times: number[]): number[] {
  const out: number[] = [];
  for (const t of [...times].filter(Number.isFinite).sort((a, b) => a - b)) {
    if (out.length && t - out[out.length - 1] < SAME_MOMENT_SECONDS) continue;
    out.push(t);
  }
  return out;
}

export function buildTimeline(input: TimelineInput): Timeline {
  const columns: 1 | 2 = input.teamCount === 3 ? 1 : 2;
  const sideOf = (team: TeamSide | null): TimelineSide => {
    if (columns === 1) return "start";
    return team === "A" ? "start" : team === "B" ? "end" : "centre";
  };
  const me = input.me;
  const myTeam = asSide(me?.team);
  const myGoalTimes = me?.report?.goalTimes ?? [];
  const events: TimelineEvent[] = [];
  const blank = { scorer: null, ownGoal: false, score: null, row: null, speedKmh: null, flag: null } as const;
  const end = input.durationSeconds !== null && input.durationSeconds > 0 ? input.durationSeconds : null;
  const phaseOf = (at: number): TimelineEvent["phase"] => (at < 0 ? "before" : end !== null && at > end ? "after" : "during");
  const timeOf = (at: number) => ({ at, minute: minuteMark(Math.max(0, at)), phase: phaseOf(at) });

  // Goals and chances.
  const rows = input.review
    .filter((row) => statusOf(row) !== "rejected" && Number.isFinite(row.atSeconds))
    .sort((a, b) => a.atSeconds - b.atSeconds);
  for (const row of rows) {
    const status = statusOf(row);
    const kind: TimelineKind = status === "confirmed" ? "goal" : row.source === "goal" ? "likely" : "chance";
    const at = row.atSeconds;
    const mine = me !== null && !row.ownGoal && (
      row.scorer
        ? row.scorer.playerId === me.playerId
        : myTeam !== null && row.side === myTeam && myGoalTimes.some((t) => Math.abs(t - at) < SAME_GOAL_SECONDS)
    );
    events.push({
      ...blank,
      id: `${kind}-${row.recordingId}-${row.key ?? row.t}-${at}`,
      kind,
      ...timeOf(at),
      team: row.side,
      side: sideOf(row.side),
      mine,
      scorer: row.ownGoal ? null : row.scorer,
      ownGoal: Boolean(row.ownGoal),
      row,
    });
  }

  // The viewer's own moments.
  const report = me?.report ?? null;
  if (me && report) {
    const mineCommon = { ...blank, team: myTeam, side: sideOf(myTeam), mine: true };
    if (report.topSpeedAt !== null && Number.isFinite(report.topSpeedAt) && me.topSpeedKmh !== null) {
      const at = report.topSpeedAt;
      events.push({ ...mineCommon, id: `sprint-${at}`, kind: "sprint", ...timeOf(at), speedKmh: me.topSpeedKmh });
    }
    distinctTimes(report.dribbleWonTimes).forEach((at, i) => {
      events.push({ ...mineCommon, id: `dribble-${i}-${at}`, kind: "dribble", ...timeOf(at) });
    });
    distinctTimes(report.shotTimes ?? []).forEach((at, i) => {
      // A shot at the same moment as a goal or chance is not a second event.
      const same = events.find((event) => (event.kind === "goal" || event.kind === "likely" || event.kind === "chance") && Math.abs(event.at - at) < SAME_SHOT_SECONDS);
      if (same) {
        // It marks an open chance of his own team as his; never a confirmed goal
        // (a rebound by someone else is not his goal) and never the other team's.
        if (same.kind !== "goal" && !same.ownGoal && !same.scorer && myTeam !== null && same.team === myTeam) same.mine = true;
        return;
      }
      if (myGoalTimes.some((g) => Math.abs(g - at) < SAME_SHOT_SECONDS)) return;
      events.push({ ...mineCommon, id: `shot-${i}-${at}`, kind: "shot", ...timeOf(at) });
    });
  }

  // Flags dropped during the match.
  for (const mark of input.marks) {
    if (mark.offsetSeconds === null || !Number.isFinite(mark.offsetSeconds)) continue;
    events.push({ ...blank, id: `flag-${mark.id}`, kind: "flag", ...timeOf(mark.offsetSeconds), team: null, side: sideOf(null), mine: mark.mine, flag: { kind: mark.kind, byName: mark.byName } });
  }

  events.sort((a, b) => a.at - b.at || KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);

  // The running score, only when the captain's score backs it up.
  let finalScore: { a: number; b: number } | null = null;
  const goals = events.filter((event) => event.kind === "goal");
  const trustworthy = input.roomScore !== null && input.teamCount === 2 && input.gameCount <= 1 && goals.every((goal) => goal.team === "A" || goal.team === "B");
  if (trustworthy && input.roomScore) {
    let a = 0;
    let b = 0;
    const running: Array<{ a: number; b: number }> = [];
    for (const goal of goals) {
      if (goal.team === "A") a += 1;
      else b += 1;
      running.push({ a, b });
    }
    if (input.roomScore.a === a && input.roomScore.b === b) {
      goals.forEach((goal, i) => { goal.score = running[i]; });
      finalScore = { a, b };
    }
  }

  return { events, columns, finalScore };
}

/** Which events a filter shows. "All" leaves out plain chances unless they are his: there can be dozens. */
export function filterTimeline(events: TimelineEvent[], filter: TimelineFilter): TimelineEvent[] {
  switch (filter) {
    case "goals": return events.filter((event) => event.kind === "goal");
    case "chances": return events.filter((event) => event.kind === "likely" || event.kind === "chance");
    case "mine": return events.filter((event) => event.mine);
    default: return events.filter((event) => event.kind !== "chance" || event.mine);
  }
}

/** The filter chips worth showing, with their counts. "Mine" needs a viewer who is in the match. */
export function timelineFilters(events: TimelineEvent[], hasMe: boolean): Array<{ id: TimelineFilter; count: number }> {
  const out: Array<{ id: TimelineFilter; count: number }> = [{ id: "all", count: filterTimeline(events, "all").length }];
  const goals = filterTimeline(events, "goals").length;
  const chances = filterTimeline(events, "chances").length;
  const mine = filterTimeline(events, "mine").length;
  if (goals) out.push({ id: "goals", count: goals });
  if (chances) out.push({ id: "chances", count: chances });
  if (hasMe && mine) out.push({ id: "mine", count: mine });
  return out;
}
