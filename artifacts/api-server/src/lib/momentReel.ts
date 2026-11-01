/**
 * "Your moments" as a reel (2026-11-01): a player's own moments from one match
 * (his shots, take-ons, long passes, goals: the ones that already became clips
 * in My Clips), played one after another on the match page so he can keep or
 * drop each. Same player and files as the goal reel (lib/goalReel*.ts): each
 * card is a few seconds of the recording, cut once and stored on Bunny, and
 * the panorama follows him using his clip's own follow path.
 *
 * Keeping a moment changes nothing (it is already saved); dropping it deletes
 * its clip, the way deleting it in My Clips does, so it is never re-made.
 * Moments still waiting in "Is this you?" are not here: they are not clips yet.
 *
 * Everything here is pure; the route reads the rows.
 */
import type { CropKeyframe } from "@workspace/db";
import { clockOf, type FocusPoint } from "./checkDeck";

export const MOMENT_REEL = {
  /** the stretch a card plays around the moment, seconds: the run-up, the moment, a little after */
  before: 5,
  after: 4,
  /** two copies of the same moment (one match analysed twice) closer than this are one card, seconds */
  twinSeconds: 2,
  /** the follow ring: a player-sized mark, fractions of the frame */
  ringW: 0.02,
  ringH: 0.07,
} as const;

export type MomentReelCard = {
  /** `${recordingId}:${momentId}` */
  id: string;
  recordingId: number;
  momentId: string;
  /** his clip of this moment, and of its twin when the footage was analysed twice: dropping it drops all */
  userClipIds: number[];
  kind: string;
  /** the server's English title; the page writes its own from kind + numbers */
  title: string;
  /** video seconds on that recording: the moment and the stretch the card plays */
  at: number;
  start: number;
  end: number;
  /** the match minute (booking clock), 1-based, and "mm:ss" of the booking clock */
  minute: number;
  clock: string;
  focus: FocusPoint[];
};

export type MomentInput = {
  recordingId: number;
  /** tracking clock zero on the booking clock */
  recordingOffsetSec: number;
  /** where tracking frame 0 sits in the video */
  videoStartSeconds: number;
  /** recordings.duration, seconds: a clip's start/end are fractions of it */
  recordingDuration: number;
  moment: { id: string; title: string; kind: string; momentSeconds: number; userClipId?: number };
  clip: { id: number; startTime: number; endTime: number; cropPath: CropKeyframe[]; isHidden: boolean } | null;
};

/** His clip's follow path (crop windows over the clip) as the reel's focus points, video seconds. */
export function focusFromCrop(clip: NonNullable<MomentInput["clip"]>, recordingDuration: number): FocusPoint[] {
  if (!clip.cropPath?.length || recordingDuration <= 0) return [];
  const s = clip.startTime * recordingDuration, e = clip.endTime * recordingDuration;
  if (e <= s) return [];
  const round3 = (v: number) => Math.round(v * 1000) / 1000;
  return [...clip.cropPath]
    .sort((a, b) => a.t - b.t)
    .map((k) => [
      round3(s + k.t * (e - s)),
      round3(k.x + k.w / 2),
      // followCrop puts the player 55% of the way down the window
      round3(Math.min(1, Math.max(0, k.y + k.h * 0.55))),
      MOMENT_REEL.ringW,
      MOMENT_REEL.ringH,
    ] as FocusPoint);
}

/**
 * The cards: moments with a clip that is still in his clips (not deleted or
 * hidden), in match order, one card per moment when the same footage was
 * analysed twice.
 */
export function momentReelCards(inputs: readonly MomentInput[]): MomentReelCard[] {
  const cards: Array<MomentReelCard & { booking: number }> = [];
  for (const m of inputs) {
    if (!m.clip || m.clip.isHidden || !m.moment.userClipId) continue;
    const at = m.moment.momentSeconds + m.videoStartSeconds;
    const booking = Math.max(0, m.moment.momentSeconds + m.recordingOffsetSec);
    cards.push({
      id: `${m.recordingId}:${m.moment.id}`,
      recordingId: m.recordingId,
      momentId: m.moment.id,
      userClipIds: [m.moment.userClipId],
      kind: m.moment.kind,
      title: m.moment.title,
      at,
      start: Math.max(0, at - MOMENT_REEL.before),
      end: at + MOMENT_REEL.after,
      minute: Math.floor(booking / 60) + 1,
      clock: clockOf(booking),
      focus: focusFromCrop(m.clip, m.recordingDuration),
      booking,
    });
  }
  cards.sort((a, b) => a.booking - b.booking);
  const kept: typeof cards = [];
  for (const c of cards) {
    const twin = kept.find((k) => k.recordingId !== c.recordingId && k.kind === c.kind && Math.abs(k.booking - c.booking) <= MOMENT_REEL.twinSeconds);
    if (twin) { twin.userClipIds.push(...c.userClipIds); continue; }
    kept.push(c);
  }
  return kept.map(({ booking: _booking, ...card }) => card);
}
