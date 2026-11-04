import { and, asc, eq, gte, inArray, lt } from "drizzle-orm";
import {
  db,
  matchPlayerStatsCacheTable,
  recordingTrackingBundlesTable,
  recordingsTable,
  venueBookingsTable,
  venueIgAwardsTable,
  venueIgAwardVotesTable,
  venueIgNominationsTable,
  venuePitchesTable,
  type VenueBooking,
  type VenueIgAward,
} from "@workspace/db";
import { goalVotesFor, reviewedGoalsOf, tenths } from "../goalReview";
import { logger } from "../logger";
import { recordingsForRoom, type LinkedRecording } from "../matchFeed";
import { detectedShots, pitchSizeOf, shotContext } from "../matchPlay";
import { loadRecordingPlay } from "../matchPlayLoad";
import { loadRoomByRequestId } from "../matchRooms";
import { addDays, fromAmmanLocal } from "./core";
import { AWARD_ORDER, type AwardCategory, voteWinner } from "./igCalendar";
import { bookingPostable, consentMode } from "./igConsent";
import { bookingFootage, windowAround } from "./igPick";
import { dayLabel, timeLabel } from "./messages";
import type { Venue } from "./store";

/**
 * Weekly awards (Mohammed, 2026-11-03). Goal, dribble and shot of the week come from what
 * the analysis already detects. There is no keeper-save detection, so a save is nominated: by a
 * player from the match page, or offered to the owner as a shot that wasn't a goal; the owner
 * approves which go on the list. Fastest player only counts level-camera games (a tilted encode,
 * like rec 401's, makes every speed wrong) and only believable speeds.
 *
 * Nominees from the games of one week (Sunday–Saturday, Amman), voting in the Replay app, then
 * the winner. A thin vote is decided by the owner.
 */

export const AWARDS = {
  nomineesPerAward: 4,
  perBooking: 2,
  /** Speeds above this come from tilted pictures (rec 401's 27–31 km/h); 25.5 is the highest seen on a level game. */
  fastestMaxKmh: 27,
  fastestMinKmh: 12,
} as const;

export type Nominee = {
  key: string;
  recordingId: number;
  bookingId: number;
  /** tracking seconds of the moment, when the analysis gave it */
  atSeconds: number | null;
  /** video ms */
  fromMs: number;
  toMs: number;
  atMs: number;
  source: "confirmed_goal" | "dribble" | "shot" | "save" | "fastest";
  label: string;
  labelAr: string;
  /** fastest: km/h */
  value?: number | null;
  nominationId?: number;
};

export function readNominees(value: unknown): Nominee[] {
  return Array.isArray(value) ? value.filter((n): n is Nominee => Boolean(n) && typeof n === "object" && typeof (n as Nominee).key === "string") : [];
}

/** Bookings of a games week this field may post (consent, not under-18, not an academy's), with their footage. */
export async function weekBookings(venue: Venue, weekStart: string, until?: Date): Promise<VenueBooking[]> {
  const from = fromAmmanLocal(`${weekStart} 00:00`);
  const weekEnd = fromAmmanLocal(`${addDays(weekStart, 7)} 00:00`);
  const to = until && weekEnd && until < weekEnd ? until : weekEnd;
  if (!from || !to) return [];
  const rows = await db.select().from(venueBookingsTable).where(and(
    eq(venueBookingsTable.academyId, venue.id),
    gte(venueBookingsTable.startsAt, from),
    lt(venueBookingsTable.startsAt, to),
    inArray(venueBookingsTable.status, ["confirmed", "completed"]),
  )).orderBy(asc(venueBookingsTable.startsAt));
  const mode = consentMode(venue.settings.igConsentMode);
  const out: VenueBooking[] = [];
  for (const b of rows) {
    if (!b.footageRequestId) continue;
    const fr = await bookingFootage(b);
    if (!fr || !fr.videoId || (fr.status !== "ready" && fr.status !== "partial")) continue;
    if (!bookingPostable(mode, { ...b, academyFootage: fr.academyId != null }).ok) continue;
    out.push(b);
  }
  return out;
}

async function pitchName(pitchId: number): Promise<{ en: string; ar: string }> {
  const [p] = await db.select({ name: venuePitchesTable.name, nameAr: venuePitchesTable.nameAr }).from(venuePitchesTable).where(eq(venuePitchesTable.id, pitchId));
  return { en: p?.name ?? "", ar: p?.nameAr || p?.name || "" };
}

async function labelsFor(b: VenueBooking) {
  const pitch = await pitchName(b.pitchId);
  const date = b.startLocal.slice(0, 10);
  const time = b.startLocal.slice(11);
  return {
    label: [dayLabel(date, "en"), timeLabel(time, "en"), pitch.en].filter(Boolean).join(" · "),
    labelAr: [dayLabel(date, "ar"), timeLabel(time, "ar"), pitch.ar].filter(Boolean).join(" · "),
  };
}

