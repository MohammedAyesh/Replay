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
import { awardTitle, countData, matchReelBars, matchReelChapters, matchReelStats, siteLine, type CreativeData, type ReelChapter } from "@workspace/api-zod";
import { readClaimSegment } from "../claimMatchStorage";
import { goalVotesFor, reviewedGoalsOf } from "../goalReview";
import { logger } from "../logger";
import { loadRecordingPlay } from "../matchPlayLoad";
import { buildPlayerMetrics } from "../playerMetrics";
import { labToHex } from "../demoShowcase";
import { matchStats } from "../matchFeed";
import { addDays, ammanLocal, fromAmmanLocal, wallString, weekday } from "./core";
import {
  AWARDS,
  bookingLinks,
  pickSpread,
  readNominees,
  toNominee,
  videoOffset,
  labelsFor,
  weekBookings,
  weekMoments,
  type Nominee,
  type RawMoment,
} from "./igAwards";
import { AWARD_ORDER, DAY_MOMENT_ROTATION, nowWall, weekStartOf, weeklyTimes, type AwardCategory, type DayMomentKind, type IgSlotSettings } from "./igCalendar";
import { wallMinutes } from "./core";
import { bookingFootage, bookingRecordings, durationSeconds, inStretch, savedClipsOf, windowAround } from "./igPick";
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
/** One design of a post. `clips`: a montage laid out for that many clips (2–5); `bars`: the Reel's stats bars (side A's share). */
export type FieldPart = { templateKey: string; format: "story" | "post"; title: string; data: CreativeData; windows: Window[]; clips?: number; bars?: number[] };
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
      // Every post ends on it (Mohammed, 2026-11-07): the band and the end card.
      siteLine: siteLine(ar),
    },
  };
}

const SOURCE_LABEL: Record<string, { en: string; ar: string }> = {
  confirmed_goal: { en: "Goal", ar: "جول" },
  dribble: { en: "Dribble", ar: "مراوغة" },
  shot: { en: "Shot", ar: "تسديدة" },
  save: { en: "Save", ar: "تصدّي" },
  fastest: { en: "Top speed", ar: "أسرع ركضة" },
  saved_clip: { en: "Highlight", ar: "لقطة" },
  footage: { en: "Highlight", ar: "لقطة" },
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

/** A shirt colour's plain name (the web app's kitColourKey, read off the side's Lab colour). */
const KIT_NAMES: Record<string, [string, string]> = {
  red: ["Red", "الأحمر"], orange: ["Orange", "البرتقالي"], yellow: ["Yellow", "الأصفر"], green: ["Green", "الأخضر"], teal: ["Teal", "الفيروزي"],
  sky: ["Sky blue", "السماوي"], blue: ["Blue", "الأزرق"], purple: ["Purple", "البنفسجي"], pink: ["Pink", "الزهري"], maroon: ["Maroon", "الخمري"],
  dark: ["Black", "الأسود"], light: ["White", "الأبيض"],
};
export function kitColourKey(hex: string): string {
  const match = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!match) return "dark";
  const [r, g, b] = [match[1], match[2], match[3]].map((x) => parseInt(x, 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  const delta = max - min;
  const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1));
  if (lightness < 0.2) return "dark";
  if (saturation < 0.18) return lightness > 0.6 ? "light" : "dark";
  let hue = max === r ? 60 * (((g - b) / delta) % 6) : max === g ? 60 * ((b - r) / delta + 2) : 60 * ((r - g) / delta + 4);
  if (hue < 0) hue += 360;
  if (hue < 15 || hue >= 345) return lightness < 0.33 ? "maroon" : "red";
  if (hue < 42) return "orange";
  if (hue < 68) return "yellow";
  if (hue < 160) return "green";
  if (hue < 190) return "teal";
  if (hue < 205) return "sky";
  if (hue < 255) return "blue";
  if (hue < 290) return "purple";
  return lightness < 0.33 ? "maroon" : "pink";
}

type StatRows = Array<[number, number] | null>;
const MATCH_CHAPTERS_MAX = 5;

/**
 * A booking's team numbers as the Reel's rows (possession %, shots on target, dribbles won, passes
 * completed), each row only when it is believable: two measured sides, possession adding up to
 * about 100 and neither side under 15 %, counts a 5-a-side hour can reach. The sides' fix
 * (per-game sides) isn't everywhere yet, so a row that fails is left off rather than shown wrong.
 */
