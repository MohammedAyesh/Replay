/**
 * The flow of a booked match on the booking clock: where the game was on at
 * all (phases: before / game / break / after), and inside it, where the ball
 * was in play. Both come from the analysis bundle:
 *   - phases from manifest.provenance.phases (phases.py, recording seconds);
 *   - ball in play from each segment's inPlaySpans (inplay.py, masked by the
 *     phases when they exist, so a break is dead time too).
 * A booking can span two recordings; each one's share is clipped to its
 * window and shifted onto the booking clock, then neighbours are joined.
 */

export type FlowPhaseKind = "before" | "game" | "break" | "after" | "nogame";
export const FLOW_PHASE_KINDS: FlowPhaseKind[] = ["before", "game", "break", "after", "nogame"];

export type FlowPhase = { kind: FlowPhaseKind; from: number; to: number };

export type MatchFlow = {
  /** null when no recording carried phases (bundles before 2026-09-29) */
  phases: FlowPhase[] | null;
  /** ball-in-play spans; null when no recording had segment data */
  inPlay: Array<[number, number]> | null;
};

export type DetectedSession = {
  startSeconds: number;
  endSeconds: number;
  spans: Array<[number, number]>;
  players?: number;
};

export type RecordingFlowInput = {
  /** the recording's share of the booking, tracking seconds */
  fromSeconds: number;
  toSeconds: number;
  /** booking seconds = tracking seconds + offset */
  offsetSec: number;
  phases: Array<{ kind: string; start: number; end: number }> | null;
  inPlay: Array<[number, number]> | null;
};

const round1 = (value: number) => Math.round(value * 10) / 10;

/** Phases from a manifest's provenance, or null when it has none or they are malformed. */
export function phasesFromProvenance(provenance: Record<string, unknown> | null | undefined): Array<{ kind: string; start: number; end: number }> | null {
  const block = provenance?.phases;
  if (!block || typeof block !== "object") return null;
  const list = (block as { phases?: unknown }).phases;
  if (!Array.isArray(list)) return null;
  const out: Array<{ kind: string; start: number; end: number }> = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const { kind, start, end } = entry as Record<string, unknown>;
    if (typeof kind !== "string" || typeof start !== "number" || typeof end !== "number") continue;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    out.push({ kind, start, end });
  }
  return out.length ? out : null;
}

/** Analysis-detected games from the same phases block, bounded to the recording. */
export function sessionsFromProvenance(
  provenance: Record<string, unknown> | null | undefined,
  duration: number,
): DetectedSession[] {
  const block = provenance?.phases;
  if (!block || typeof block !== "object" || !Array.isArray((block as { sessions?: unknown }).sessions)) return [];
  return ((block as { sessions: unknown[] }).sessions).flatMap((entry): DetectedSession[] => {
    if (!entry || typeof entry !== "object") return [];
    const raw = entry as Record<string, unknown>;
    if (typeof raw.start !== "number" || typeof raw.end !== "number") return [];
    if (!Number.isFinite(raw.start) || !Number.isFinite(raw.end)) return [];
    const startSeconds = Math.max(0, raw.start);
    const endSeconds = Math.min(duration, raw.end);
    if (endSeconds <= startSeconds) return [];
    const spans = (Array.isArray(raw.spans) ? raw.spans : []).flatMap((span): Array<[number, number]> => {
      if (!Array.isArray(span) || typeof span[0] !== "number" || typeof span[1] !== "number") return [];
      if (!Number.isFinite(span[0]) || !Number.isFinite(span[1])) return [];
      const from = Math.max(startSeconds, span[0]);
      const to = Math.min(endSeconds, span[1]);
      return to > from ? [[from, to]] : [];
    });
    const players = typeof raw.players === "number" && Number.isSafeInteger(raw.players) && raw.players >= 0
      ? raw.players
      : undefined;
    return [{
      startSeconds,
      endSeconds,
      spans,
      ...(players === undefined ? {} : { players }),
    }];
  });
}

/** Accept a saved selection only when it exactly names one of this bundle's sessions. */
export function selectedSessionFromState(
  provenance: Record<string, unknown> | null | undefined,
  duration: number,
  state: unknown,
): DetectedSession | null {
  if (!state || typeof state !== "object") return null;
  const window = (state as Record<string, unknown>).detectedGameWindow;
  if (!window || typeof window !== "object") return null;
  const raw = window as Record<string, unknown>;
  if (typeof raw.startSeconds !== "number" || typeof raw.endSeconds !== "number") return null;
  return sessionsFromProvenance(provenance, duration).find((session) =>
    session.startSeconds === raw.startSeconds && session.endSeconds === raw.endSeconds) ?? null;
}