export async function videoOffset(recordingId: number): Promise<{ offset: number; duration: number | null; tilted: boolean }> {
  const [b] = await db.select({ manifest: recordingTrackingBundlesTable.manifest }).from(recordingTrackingBundlesTable).where(eq(recordingTrackingBundlesTable.recordingId, recordingId));
  const [r] = await db.select({ duration: recordingsTable.duration, tilted: recordingsTable.cameraTilted }).from(recordingsTable).where(eq(recordingsTable.id, recordingId));
  const parts = String(r?.duration ?? "").split(":").map(Number);
  const duration = parts.length && parts.every(Number.isFinite) ? parts.reduce((s, n) => s * 60 + n, 0) : null;
  return { offset: b?.manifest?.videoStartSeconds ?? 0, duration, tilted: Boolean(r?.tilted) };
}

/** A moment found in a booking's footage, before it is made a nominee. */
export type RawMoment = { booking: VenueBooking; link: LinkedRecording; t: number; start: number; rank: number; source: Nominee["source"]; value?: number | null; nominationId?: number; keyExtra?: string };
type Raw = RawMoment;

/** Every candidate of every award in this week's postable bookings. */
export async function weekCandidates(venue: Venue, weekStart: string): Promise<Record<AwardCategory, Nominee[]>> {
  const { raw } = await weekMoments(venue, weekStart);
  const out = {} as Record<AwardCategory, Nominee[]>;
  for (const category of AWARD_ORDER) {
    const picked = pickSpread(raw[category], AWARDS.nomineesPerAward);
    const list: Nominee[] = [];
    for (const c of picked) list.push(await toNominee(c));
    out[category] = list;
  }
  return out;
}

/** The best first, at most `perBooking` from one booking. */
export function pickSpread(moments: RawMoment[], count: number, perBooking: number = AWARDS.perBooking): RawMoment[] {
  const sorted = [...moments].sort((a, b) => b.rank - a.rank || a.booking.startsAt.getTime() - b.booking.startsAt.getTime() || a.t - b.t);
  const picked: RawMoment[] = [];
  const used = new Map<number, number>();
  for (const c of sorted) {
    if (picked.length >= count) break;
    if ((used.get(c.booking.id) ?? 0) >= perBooking) continue;
    if (picked.some((p) => p.link.recordingId === c.link.recordingId && Math.abs(p.t - c.t) < 6)) continue;
    used.set(c.booking.id, (used.get(c.booking.id) ?? 0) + 1);
    picked.push(c);
  }
  return picked;
}

/** A moment as a nominee: its video window and labels. */
export async function toNominee(c: RawMoment): Promise<Nominee> {
  const video = await videoOffset(c.link.recordingId);
  const before = c.source === "dribble" || c.source === "fastest" ? 3 : 9;
  const w = windowAround(c.start + video.offset, video.duration, before);
  const labels = await labelsFor(c.booking);
  return {
    key: `${c.link.recordingId}:${c.keyExtra ?? tenths(c.t)}`,
    recordingId: c.link.recordingId,
    bookingId: c.booking.id,
    atSeconds: c.t,
    ...w,
    atMs: Math.round((c.t + video.offset) * 1000),
    source: c.source,
    ...labels,
    ...(c.value != null ? { value: c.value } : {}),
    ...(c.nominationId ? { nominationId: c.nominationId } : {}),
  };
}

/** A booking's match room and the stretches of each recording that are this booking. */
export async function bookingLinks(booking: VenueBooking): Promise<{ ctx: NonNullable<Awaited<ReturnType<typeof loadRoomByRequestId>>>; links: LinkedRecording[] } | null> {
  const fr = await bookingFootage(booking);
  const ctx = fr ? await loadRoomByRequestId(fr.id).catch(() => null) : null;
  if (!ctx) return null;
  try {
    return { ctx, links: await recordingsForRoom(ctx) };
  } catch (error) {
    logger.warn({ bookingId: booking.id, error: (error as Error).message }, "Awards: reading a booking's recordings failed");
    return null;
  }
}

/**
 * Every moment in a games week's postable bookings (up to `until`, for this week so far): confirmed
 * goals, shots that weren't goals, dribbles won, approved saves, claimed players' top speeds.
 */
