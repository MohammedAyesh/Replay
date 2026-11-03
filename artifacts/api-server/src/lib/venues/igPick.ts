import { and, desc, eq, isNull, like, or, sql } from "drizzle-orm";
import { db, footageRequestsTable, recordingTrackingBundlesTable, recordingsTable, userClipsTable, type FootageRequest, type VenueBooking } from "@workspace/db";
import { clipSpans } from "../creative/clipSpan";
import { clipOrigin } from "../creative/venueLibrary";
import { goalVotesFor, reviewedGoalsOf } from "../goalReview";
import { logger } from "../logger";
import { recordingsForRoom } from "../matchFeed";
import { detectedShots, pitchSizeOf, shotContext } from "../matchPlay";
import { loadRecordingPlay } from "../matchPlayLoad";
import { loadRoomByRequestId } from "../matchRooms";
import { SOURCE_SCORE } from "./igCalendar";

/**
 * One clip per booking, in this order (Mohammed, 2026-11-03):
 *   1. a clip a player saved or shared from that match (shared first);
 *   2. a confirmed goal;
 *   3. a detected shot, then a dribble, when the match was analysed;
 *   4. otherwise the booking is skipped.
 * The window is a recording's video time, 15 s, built up before the moment.
 */

export const CLIP_MS = 15_000;
/** Build-up before a goal, a shot or a dribble's start, seconds. */
const BEFORE_S = 9;

export type BookingPick = {
  source: "saved_clip" | "confirmed_goal" | "shot" | "dribble";
  recordingId: number;
  clipId: number | null;
  /** video ms */
  fromMs: number;
  toMs: number;
  /** tracking seconds of the moment, when it came from the analysis */
  atSeconds: number | null;
  score: number;
};

export type PickResult =
  | { ok: true; pick: BookingPick }
  /** wait: nothing yet, but the analysis or a player's clip may still come. */
  | { ok: false; wait: boolean; reason: string };

/** A 15 s window around a moment in video seconds, built up before it. */
export function windowAround(videoSec: number, durationSec: number | null, beforeSec = BEFORE_S): { fromMs: number; toMs: number } {
  let from = Math.max(0, videoSec - beforeSec);
  if (durationSec && durationSec > 0 && from + CLIP_MS / 1000 > durationSec) from = Math.max(0, durationSec - CLIP_MS / 1000);
  return { fromMs: Math.round(from * 1000), toMs: Math.round(from * 1000) + CLIP_MS };
}

/** A saved clip's window: its middle 15 s (or all of it, with the rest from after it). */
export function clipWindow(startSec: number, endSec: number): { fromMs: number; toMs: number } {
  const len = endSec - startSec;
  const from = len > CLIP_MS / 1000 ? startSec + (len - CLIP_MS / 1000) / 2 : startSec;
  return { fromMs: Math.round(Math.max(0, from) * 1000), toMs: Math.round(Math.max(0, from) * 1000) + CLIP_MS };
}

export async function bookingFootage(booking: Pick<VenueBooking, "footageRequestId">): Promise<FootageRequest | null> {
  if (!booking.footageRequestId) return null;
  const [fr] = await db.select().from(footageRequestsTable).where(eq(footageRequestsTable.id, booking.footageRequestId));
  return fr ?? null;
}

export async function recordingForVideo(videoId: string | null): Promise<{ id: number; duration: string } | null> {
  if (!videoId) return null;
  const [rec] = await db.select({ id: recordingsTable.id, duration: recordingsTable.duration }).from(recordingsTable)
    .where(like(recordingsTable.videoUrl, `%/${videoId}/%`)).limit(1);
  return rec ?? null;
}

function durationSeconds(label: string | null | undefined): number | null {
  const parts = String(label ?? "").split(":").map(Number);
  if (!parts.length || parts.some((n) => !Number.isFinite(n))) return null;
  return parts.reduce((s, n) => s * 60 + n, 0) || null;
}

