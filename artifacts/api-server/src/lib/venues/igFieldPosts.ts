import { and, asc, eq, gte, inArray, isNotNull, lt } from "drizzle-orm";
import {
  db,
  footageRequestsTable,
  matchPlayerStatsCacheTable,
  usersTable,
  venueBookingsTable,
  type Academy,
  type VenueBooking,
  type VenueIgAward,
  type VenueIgItem,
} from "@workspace/db";
import { awardTitle, countData, type CreativeData } from "@workspace/api-zod";
import { readClaimSegment } from "../claimMatchStorage";
import { goalVotesFor, reviewedGoalsOf } from "../goalReview";
import { logger } from "../logger";
import { loadRecordingPlay } from "../matchPlayLoad";
import { buildPlayerMetrics } from "../playerMetrics";
import { addDays, ammanLocal, fromAmmanLocal, wallString } from "./core";
import {
  AWARDS,
  bookingLinks,
  pickSpread,
  readNominees,
  toNominee,
  videoOffset,
  weekBookings,
  weekMoments,
  type Nominee,
  type RawMoment,
} from "./igAwards";
import { AWARD_ORDER, nowWall, weekStartOf, weeklyTimes, type AwardCategory, type IgSlotSettings } from "./igCalendar";
import { wallMinutes } from "./core";
import { windowAround } from "./igPick";
import { dayLabel, timeLabel, type Locale } from "./messages";
import { availability, type Venue } from "./store";

/**
 * What each field Instagram post shows (Mohammed, 2026-11-04): the field template pack
 * (lib/api-zod creativeTemplates/fieldPack.ts) filled from the field's games.
 *
 *   booking clip      one moment of one booking, its reference on the end card;
 *   award nominees    a carousel: a cover listing them, then one slide each, voted in the comments;
 *   award winner      the winning clip (no vote count on it; the fastest player's speed counts up);
 *   which is nicer?   this week's two best moments, voted A or B in the comments;
 *   top 5             last week's five best moments, counted down;
 *   thank you         last week's games filmed, goals and the km everyone ran, over the best goal;
 *   match of the week the booking with the most confirmed goals;
 *   player of the week a claimed player who agreed to be shown (users.social_media_consent);
 *   milestone         games filmed passing 100, 250, 500, 1,000 …;
 *   open slots        tonight's free kick-offs (a still);
 *   leaderboard       last month's scorers who agreed to be shown (a still).
 *
 * Every clip comes from a booking the field may post (consent on, nobody under 18, not an
 * academy's footage); the numbers (games, goals, km) count every filmed game, but name no one.
 */

export type Window = { recordingId: number; fromMs: number; toMs: number };
/** One design of a post. `clips`: a montage laid out for that many clips (2–5). */
export type FieldPart = { templateKey: string; format: "story" | "post"; title: string; data: CreativeData; windows: Window[]; clips?: number };
/** parts to render; skip: nothing to post (and why); wait: not ready yet (try again later). */
export type FieldDesign = { parts: FieldPart[]; moment?: Record<string, unknown> } | { skip: string } | { wait: string };

const AR_MONTHS = ["كانون الثاني", "شباط", "آذار", "نيسان", "أيار", "حزيران", "تموز", "آب", "أيلول", "تشرين الأول", "تشرين الثاني", "كانون الأول"];
const EN_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const monthName = (month: string, ar: boolean) => (ar ? AR_MONTHS : EN_MONTHS)[Number(month.slice(5, 7)) - 1] ?? month;

/** "+962799204098" / "0799204098" → "07 9920 4098"; anything else as given. */
export function localPhone(raw: string | null | undefined): string {
  const digits = (raw ?? "").replace(/\D/g, "");
  const local = digits.startsWith("962") ? `0${digits.slice(3)}` : digits;
  return /^07\d{8}$/.test(local) ? `${local.slice(0, 2)} ${local.slice(2, 6)} ${local.slice(6)}` : (raw ?? "").trim();
}

export function venuePhone(academy: Pick<Academy, "whatsappPhone" | "contactPhone">): string {
  return localPhone(academy.whatsappPhone || academy.contactPhone);
}

/** The field's name, phone and booking lines every template's end card and band read. */
export function fieldBits(venue: Venue, academy: Pick<Academy, "whatsappPhone" | "contactPhone">, locale: Locale, reference?: string): { academy: CreativeData["academy"]; custom: Record<string, string> } {
  const ar = locale === "ar";
  const phone = venuePhone(academy);
  const name = ar ? venue.nameAr || venue.name : venue.name;
  return {
    academy: { name: venue.name, nameAr: venue.nameAr, phone },
    custom: {
      field: name,
      bookLine: ar ? "احجز ملعبك · كل ماتش متصوّر" : "Book a pitch · every game filmed",
      endLine: reference ? (ar ? "حجز" : "Booking") : (ar ? "احجز ملعبك، وماتشك بيتصوّر" : "Book a pitch, your game gets filmed"),
      endBig: reference ?? phone,
      endSmall: ar ? "كل ماتش إله فيديو" : "Every game gets its video",
    },
  };
}

const SOURCE_LABEL: Record<string, { en: string; ar: string }> = {
  confirmed_goal: { en: "Goal", ar: "جول" },
  dribble: { en: "Dribble", ar: "مراوغة" },
  shot: { en: "Shot", ar: "تسديدة" },
  save: { en: "Save", ar: "تصدّي" },
  fastest: { en: "Top speed", ar: "أسرع ركضة" },
};
export const sourceLabel = (source: string, ar: boolean) => (ar ? SOURCE_LABEL[source]?.ar : SOURCE_LABEL[source]?.en) ?? source;

