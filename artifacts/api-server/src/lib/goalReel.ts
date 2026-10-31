/**
 * "Was it a goal?" as a reel (2026-10-31): every chance in a match that
 * nobody has decided yet, as a run of short clips a player flicks through,
 * Goal / Not a goal, one after another. The list on the match page made him
 * open each chance on the watch page and come back; this plays them in place.
 *
 * Quick by construction, the same way as the "Is this you?" deck:
 *   - nothing is rendered: a card is the match recording itself, seeked to
 *     its few seconds, so a card costs only the 2-3 HLS fragments it covers;
 *   - the page loads one card at a time, the one on screen first, and the
 *     next ones while it plays;
 *   - each card carries the ball's path through it, so the page can follow
 *     the ball on the panorama without asking anything else.
 *
 * Everything here is pure; the route reads the plays and the recordings.
 */
import type { TrackingManifest } from "@workspace/db";
import { ballFocus, clockOf, type FocusPoint } from "./checkDeck";
import type { ReplayGoal } from "./matchFeed";

export const REEL = {
  /**
   * how much of the video a card plays around the moment, seconds: the build-up
   * and the ball reaching the mouth before, and after it enough to see it in
   * the net, saved or wide (and the scorer turn away), not the whole restart
   */
  before: 4,
  after: 3,
  /** a reel never holds more than this many cards; the rest wait for the next time */
  maxCards: 120,
  /** answers per save */
  maxVotesPerSave: 50,
} as const;

export type ReelRecording = {
  recordingId: number;
  videoUrl: string;
  srcW: number;
  srcH: number;
};

export type ReelCard = {
  /** `${recordingId}:${key}` */
  id: string;
  recordingId: number;
  /** the key a vote is cast with */
  key: number;
  /** video seconds on that recording: the moment, and the stretch the card plays */
  at: number;
  start: number;
  end: number;
  /** the match minute (booking clock), 1-based, and "mm:ss" of the booking clock */
  minute: number;
  clock: string;
  /** the goal detector found it (the rest are shots on target and goal events) */
  likely: boolean;
  source: ReplayGoal["source"];
  side: ReplayGoal["side"];
  ownGoal: boolean;
  scorer: string | null;
  focus: FocusPoint[];
};

export type ReelPlay = {
  manifest: Pick<TrackingManifest, "frameRate" | "width" | "height" | "videoStartSeconds">;
  ball: ReadonlyArray<readonly [number, number, number, ...number[]]>;
};

/**
 * The open chances, likely goals first (the detector's own goals are the ones
 * most often real), then every other chance in match order. A chance with no
 * key cannot be voted on, and one on a recording with no video cannot play.
 */
export function reelOrder(review: readonly ReplayGoal[]): ReplayGoal[] {
  const open = review.filter((g) => g.status === "open" && Number.isSafeInteger(g.key));
  const byTime = (a: ReplayGoal, b: ReplayGoal) => a.atSeconds - b.atSeconds;
  return [
    ...open.filter((g) => g.source === "goal").sort(byTime),
    ...open.filter((g) => g.source !== "goal").sort(byTime),
  ];
}

export function reelCards(
  review: readonly ReplayGoal[],
  plays: ReadonlyMap<number, ReelPlay>,
  limit: number = REEL.maxCards,
): ReelCard[] {
  const cards: ReelCard[] = [];
  for (const g of reelOrder(review)) {
    if (cards.length >= limit) break;
    const play = plays.get(g.recordingId);
    if (!play) continue;
    const vs = play.manifest.videoStartSeconds ?? 0;
    const from = Math.max(0, g.t - REEL.before), to = g.t + REEL.after;
    cards.push({
      id: `${g.recordingId}:${g.key}`,
      recordingId: g.recordingId,
      key: g.key,
      at: g.t + vs,
      start: from + vs,
      end: to + vs,
      minute: Math.floor(g.atSeconds / 60) + 1,
      clock: clockOf(g.atSeconds),
      likely: g.source === "goal",
      source: g.source,
      side: g.side,
      ownGoal: g.ownGoal,
      scorer: g.scorer?.name ?? null,
      focus: ballFocus(play.ball, play.manifest, from, to, vs),
    });
  }
  return cards;
}