export async function pickBookingClip(booking: VenueBooking, now = new Date()): Promise<PickResult> {
  const fr = await bookingFootage(booking);
  if (!fr || !fr.videoId || (fr.status !== "ready" && fr.status !== "partial")) return { ok: false, wait: true, reason: "The recording isn't ready yet" };
  if (fr.academyId) return { ok: false, wait: false, reason: "Filmed for an academy" };
  const rec = await recordingForVideo(fr.videoId);
  const readyAt = fr.readyAt ?? fr.updatedAt;
  const ageH = (now.getTime() - readyAt.getTime()) / 3_600_000;

  // 1. Players' own clips from this match (shared ones first).
  if (rec) {
    const rows = await db.select().from(userClipsTable).where(and(
      or(eq(userClipsTable.footageRequestId, fr.id), eq(sql`lower(${userClipsTable.videoId})`, fr.videoId.toLowerCase()), eq(userClipsTable.sourceRecordingId, rec.id))!,
      eq(userClipsTable.isHidden, false),
      isNull(userClipsTable.hiddenReason),
    )).orderBy(desc(userClipsTable.shareCount), desc(userClipsTable.likeCount), desc(userClipsTable.viewCount), desc(userClipsTable.createdAt)).limit(50);
    const mine = rows.filter((c) => clipOrigin(c) === "player" && !c.videoId.startsWith("live:"));
    if (mine.length) {
      const spans = await clipSpans(mine, () => rec.duration);
      for (const clip of mine) {
        const span = spans.get(clip.id);
        if (!span || span.endSec <= span.startSec) continue;
        const w = clipWindow(span.startSec, span.endSec);
        return { ok: true, pick: { source: "saved_clip", recordingId: rec.id, clipId: clip.id, ...w, atSeconds: null, score: SOURCE_SCORE.saved_clip + Math.min(9, clip.shareCount) } };
      }
    }
  }

  // 2–3. The analysis: confirmed goals, then shots, then dribbles, inside this booking's share.
  const ctx = await loadRoomByRequestId(fr.id).catch(() => null);
  let analysed = false;
  if (ctx) {
    const links = await recordingsForRoom(ctx).catch((error) => { logger.warn({ bookingId: booking.id, error: (error as Error).message }, "Instagram: reading the match's recordings failed"); return []; });
    const votes = await goalVotesFor(links.map((l) => l.recordingId));
    type Cand = { source: BookingPick["source"]; recordingId: number; t: number; start: number; rank: number };
    const found: Cand[] = [];
    for (const link of links) {
      const play = await loadRecordingPlay(link.recordingId).catch(() => null);
      if (!play || !play.hasBall) continue;
      analysed = true;
      const inside = (t: number) => t >= link.fromSeconds && t <= link.toSeconds;
      for (const g of reviewedGoalsOf(play, votes.get(link.recordingId) ?? [])) {
        if (g.status === "confirmed" && inside(g.t)) found.push({ source: "confirmed_goal", recordingId: link.recordingId, t: g.t, start: g.t, rank: g.confirmedBy.length });
      }
      for (const s of detectedShots(play.events, play.touches, pitchSizeOf(play.manifest), shotContext(play))) {
        if (inside(s.t)) found.push({ source: "shot", recordingId: link.recordingId, t: s.t, start: s.t, rank: 0 });
      }
      for (const d of play.dribbles) {
        if (d.outcome === "won" && inside(d.t0)) found.push({ source: "dribble", recordingId: link.recordingId, t: d.t1, start: d.t0, rank: d.beaten * 10 + Math.min(9, Math.round(d.metres ?? 0)) });
      }
    }
    const order: BookingPick["source"][] = ["confirmed_goal", "shot", "dribble"];
    for (const source of order) {
      const list = found.filter((c) => c.source === source).sort((a, b) => b.rank - a.rank || a.t - b.t);
      const best = list[0];
      if (!best) continue;
      const [bundle] = await db.select({ manifest: recordingTrackingBundlesTable.manifest }).from(recordingTrackingBundlesTable)
        .where(eq(recordingTrackingBundlesTable.recordingId, best.recordingId));
      const [recRow] = await db.select({ duration: recordingsTable.duration }).from(recordingsTable).where(eq(recordingsTable.id, best.recordingId));
      const offset = bundle?.manifest?.videoStartSeconds ?? 0;
      const before = source === "dribble" ? 2 : BEFORE_S;
      const w = windowAround(best.start + offset, durationSeconds(recRow?.duration), before);
      return { ok: true, pick: { source, recordingId: best.recordingId, clipId: null, ...w, atSeconds: best.t, score: SOURCE_SCORE[source] + Math.min(9, best.rank) } };
    }
  }

  // 4. Nothing. Wait while a player could still save a clip or the analysis could still land.
  const [hasBundle] = rec ? await db.select({ id: recordingTrackingBundlesTable.id }).from(recordingTrackingBundlesTable).where(eq(recordingTrackingBundlesTable.recordingId, rec.id)) : [];
  if (!analysed && !hasBundle && ageH < 24) return { ok: false, wait: true, reason: "Waiting for the match analysis or a player's clip" };
  if (ageH < 12) return { ok: false, wait: true, reason: "Waiting for a player's clip" };
  return { ok: false, wait: false, reason: "No saved clip, confirmed goal, shot or dribble in this booking" };
}