/** A short window: the moment `leadSec` in (a dribble from just before it starts). */
async function shortWindow(m: RawMoment, leadSec: number, lengthMs: number): Promise<Window> {
  const video = await videoOffset(m.link.recordingId);
  const anchor = m.source === "dribble" ? m.start - 0.8 : m.t - leadSec;
  const from = Math.max(0, anchor + video.offset);
  return { recordingId: m.link.recordingId, fromMs: Math.round(from * 1000), toMs: Math.round(from * 1000) + lengthMs };
}

const recording = (w: Window): NonNullable<CreativeData["media"]> => ({ type: "recording", recordingId: w.recordingId, fromMs: w.fromMs, toMs: w.toMs });

/** Goals first, then dribbles, saves and shots (top speeds are not a moment to watch twice). */
function bestMoments(raw: Record<AwardCategory, RawMoment[]>): RawMoment[] {
  const weight: Partial<Record<AwardCategory, number>> = { goal: 3000, dribble: 2000, save: 1500, shot: 1000 };
  return (Object.keys(weight) as AwardCategory[]).flatMap((k) => raw[k].map((m) => ({ ...m, rank: m.rank + weight[k]! })));
}

const weekRange = (weekStart: string, ar: boolean) => {
  const end = addDays(weekStart, 6);
  const d = (x: string) => `${Number(x.slice(8, 10))} ${monthName(x, ar)}`;
  return ar ? `من ${d(weekStart)} لـ ${d(end)}` : `${d(weekStart)} – ${d(end)}`;
};

// ─── Booking clips and awards ────────────────────────────────────────────────

export async function bookingClipDesign(venue: Venue, academy: Academy, booking: VenueBooking, item: VenueIgItem, locale: Locale, facts: { date: string; time: string; place: string }, headline: { en: string; ar: string }): Promise<FieldDesign> {
  const m = item.moment as Window | null;
  if (!m) return { skip: "Its footage is gone" };
  const ar = locale === "ar";
  const bits = fieldBits(venue, academy, locale, booking.reference);
  const name = ar ? venue.nameAr || venue.name : venue.name;
  return {
    parts: [{
      templateKey: "field-booking-clip",
      format: "story",
      title: `${ar ? headline.ar : headline.en} · ${booking.reference}`,
      windows: [m],
      data: {
        academy: bits.academy,
        match: facts,
        media: recording(m),
        custom: { ...bits.custom, kicker: ar ? `على أرض ${name}` : `On the pitch at ${name}`, headline: ar ? headline.ar : headline.en, title: ar ? headline.ar : headline.en, meta: [facts.date, facts.time, facts.place].filter(Boolean).join(" · ") },
      },
    }],
  };
}

/** Nominees as a carousel: the cover (what's voted, the list, how) then one slide per nominee. */
export function nomineesDesign(venue: Venue, academy: Academy, award: VenueIgAward, locale: Locale, closes: string): FieldDesign {
  const nominees = readNominees(award.nominees).slice(0, AWARDS.nomineesPerAward);
  if (nominees.length < 2) return { skip: "Fewer than two nominees" };
  const ar = locale === "ar";
  const bits = fieldBits(venue, academy, locale);
  const title = awardTitle(award.category, ar);
  const label = (n: Nominee) => (ar ? n.labelAr : n.label);
  const cover: FieldPart = {
    templateKey: "field-nominees-cover",
    format: "post",
    title: `${title} · ${award.weekStart}`,
    windows: [],
    data: {
      academy: bits.academy,
      custom: {
        ...bits.custom,
        kicker: ar ? "صوّتوا" : "Vote",
        title,
        ...Object.fromEntries(nominees.map((n, i) => [`n${i + 1}`, label(n)])),
        cta: ar ? "اسحبوا وعلّقوا برقم اللقطة" : "Swipe, then comment its number",
        closes,
      },
    },
  };
  const slides = nominees.map((n, i): FieldPart => ({
    templateKey: "field-nominee-slide",
    format: "post",
    title: `${title} · ${i + 1}`,
    windows: [{ recordingId: n.recordingId, fromMs: n.fromMs, toMs: n.toMs }],
    data: {
      academy: bits.academy,
      media: { type: "recording", recordingId: n.recordingId, fromMs: n.fromMs, toMs: n.toMs },
      custom: { ...bits.custom, n: String(i + 1), label: label(n), cta: ar ? `علّق ${i + 1} إذا عجبتك` : `Comment ${i + 1} if it's your pick` },
    },
  }));
  return { parts: [cover, ...slides] };
}

/**
 * The winner's video. No vote count and no "voted by" on it (Mohammed, 2026-11-04: "remove votes
 * from the designs"); the fastest player shows his speed.
 */
export async function winnerDesign(venue: Venue, academy: Academy, award: VenueIgAward, winner: Nominee, booking: VenueBooking, locale: Locale, facts: { date: string; time: string; place: string }): Promise<FieldDesign> {
  const ar = locale === "ar";
  const bits = fieldBits(venue, academy, locale, booking.reference);
  const title = awardTitle(award.category, ar);
  const w = { recordingId: winner.recordingId, fromMs: winner.fromMs, toMs: winner.toMs };
  return {
    parts: [{
      templateKey: "field-award",
      format: "story",
      title: `${title} · ${award.weekStart}`,
      windows: [w],
      data: {
        academy: bits.academy,
        match: facts,
        media: recording(w),
        custom: {
          ...bits.custom,
          kicker: ar ? "فايز هالأسبوع" : "This week's winner",
          title,
          ...(winner.value != null ? { ...countData("stat", winner.value, 1), statLabel: ar ? "كم/س" : "km/h" } : {}),
          meta: [facts.date, facts.time, facts.place].filter(Boolean).join(" · "),
        },
      },
    }],
  };
}

