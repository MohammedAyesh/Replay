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
