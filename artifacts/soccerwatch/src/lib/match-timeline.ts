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
 * list use. The running score is shown only when it can be trusted: two teams,
 * one game, every confirmed goal has a side, and it adds up to the score the
 * captain entered (when he entered one). With no confirmed goal and no score
 * entered there is no full-time score at all: that is unknown, not 0–0.
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
  me: TimelineMe;
  marks: MatchMark[];
};

/** A goal in the viewer's report within this many seconds of a chance is that chance. */
const SAME_GOAL_SECONDS = 20;
/** A shot this close to a chance is that chance, not a second event. */
const SAME_SHOT_SECONDS = 5;

const KIND_ORDER: Record<TimelineKind, number> = { goal: 0, likely: 1, chance: 2, shot: 3, sprint: 4, dribble: 5, flag: 6 };

const statusOf = (row: TimelineGoalRow) => row.status ?? "confirmed";

function asSide(team: string | null | undefined): TeamSide | null {
  return team === "A" || team === "B" || team === "C" ? team : null;
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

  // Goals and chances.
  const rows = input.review
    .filter((row) => statusOf(row) !== "rejected" && Number.isFinite(row.atSeconds))
    .sort((a, b) => a.atSeconds - b.atSeconds);
  for (const row of rows) {
    const status = statusOf(row);
    const kind: TimelineKind = status === "confirmed" ? "goal" : row.source === "goal" ? "likely" : "chance";
    const at = Math.max(0, row.atSeconds);
    const mine = me !== null && !row.ownGoal && (
      row.scorer
        ? row.scorer.playerId === me.playerId
        : myGoalTimes.some((t) => Math.abs(t - at) < SAME_GOAL_SECONDS)
    );
    events.push({
      ...blank,
      id: `${kind}-${row.recordingId}-${row.key ?? row.t}-${at}`,
      kind,
      at,
      minute: minuteMark(at),
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
    if (report.topSpeedAt !== null && me.topSpeedKmh !== null) {
      const at = Math.max(0, report.topSpeedAt);
      events.push({ ...mineCommon, id: `sprint-${at}`, kind: "sprint", at, minute: minuteMark(at), speedKmh: me.topSpeedKmh });
    }
    for (const t of report.dribbleWonTimes) {
      const at = Math.max(0, t);
      events.push({ ...mineCommon, id: `dribble-${at}`, kind: "dribble", at, minute: minuteMark(at) });
    }
    for (const t of report.shotTimes ?? []) {
      const at = Math.max(0, t);
      // A shot that is already a goal or a chance on the timeline marks that row as his.
      const same = events.find((event) => (event.kind === "goal" || event.kind === "likely" || event.kind === "chance") && Math.abs(event.at - at) < SAME_SHOT_SECONDS);
      if (same) {
        if (!same.ownGoal && (!same.scorer || same.scorer.playerId === me.playerId)) same.mine = true;
        continue;
      }
      if (myGoalTimes.some((g) => Math.abs(g - at) < SAME_SHOT_SECONDS)) continue;
      events.push({ ...mineCommon, id: `shot-${at}`, kind: "shot", at, minute: minuteMark(at) });
    }
  }

  // Flags dropped during the match.
  for (const mark of input.marks) {
    if (mark.offsetSeconds === null || !Number.isFinite(mark.offsetSeconds)) continue;
    const at = Math.max(0, mark.offsetSeconds);
    events.push({ ...blank, id: `flag-${mark.id}`, kind: "flag", at, minute: minuteMark(at), team: null, side: sideOf(null), mine: mark.mine, flag: { kind: mark.kind, byName: mark.byName } });
  }

  events.sort((a, b) => a.at - b.at || KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);

  // The running score, only when it can be trusted.
  let finalScore: { a: number; b: number } | null = null;
  const goals = events.filter((event) => event.kind === "goal");
  const trustworthy = input.teamCount === 2 && input.gameCount <= 1 && goals.every((goal) => goal.team === "A" || goal.team === "B");
  if (trustworthy) {
    let a = 0;
    let b = 0;
    for (const goal of goals) {
      if (goal.team === "A") a += 1;
      else b += 1;
      goal.score = { a, b };
    }
    const matchesRoom = !input.roomScore || (input.roomScore.a === a && input.roomScore.b === b);
    if (!matchesRoom) for (const goal of goals) goal.score = null;
    // No confirmed goal and no score entered is "we don't know", not 0–0.
    else if (input.roomScore || goals.length > 0) finalScore = { a, b };
  }

  return { events, columns, finalScore };
}

/** Which events a filter shows. "All" leaves out plain chances unless they are his: there can be dozens. */
export function filterTimeline(events: TimelineEvent[], filter: TimelineFilter): TimelineEvent[] {
  switch (filter) {
    case "goals": return events.filter((event) => event.kind === "goal" || event.kind === "likely");
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
