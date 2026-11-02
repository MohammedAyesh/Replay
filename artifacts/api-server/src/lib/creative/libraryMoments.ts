/**
 * Creative hub → Library → a match's moments, from what the match analysis
 * found (pure: the route loads the play, the votes and the roster).
 *
 *   goal      a chance a player confirmed was a goal (goalReview)
 *   chance    every other chance on goal: the detector's goals nobody confirmed,
 *             shots on target, goals.py goal events — not the ones that are part
 *             of a confirmed goal
 *   highlight a dribble past an opponent that kept the ball
 *   saved     a clip a member saved from this recording (built in libraryData)
 *
 * Who did it comes from the analysis track: the roster player whose part holds
 * that track at that frame, then the owner's lineup binding (shirt number or a
 * hand pick). An unbound track is nobody: no number, no name.
 */
import { GOAL_REVIEW } from "../goalReview";
import {
  analysisMomentWindow,
  frameSource,
  matchMinute,
  windowSource,
  type LibraryMomentType,
  type LibraryPlayer,
  type RecordingWindow,
} from "./library";
import type { MediaSource } from "@workspace/api-zod";

export type LibraryMoment = {
  /** stable within a recording: `${type}:${recordingId}:${tenths}` or `saved:${clipId}` */
  id: string;
  type: LibraryMomentType;
  recordingId: number;
  window: RecordingWindow;
  /** the frame a still of this moment is taken from, video ms */
  atMs: number;
  durationMs: number;
  minute: number | null;
  player: LibraryPlayer | null;
  /** true when the player is the academy's; null when it can't be told */
  ours: boolean | null;
  ownGoal: boolean;
  /** a saved clip's own title (names already filtered), else null */
  title: string | null;
  clipId: number | null;
  source: Extract<MediaSource, { type: "recording" }>;
  still: Extract<MediaSource, { type: "frame" }>;
  /** fallback thumbnail when the media route can't make one, API path or null */
  thumbnailUrl: string | null;
};

export type AnalysisChance = {
  t: number;
  status: "confirmed" | "rejected" | "open";
  trackId: string | null;
  touchF: number | null;
  ownGoal?: boolean;
};

export type AnalysisDribble = {
  trackId: string;
  t0: number;
  t1: number;
  f0: number;
  beaten: number;
  outcome: "won" | "lost" | null;
};

export type AnalysisMomentsInput = {
  recordingId: number;
  videoStartSeconds: number;
  durationSec: number | null;
  /** tracking seconds the match started (match window start, first game phase, or 0) */
  kickOffSeconds: number;
  /** the tracked match, tracking seconds: moments outside it are someone else's game */
  window: { fromSeconds: number; toSeconds: number } | null;
  fps: number;
  chances: AnalysisChance[];
  dribbles: AnalysisDribble[];
  /** the academy player on this track at this frame, already name-filtered; null = not ours / unknown */
  playerAt: (trackId: string, frame: number | null) => LibraryPlayer | null;
  thumbnailAt?: (atMs: number) => string | null;
};

/** Chances closer together than this are one chance (a shot and its event), seconds. */
const SAME_CHANCE_SECONDS = 3;

export function analysisMoments(input: AnalysisMomentsInput): LibraryMoment[] {
  const within = (t: number) => !input.window || (t >= input.window.fromSeconds && t < input.window.toSeconds);
  const out: LibraryMoment[] = [];
  const make = (
    type: "goal" | "chance" | "highlight",
    t0: number,
    t1: number,
    trackId: string | null,
    frame: number | null,
    ownGoal: boolean,
  ) => {
    const w = analysisMomentWindow(type, input.recordingId, t0, t1, input.videoStartSeconds, input.durationSec);
    const player = trackId && !ownGoal ? input.playerAt(trackId, frame) : null;
    const window = { recordingId: w.recordingId, fromMs: w.fromMs, toMs: w.toMs };
    out.push({
      id: `${type}:${input.recordingId}:${Math.round(t0 * 10)}`,
      type,
      recordingId: input.recordingId,
      window,
      atMs: w.atMs,
      durationMs: w.toMs - w.fromMs,
      minute: matchMinute(t0, input.kickOffSeconds),
      player,
      ours: player ? true : null,
      ownGoal,
      title: null,
      clipId: null,
      source: windowSource(window),
      still: frameSource(input.recordingId, w.atMs),
      thumbnailUrl: input.thumbnailAt?.(w.atMs) ?? null,
    });
  };

  const confirmed = input.chances.filter((c) => c.status === "confirmed").sort((a, b) => a.t - b.t);
  // A confirmed goal always counts, even outside a detected window: a person said so.
  for (const g of confirmed) make("goal", g.t, g.t, g.trackId, g.touchF, Boolean(g.ownGoal));

  const chances = input.chances
    .filter((c) => c.status !== "confirmed" && within(c.t))
    .filter((c) => !confirmed.some((g) => Math.abs(g.t - c.t) <= GOAL_REVIEW.confirmedMinGap))
    .sort((a, b) => a.t - b.t);
  let last = -Infinity;
  for (const c of chances) {
    if (c.t - last < SAME_CHANCE_SECONDS) continue;
    last = c.t;
    make("chance", c.t, c.t, c.trackId, c.touchF, Boolean(c.ownGoal));
  }

  for (const d of input.dribbles) {
    if (d.outcome !== "won" || d.beaten < 1 || !within(d.t0)) continue;
    make("highlight", d.t0, d.t1, d.trackId, d.f0, false);
  }

  return out.sort((a, b) => a.window.fromMs - b.window.fromMs || a.id.localeCompare(b.id));
}

/**
 * The roster player holding a track at a frame, then the academy player bound
 * to him. `bound` maps roster player id → the academy player as shown.
 */
export function trackPlayerLookup(
  roster: { players: Array<{ id: string; parts: Array<{ trackId: string; fromFrame: number; toFrame: number }> }> } | null,
  bound: Map<string, LibraryPlayer>,
): (trackId: string, frame: number | null) => LibraryPlayer | null {
  if (!roster) return () => null;
  const byTrack = new Map<string, Array<{ rosterId: string; from: number; to: number }>>();
  for (const p of roster.players) {
    for (const part of p.parts) {
      const list = byTrack.get(part.trackId) ?? [];
      list.push({ rosterId: p.id, from: part.fromFrame, to: part.toFrame });
      byTrack.set(part.trackId, list);
    }
  }
  return (trackId, frame) => {
    const parts = byTrack.get(trackId);
    if (!parts?.length) return null;
    const hit = frame === null ? parts[0] : parts.find((p) => frame >= p.from && frame <= p.to) ?? (parts.length === 1 ? parts[0] : null);
    return hit ? bound.get(hit.rosterId) ?? null : null;
  };
}

export function filterMoments(
  moments: LibraryMoment[],
  f: { types: LibraryMomentType[]; playerNumber: number | null },
): LibraryMoment[] {
  return moments.filter((m) =>
    (!f.types.length || f.types.includes(m.type))
    && (f.playerNumber === null || m.player?.number === f.playerNumber));
}