export function plausibleStatRows(team: { sides: string[]; measured: boolean[]; possessionPercent: number[]; shots: number[]; dribblesWon: number[]; passesCompleted: number[] } | null): StatRows {
  if (!team || team.sides.length !== 2 || !team.measured.every(Boolean)) return [null, null, null, null];
  const pair = (v: number[] | undefined): [number, number] | null => (v && v.length === 2 && v.every((x) => Number.isFinite(x) && x >= 0) ? [Math.round(v[0]), Math.round(v[1])] : null);
  const pos = pair(team.possessionPercent);
  const possession = pos && Math.abs(pos[0] + pos[1] - 100) <= 3 && Math.min(...pos) >= 15 ? pos : null;
  const counts = (v: number[], max: number, minTotal = 1) => {
    const p = pair(v);
    return p && p[0] + p[1] >= minTotal && Math.max(...p) <= max ? p : null;
  };
  return [possession, counts(team.shots, 30), counts(team.dribblesWon, 60), counts(team.passesCompleted, 400, 10)];
}

const CHAPTER_OF: Partial<Record<Nominee["source"], ReelChapter>> = { confirmed_goal: "goal", dribble: "dribble", save: "save", shot: "close", skill: "dribble" };

/**
 * Match of the week as a showcase of the stats (Mohammed, 2026-11-07): last week's game with the
 * most moments (at least three), opening on its dribbles won or shots on target (the owner's
 * choice, never the goals), then its moments in the order they happened (a goal, a dribble, a
 * save, so close …, up to five), then the match stats when they are believable, then the end card.
 */