// ─── Which is nicer? ─────────────────────────────────────────────────────────

/** This week's two best moments (two bookings when possible), A against B. */
export async function versusDesign(venue: Venue, academy: Academy, s: IgSlotSettings, slotAt: Date, locale: Locale, picks: Nominee[] = []): Promise<FieldDesign> {
  const t = weeklyTimes(s, "versus", nowWall(slotAt));
  let a: Window, b: Window, na: Nominee, nb: Nominee;
  if (picks.length >= 2) {
    // The owner's two clips.
    [na, nb] = picks;
    [a, b] = [nomineeWindow(na, 4.5, 12_000), nomineeWindow(nb, 4.5, 12_000)];
  } else {
    const until = fromAmmanLocal(wallString(t.gamesUntil!)) ?? slotAt;
    const { raw } = await weekMoments(venue, t.gamesWeek, until);
    const goals = pickSpread(raw.goal, 2, 1);
    const pair = goals.length === 2 ? goals : pickSpread(bestMoments(raw), 2, 1);
    if (pair.length < 2) return { skip: "Fewer than two moments to compare this week" };
    [a, b] = await Promise.all(pair.map((m) => shortWindow(m, 4.5, 12_000)));
    [na, nb] = await Promise.all(pair.map((m) => toNominee(m)));
  }
  const ar = locale === "ar";
  const bits = fieldBits(venue, academy, locale);
  const bothGoals = [na, nb].every((m) => m.source === "confirmed_goal");
  return {
    moment: { choices: [na, nb].map((n) => ({ key: n.key, bookingId: n.bookingId, label: n.label, labelAr: n.labelAr })) },
    parts: [{
      templateKey: "field-versus",
      format: "story",
      title: ar ? `أي واحد أحلى؟ · ${t.gamesWeek}` : `Which is nicer? · ${t.gamesWeek}`,
      windows: [a, b],
      data: {
        academy: bits.academy,
        media: recording(a),
        more: [recording(b)],
        custom: {
          ...bits.custom,
          question: bothGoals ? (ar ? "أي جول أحلى؟" : "Which goal is nicer?") : (ar ? "أي لقطة أحلى؟" : "Which one is nicer?"),
          labelA: ar ? "أ" : "A",
          labelB: ar ? "ب" : "B",
          metaA: ar ? na.labelAr : na.label,
          metaB: ar ? nb.labelAr : nb.label,
          cta: ar ? "علّقوا: أ ولا ب؟" : "Comment: A or B?",
        },
      },
    }],
  };
}

// ─── Top 5 ───────────────────────────────────────────────────────────────────

export async function top5Design(venue: Venue, academy: Academy, s: IgSlotSettings, slotAt: Date, locale: Locale, picks: Nominee[] = []): Promise<FieldDesign> {
  const t = weeklyTimes(s, "top5", nowWall(slotAt));
  let windows: Window[];
  let nominees: Nominee[];
  if (picks.length >= 5) {
    // The owner's five, #1 first.
    nominees = picks.slice(0, 5);
    windows = nominees.map((n) => nomineeWindow(n, 2.4, 6_000));
  } else {
    const { raw } = await weekMoments(venue, t.gamesWeek);
    const five = pickSpread(bestMoments(raw), 5, 2);
    if (five.length < 5) return { skip: "Fewer than five moments last week" };
    windows = await Promise.all(five.map((m) => shortWindow(m, 2.4, 6_000)));
    nominees = await Promise.all(five.map((m) => toNominee(m)));
  }
  const ar = locale === "ar";
  const bits = fieldBits(venue, academy, locale);
  const custom: Record<string, string> = { ...bits.custom, kicker: ar ? "الأسبوع الماضي على أرضنا" : "Last week on our pitches", title: ar ? "أحلى 5 لقطات" : "Top 5 clips" };
  nominees.forEach((n, i) => {
    // #1 is the best: data.media; #2 … #5 are more.0 … more.3.
    custom[`l${i + 1}`] = sourceLabel(n.source, ar);
    custom[`m${i + 1}`] = ar ? n.labelAr : n.label;
  });
  return {
    moment: { bookingIds: [...new Set(nominees.map((n) => n.bookingId))] },
    parts: [{
      templateKey: "field-top5",
      format: "story",
      title: ar ? `أحلى 5 لقطات · ${t.gamesWeek}` : `Top 5 · ${t.gamesWeek}`,
      windows,
      data: { academy: bits.academy, media: recording(windows[0]), more: windows.slice(1).map(recording), custom },
    }],
  };
}

// ─── The week in numbers ─────────────────────────────────────────────────────

export type WeekNumbers = { matches: number; goals: number; km: number | null };

/**
 * Metres run by everyone on the pitch in one booking's stretch of a recording: every person the
 * analysis put together (the match roster), not just the players who claimed themselves.
 * Null when the recording has no roster or no segments.
 */