export async function weekMoments(venue: Venue, weekStart: string, until?: Date): Promise<{ bookings: VenueBooking[]; raw: Record<AwardCategory, RawMoment[]> }> {
  const bookings = await weekBookings(venue, weekStart, until);
  const raw: Record<AwardCategory, Raw[]> = { goal: [], dribble: [], shot: [], save: [], fastest: [] };
  const bookingIds = bookings.map((b) => b.id);
  const approved = bookingIds.length ? await db.select().from(venueIgNominationsTable).where(and(
    eq(venueIgNominationsTable.academyId, venue.id),
    eq(venueIgNominationsTable.status, "approved"),
    inArray(venueIgNominationsTable.bookingId, bookingIds),
  )) : [];
  for (const booking of bookings) {
    const found = await bookingLinks(booking);
    if (!found) continue;
    const { ctx, links } = found;
    const votes = await goalVotesFor(links.map((l) => l.recordingId));
    for (const link of links) {
      const inside = (t: number) => t >= link.fromSeconds && t <= link.toSeconds;
      const play = await loadRecordingPlay(link.recordingId).catch(() => null);
      if (play?.hasBall) {
        const reviewed = reviewedGoalsOf(play, votes.get(link.recordingId) ?? []);
        const goals = reviewed.filter((g) => g.status === "confirmed" && inside(g.t));
        for (const g of goals) raw.goal.push({ booking, link, t: g.t, start: g.t, rank: g.confirmedBy.length, source: "confirmed_goal" });
        for (const s of detectedShots(play.events, play.touches, pitchSizeOf(play.manifest), shotContext(play))) {
          if (!inside(s.t) || goals.some((g) => Math.abs(g.t - s.t) <= 3)) continue;
          raw.shot.push({ booking, link, t: s.t, start: s.t, rank: 0, source: "shot" });
        }
        for (const d of play.dribbles) {
          if (d.outcome === "won" && inside(d.t0)) raw.dribble.push({ booking, link, t: d.t1, start: d.t0, rank: d.beaten * 10 + Math.min(9, Math.round(d.metres ?? 0)), source: "dribble" });
        }
      }
      for (const n of approved.filter((x) => x.bookingId === booking.id && x.recordingId === link.recordingId)) {
        raw.save.push({ booking, link, t: n.atSeconds, start: n.atSeconds, rank: n.source === "player" ? 1 : 0, source: "save", nominationId: n.id });
      }
    }
    // Fastest: the claimed players' top speeds, level games only, believable speeds only.
    const stats = await db.select({ userId: matchPlayerStatsCacheTable.userId, stats: matchPlayerStatsCacheTable.stats })
      .from(matchPlayerStatsCacheTable).where(eq(matchPlayerStatsCacheTable.matchId, ctx.room.id));
    for (const row of stats) {
      const kmh = row.stats?.topSpeedKmh;
      const at = row.stats?.extras?.topSpeedAt;
      if (typeof kmh !== "number" || typeof at !== "number" || kmh < AWARDS.fastestMinKmh || kmh > AWARDS.fastestMaxKmh) continue;
      // Booking seconds → each recording's tracking clock (tracking zero sits at recordingOffsetSec).
      const link = links.find((l) => at - l.recordingOffsetSec >= l.fromSeconds && at - l.recordingOffsetSec <= l.toSeconds);
      if (!link) continue;
      const t = at - link.recordingOffsetSec;
      if ((await videoOffset(link.recordingId)).tilted) continue;
      raw.fastest.push({ booking, link, t, start: t, rank: Math.round(kmh * 10), source: "fastest", value: Math.round(kmh * 10) / 10, keyExtra: `speed:${row.userId}` });
    }
  }
  return { bookings, raw };
}

/** Shots that weren't goals in a recording's booking share: the save candidates the owner can approve. */
export async function saveCandidates(link: LinkedRecording): Promise<number[]> {
  const play = await loadRecordingPlay(link.recordingId).catch(() => null);
  if (!play?.hasBall) return [];
  const votes = await goalVotesFor([link.recordingId]);
  const goals = reviewedGoalsOf(play, votes.get(link.recordingId) ?? []).filter((g) => g.status === "confirmed");
  return detectedShots(play.events, play.touches, pitchSizeOf(play.manifest), shotContext(play))
    .map((s) => s.t)
    .filter((t) => t >= link.fromSeconds && t <= link.toSeconds && !goals.some((g) => Math.abs(g.t - t) <= 3));
}

export async function awardVotes(awardIds: number[]) {
  if (!awardIds.length) return [];
  return db.select().from(venueIgAwardVotesTable).where(inArray(venueIgAwardVotesTable.awardId, awardIds));
}

/**
 * Count the vote: the app's votes and `extra` (the Instagram comments on the nominees carousel,
 * one per account). Returns the award decided, or waiting for the owner when the vote is thin.
 */
export async function closeVoting(award: VenueIgAward, minVotes: number, now = new Date(), extra: Array<{ nomineeKey: string }> = []): Promise<VenueIgAward> {
  const nominees = readNominees(award.nominees);
  const votes = [...(await awardVotes([award.id])), ...extra];
  const result = voteWinner(nominees.map((n) => n.key), votes, minVotes);
  const [row] = await db.update(venueIgAwardsTable).set(result.key
    ? { status: "decided", winnerKey: result.key, decidedBy: "votes", decidedAt: now, updatedAt: now }
    : { status: "owner_pick", updatedAt: now })
    .where(and(eq(venueIgAwardsTable.id, award.id), eq(venueIgAwardsTable.status, "voting"))).returning();
  return row ?? award;
}