export async function matchWeekDesign(venue: Venue, academy: Academy, s: IgSlotSettings, slotAt: Date, locale: Locale, picks: Nominee[] = []): Promise<FieldDesign> {
  const t = weeklyTimes(s, "match_week", nowWall(slotAt));
  const { raw, skills } = await weekMoments(venue, t.gamesWeek);
  const all = [...bestMoments(raw), ...skills.map((m) => ({ ...m, rank: m.rank + 1800 }))];
  const byBooking = new Map<number, RawMoment[]>();
  for (const m of all) byBooking.set(m.booking.id, [...(byBooking.get(m.booking.id) ?? []), m]);
  const goalsOf = (list: RawMoment[]) => list.filter((m) => m.source === "confirmed_goal").length;
  let booking: VenueBooking;
  let nominees: Nominee[];
  let moments: RawMoment[];
  if (picks.length >= 2) {
    // The owner's clips, from one game: that game's numbers.
    nominees = picks.slice(0, MATCH_CHAPTERS_MAX);
    const [b] = await db.select().from(venueBookingsTable).where(eq(venueBookingsTable.id, nominees[0].bookingId));
    if (!b) return { skip: "The picked game's booking is gone" };
    booking = b;
    moments = byBooking.get(b.id) ?? [];
  } else {
    const ranked = [...byBooking.values()].sort((a, b) => b.length - a.length || goalsOf(b) - goalsOf(a) || a[0].booking.startsAt.getTime() - b[0].booking.startsAt.getTime());
    moments = ranked[0] ?? [];
    if (moments.length < 3) return { skip: "No game last week had three moments" };
    booking = moments[0].booking;
    // One of each kind first (goal, dribble, save, so close), then the next best, at most five.
    const chosen: RawMoment[] = [];
    const take = (m: RawMoment | undefined) => {
      if (m && chosen.length < MATCH_CHAPTERS_MAX && !chosen.some((c) => c.link.recordingId === m.link.recordingId && Math.abs(c.t - m.t) < 6)) chosen.push(m);
    };
    const sorted = [...moments].sort((a, b) => b.rank - a.rank);
    for (const src of ["confirmed_goal", "dribble", "save", "shot", "skill"] as const) take(sorted.find((m) => m.source === src));
    for (const m of sorted) take(m);
    nominees = await Promise.all(chosen.sort((a, b) => a.t - b.t).map((m) => toNominee(m)));
    if (nominees.length < 2) return { skip: "No game last week had two separate moments" };
  }
  const a = isAr(locale);
  const found = await bookingLinks(booking);
  // The game minute of each moment (booking seconds: the recording's tracking time plus its offset).
  const offsets = new Map((found?.links ?? []).map((l) => [l.recordingId, l.recordingOffsetSec]));
  const minutes = nominees.map((n) => (n.atSeconds != null && offsets.has(n.recordingId) ? Math.floor((n.atSeconds + offsets.get(n.recordingId)!) / 60) + 1 : null));
  const chapters = nominees.map((n) => CHAPTER_OF[n.source] ?? (n.clipId ? "pass" : "goal"));
  // The stats, only rows that hold up.
  let team: Awaited<ReturnType<typeof matchStats>>["team"] = null;
  if (found) {
    try {
      team = (await matchStats(found.ctx, false)).team;
    } catch (error) {
      logger.warn({ bookingId: booking.id, error: (error as Error).message }, "Match of the week: reading the match stats failed");
    }
  }
  const rows = plausibleStatRows(team);
  const bars = matchReelBars(rows);
  // The opening number: dribbles won or shots on target (from the stats when believable, else the moments found).
  const counted = {
    dribbles: rows[2] ? rows[2][0] + rows[2][1] : moments.filter((m) => m.source === "dribble").length,
    shots: rows[1] ? rows[1][0] + rows[1][1] : moments.filter((m) => m.source === "shot" || m.source === "confirmed_goal").length,
  };
  const headKind = counted[s.matchWeekHeadline] > 0 ? s.matchWeekHeadline : counted.dribbles > 0 ? "dribbles" : counted.shots > 0 ? "shots" : null;
  const head = headKind ? {
    ...countData("head", counted[headKind]),
    headLabel: headKind === "dribbles" ? (a ? "مراوغة ناجحة بالماتش" : "dribbles won in the game") : (a ? "تسديدة على المرمى بالماتش" : "shots on target in the game"),
  } : {};
  const kit = (i: number) => {
    const lab = team?.colours?.[i];
    const name = lab ? KIT_NAMES[kitColourKey(labToHex(lab))] : null;
    return name ? name[a ? 1 : 0] : null;
  };
  let [teamA, teamB] = [kit(0), kit(1)];
  if (!teamA || !teamB || teamA === teamB) [teamA, teamB] = a ? ["الفريق أ", "الفريق ب"] : ["Side A", "Side B"];
  const facts = (await labelsFor(booking));
  const where = a ? facts.labelAr : facts.label;
  const bits = fieldBits(venue, academy, locale);
  const tonight = await freeTimes(venue, ammanLocal(slotAt).slice(0, 10), slotAt, locale);
  const windows = nominees.map((n) => nomineeWindow(n, 2.6, 4_400));
  return {
    moment: { bookingIds: [booking.id], stats: rows },
    parts: [{
      templateKey: "field-match-week-reel",
      format: "story",
      clips: windows.length,
      bars,
      title: a ? `ماتش الأسبوع · ${booking.reference}` : `Match of the week · ${booking.reference}`,
      windows,
      data: {
        academy: bits.academy,
        media: recording(windows[0]),
        more: windows.slice(1).map(recording),
        custom: {
          ...bits.custom,
          ...slotsEnd(tonight, venuePhone(academy), a),
          kicker: a ? "ماتش الأسبوع" : "Match of the week",
          title: a ? "أحلى ماتش على أرضنا" : "Best game on our pitches",
          ...head,
          meta: where,
          ...matchReelChapters(a, chapters, minutes),
          ...(bars.length ? {
            statsMeta: where,
            statsTitle: a ? "أرقام الماتش" : "Match stats",
            teamA, teamB,
            ...matchReelStats(a, rows),
            statsNote: a ? "عدّها Replay من الفيديو · بدون أسماء" : "Counted by Replay from the video · no names",
          } : {}),
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
  moment_day: { min: 1, max: 1 },
  so_close: { min: 1, max: 1 },
  pass_week: { min: 1, max: 1 },
  skill_week: { min: 1, max: 1 },
  same_hour: { min: 1, max: 1 },
  best_goals: { min: 3, max: 3 },
  match_week: { min: 2, max: 5 },
};

const momentsOfDay = async (venue: Venue, date: string): Promise<RawMoment[]> => {
  const { raw } = await weekMoments(venue, weekStartOf(wallMinutes(`${date} 12:00`)));
  return bestMoments(raw).filter((m) => m.booking.startLocal.slice(0, 10) === date);
};

const momentsOfBooking = async (venue: Venue, booking: VenueBooking): Promise<RawMoment[]> => {
  const { raw } = await weekMoments(venue, weekStartOf(wallMinutes(booking.startLocal)));
  return bestMoments(raw).filter((m) => m.booking.id === booking.id);
};

/** Which games an item's clips come from: a games week (up to `until`), narrowed to one booking or one day. */
type ItemScope = { weekStart: string; until?: Date; keep: (b: VenueBooking) => boolean };

function itemScope(item: VenueIgItem, booking: VenueBooking | null, s: IgSlotSettings, now: Date): ItemScope | null {
  const slotAt = item.slotAt ?? now;
  switch (item.kind) {
    case "booking_clip":
    case "match_highlights":
      return booking ? { weekStart: weekStartOf(wallMinutes(booking.startLocal)), keep: (b) => b.id === booking.id } : null;
    case "versus": {
      const t = weeklyTimes(s, "versus", nowWall(slotAt));
      return { weekStart: t.gamesWeek, until: fromAmmanLocal(wallString(t.gamesUntil!)) ?? slotAt, keep: () => true };
    }
    case "top5": return { weekStart: weeklyTimes(s, "top5", nowWall(slotAt)).gamesWeek, keep: () => true };
    case "day_best": {
      const date = item.originKey.slice("day:".length);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
      return { weekStart: weekStartOf(wallMinutes(`${date} 12:00`)), keep: (b) => b.startLocal.slice(0, 10) === date };
    }
    case "moment_day": {
      // Posted on `moment:<date>` about the day before.
      const date = item.originKey.slice("moment:".length);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
      const games = addDays(date, -1);
      return { weekStart: weekStartOf(wallMinutes(`${games} 12:00`)), keep: (b) => b.startLocal.slice(0, 10) === games };
    }
    case "same_hour": {
      // The last seven days' games (the week holding the day before; earlier days of that week too).
      const date = item.originKey.slice("samehour:".length);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
      const from = addDays(date, -7);
      return { weekStart: weekStartOf(wallMinutes(`${addDays(date, -1)} 12:00`)), keep: (b) => b.startLocal.slice(0, 10) >= from && b.startLocal.slice(0, 10) < date };
    }
    case "so_close":
    case "pass_week":
    case "skill_week":
    case "match_week":
      return { weekStart: weeklyTimes(s, item.kind, nowWall(slotAt)).gamesWeek, keep: () => true };
    case "best_goals": {
      const t = weeklyTimes(s, "best_goals", nowWall(slotAt));
      return { weekStart: t.gamesWeek, until: fromAmmanLocal(wallString(t.gamesUntil!)) ?? slotAt, keep: () => true };
    }
    default: return null;
  }
}

/**
 * The moments an item may show, best first (what the owner picks from): a booking's own for its
 * clip and its highlights; this week's for "which is nicer?"; last week's for the top 5; the
 * day's for the day's best. Every one is from a booking the field may post.
 */
export async function itemMoments(venue: Venue, item: VenueIgItem, booking: VenueBooking | null, s: IgSlotSettings, now: Date): Promise<RawMoment[]> {
  const scope = itemScope(item, booking, s, now);
  if (!scope) return [];
  const { raw, skills } = await weekMoments(venue, scope.weekStart, scope.until);
  // A post about one kind offers that kind; the rest offer every kind, skills too.
  const list = item.kind === "skill_week" ? skills : item.kind === "so_close" ? raw.shot : item.kind === "best_goals" ? raw.goal
    : [...bestMoments(raw), ...skills.map((m) => ({ ...m, rank: m.rank + 1800 }))].sort((a, b) => b.rank - a.rank);
  return list.filter((m) => scope.keep(m.booking));
}

/** Frames offered from one game when the owner picks by eye: one every ~5 minutes, 4 to 12. */
export function footageTimes(durationSec: number, count: number): number[] {
  if (!(durationSec > 20) || count < 1) return [];
  return Array.from({ length: count }, (_, i) => Math.round(durationSec * (i + 0.5) / count));
}

const gameMinute = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;

/**
 * Clips beyond the analysis, so the owner can always pick (Mohammed, 2026-11-06: the picker was
 * empty whenever the analysis found nothing, which is exactly when the post had skipped):
 * the players' own clips of each game, then moments spread through each game, chosen by frame.
 * Same games as itemMoments (consent included). `filmed` counts the scope's filmed games whatever
 * their consent, so an empty list can say why.
 */
export async function itemExtraClips(venue: Venue, item: VenueIgItem, booking: VenueBooking | null, s: IgSlotSettings, now: Date): Promise<{ games: number; filmed: number; saved: Nominee[]; footage: Nominee[] }> {
  const scope = itemScope(item, booking, s, now);
  if (!scope) return { games: 0, filmed: 0, saved: [], footage: [] };
  const games = (await weekBookings(venue, scope.weekStart, scope.until)).filter(scope.keep);
  const filmed = games.length ? games.length : (await weekBookings(venue, scope.weekStart, scope.until, { anyConsent: true })).filter(scope.keep).length;
  const saved: Nominee[] = [];
  const footage: Nominee[] = [];
  const perGame = Math.max(4, Math.min(12, Math.floor(48 / Math.max(1, games.length))));
  for (const b of games) {
    const fr = await bookingFootage(b);
    if (!fr) continue;
    const labels = await labelsFor(b);
    const stretches = await bookingRecordings(b, fr);
    const played = stretches.reduce((t, br) => t + (br.toSec - br.fromSec), 0);
    let gameStart = 0;
    for (const br of stretches) {
      for (const c of (await savedClipsOf(fr, br.rec)).filter((w) => inStretch(w, br)).slice(0, 6)) {
        saved.push({ key: `${br.rec.id}:clip:${c.clipId}`, recordingId: br.rec.id, bookingId: b.id, atSeconds: null, fromMs: c.fromMs, toMs: c.toMs, atMs: c.fromMs + 9_000, source: "saved_clip", clipId: c.clipId, ...labels });
      }
      // Moments spread through the game, about one every 5 minutes; the label is the game's own minute.
      const len = br.toSec - br.fromSec;
      const count = Math.max(1, Math.round(Math.min(perGame, Math.max(4, Math.round(played / 300))) * (played > 0 ? len / played : 1)));
      const dur = durationSeconds(br.rec.duration);
      for (const rel of footageTimes(len, count)) {
        const sec = Math.round(br.fromSec + rel);
        const w = windowAround(sec, dur);
        footage.push({
          key: `${br.rec.id}:at:${sec}`, recordingId: br.rec.id, bookingId: b.id, atSeconds: null, ...w, atMs: sec * 1000, source: "footage",
          label: `${labels.label} · ${gameMinute(gameStart + rel)}`, labelAr: `${labels.labelAr} · ${gameMinute(gameStart + rel)}`,
        });
      }
      gameStart += len;
    }
  }
  return { games: games.length, filmed, saved, footage };
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

type FreeTime = { start: string; pitch: string; minutes: number };

/**
 * A day's free kick-offs from now to closing: one per time (the first free pitch), on the hour or
 * half hour, earliest first. `from` ("HH:MM") and `before` narrow it to part of the day.
 */
async function freeTimes(venue: Venue, date: string, now: Date, locale: Locale, opts: { from?: string; before?: string; limit?: number } = {}): Promise<FreeTime[]> {
  const ar = locale === "ar";
  const pitches = await availability(venue, date);
  const nowLocal = ammanLocal(now);
  const free: FreeTime[] = [];
  for (const p of pitches) {
    for (const slot of p.slots) {
      if (!slot.available || slot.startLocal <= nowLocal) continue;
      const hm = slot.startLocal.slice(11, 16);
      if ((opts.from && hm < opts.from) || (opts.before && hm >= opts.before)) continue;
      const option = slot.options.find((o) => o.available);
      if (!option) continue;
      free.push({ start: slot.startLocal, pitch: (ar ? p.nameAr || p.name : p.name) ?? "", minutes: option.minutes });
    }
  }
  const rows: FreeTime[] = [];
  for (const f of free.sort((a, b) => a.start.localeCompare(b.start) || a.pitch.localeCompare(b.pitch))) {
    if (rows.length >= (opts.limit ?? 3)) break;
    if (!/:(00|30)$/.test(f.start) || rows.some((r) => r.start === f.start)) continue;
    rows.push(f);
  }
  return rows;
}

/** "8:00 · 10:00 · 11:00": kick-offs on an end card, the hour only (the line says tonight or today). */
const clockOnly = (start: string) => {
  const [h, m] = start.slice(11, 16).split(":").map(Number);
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")}`;
};

/** The end card listing free kick-offs instead of the phone number (the phone goes under them). */
function slotsEnd(rows: FreeTime[], phone: string, ar: boolean, today = false): Record<string, string> {
  if (!rows.length) return {};
  return {
    endLine: ar ? (today ? "فاضي اليوم، الساعة" : "فاضي الليلة، الساعة") : (today ? "Free today at" : "Free tonight at"),
    endBig: rows.map((r) => clockOnly(r.start)).join(" · "),
    endSmall: phone ? (ar ? `احجز: \u2066${phone}\u2069` : `Book: ${phone}`) : (ar ? "احجز من الرابط" : "Book from the link"),
  };
}

/** Tonight's free kick-offs: the earliest three, across pitches, from now to closing. */
export async function openSlotsDesign(venue: Venue, academy: Academy, date: string, now: Date, locale: Locale): Promise<FieldDesign> {
  const ar = locale === "ar";
  const rows = await freeTimes(venue, date, now, locale);
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

// ─── One moment: of the day, so close, pass, skill, same hour ────────────────

const nomineeWin = (n: Nominee): Window => ({ recordingId: n.recordingId, fromMs: n.fromMs, toMs: n.toMs });
const label = (n: Nominee, ar: boolean) => (ar ? n.labelAr : n.label);

/** One moment on the award-style template (opening card, the clip, the end card). */
function momentPart(venue: Venue, academy: Academy, locale: Locale, templateKey: string, title: string, n: Nominee, words: Record<string, string>): FieldDesign {
  const bits = fieldBits(venue, academy, locale);
  const w = nomineeWin(n);
  return {
    moment: { bookingIds: n.bookingId ? [n.bookingId] : [], key: n.key },
    parts: [{
      templateKey,
      format: "story",
      title,
      windows: [w],
      data: { academy: bits.academy, media: recording(w), custom: { ...bits.custom, meta: label(n, isAr(locale)), ...words } },
    }],
  };
}
const isAr = (locale: Locale) => locale === "ar";

const DAY_WORDS: Record<DayMomentKind | "shot", { kicker: [string, string]; title: [string, string] }> = {
  goal: { kicker: ["Yesterday's best goal", "أحلى جول مبارح"], title: ["Goal of the day", "جول اليوم"] },
  dribble: { kicker: ["Yesterday's best dribble", "أحلى مراوغة مبارح"], title: ["Dribble of the day", "مراوغة اليوم"] },
  skill: { kicker: ["Yesterday's best skill", "أحلى حركة مبارح"], title: ["Skill of the day", "حركة اليوم"] },
  save: { kicker: ["Yesterday's best save", "أحلى تصدّي مبارح"], title: ["Save of the day", "تصدّي اليوم"] },
  shot: { kicker: ["Yesterday's best shot", "أحلى تسديدة مبارح"], title: ["Shot of the day", "تسديدة اليوم"] },
};
const kindOfSource = (source: Nominee["source"]): DayMomentKind | "shot" =>
  source === "confirmed_goal" ? "goal" : source === "dribble" ? "dribble" : source === "skill" ? "skill" : source === "save" ? "save" : "shot";

/** A day's moments by kind: confirmed goals, dribbles won, approved saves and skills, shots on target. */
async function dayMoments(venue: Venue, gamesDay: string): Promise<Record<DayMomentKind | "shot", RawMoment[]>> {
  const { raw, skills } = await weekMoments(venue, weekStartOf(wallMinutes(`${gamesDay} 12:00`)));
  const on = (list: RawMoment[]) => list.filter((m) => m.booking.startLocal.slice(0, 10) === gamesDay);
  return { goal: on(raw.goal), dribble: on(raw.dribble), save: on(raw.save), skill: on(skills), shot: on(raw.shot) };
}

/**
 * The moment of the day (Mohammed, 2026-11-07): yesterday's best of one kind, by the post's
 * weekday (goal, dribble, skill, goal, save, goal, dribble from Sunday); when that kind has none,
 * a goal, a dribble, a save, a skill, a shot. The end card lists tonight's free kick-offs.
 */
export async function momentDayDesign(venue: Venue, academy: Academy, date: string, now: Date, locale: Locale, picks: Nominee[] = []): Promise<FieldDesign> {
  const gamesDay = addDays(date, -1);
  const want = DAY_MOMENT_ROTATION[weekday(date)];
  let n: Nominee | null = picks[0] ?? null;
  let kind: DayMomentKind | "shot" = n ? kindOfSource(n.source) : want;
  if (!n) {
    const byKind = await dayMoments(venue, gamesDay);
    const order = [...new Set<DayMomentKind | "shot">([want, "goal", "dribble", "save", "skill", "shot"])];
    const found = order.find((k) => byKind[k].length > 0);
    if (!found) return { skip: "No moments yesterday" };
    kind = found;
    n = await toNominee(pickSpread(byKind[found], 1, 1)[0]);
  }
  const a = isAr(locale);
  const w = DAY_WORDS[kind];
  const tonight = await freeTimes(venue, date, now, locale, { from: "17:00" });
  const design = momentPart(venue, academy, locale, "field-day-moment", `${a ? w.title[1] : w.title[0]} · ${gamesDay}`, n, {
    kicker: a ? w.kicker[1] : w.kicker[0],
    title: a ? w.title[1] : w.title[0],
    ...slotsEnd(tonight, venuePhone(academy), a),
  });
  if ("parts" in design) design.moment = { ...design.moment, kind, gamesDay };
  return design;
}

/** So close of the week: last week's shot on target that wasn't a goal (the owner can pick another). */
export async function soCloseDesign(venue: Venue, academy: Academy, s: IgSlotSettings, slotAt: Date, locale: Locale, picks: Nominee[] = []): Promise<FieldDesign> {
  const t = weeklyTimes(s, "so_close", nowWall(slotAt));
  let n = picks[0] ?? null;
  if (!n) {
    const { raw } = await weekMoments(venue, t.gamesWeek);
    const [best] = pickSpread(raw.shot, 1, 1);
    if (!best) return { skip: "No shot on target that wasn't a goal last week" };
    n = await toNominee(best);
  }
  const a = isAr(locale);
  return momentPart(venue, academy, locale, "field-so-close", `${a ? "كانت رح تفوت" : "So close"} · ${t.gamesWeek}`, n, {
    kicker: a ? "أقرب فرصة الأسبوع الماضي" : "Last week's closest call",
    title: a ? "كانت رح تفوت!" : "So close!",
  });
}

/**
 * Pass of the week: the analysis doesn't pick passes out, so it is a clip someone cut as a pass
 * (the library's "pass" clips, last week's games: `nominee`) or the owner's pick.
 */
export function passWeekDesign(venue: Venue, academy: Academy, s: IgSlotSettings, slotAt: Date, locale: Locale, picks: Nominee[] = [], nominee: Nominee | null = null): FieldDesign {
  const t = weeklyTimes(s, "pass_week", nowWall(slotAt));
  const n = picks[0] ?? nominee;
  if (!n) return { skip: "No pass clip from last week's games: pick one" };
  const a = isAr(locale);
  return momentPart(venue, academy, locale, "field-pass-week", `${a ? "تمريرة الأسبوع" : "Pass of the week"} · ${t.gamesWeek}`, n, {
    kicker: a ? "لقاها زميله من بعيد" : "Found from far away",
    title: a ? "تمريرة الأسبوع" : "Pass of the week",
  });
}

/** Skill of the week: last week's approved skill nominations (players nominate, the owner approves). */
export async function skillWeekDesign(venue: Venue, academy: Academy, s: IgSlotSettings, slotAt: Date, locale: Locale, picks: Nominee[] = []): Promise<FieldDesign> {
  const t = weeklyTimes(s, "skill_week", nowWall(slotAt));
  let n = picks[0] ?? null;
  if (!n) {
    const { skills } = await weekMoments(venue, t.gamesWeek);
    const [best] = pickSpread(skills, 1, 1);
    if (!best) return { skip: "No skill was nominated and approved last week" };
    n = await toNominee(best);
  }
  const a = isAr(locale);
  return momentPart(venue, academy, locale, "field-skill-week", `${a ? "حركة الأسبوع" : "Skill of the week"} · ${t.gamesWeek}`, n, {
    kicker: a ? "أحلى حركة الأسبوع الماضي" : "Last week's best skill",
    title: a ? "حركة الأسبوع" : "Skill of the week",
  });
}

/**
 * Same hour, free today: an afternoon kick-off still free today, over a moment from a game played
 * around that hour in the last seven days (within an hour of it). The end card lists today's free
 * afternoon times.
 */
export async function sameHourDesign(venue: Venue, academy: Academy, date: string, now: Date, locale: Locale, picks: Nominee[] = []): Promise<FieldDesign> {
  const a = isAr(locale);
  const free = await freeTimes(venue, date, now, locale, { from: "12:00", before: "18:00", limit: 6 });
  if (!free.length) return { skip: "Nothing free this afternoon" };
  const minuteOf = (local: string) => Number(local.slice(11, 13)) * 60 + Number(local.slice(14, 16));
  let slot = free[0];
  let n: Nominee | null = picks[0] ?? null;
  let when = "";
  if (!n) {
    const from = addDays(date, -7);
    const weeks = [...new Set([weekStartOf(wallMinutes(`${from} 12:00`)), weekStartOf(wallMinutes(`${addDays(date, -1)} 12:00`))])];
    const moments: RawMoment[] = [];
    for (const w of weeks) {
      const { raw, skills } = await weekMoments(venue, w);
      moments.push(...bestMoments(raw), ...skills.map((m) => ({ ...m, rank: m.rank + 1800 })));
    }
    const recent = moments.filter((m) => { const d = m.booking.startLocal.slice(0, 10); return d >= from && d < date; });
    let found: RawMoment | null = null;
    for (const f of free) {
      const near = recent.filter((m) => Math.abs(minuteOf(m.booking.startLocal) - minuteOf(f.start)) <= 60);
      const [best] = pickSpread(near, 1, 1);
      if (best) { slot = f; found = best; break; }
    }
    if (!found) return { skip: "No moment from a game around a free afternoon hour this week" };
    n = await toNominee(found);
    when = `${dayLabel(found.booking.startLocal.slice(0, 10), locale)} · ${timeLabel(found.booking.startLocal.slice(11, 16), locale)}`;
  } else {
    // The pick's own day and time (its label: "Thu 6 Nov · 9:00 pm · Pitch 2"), the hour nearest it.
    when = label(n, a).split(" · ").slice(0, 2).join(" · ");
  }
  const design = momentPart(venue, academy, locale, "field-same-hour", `${a ? "نفس الساعة" : "Same hour"} · ${date}`, n, {
    kicker: when,
    title: a ? "نفس الساعة، فاضية اليوم" : "Same hour, free today",
    ...slotsEnd(free.filter((f) => f.start >= slot.start).slice(0, 3), venuePhone(academy), a, true),
  });
  if ("parts" in design) {
    design.parts[0].data.custom = { ...design.parts[0].data.custom, meta: [a ? `اليوم ${timeLabel(slot.start.slice(11), locale)}` : `Today ${timeLabel(slot.start.slice(11), locale)}`, slot.pitch].filter(Boolean).join(" · ") };
    design.moment = { ...design.moment, date, start: slot.start };
  }
  return design;
}

// ─── Best goals of the week ──────────────────────────────────────────────────

/** This week's three best confirmed goals so far, counted down (#1 is data.media). */
export async function bestGoalsDesign(venue: Venue, academy: Academy, s: IgSlotSettings, slotAt: Date, locale: Locale, picks: Nominee[] = []): Promise<FieldDesign> {
  const t = weeklyTimes(s, "best_goals", nowWall(slotAt));
  let nominees: Nominee[];
  if (picks.length >= 3) {
    nominees = picks.slice(0, 3);
  } else {
    const until = fromAmmanLocal(wallString(t.gamesUntil!)) ?? slotAt;
    const { raw } = await weekMoments(venue, t.gamesWeek, until);
    const three = pickSpread(raw.goal, 3, 2);
    if (three.length < 3) return { skip: "Fewer than three confirmed goals this week" };
    nominees = await Promise.all(three.map((m) => toNominee(m)));
  }
  const a = isAr(locale);
  const windows = nominees.map((n) => nomineeWindow(n, 2.4, 6_000));
  const bits = fieldBits(venue, academy, locale);
  const custom: Record<string, string> = { ...bits.custom, kicker: a ? "هالأسبوع على أرضنا" : "This week on our pitches", title: a ? "أحلى 3 أجوال" : "Top 3 goals" };
  nominees.forEach((n, i) => {
    custom[`l${i + 1}`] = i === 0 ? (a ? "جول الأسبوع" : "Goal of the week") : sourceLabel(n.source, a);
    custom[`m${i + 1}`] = label(n, a);
  });
  return {
    moment: { bookingIds: [...new Set(nominees.map((n) => n.bookingId))] },
    parts: [{
      templateKey: "field-best-goals",
      format: "story",
      title: a ? `أحلى 3 أجوال · ${t.gamesWeek}` : `Top 3 goals · ${t.gamesWeek}`,
      windows,
      data: { academy: bits.academy, media: recording(windows[0]), more: windows.slice(1).map(recording), custom },
    }],
  };
}

export { AWARD_ORDER };