export async function bookingDistanceKm(recordingId: number, fromSeconds: number, toSeconds: number): Promise<number | null> {
  const play = await loadRecordingPlay(recordingId, { keepSegments: true }).catch(() => null);
  const rosterPath = play?.manifest.matchRosterPath;
  if (!play?.segments || !rosterPath) return null;
  let roster: { players?: Array<{ parts?: Array<{ trackId: string; fromFrame: number; toFrame: number }> }> };
  try {
    roster = JSON.parse((await readClaimSegment(rosterPath)).toString("utf8"));
  } catch {
    return null;
  }
  const lo = fromSeconds * play.fps;
  const hi = toSeconds * play.fps;
  let metres = 0;
  let measured = false;
  for (const player of roster.players ?? []) {
    const parts = (player.parts ?? [])
      .filter((p) => typeof p.trackId === "string" && Number.isFinite(p.fromFrame) && Number.isFinite(p.toFrame))
      .map((p) => ({ trackId: p.trackId, fromFrame: Math.max(p.fromFrame, lo), toFrame: Math.min(p.toFrame, hi) }))
      .filter((p) => p.toFrame > p.fromFrame);
    if (!parts.length) continue;
    const seconds = parts.reduce((sum, p) => sum + (p.toFrame - p.fromFrame) / play.fps, 0);
    const m = buildPlayerMetrics(play.manifest, play.segments, parts, seconds, 0, 0, 0, 0, 0, 0, []);
    if (m.distanceMetres !== null) {
      metres += m.distanceMetres;
      measured = true;
    }
  }
  return measured ? metres / 1000 : null;
}

/** Every game filmed in a week (consent or not: these are totals, nobody is shown or named). */
async function filmedBookings(venue: Venue, weekStart: string): Promise<VenueBooking[]> {
  const from = fromAmmanLocal(`${weekStart} 00:00`);
  const to = fromAmmanLocal(`${addDays(weekStart, 7)} 00:00`);
  if (!from || !to) return [];
  const rows = await db.select({ b: venueBookingsTable }).from(venueBookingsTable)
    .innerJoin(footageRequestsTable, eq(footageRequestsTable.id, venueBookingsTable.footageRequestId))
    .where(and(
      eq(venueBookingsTable.academyId, venue.id),
      gte(venueBookingsTable.startsAt, from),
      lt(venueBookingsTable.startsAt, to),
      inArray(venueBookingsTable.status, ["confirmed", "completed"]),
      inArray(footageRequestsTable.status, ["ready", "partial"]),
      isNotNull(footageRequestsTable.videoId),
    )).orderBy(asc(venueBookingsTable.startsAt));
  return rows.map((r) => r.b);
}

async function computeWeekNumbers(venue: Venue, weekStart: string): Promise<WeekNumbers> {
  const bookings = await filmedBookings(venue, weekStart);
  let goals = 0;
  let km = 0;
  let measured = false;
  for (const booking of bookings) {
    const found = await bookingLinks(booking);
    if (!found) continue;
    const votes = await goalVotesFor(found.links.map((l) => l.recordingId));
    for (const link of found.links) {
      const play = await loadRecordingPlay(link.recordingId).catch(() => null);
      if (play?.hasBall) {
        goals += reviewedGoalsOf(play, votes.get(link.recordingId) ?? [])
          .filter((g) => g.status === "confirmed" && g.t >= link.fromSeconds && g.t <= link.toSeconds).length;
      }
      const d = await bookingDistanceKm(link.recordingId, link.fromSeconds, link.toSeconds).catch(() => null);
      if (d !== null) {
        km += d;
        measured = true;
      }
    }
  }
  return { matches: bookings.length, goals, km: measured ? Math.round(km) : null };
}

/**
 * The week's numbers take minutes to count (every recording's tracks), so they are counted in
 * the background once per field and week; the design waits for them.
 */
const weekNumbersCache = new Map<string, { promise: Promise<WeekNumbers>; value: WeekNumbers | null; failed: boolean; at: number }>();

export function weekNumbers(venue: Venue, weekStart: string): WeekNumbers | "counting" | "failed" {
  const key = `${venue.id}:${weekStart}`;
  let entry = weekNumbersCache.get(key);
  if (entry?.failed && Date.now() - entry.at > 30 * 60_000) entry = undefined;
  if (!entry) {
    const fresh: { promise: Promise<WeekNumbers>; value: WeekNumbers | null; failed: boolean; at: number } = { promise: computeWeekNumbers(venue, weekStart), value: null, failed: false, at: Date.now() };
    fresh.promise.then((v) => { fresh.value = v; }, (error) => {
      fresh.failed = true;
      logger.warn({ venueId: venue.id, weekStart, error: (error as Error).message }, "Instagram: counting the week failed");
    });
    weekNumbersCache.set(key, fresh);
    if (weekNumbersCache.size > 50) weekNumbersCache.delete(weekNumbersCache.keys().next().value!);
    entry = fresh;
  }
  return entry.value ?? (entry.failed ? "failed" : "counting");
}

/** For tests. */
export function resetWeekNumbers(): void {
  weekNumbersCache.clear();
}