/** Choose the detected game with the most played time inside a booking window. */
export function sessionForWindow(
  provenance: Record<string, unknown> | null | undefined,
  duration: number,
  window: { fromSeconds: number; toSeconds: number },
): DetectedSession | null {
  const sessions = sessionsFromProvenance(provenance, duration);
  if (sessions.length < 2 || window.toSeconds <= window.fromSeconds) return null;
  const score = (session: DetectedSession) => {
    const spans = session.spans.length
      ? session.spans
      : [[session.startSeconds, session.endSeconds] as [number, number]];
    return spans.reduce(
      (sum, [from, to]) => sum + Math.max(0, Math.min(to, window.toSeconds) - Math.max(from, window.fromSeconds)),
      0,
    );
  };
  let best: DetectedSession | null = null;
  let bestScore = 0;
  for (const session of sessions) {
    const current = score(session);
    if (current > bestScore) {
      best = session;
      bestScore = current;
    }
  }
  return best;
}

/**
 * Sidecar kit summaries aggregate a whole segment. Use them only when that
 * whole segment belongs to the selected game; a boundary-crossing segment
 * cannot be divided safely after aggregation.
 */
export function segmentIndexesContainedInSession(
  segments: Array<{ index: number; startSeconds: number; endSeconds: number }>,
  session: DetectedSession,
  window: { fromSeconds: number; toSeconds: number },
): Set<number> {
  const epsilon = 1 / 100;
  return new Set(segments
    .filter((segment) =>
      segment.endSeconds > window.fromSeconds
      && segment.startSeconds < window.toSeconds
      && segment.startSeconds >= session.startSeconds - epsilon
      && segment.endSeconds <= session.endSeconds + epsilon)
    .map((segment) => segment.index));
}

/** Merge spans that overlap or sit within `gap` seconds of each other. */
export function mergeSpans(spans: Array<[number, number]>, gap = 0): Array<[number, number]> {
  const sorted = spans.filter(([a, b]) => b > a).map(([a, b]) => [a, b] as [number, number]).sort((p, q) => p[0] - q[0]);
  const out: Array<[number, number]> = [];
  for (const [a, b] of sorted) {
    const last = out.at(-1);
    if (last && a <= last[1] + gap) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

export function matchFlow(recordings: RecordingFlowInput[]): MatchFlow {
  let anyPhases = false;
  let anyInPlay = false;
  const phases: FlowPhase[] = [];
  const inPlay: Array<[number, number]> = [];
  for (const rec of [...recordings].sort((p, q) => (p.fromSeconds + p.offsetSec) - (q.fromSeconds + q.offsetSec))) {
    const clip = (a: number, b: number): [number, number] | null => {
      const lo = Math.max(a, rec.fromSeconds);
      const hi = Math.min(b, rec.toSeconds);
      return hi > lo ? [lo + rec.offsetSec, hi + rec.offsetSec] : null;
    };
    if (rec.phases) {
      anyPhases = true;
      for (const phase of rec.phases) {
        const kind = (FLOW_PHASE_KINDS as string[]).includes(phase.kind) ? phase.kind as FlowPhaseKind : null;
        const span = kind ? clip(phase.start, phase.end) : null;
        if (kind && span) phases.push({ kind, from: span[0], to: span[1] });
      }
    }
    if (rec.inPlay) {
      anyInPlay = true;
      for (const [a, b] of rec.inPlay) {
        const span = clip(a, b);
        if (span) inPlay.push(span);
      }
    }
  }
  // Two recordings meet in the middle of a game: phases.py calls the tail of
  // the first "after" and the head of the second "before" only because each
  // saw half of it. Inside the booking, a non-game stretch between two game
  // stretches is a break.
  phases.sort((p, q) => p.from - q.from);
  const firstGame = phases.findIndex((p) => p.kind === "game");
  const lastGame = phases.length - 1 - [...phases].reverse().findIndex((p) => p.kind === "game");
  const joined: FlowPhase[] = [];
  phases.forEach((phase, index) => {
    let kind = phase.kind;
    if (firstGame >= 0 && index > firstGame && index < lastGame && kind !== "game") kind = "break";
    const last = joined.at(-1);
    if (last && last.kind === kind && phase.from <= last.to + 1) last.to = Math.max(last.to, phase.to);
    else joined.push({ kind, from: phase.from, to: phase.to });
  });
  return {
    phases: anyPhases ? joined.map((p) => ({ kind: p.kind, from: round1(p.from), to: round1(p.to) })) : null,
    inPlay: anyInPlay ? mergeSpans(inPlay, 0.5).map(([a, b]) => [round1(a), round1(b)]) : null,
  };
}
