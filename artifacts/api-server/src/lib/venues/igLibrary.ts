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
import { and, eq, inArray, sql } from "drizzle-orm";
import { db, footageRequestsTable, recordingsTable, venueBookingsTable, venuePitchesTable, type FootageRequest, type UserClipRow, type VenueBooking, type VenueIgItem } from "@workspace/db";
import { clipSpans } from "../creative/clipSpan";
import { savedClipWindow, type LibraryFilters } from "../creative/library";
import { venueClip, venueFieldIds, venueLibraryClips, type ClipKind, type ClipOrigin, type ClipSort, type VenueRecording } from "../creative/venueLibrary";
import { recordingWindow } from "../matchFeed";
import { ammanLocalInstant } from "../matchRooms";
import { extractBunnyVideoId } from "../publicFootage";
import { labelsFor, type Nominee } from "./igAwards";
import { bookingRecordings } from "./igPick";
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

/** A posted booking's place in time: its field and its start and end (ms). */
type GameWindow = { booking: VenueBooking; fieldId: number; startMs: number; endMs: number };
/** blocked: games the field may not post. A camera moment inside one is never posted, even if a postable game overlaps it (one camera over two pitches). */
type Postable = { games: GameWindow[]; blocked: GameWindow[]; byRequest: Map<number, VenueBooking>; byRecording: Map<number, VenueBooking> };

function gameWindow(b: VenueBooking, fieldId: number): GameWindow | null {
  const startMs = ammanLocalInstant(b.startLocal);
  const endMs = ammanLocalInstant(b.endLocal);
  return Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs ? { booking: b, fieldId, startMs, endMs } : null;
}

/** The field's bookings it may post: their field and time, their footage request, and any recording that is their own video. */
export async function postableFootage(venue: Venue, onlyBookingId: number | null = null): Promise<Postable> {
  const out: Postable = { games: [], blocked: [], byRequest: new Map(), byRecording: new Map() };
  const s = igSettings(venue);
  if (s.mode === "off") return out;
  // Every played booking, with its footage request when it has one: the camera films the pitch either way.
  const rows = await db.select({ b: venueBookingsTable, fr: footageRequestsTable, pitchField: venuePitchesTable.fieldId }).from(venueBookingsTable)
    .leftJoin(footageRequestsTable, eq(footageRequestsTable.id, venueBookingsTable.footageRequestId))
    .leftJoin(venuePitchesTable, eq(venuePitchesTable.id, venueBookingsTable.pitchId))
    .where(and(
      eq(venueBookingsTable.academyId, venue.id),
      inArray(venueBookingsTable.status, ["confirmed", "completed"]),
      ...(onlyBookingId ? [eq(venueBookingsTable.id, onlyBookingId)] : []),
    ));
  const okRows: Array<{ b: VenueBooking; fr: FootageRequest | null; fieldId: number | null }> = [];
  for (const row of rows) {
    const fieldId = row.fr?.fieldId ?? row.pitchField ?? null;
    if (bookingPostable(s.mode, { ...row.b, academyFootage: row.fr?.academyId != null }, { since: s.since, wording: s.wording }).ok) okRows.push({ b: row.b, fr: row.fr, fieldId });
    else {
      const w = fieldId ? gameWindow(row.b, fieldId) : null;
      if (w) out.blocked.push(w);
    }
  }
  const ok = okRows;
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
  for (const { b, fr, fieldId } of ok) {
    const w = fieldId ? gameWindow(b, fieldId) : null;
    if (w) out.games.push(w);
    if (!fr) continue;
    out.byRequest.set(fr.id, b);
    const recId = fr.videoId ? recByVideo.get(fr.videoId.toLowerCase()) : undefined;
    if (recId) out.byRecording.set(recId, b);
  }
  return out;
}

type ClipTimes = Pick<UserClipRow, "footageRequestId" | "startTime">;
type RecTimes = Pick<VenueRecording, "id" | "fieldId" | "date" | "timeSlot" | "duration">;

/**
 * The posted booking a clip is from, or null when the field may not post it: cut from the booking's
 * own footage (share link), or from a camera recording at the booking's field at a moment inside it.
 */
function bookingOfClip(p: Postable, clip: ClipTimes, recording: RecTimes | null): VenueBooking | null {
  const byRequest = clip.footageRequestId ? p.byRequest.get(clip.footageRequestId) : undefined;
  if (byRequest) return byRequest;
  if (!recording) return null;
  const own = p.byRecording.get(recording.id);
  if (own) return own;
  const at = Number.parseFloat(String(clip.startTime));
  const w = recordingWindow(recording);
  if (!Number.isFinite(at) || !Number.isFinite(w.fileStartMs)) return null;
  const t = w.fileStartMs + at * 1000;
  const during = (g: GameWindow) => g.fieldId === recording.fieldId && t >= g.startMs && t < g.endMs;
  if (p.blocked.some(during)) return null;
  return p.games.find(during)?.booking ?? null;
}