export async function thanksDesign(venue: Venue, academy: Academy, s: IgSlotSettings, slotAt: Date, locale: Locale): Promise<FieldDesign> {
  const t = weeklyTimes(s, "thanks", nowWall(slotAt));
  const n = weekNumbers(venue, t.gamesWeek);
  if (n === "counting") return { wait: "Counting last week's games" };
  if (n === "failed") return { wait: "Counting last week's games failed; trying again" };
  if (n.matches === 0) return { skip: "No games were filmed last week" };
  const ar = locale === "ar";
  const bits = fieldBits(venue, academy, locale);
  const name = ar ? venue.nameAr || venue.name : venue.name;
  // Numbers on the pack's own background: no footage, so no one's game is in it.
  return {
    moment: { bookingIds: [], numbers: n },
    parts: [{
      templateKey: "field-thanks",
      format: "story",
      title: ar ? `شكراً · ${t.gamesWeek}` : `Thank you · ${t.gamesWeek}`,
      windows: [],
      data: {
        academy: bits.academy,
        custom: {
          ...bits.custom,
          title: ar ? "شكراً إلكم" : "Thank you",
          sub: ar ? `على أسبوع حلو بـ${name}` : `for a great week at ${name}`,
          ...countData("matches", n.matches), matchesLabel: ar ? "ماتش متصوّر" : n.matches === 1 ? "game filmed" : "games filmed",
          ...(n.goals > 0 ? { ...countData("goals", n.goals), goalsLabel: ar ? "جول" : n.goals === 1 ? "goal" : "goals" } : {}),
          ...(n.km !== null && n.km > 0 ? { ...countData("km", n.km), kmLabel: ar ? "كم ركضتوا كلكم" : "km you all ran" } : {}),
        },
      },
    }],
  };
}

// ─── Match of the week ───────────────────────────────────────────────────────

export async function matchWeekDesign(venue: Venue, academy: Academy, s: IgSlotSettings, slotAt: Date, locale: Locale): Promise<FieldDesign> {
  const t = weeklyTimes(s, "match_week", nowWall(slotAt));
  const { raw } = await weekMoments(venue, t.gamesWeek);
  const byBooking = new Map<number, RawMoment[]>();
  for (const g of raw.goal) byBooking.set(g.booking.id, [...(byBooking.get(g.booking.id) ?? []), g]);
  const ranked = [...byBooking.values()].sort((a, b) => b.length - a.length || a[0].booking.startsAt.getTime() - b[0].booking.startsAt.getTime());
  const goals = ranked[0];
  if (!goals || goals.length < 3) return { skip: "No game last week had three confirmed goals" };
  const ar = locale === "ar";
  const booking = goals[0].booking;
  const bits = fieldBits(venue, academy, locale, booking.reference);
  const [best] = pickSpread(goals, 1, 1);
  const n = await toNominee(best);
  const w = { recordingId: n.recordingId, fromMs: n.fromMs, toMs: n.toMs };
  const minutes = Math.round((booking.endsAt.getTime() - booking.startsAt.getTime()) / 60_000);
  const span = ar ? (minutes === 60 ? "بساعة وحدة" : `بـ${minutes} دقيقة`) : (minutes === 60 ? "in one hour" : `in ${minutes} minutes`);
  return {
    moment: { bookingIds: [booking.id] },
    parts: [{
      templateKey: "field-match-week",
      format: "story",
      title: ar ? `ماتش الأسبوع · ${booking.reference}` : `Match of the week · ${booking.reference}`,
      windows: [w],
      data: {
        academy: bits.academy,
        media: recording(w),
        custom: {
          ...bits.custom,
          kicker: ar ? "ماتش الأسبوع" : "Match of the week",
          ...countData("goals", goals.length),
          goalsLabel: ar ? `جول ${span}` : `goals ${span}`,
          headline: ar ? `${goals.length} جول بماتش واحد` : `${goals.length} goals, one game`,
          meta: ar ? n.labelAr : n.label,
        },
      },
    }],
  };
}

// ─── Picked clips, match highlights and the day's best ───────────────────────

/** A window on a nominee's moment: `leadSec` before it (a dribble or a sprint from its own start). */
export function nomineeWindow(n: Nominee, leadSec: number, lengthMs: number): Window {
  const from = n.source === "dribble" || n.source === "fastest" ? n.fromMs : Math.max(0, n.atMs - Math.round(leadSec * 1000));
  return { recordingId: n.recordingId, fromMs: from, toMs: from + lengthMs };
}

/** The kinds whose clips the owner can pick, and how many each takes. */
export const PICKABLE: Record<string, { min: number; max: number }> = {
  booking_clip: { min: 1, max: 1 },
  versus: { min: 2, max: 2 },
  top5: { min: 5, max: 5 },
  match_highlights: { min: 2, max: 5 },
  day_best: { min: 2, max: 5 },
};

const momentsOfDay = async (venue: Venue, date: string): Promise<RawMoment[]> => {
  const { raw } = await weekMoments(venue, weekStartOf(wallMinutes(`${date} 12:00`)));
  return bestMoments(raw).filter((m) => m.booking.startLocal.slice(0, 10) === date);
};

const momentsOfBooking = async (venue: Venue, booking: VenueBooking): Promise<RawMoment[]> => {
  const { raw } = await weekMoments(venue, weekStartOf(wallMinutes(booking.startLocal)));
  return bestMoments(raw).filter((m) => m.booking.id === booking.id);
};

/**
 * The moments an item may show, best first (what the owner picks from): a booking's own for its
 * clip and its highlights; this week's for "which is nicer?"; last week's for the top 5; the
 * day's for the day's best. Every one is from a booking the field may post.
 */
