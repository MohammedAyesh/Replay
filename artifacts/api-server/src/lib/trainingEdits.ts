import { z } from "zod";

/**
 * A coach's own split of a training into parts. The analysis's segments are a first guess
 * (it calls a warm-up "drill", a talk among spare balls a queue drill); the coach can relabel,
 * move, add and remove parts. The edits live on the tracking bundle's manifest and are
 * carried to any bundle that replaces it.
 */

export const TRAINING_SEGMENT_LABELS = [
  "game", "multi-ball drill", "shooting / queue drill", "warm-up", "team talk", "break", "drill", "adult game", "adults", "empty",
] as const;
export type TrainingEditSegment = { start: number; end: number; label: (typeof TRAINING_SEGMENT_LABELS)[number] };

export const trainingSplitsInput = z.object({
  segments: z.array(z.object({
    start: z.number().finite().min(0).max(86_400),
    end: z.number().finite().min(0).max(86_400),
    label: z.enum(TRAINING_SEGMENT_LABELS),
  })).max(300),
});

/** In time order, at least a second long, inside the video, no overlaps (a later part trims the one before), same-kind neighbours joined. */
export function normaliseSegments(input: ReadonlyArray<TrainingEditSegment>, duration?: number): TrainingEditSegment[] {
  const max = duration && duration > 0 ? duration : Number.POSITIVE_INFINITY;
  const sorted = input
    .map((s) => ({ start: Math.max(0, Math.min(s.start, max)), end: Math.max(0, Math.min(s.end, max)), label: s.label }))
    .filter((s) => s.end - s.start >= 1)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const out: TrainingEditSegment[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.start < last.end) last.end = s.start;
    if (last && last.end - last.start < 1) out.pop();
    const prev = out[out.length - 1];
    if (prev && prev.label === s.label && s.start - prev.end <= 1) { prev.end = Math.max(prev.end, s.end); continue; }
    out.push({ ...s });
  }
  return out.map((s) => ({ start: Math.round(s.start * 10) / 10, end: Math.round(s.end * 10) / 10, label: s.label }));
}

type Game = { start: number; end: number; teams?: unknown[]; teamNames?: unknown[]; resting?: unknown[]; players?: unknown[]; teamTotals?: Record<string, unknown> };

/**
 * The games under a coach's split: the analysis's games (split by which kits played) whose middle
 * falls in one of his game parts, clipped to it, and an empty game for any game part the analysis
 * had none in. Stats stay the analysis's: they are not re-measured for moved edges.
 */
export function gamesForSegments<G extends Game>(segments: ReadonlyArray<TrainingEditSegment>, analysisGames: ReadonlyArray<G>): Array<G | Game> {
  const parts = segments.filter((s) => s.label === "game");
  const out: Array<G | Game> = [];
  for (const part of parts) {
    const inside = analysisGames
      .filter((g) => { const mid = (g.start + g.end) / 2; return mid >= part.start && mid < part.end; })
      .map((g) => ({ ...g, start: Math.max(g.start, part.start), end: Math.min(g.end, part.end) }));
    if (inside.length) out.push(...inside);
    else out.push({ start: part.start, end: part.end, teams: [], teamNames: [], resting: [], players: [], teamTotals: {} });
  }
  return out.sort((a, b) => a.start - b.start);
}

/** The training block the app shows: the coach's split over the analysis's, or the analysis's as it is. */
export function withTrainingEdits<T extends { segments: unknown; games: unknown }>(
  training: T | null,
  edits: { segments: TrainingEditSegment[] | Array<{ start: number; end: number; label: string }>; at: string } | undefined,
  empty: () => T,
): (T & { edited: boolean; editedAt: string | null; analysisSegments: unknown }) | null {
  if (!edits) return training ? { ...training, edited: false, editedAt: null, analysisSegments: training.segments } : null;
  const base = training ?? empty();
  const segments = edits.segments as TrainingEditSegment[];
  return {
    ...base,
    segments,
    games: gamesForSegments(segments, Array.isArray(base.games) ? (base.games as Game[]) : []),
    edited: true,
    editedAt: edits.at,
    analysisSegments: training?.segments ?? [],
  } as T & { edited: boolean; editedAt: string | null; analysisSegments: unknown };
}
