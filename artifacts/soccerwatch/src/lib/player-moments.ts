/**
 * The moments a full-match player can jump between: the match's goals, and
 * one claimed player's goals, shots, passes, dribbles and touches.
 *
 * Everything is on the booking clock, which is also the shared footage's
 * clock (/w/:token starts at the booked kick-off). Nothing here draws; it
 * decides what is listed, in what order, and what "play my moments" plays.
 */

import type { ReportTimeline } from "./match-report";

export type MomentKind = "matchGoal" | "goal" | "shot" | "dribble" | "pass" | "touch" | "flag";

export const MOMENT_KINDS: MomentKind[] = ["matchGoal", "goal", "shot", "dribble", "pass", "touch", "flag"];

/** Kinds that belong to the chosen player (the rest belong to the match). */
export const PLAYER_KINDS: MomentKind[] = ["goal", "shot", "dribble", "pass", "touch"];

export type Moment = {
  kind: MomentKind;
  /** seconds from kick-off */
  at: number;
  /** last second of the moment, for a run of touches */
  endAt: number;
  /** touches in a run */
  count: number;
  /** how it ended: a pass completed or not, a dribble won or lost */
  outcome: "won" | "lost" | "completed" | "missed" | null;
  /** a scorer's name or a flag's note */
  label: string | null;
  /** team colour for a match goal */
  colour: string | null;
};

export type MatchGoalInput = { at: number; scorerName: string | null; colour: string | null; byPlayer: boolean };
export type FlagInput = { at: number; kind: string; note: string | null };

/** Touches this close together are one run on the ball. */
export const TOUCH_RUN_GAP = 6;
/** Seconds shown before a moment, so the build-up is on screen. */
export const LEAD_IN = 4;
/** Seconds kept after it. */
export const TAIL = 3;

const PRIORITY: Record<MomentKind, number> = { matchGoal: 0, goal: 0, shot: 1, dribble: 2, pass: 3, touch: 4, flag: 5 };

function moment(kind: MomentKind, at: number, extra: Partial<Moment> = {}): Moment {
  return { kind, at, endAt: at, count: 1, outcome: null, label: null, colour: null, ...extra };
}

const near = (a: number, b: number, within: number) => Math.abs(a - b) <= within;

/** Groups touches into runs: a new run starts after a gap longer than TOUCH_RUN_GAP. */
export function touchRuns(times: number[]): Array<{ at: number; endAt: number; count: number }> {
  const runs: Array<{ at: number; endAt: number; count: number }> = [];
  for (const t of [...times].filter(Number.isFinite).sort((a, b) => a - b)) {
    const last = runs.at(-1);
    if (last && t - last.endAt <= TOUCH_RUN_GAP) {
      last.endAt = t;
      last.count += 1;
    } else {
      runs.push({ at: t, endAt: t, count: 1 });
    }
  }
  return runs;
}

/**
 * Every moment, in time order. A goal is listed once: the player's own goal
 * replaces the match goal it matches and the shot that scored it.
 */
export function buildMoments({ report, matchGoals, flags }: {
  report: ReportTimeline | null | undefined;
  matchGoals: MatchGoalInput[];
  flags: FlagInput[];
}): Moment[] {
  const out: Moment[] = [];
  const myGoals = report?.goalTimes ?? [];
  for (const at of myGoals) {
    const match = matchGoals.find((goal) => near(goal.at, at, 10));
    out.push(moment("goal", at, { colour: match?.colour ?? null }));
  }
  for (const goal of matchGoals) {
    if (myGoals.some((at) => near(goal.at, at, 10))) continue;
    out.push(moment("matchGoal", goal.at, { label: goal.scorerName, colour: goal.colour }));
  }
  if (report) {
    for (const at of report.shotTimes ?? []) {
      if (myGoals.some((goal) => near(goal, at, 5))) continue;
      out.push(moment("shot", at));
    }
    const dribbles = report.dribbles ?? report.dribbleWonTimes.map((t) => ({ t, outcome: "won" as const }));
    for (const dribble of dribbles) out.push(moment("dribble", dribble.t, { outcome: dribble.outcome }));
    for (const pass of report.passes ?? []) {
      out.push(moment("pass", pass.t, { outcome: pass.completed === null ? null : pass.completed ? "completed" : "missed" }));
    }
    for (const run of touchRuns(report.touchTimes)) out.push(moment("touch", run.at, { endAt: run.endAt, count: run.count }));
  }
  for (const flag of flags) {
    if (Number.isFinite(flag.at) && flag.at >= 0) out.push(moment("flag", flag.at, { label: flag.note ?? flag.kind }));
  }
  return out
    .filter((m) => Number.isFinite(m.at) && m.at >= 0)
    .sort((a, b) => a.at - b.at || PRIORITY[a.kind] - PRIORITY[b.kind]);
}

export function countByKind(moments: Moment[]): Record<MomentKind, number> {
  const counts = Object.fromEntries(MOMENT_KINDS.map((kind) => [kind, 0])) as Record<MomentKind, number>;
  for (const m of moments) counts[m.kind] += m.kind === "touch" ? m.count : 1;
  return counts;
}

/** Where to start playing a moment. */
export function startOf(m: Moment): number {
  return Math.max(0, m.at - LEAD_IN);
}

/**
 * The moment on screen at a position: the highest-priority one whose window
 * (lead-in to tail) holds it, or null.
 */
export function momentAt(moments: Moment[], position: number): Moment | null {
  let best: Moment | null = null;
  for (const m of moments) {
    if (position < m.at - LEAD_IN || position > m.endAt + TAIL) continue;
    if (!best || PRIORITY[m.kind] < PRIORITY[best.kind] || (PRIORITY[m.kind] === PRIORITY[best.kind] && Math.abs(position - m.at) < Math.abs(position - best.at))) best = m;
  }
  return best;
}

/** The next moment that starts after the one on screen (or after the position). */
export function nextMoment(moments: Moment[], position: number): Moment | null {
  const current = momentAt(moments, position);
  const after = current ? current.at : position;
  return moments.find((m) => m.at > after + 0.5 && startOf(m) > position + 0.5) ?? null;
}

/** The moment before: the start of the one on screen if well into it, else the one before that. */
export function previousMoment(moments: Moment[], position: number): Moment | null {
  const current = momentAt(moments, position);
  if (current && position - startOf(current) > 2) return current;
  const before = current ? current.at : position;
  for (let index = moments.length - 1; index >= 0; index--) {
    if (moments[index].at < before - 0.5) return moments[index];
  }
  return null;
}

export type ReelStop = { start: number; end: number; moments: Moment[] };

/** "Play my moments": each moment's window, merged where they overlap or nearly touch. */
export function reel(moments: Moment[], durationSeconds = Infinity): ReelStop[] {
  const stops: ReelStop[] = [];
  for (const m of [...moments].sort((a, b) => a.at - b.at)) {
    const start = startOf(m);
    const end = Math.min(durationSeconds, m.endAt + TAIL);
    const last = stops.at(-1);
    if (last && start <= last.end + 2) {
      last.end = Math.max(last.end, end);
      last.moments.push(m);
    } else {
      stops.push({ start, end, moments: [m] });
    }
  }
  return stops;
}

/**
 * While the reel plays: where to jump from a position, "end" when the reel is
 * over, or null to keep playing.
 */
export function reelJump(stops: ReelStop[], position: number): number | "end" | null {
  if (stops.some((stop) => position >= stop.start - 0.5 && position <= stop.end)) return null;
  const next = stops.find((stop) => stop.start > position);
  return next ? next.start : "end";
}