export type LibraryQuery = { filters: LibraryFilters; origin: ClipOrigin | null; kind: ClipKind | null; sort: ClipSort };

/** The library clips an item may use, filtered and paged like the Creative hub's Library → Clips. */
export async function itemLibraryClips(venue: Venue, item: VenueIgItem, q: LibraryQuery) {
  const fields = (await venueFieldIds(venue.id)) ?? [];
  const oneGame = ONE_GAME.has(item.kind) ? item.bookingId : null;
  const p = await postableFootage(venue, oneGame);
  const empty = !p.games.length && !p.byRequest.size;
  const out = empty
    ? { clips: [], total: 0, nextOffset: null, counts: { all: 0, auto: 0, player: 0 }, kindCounts: { goal: 0, dribble: 0, pass: 0, shot: 0, other: 0 }, sort: q.sort, groupSizes: {} }
    : await venueLibraryClips(venue.id, fields, q.filters, q.origin, q.sort, {
      keep: (clip: UserClipRow, recording: VenueRecording | null) => !clip.videoId.startsWith("live:") && bookingOfClip(p, clip, recording) !== null,
      kind: q.kind,
      byMatchDate: true,
    });
  // Why it's empty: nothing may be posted (consent off, or no booking said yes), or no game was filmed.
  const why = out.total ? null : igSettings(venue).mode === "off" ? "consent_off" : empty ? (p.blocked.length ? "no_consent" : "no_games") : null;
  return { ...out, oneGame: oneGame !== null, why };
}

/** A library clip as a post's clip: its window on the game's recording, labelled with the game. Null when it can't be used. */
export async function libraryNominee(venue: Venue, item: VenueIgItem, clipId: number): Promise<Nominee | null> {
  const clip = await venueClip(venue.id, clipId);
  if (!clip || clip.videoId.startsWith("live:")) return null;
  const p = await postableFootage(venue, ONE_GAME.has(item.kind) ? item.bookingId : null);
  // The recording it was cut from: its source link, or the recording whose video it is.
  let recordingId = clip.sourceRecordingId;
  if (!recordingId) {
    const [byVideo] = await db.select({ id: recordingsTable.id }).from(recordingsTable)
      .where(sql`lower(${recordingsTable.videoUrl}) like ${`%/${clip.videoId.toLowerCase()}/%`}`).limit(1);
    recordingId = byVideo?.id ?? null;
  }
  let w: ReturnType<typeof savedClipWindow> = null;
  let booking: VenueBooking | null = null;
  if (recordingId) {
    const [rec] = await db.select({ id: recordingsTable.id, fieldId: recordingsTable.fieldId, date: recordingsTable.date, timeSlot: recordingsTable.timeSlot, duration: recordingsTable.duration })
      .from(recordingsTable).where(eq(recordingsTable.id, recordingId));
    if (!rec) return null;
    booking = bookingOfClip(p, clip, rec);
    const span = booking ? (await clipSpans([clip], () => rec.duration)).get(clip.id) : null;
    w = span ? savedClipWindow(rec.id, span.startSec, span.endSec, span.thumbSec ?? null) : null;
  } else if (clip.footageRequestId) {
    // Cut from the booking's own footage (a share link): the same moment on the camera's recording.
    booking = p.byRequest.get(clip.footageRequestId) ?? null;
    const [fr] = booking ? await db.select().from(footageRequestsTable).where(eq(footageRequestsTable.id, clip.footageRequestId)) : [];
    const from = Number.parseFloat(String(clip.startTime));
    const to = Number.parseFloat(String(clip.endTime));
    const t0 = fr ? ammanLocalInstant(fr.startLocal) : Number.NaN;
    if (fr && booking && Number.isFinite(from) && Number.isFinite(to) && to > from && Number.isFinite(t0)) {
      const at = t0 + from * 1000;
      for (const br of await bookingRecordings(booking, fr)) {
        const [rec] = await db.select({ date: recordingsTable.date, timeSlot: recordingsTable.timeSlot, duration: recordingsTable.duration }).from(recordingsTable).where(eq(recordingsTable.id, br.rec.id));
        const rw = rec ? recordingWindow(rec) : null;
        if (!rw || !Number.isFinite(rw.fileStartMs) || at < rw.fileStartMs || at >= rw.endMs) continue;
        const start = (at - rw.fileStartMs) / 1000;
        w = savedClipWindow(br.rec.id, start, start + (to - from), null);
        break;
      }
    }
  }
  if (!booking || !w) return null;
  const recordingIdUsed = w.recordingId;
  const labels = await labelsFor(booking);
  return {
    key: libraryKey(clip.id),
    recordingId: recordingIdUsed,
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
