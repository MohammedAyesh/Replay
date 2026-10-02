/**
 * The flow of a match on the booking clock (GET /m/:code/replay `flow`):
 * where the game was on at all, and inside it, where the ball was in play.
 * Used by the full-match player to shade the timeline, name what is on
 * screen when nothing is happening, and skip the dead time.
 */

export type FlowPhaseKind = "before" | "game" | "break" | "after" | "nogame";
export type FlowPhase = { kind: FlowPhaseKind; from: number; to: number };
export type MatchFlowData = {
  phases: FlowPhase[] | null;
  inPlay: Array<[number, number]> | null;
};

export type DeadKind = Exclude<FlowPhaseKind, "game"> | "outOfPlay";
export type DeadStretch = { kind: DeadKind; from: number; to: number };

/** A stoppage shorter than this is part of the play: a throw-in, a quick free kick. */
export const MIN_DEAD_SECONDS = 8;
/** Skipping lands this long before play resumes, so the restart is seen. */
export const SKIP_LEAD = 2;

export function hasFlow(flow: MatchFlowData | null | undefined): flow is MatchFlowData {
  return Boolean(flow && ((flow.phases && flow.phases.length) || (flow.inPlay && flow.inPlay.length)));
}

/** The game's stretches; without phases, the whole match is the game. */
export function gameSpans(flow: MatchFlowData, durationSeconds: number): Array<[number, number]> {
  if (!flow.phases || !flow.phases.length) return [[0, durationSeconds]];
  return flow.phases.filter((p) => p.kind === "game").map((p) => [p.from, p.to]);
}

/**
 * Everything that isn't the game being played: the phases outside the game,
 * and inside it, stretches without the ball in play longer than minSeconds.
 */
export function deadStretches(flow: MatchFlowData | null | undefined, durationSeconds: number, minSeconds = MIN_DEAD_SECONDS): DeadStretch[] {
  if (!hasFlow(flow)) return [];
  const out: DeadStretch[] = [];
  for (const phase of flow.phases ?? []) {
    if (phase.kind !== "game" && phase.to > phase.from) out.push({ kind: phase.kind, from: phase.from, to: phase.to });
  }
  if (flow.inPlay) {
    const live = [...flow.inPlay].sort((a, b) => a[0] - b[0]);
    for (const [g0, g1] of gameSpans(flow, durationSeconds)) {
      let cursor = g0;
      for (const [a, b] of live) {
        if (b <= g0 || a >= g1) continue;
        const start = Math.max(a, g0);
        if (start - cursor >= minSeconds) out.push({ kind: "outOfPlay", from: cursor, to: start });
        cursor = Math.max(cursor, Math.min(b, g1));
      }
      if (g1 - cursor >= minSeconds) out.push({ kind: "outOfPlay", from: cursor, to: g1 });
    }
  }
  return out.sort((a, b) => a.from - b.from);
}

export function deadAt(stretches: DeadStretch[], position: number): DeadStretch | null {
  return stretches.find((s) => position >= s.from && position < s.to) ?? null;
}

/**
 * While skipping: where to jump from a position inside dead time, or null.
 * The stretch that runs to the end of the match is never skipped: there is
 * nothing after it to land on.
 */
export function skipTarget(stretches: DeadStretch[], position: number, durationSeconds: number): number | null {
  const s = deadAt(stretches, position);
  if (!s || s.to >= durationSeconds - 1) return null;
  const target = Math.max(s.from, s.to - SKIP_LEAD);
  return position < target - 0.5 ? target : null;
}

/** Game time, and ball-in-play time inside it (null without in-play data). */
export function flowSummary(flow: MatchFlowData, durationSeconds: number): { gameSeconds: number; inPlaySeconds: number | null } {
  const games = gameSpans(flow, durationSeconds);
  const gameSeconds = games.reduce((sum, [a, b]) => sum + Math.max(0, b - a), 0);
  if (!flow.inPlay) return { gameSeconds, inPlaySeconds: null };
  let inPlaySeconds = 0;
  for (const [a, b] of flow.inPlay) {
    for (const [g0, g1] of games) inPlaySeconds += Math.max(0, Math.min(b, g1) - Math.max(a, g0));
  }
  return { gameSeconds, inPlaySeconds };
}

export type FlowMark = { at: number; mark: "kickoff" | "restart" | "break" | "fullTime" };

/** The points worth jumping to in the match's flow: kick-off, each break, each restart, full time. */
export function flowMarks(flow: MatchFlowData | null | undefined): FlowMark[] {
  const marks: FlowMark[] = [];
  let games = 0;
  for (const phase of [...(flow?.phases ?? [])].sort((a, b) => a.from - b.from)) {
    if (phase.kind === "game") marks.push({ at: phase.from, mark: games++ === 0 ? "kickoff" : "restart" });
    else if (phase.kind === "break") marks.push({ at: phase.from, mark: "break" });
    else if (phase.kind === "after" && games > 0) marks.push({ at: phase.from, mark: "fullTime" });
  }
  return marks;
}