export async function itemMoments(venue: Venue, item: VenueIgItem, booking: VenueBooking | null, s: IgSlotSettings, now: Date): Promise<RawMoment[]> {
  const slotAt = item.slotAt ?? now;
  switch (item.kind) {
    case "booking_clip":
    case "match_highlights":
      return booking ? momentsOfBooking(venue, booking) : [];
    case "versus": {
      const t = weeklyTimes(s, "versus", nowWall(slotAt));
      return bestMoments((await weekMoments(venue, t.gamesWeek, fromAmmanLocal(wallString(t.gamesUntil!)) ?? slotAt)).raw);
    }
    case "top5": return bestMoments((await weekMoments(venue, weeklyTimes(s, "top5", nowWall(slotAt)).gamesWeek)).raw);
    case "day_best": return momentsOfDay(venue, item.originKey.slice("day:".length));
    default: return [];
  }
}

const montageCustom = (ar: boolean, nominees: Nominee[], meta: (n: Nominee) => string) => {
  const out: Record<string, string> = {};
  nominees.forEach((n, i) => {
    out[`l${i + 1}`] = sourceLabel(n.source, ar);
    out[`m${i + 1}`] = meta(n);
  });
  return out;
};

const montageHeadline = (n: Nominee, ar: boolean) => (n.source === "confirmed_goal" ? (ar ? "جووول!" : "Goal!") : sourceLabel(n.source, ar));

/** One game's highlights: its best moments one after another, the date big and the kick-off under it. */
export async function highlightsDesign(venue: Venue, academy: Academy, booking: VenueBooking, locale: Locale, facts: { date: string; time: string; place: string }, picks: Nominee[] = []): Promise<FieldDesign> {
  let nominees = picks;
  if (nominees.length < 2) {
    const best = pickSpread(await momentsOfBooking(venue, booking), 4, 4);
    if (best.length < 2) return { skip: "Fewer than two moments in this game" };
    // In the order they happened.
    nominees = await Promise.all(best.sort((a, b) => a.t - b.t).map((m) => toNominee(m)));
  }
  nominees = nominees.slice(0, 5);
  const ar = locale === "ar";
  const bits = fieldBits(venue, academy, locale, booking.reference);
  const windows = nominees.map((n) => nomineeWindow(n, 2.6, 4_000));
  return {
    moment: { bookingIds: [booking.id] },
    parts: [{
      templateKey: "field-match-highlights",
      format: "story",
      clips: windows.length,
      title: ar ? `ملخص الماتش · ${booking.reference}` : `Match highlights · ${booking.reference}`,
      windows,
      data: {
        academy: bits.academy,
        match: facts,
        media: recording(windows[0]),
        more: windows.slice(1).map(recording),
        custom: {
          ...bits.custom,
          kicker: ar ? "ملخص الماتش" : "Match highlights",
          title: facts.date,
          meta: [facts.time, facts.place].filter(Boolean).join(" · "),
          headline: montageHeadline(nominees[0], ar),
          ...montageCustom(ar, nominees, () => ""),
        },
      },
    }],
  };
}

/** Yesterday's (or any day's) best clips across its games, best first. */
export async function dayBestDesign(venue: Venue, academy: Academy, date: string, locale: Locale, picks: Nominee[] = []): Promise<FieldDesign> {
  let nominees = picks;
  let games: number;
  if (nominees.length < 2) {
    const moments = await momentsOfDay(venue, date);
    const best = pickSpread(moments, 5, 1);
    if (best.length < 2) return { skip: "Fewer than two moments that day" };
    nominees = await Promise.all(best.map((m) => toNominee(m)));
    games = new Set(moments.map((m) => m.booking.id)).size;
  } else {
    games = new Set(nominees.map((n) => n.bookingId)).size;
  }
  nominees = nominees.slice(0, 5);
  const ar = locale === "ar";
  const bits = fieldBits(venue, academy, locale);
  const windows = nominees.map((n) => nomineeWindow(n, 2.6, 4_000));
  // "Thu 6 Nov · 9:00 PM · Pitch 2" → the time and pitch (the day is the title).
  const where = (n: Nominee) => (ar ? n.labelAr : n.label).split(" · ").slice(1).join(" · ");
  return {
    moment: { bookingIds: [...new Set(nominees.map((n) => n.bookingId))] },
    parts: [{
      templateKey: "field-day-best",
      format: "story",
      clips: windows.length,
      title: ar ? `أحلى لقطات اليوم · ${date}` : `Best of the day · ${date}`,
      windows,
      data: {
        academy: bits.academy,
        media: recording(windows[0]),
        more: windows.slice(1).map(recording),
        custom: {
          ...bits.custom,
          kicker: ar ? "أحلى لقطات اليوم" : "Best of the day",
          title: dayLabel(date, locale),
          meta: ar ? `من ${games} ${games === 1 ? "ماتش" : "ماتشات"}` : `From ${games} ${games === 1 ? "game" : "games"}`,
          headline: montageHeadline(nominees[0], ar),
          ...montageCustom(ar, nominees, where),
        },
      },
    }],
  };
}

// ─── Players who agreed to be shown ──────────────────────────────────────────

/** "Mohammed Ayesh" → "Mohammed A."; initials "MA". Arabic names the same way. */
export function shortName(full: string): { name: string; initials: string } {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { name: "", initials: "" };
  const first = parts[0];
  const last = parts.length > 1 ? parts[parts.length - 1] : "";
  const initial = (w: string) => [...w][0] ?? "";
  return { name: last ? `${first} ${initial(last)}.` : first, initials: `${initial(first)}${last ? initial(last) : ""}`.toUpperCase() };
}

