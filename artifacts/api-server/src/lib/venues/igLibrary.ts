/**
 * The field's whole clip library as clips for an Instagram post (Mohammed, 2026-11-06: "The clips
 * don't have to be from the same day … separate them by goals, dribbles, passes, and by match …
 * by user clipped or AI clipped … by date. This is all for autopilot").
 *
 * Every clip anyone cut from the field's footage (players by hand, or Replay from the analysis),
 * but only from bookings the field may post: consent on, nobody under 18, not an academy's footage.
 * A post about one game (its booking clip, its highlights) only takes that game's clips.
 * A picked clip becomes a Nominee keyed `lib:<clipId>`, its window on the game's recording.
 */
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db, footageRequestsTable, recordingsTable, venueBookingsTable, type UserClipRow, type VenueBooking, type VenueIgItem } from "@workspace/db";
import { clipSpans } from "../creative/clipSpan";
import { savedClipWindow, type LibraryFilters } from "../creative/library";
import { venueClip, venueFieldIds, venueLibraryClips, type ClipKind, type ClipOrigin, type ClipSort, type VenueRecording } from "../creative/venueLibrary";
import { extractBunnyVideoId } from "../publicFootage";
import { labelsFor, type Nominee } from "./igAwards";
import { bookingPostable } from "./igConsent";
import { igSettings } from "./igAutopilot";
import type { Venue } from "./store";

export const LIBRARY_KEY = "lib:";
export const libraryKey = (clipId: number) => `${LIBRARY_KEY}${clipId}`;
export const libraryClipId = (key: string): number | null => {
  if (!key.startsWith(LIBRARY_KEY)) return null;
  const n = Number(key.slice(LIBRARY_KEY.length));
  return Number.isInteger(n) && n > 0 ? n : null;
};

/** Posts about one game take only that game's clips. */
const ONE_GAME = new Set(["booking_clip", "match_highlights"]);

type Postable = { byRecording: Map<number, VenueBooking>; byRequest: Map<number, VenueBooking>; recordingOfRequest: Map<number, number> };

/** The field's bookings it may post, by their footage: the recording and the footage request. */
export async function postableFootage(venue: Venue, onlyBookingId: number | null = null): Promise<Postable> {
  const out: Postable = { byRecording: new Map(), byRequest: new Map(), recordingOfRequest: new Map() };
  const s = igSettings(venue);
  if (s.mode === "off") return out;
  const rows = await db.select({ b: venueBookingsTable, fr: footageRequestsTable }).from(venueBookingsTable)
    .innerJoin(footageRequestsTable, eq(footageRequestsTable.id, venueBookingsTable.footageRequestId))
    .where(and(
      eq(venueBookingsTable.academyId, venue.id),
      inArray(venueBookingsTable.status, ["confirmed", "completed"]),
      inArray(footageRequestsTable.status, ["ready", "partial"]),
      isNotNull(footageRequestsTable.videoId),
      ...(onlyBookingId ? [eq(venueBookingsTable.id, onlyBookingId)] : []),
    ));
  const ok = rows.filter(({ b, fr }) => bookingPostable(s.mode, { ...b, academyFootage: fr.academyId != null }, { since: s.since, wording: s.wording }).ok);
  if (!ok.length) return out;
  const fields = (await venueFieldIds(venue.id)) ?? [];
  const recs = fields.length
    ? await db.select({ id: recordingsTable.id, videoUrl: recordingsTable.videoUrl }).from(recordingsTable)
      .where(and(inArray(recordingsTable.fieldId, fields), sql`${recordingsTable.videoUrl} <> ''`))
    : [];
  const recByVideo = new Map<string, number>();
  for (const r of recs) {
    const id = extractBunnyVideoId(r.videoUrl)?.toLowerCase();
    if (id) recByVideo.set(id, r.id);
  }
  for (const { b, fr } of ok) {
    out.byRequest.set(fr.id, b);
    const recId = fr.videoId ? recByVideo.get(fr.videoId.toLowerCase()) : undefined;
    if (recId) {
      out.byRecording.set(recId, b);
      out.recordingOfRequest.set(fr.id, recId);
    }
  }
  return out;
}

/** The posted booking a clip is from, or null when the field may not post it. */
function bookingOfClip(p: Postable, clip: Pick<UserClipRow, "footageRequestId">, recordingId: number | null): VenueBooking | null {
  return (recordingId ? p.byRecording.get(recordingId) : undefined) ?? (clip.footageRequestId ? p.byRequest.get(clip.footageRequestId) : undefined) ?? null;
}

export type LibraryQuery = { filters: LibraryFilters; origin: ClipOrigin | null; kind: ClipKind | null; sort: ClipSort };

/** The library clips an item may use, filtered and paged like the Creative hub's Library → Clips. */
export async function itemLibraryClips(venue: Venue, item: VenueIgItem, q: LibraryQuery) {
  const fields = (await venueFieldIds(venue.id)) ?? [];
  const oneGame = ONE_GAME.has(item.kind) ? item.bookingId : null;
  const p = await postableFootage(venue, oneGame);
  const empty = !p.byRecording.size && !p.byRequest.size;
  const out = empty
    ? { clips: [], total: 0, nextOffset: null, counts: { all: 0, auto: 0, player: 0 }, kindCounts: { goal: 0, dribble: 0, pass: 0, shot: 0, other: 0 }, sort: q.sort, groupSizes: {} }
    : await venueLibraryClips(venue.id, fields, q.filters, q.origin, q.sort, {
      keep: (clip: UserClipRow, recording: VenueRecording | null) => !clip.videoId.startsWith("live:") && bookingOfClip(p, clip, recording?.id ?? null) !== null,
      kind: q.kind,
      byMatchDate: true,
    });
  return { ...out, oneGame: oneGame !== null };
}

/** A library clip as a post's clip: its window on the game's recording, labelled with the game. Null when it can't be used. */
export async function libraryNominee(venue: Venue, item: VenueIgItem, clipId: number): Promise<Nominee | null> {
  const clip = await venueClip(venue.id, clipId);
  if (!clip || clip.videoId.startsWith("live:")) return null;
  const p = await postableFootage(venue, ONE_GAME.has(item.kind) ? item.bookingId : null);
  // The recording it was cut from: its source link, its video, or its footage request's video.
  let recordingId = clip.sourceRecordingId;
  if (!recordingId) {
    const [byVideo] = await db.select({ id: recordingsTable.id }).from(recordingsTable)
      .where(sql`lower(${recordingsTable.videoUrl}) like ${`%/${clip.videoId.toLowerCase()}/%`}`).limit(1);
    recordingId = byVideo?.id ?? (clip.footageRequestId ? p.recordingOfRequest.get(clip.footageRequestId) ?? null : null);
  }
  if (!recordingId) return null;
  const booking = bookingOfClip(p, clip, recordingId);
  if (!booking) return null;
  const [rec] = await db.select({ duration: recordingsTable.duration }).from(recordingsTable).where(eq(recordingsTable.id, recordingId));
  const span = (await clipSpans([clip], () => rec?.duration)).get(clip.id);
  const w = span ? savedClipWindow(recordingId, span.startSec, span.endSec, span.thumbSec ?? null) : null;
  if (!w) return null;
  const labels = await labelsFor(booking);
  return {
    key: libraryKey(clip.id),
    recordingId,
    bookingId: booking.id,
    atSeconds: null,
    fromMs: w.fromMs,
    toMs: w.toMs,
    atMs: w.atMs,
    source: "saved_clip",
    clipId: clip.id,
    label: labels.label,
    labelAr: labels.labelAr,
  };
}
