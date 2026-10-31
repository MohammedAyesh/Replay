import { mergeSpans } from "./matchFlow";
import type { StoredMatchWindow } from "./matchWindow";

export const MATCH_WINDOW_DETECTOR = {
  splitGapSeconds: 300,
  afterLastPlaySeconds: 60,
} as const;

export type DetectorInput = {
  duration: number;
  inPlay: Array<[number, number]>;
  phases?: Array<{ kind: string; start: number; end: number }> | null;
};

/**
 * Detect a booked game inside a longer camera recording. Long in-play gaps
 * separate adjacent games; an explicit break phase keeps half-time together.
 * When the phase timeline cannot identify which game was booked, fail closed.
 */
export function detectMatchWindow(input: DetectorInput): StoredMatchWindow | null {
  const { duration } = input;
  if (!Number.isFinite(duration) || duration <= 0) return null;
  const spans = mergeSpans(input.inPlay
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b > a && a < duration)
    .map(([a, b]) => [Math.max(0, a), Math.min(duration, b)]), 0);
  if (!spans.length) return null;

  const phases = (input.phases ?? [])
    .filter((p) => Number.isFinite(p.start) && Number.isFinite(p.end) && p.end > p.start)
    .map((p) => ({ kind: p.kind.toLowerCase(), start: Math.max(0, p.start), end: Math.min(duration, p.end) }))
    .filter((p) => p.end > p.start);
  const breaks = phases.filter((p) => p.kind === "break");
  const groups: Array<{ start: number; end: number }> = [];
  for (const [start, end] of spans) {
    const previous = groups.at(-1);
    const gap = previous ? start - previous.end : 0;
    const hasBreak = previous && breaks.some((p) => p.start <= start && p.end >= previous.end);
    if (previous && gap > MATCH_WINDOW_DETECTOR.splitGapSeconds && !hasBreak) {
      groups.push({ start, end });
    } else if (previous) {
      previous.end = end;
    } else {
      groups.push({ start, end });
    }
  }

  const gamePhases = phases.filter((p) => p.kind === "game").sort((a, b) => a.start - b.start);
  let selected: { start: number; end: number };
  let phase: (typeof gamePhases)[number] | undefined;
  let why: string;
  if (groups.length === 1) {
    selected = groups[0]!;
    phase = gamePhases.find((p) => p.end >= selected.start && p.start <= selected.end);
    why = phase ? "Single continuous game phase with in-play spans." : "Single continuous in-play stretch.";
  } else if (groups.length === 2 && gamePhases.length >= 2) {
    const second = groups[1]!;
    const secondPhase = gamePhases.find((p) => p.end >= second.start && p.start <= second.end);
    if (secondPhase && secondPhase.start > groups[0]!.end) {
      selected = second;
      phase = secondPhase;
      why = "A long no-play gap separates the previous game; this game starts after the gap.";
    } else {
      selected = groups[0]!;
      phase = gamePhases.find((p) => p.end >= selected.start && p.start <= selected.end);
      if (!phase) return null;
      why = "A later game follows a long no-play gap; the booked game ends before it.";
    }
  } else {
    return null;
  }
  const startSeconds = phase && phase.start <= selected.start && selected.start - phase.start <= MATCH_WINDOW_DETECTOR.splitGapSeconds
    ? phase.start
    : selected.start;
  const phaseEnd = phase?.end;
  const endSeconds = phaseEnd && phaseEnd >= selected.end && phaseEnd - selected.end <= 180
    ? phaseEnd
    : Math.min(duration, selected.end + MATCH_WINDOW_DETECTOR.afterLastPlaySeconds);
  if (endSeconds <= startSeconds) return null;
  return {
    startSeconds: Math.max(0, startSeconds),
    endSeconds,
    source: "detector",
    why: `${why} In-play ${Math.round(selected.start)}–${Math.round(selected.end)}s.`,
  };
}