type PlayerTotals = { userId: number; name: string; games: number; goals: number; km: number; shots: number; dribblesWon: number; best: { booking: VenueBooking; atSeconds: number; kmh: number } | null };

/** Claimed players' numbers across bookings, only those who agreed to appear on social media. */
async function shownPlayers(bookings: VenueBooking[]): Promise<PlayerTotals[]> {
  const totals = new Map<number, PlayerTotals>();
  for (const booking of bookings) {
    const found = await bookingLinks(booking);
    if (!found) continue;
    const rows = await db.select({ userId: matchPlayerStatsCacheTable.userId, stats: matchPlayerStatsCacheTable.stats, name: usersTable.name })
      .from(matchPlayerStatsCacheTable)
      .innerJoin(usersTable, eq(usersTable.id, matchPlayerStatsCacheTable.userId))
      .where(and(eq(matchPlayerStatsCacheTable.matchId, found.ctx.room.id), eq(usersTable.socialMediaConsent, true), eq(usersTable.isGuest, false)));
    for (const r of rows) {
      const st = r.stats;
      const t = totals.get(r.userId) ?? { userId: r.userId, name: r.name, games: 0, goals: 0, km: 0, shots: 0, dribblesWon: 0, best: null };
      t.games += 1;
      t.goals += st?.goals ?? 0;
      t.km += st?.distanceKm ?? 0;
      t.shots += st?.shots ?? 0;
      t.dribblesWon += st?.dribblesWon ?? 0;
      const kmh = st?.topSpeedKmh;
      const at = st?.extras?.topSpeedAt;
      if (typeof kmh === "number" && typeof at === "number" && kmh >= AWARDS.fastestMinKmh && kmh <= AWARDS.fastestMaxKmh && (!t.best || kmh > t.best.kmh)) t.best = { booking, atSeconds: at, kmh };
      totals.set(r.userId, t);
    }
  }
  return [...totals.values()].filter((t) => t.name.trim());
}

/** The window around a booking-clock second (the player's fastest run). */
async function bookingSecondWindow(booking: VenueBooking, atSeconds: number): Promise<Window | null> {
  const found = await bookingLinks(booking);
  const link = found?.links.find((l) => atSeconds - l.recordingOffsetSec >= l.fromSeconds && atSeconds - l.recordingOffsetSec <= l.toSeconds);
  if (!link) return null;
  const video = await videoOffset(link.recordingId);
  if (video.tilted) return null;
  const w = windowAround(atSeconds - link.recordingOffsetSec + video.offset, video.duration, 4);
  return { recordingId: link.recordingId, ...w };
}

export async function playerWeekDesign(venue: Venue, academy: Academy, s: IgSlotSettings, slotAt: Date, locale: Locale): Promise<FieldDesign> {
  const t = weeklyTimes(s, "player_week", nowWall(slotAt));
  const bookings = await weekBookings(venue, t.gamesWeek);
  const players = (await shownPlayers(bookings)).filter((p) => p.best);
  const top = players.sort((a, b) => b.goals - a.goals || b.dribblesWon - a.dribblesWon || b.km - a.km)[0];
  if (!top || top.goals + top.dribblesWon === 0) return { skip: "No player who agreed to be shown stood out last week" };
  const w = await bookingSecondWindow(top.best!.booking, top.best!.atSeconds);
  if (!w) return { skip: "No clip of last week's best player" };
  const ar = locale === "ar";
  const bits = fieldBits(venue, academy, locale);
  const who = shortName(top.name);
  const gamesWord = ar ? (top.games === 1 ? "بماتش واحد" : `بـ ${top.games} ماتشات`) : (top.games === 1 ? "in 1 game" : `in ${top.games} games`);
  const headline = top.goals > 0
    ? { stat: top.goals, label: ar ? `أهداف ${gamesWord}` : `${top.goals === 1 ? "goal" : "goals"} ${gamesWord}` }
    : { stat: top.dribblesWon, label: ar ? `مراوغات ${gamesWord}` : `dribbles won ${gamesWord}` };
  return {
    moment: { bookingIds: [top.best!.booking.id], userId: top.userId },
    parts: [{
      templateKey: "field-potw",
      format: "story",
      title: `${ar ? "لاعب الأسبوع" : "Player of the week"} · ${who.name}`,
      windows: [w],
      data: {
        academy: bits.academy,
        media: recording(w),
        custom: {
          ...bits.custom,
          kicker: ar ? "لاعب الأسبوع" : "Player of the week",
          title: who.name,
          initials: who.initials,
          ...countData("stat", headline.stat),
          statLabel: headline.label,
          meta: weekRange(t.gamesWeek, ar),
          s1v: top.km.toFixed(1), s1l: ar ? "كم ركض" : "km run",
          s2v: String(top.dribblesWon), s2l: ar ? "مراوغات" : "Dribbles",
          s3v: String(top.shots), s3l: ar ? "تسديدات" : "Shots",
          s4v: String(top.games), s4l: ar ? "ماتشات" : "Games",
        },
      },
    }],
  };
}

export async function leaderboardDesign(venue: Venue, academy: Academy, month: string, locale: Locale): Promise<FieldDesign> {
  const ar = locale === "ar";
  const first = `${month}-01`;
  const bookings: VenueBooking[] = [];
  // Weeks overlapping the month, then only the month's own bookings.
  for (let w = addDays(first, -6); w <= addDays(first, 31); w = addDays(w, 7)) {
    for (const b of await weekBookings(venue, w)) if (b.startLocal.slice(0, 7) === month && !bookings.some((x) => x.id === b.id)) bookings.push(b);
  }
  const rows = (await shownPlayers(bookings)).filter((p) => p.goals > 0).sort((a, b) => b.goals - a.goals || a.games - b.games).slice(0, 5);
  if (rows.length < 3) return { skip: "Fewer than three scorers who agreed to be shown" };
  const bits = fieldBits(venue, academy, locale);
  const custom: Record<string, string> = {
    ...bits.custom,
    kicker: monthName(month, ar),
    title: ar ? "هدّافين الشهر" : "Top scorers",
    note: ar ? "بس اللاعبين اللي وافقوا يظهر اسمهم" : "Only players who chose to show their name",
  };
  rows.forEach((r, i) => { custom[`r${i + 1}n`] = shortName(r.name).name; custom[`r${i + 1}v`] = String(r.goals); });
  return {
    moment: { userIds: rows.map((r) => r.userId) },
    parts: [{ templateKey: "field-leaderboard", format: "story", title: `${ar ? "هدّافين" : "Top scorers"} · ${month}`, windows: [], data: { academy: bits.academy, custom } }],
  };
}

// ─── Milestones and open slots ───────────────────────────────────────────────

/** Games filmed at the field up to `until`. */
export async function gamesFilmed(venue: Venue, until: Date): Promise<number> {
  const rows = await db.select({ id: venueBookingsTable.id }).from(venueBookingsTable)
    .innerJoin(footageRequestsTable, eq(footageRequestsTable.id, venueBookingsTable.footageRequestId))
    .where(and(
      eq(venueBookingsTable.academyId, venue.id),
      lt(venueBookingsTable.startsAt, until),
      inArray(venueBookingsTable.status, ["confirmed", "completed"]),
      inArray(footageRequestsTable.status, ["ready", "partial"]),
    ));
  return rows.length;
}

export async function milestoneDesign(venue: Venue, academy: Academy, count: number, now: Date, locale: Locale): Promise<FieldDesign> {
  const ar = locale === "ar";
  const bits = fieldBits(venue, academy, locale);
  const name = ar ? venue.nameAr || venue.name : venue.name;
  // Numbers on the pack's own background: no footage, so no one's game is in it.
  return {
    moment: { count, bookingIds: [] },
    parts: [{
      templateKey: "field-milestone",
      format: "story",
      title: ar ? `${count} ماتش متصوّر` : `${count} games filmed`,
      windows: [],
      data: {
        academy: bits.academy,
        custom: {
          ...bits.custom,
          title: ar ? "شكراً إلكم" : "Thank you",
          sub: ar ? `وصلنا لرقم كبير بـ${name}` : `A big one at ${name}`,
          ...countData("big", count),
          bigLabel: ar ? "ماتش متصوّر على أرضنا" : "games filmed on our pitches",
          bigSub: ar ? "وكل واحد إله فيديو" : "and every one has its video",
        },
      },
    }],
  };
}

/** Tonight's free kick-offs: the earliest four, across pitches, from now to closing. */
export async function openSlotsDesign(venue: Venue, academy: Academy, date: string, now: Date, locale: Locale): Promise<FieldDesign> {
  const ar = locale === "ar";
  const pitches = await availability(venue, date);
  const nowLocal = ammanLocal(now);
  const free: Array<{ start: string; pitch: string; minutes: number }> = [];
  for (const p of pitches) {
    for (const slot of p.slots) {
      if (!slot.available || slot.startLocal <= nowLocal) continue;
      const option = slot.options.find((o) => o.available);
      if (!option) continue;
      free.push({ start: slot.startLocal, pitch: (ar ? p.nameAr || p.name : p.name) ?? "", minutes: option.minutes });
    }
  }
  // One row per kick-off time (the first free pitch), on the hour or half hour.
  const rows: typeof free = [];
  for (const f of free.sort((a, b) => a.start.localeCompare(b.start) || a.pitch.localeCompare(b.pitch))) {
    if (rows.length >= 4) break;
    if (!/:(00|30)$/.test(f.start) || rows.some((r) => r.start === f.start)) continue;
    rows.push(f);
  }
  if (!rows.length) return { skip: "Nothing free tonight" };
  const bits = fieldBits(venue, academy, locale);
  const custom: Record<string, string> = {
    ...bits.custom,
    kicker: ar ? "الليلة" : "Tonight",
    title: rows.length === 1 ? (ar ? "في ملعب فاضي" : "A pitch is free tonight") : (ar ? "في ملاعب فاضية" : "Pitches free tonight"),
    sub: ar ? "احجز، والماتش بيتصوّر وبيوصلك فيديو" : "Book now: your game gets filmed",
    free: ar ? "فاضي" : "Free",
  };
  rows.forEach((r, i) => {
    custom[`t${i + 1}`] = timeLabel(r.start.slice(11), locale);
    custom[`p${i + 1}`] = [r.pitch, ar ? `${r.minutes} دقيقة` : `${r.minutes} min`].filter(Boolean).join(" · ");
  });
  return {
    moment: { date, starts: rows.map((r) => r.start) },
    parts: [{ templateKey: "field-open-slots", format: "story", title: `${ar ? "ملاعب فاضية" : "Free tonight"} · ${dayLabel(date, locale)}`, windows: [], data: { academy: bits.academy, custom } }],
  };
}

export { AWARD_ORDER };
