import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, lte, ne, notInArray, or, sql } from "drizzle-orm";
import {
  academiesTable,
  academyCreativeProjectsTable,
  academyMembersTable,
  academySocialPostsTable,
  db,
  footageRequestsTable,
  usersTable,
  venueBookingsTable,
  venueIgAwardsTable,
  venueIgItemsTable,
  venueIgRemovalsTable,
  venuePitchesTable,
  venueSettingsTable,
  type Academy,
  type AcademyCreativeProject,
  type VenueBooking,
  type VenueIgAward,
  type VenueIgItem,
} from "@workspace/db";
import { FIELD_STYLE, awardTitle, buildFieldMontage, buildTemplateScene, resolveSource, sceneSchema, type FieldTemplateKey, type Scene } from "@workspace/api-zod";
import { replacementFor, replacementScenes, withReplacements } from "../creative/myTemplates";
import type { AcademyOwnerAccess } from "../academyOwner";
import { framingFor } from "../creative/framing";
import { ensureReplayMusic, replayLibrary, sceneWithDefaultMusic, templateMusicOverrides } from "../creative/music";
import { ensureCreativeMedia, renderIsDone } from "../creative/publishMedia";
import { queueVideoRender, renderStillNow } from "../creative/renderJobs";
import { deleteOutput } from "../creative/renderStore";
import { logger } from "../logger";
import { getSocialAccount, refreshSocialAccountHealth } from "../social/account";
import { getWhatsappSettings } from "../whatsapp/queue";
import { publicBaseUrl } from "../whatsapp/waha";
import { addDays, ammanLocal, fromAmmanLocal, normaliseHours, wallMinutes, wallString } from "./core";
import { AWARDS, closeVoting, pickSpread, readNominees, toNominee, weekCandidates, type Nominee } from "./igAwards";
import {
  PICKABLE,
  bestGoalsDesign,
  bookingClipDesign,
  dayBestDesign,
  momentDayDesign,
  passWeekDesign,
  sameHourDesign,
  skillWeekDesign,
  soCloseDesign,
  itemExtraClips,
  itemMoments,
  gamesFilmed,
  highlightsDesign,
  leaderboardDesign,
  matchWeekDesign,
  milestoneDesign,
  nomineesDesign,
  openSlotsDesign,
  playerWeekDesign,
  thanksDesign,
  top5Design,
  versusDesign,
  winnerDesign,
  type FieldDesign,
  type FieldPart,
} from "./igFieldPosts";
import { awardCommentVotes, pullOpenVotes } from "./igVotes";
import {
  AWARD_ORDER,
  WEEKLY_KINDS,
  IG_GRACE_MINUTES,
  IG_LEAD_MINUTES,
  IG_BACKFILL_DAYS,
  announcingWeek,
  awardTimes,
  isQuiet,
  boardTimes,
  milestoneCrossed,
  normaliseIgSlots,
  nowWall,
  pacing,
  planSlots,
  slotsFor,
  weeklyTimes,
  type AwardCategory,
  type IgSlotSettings,
} from "./igCalendar";
import { CONSENT_REASON_TEXT, bookingPostable, consentMode, type ConsentRef, type IgConsentMode } from "./igConsent";
import { itemLibraryClips, libraryNominee, unbookedStillPostable } from "./igLibrary";
import { parseLibraryFilters } from "../creative/library";
import { dailyOff } from "./igSuggest";
import { checkInstagram, deleteInstagramMedia, mediaInsights } from "./igGraph";
import { bookingFootage, pickBookingClip } from "./igPick";
import { dayLabel, timeLabel, type Locale } from "./messages";
import { loadVenue, type Venue } from "./store";

/**
 * Field console → Instagram autopilot. Every minute (from the WhatsApp tick):
 *   1. bookings whose footage came back get their clip (igPick.ts) as a calendar item;
 *   2. the planner hands waiting items their slots (igCalendar.ts);
 *   3. items due within a few hours are rendered (Creative hub engine, the field's brand);
 *   4. at its slot an item goes out — if the owner approved it or the field publishes
 *      automatically — through academy_social_posts, after its consent is checked again and
 *      only while Instagram's 24-hour limit has room;
 *   5. weekly awards move on (nominees → voting → winner);
 *   6. numbers come back from Instagram for what went out.
 */

export const IG = {
  /** Render this far ahead of an item's slot. */
  renderAheadHours: 6,
  /** Read a post's numbers back this often while Instagram gives them. */
  insightsEveryHours: 3,
  calendarDays: 14,
  /** Minutes between award stories. */
  nomineeGapMinutes: 30,
} as const;

export type IgFieldSettings = {
  mode: IgConsentMode;
  since: Date | null;
  wording: string | null;
  autopilot: boolean;
  publishMode: "approve" | "auto";
  slots: IgSlotSettings;
};

export function igSettings(venue: Venue): IgFieldSettings {
  const s = venue.settings;
  return {
    mode: consentMode(s.igConsentMode),
    since: s.igConsentSince ?? null,
    wording: s.igConsentWording ?? null,
    autopilot: Boolean(s.igAutopilot),
    publishMode: s.igPublishMode === "auto" ? "auto" : "approve",
    slots: normaliseIgSlots(s.igSlots),
  };
}

const WAITING = ["planned", "approved"] as const;
const LIVE = ["planned", "approved", "rendering", "ready", "publishing"] as const;

const wallOf = (d: Date | null | undefined) => (d ? wallMinutes(ammanLocal(d)) : null);
const dateOfWall = (m: number) => fromAmmanLocal(wallString(m));

async function localeFor(venueId: number): Promise<Locale> {
  const wa = await getWhatsappSettings(venueId).catch(() => null);
  return wa?.locale === "en" ? "en" : "ar";
}

/** The field's owner as the Creative hub engine's access (renders run in his name). */
export async function ownerAccess(venueId: number): Promise<AcademyOwnerAccess | null> {
  const [row] = await db.select({ user: usersTable, academy: academiesTable })
    .from(academyMembersTable)
    .innerJoin(usersTable, eq(usersTable.id, academyMembersTable.userId))
    .innerJoin(academiesTable, eq(academiesTable.id, academyMembersTable.academyId))
    .where(and(eq(academyMembersTable.academyId, venueId), eq(academyMembersTable.role, "owner")))
    .orderBy(asc(academyMembersTable.id)).limit(1);
  return row ? { user: row.user, academyId: venueId, academy: row.academy } : null;
}

async function bookingFor(id: number | null): Promise<VenueBooking | null> {
  if (!id) return null;
  const [b] = await db.select().from(venueBookingsTable).where(eq(venueBookingsTable.id, id));
  return b ?? null;
}

/** Consent for one booking, now (the mode, the booking's answer, under-18, academy footage). */
export async function consentNow(venue: Venue, booking: VenueBooking) {
  const fr = await bookingFootage(booking);
  const s = igSettings(venue);
  return bookingPostable(s.mode, { ...booking, academyFootage: fr?.academyId != null }, { since: s.since, wording: s.wording });
}

// ─── 1. Bookings → items ─────────────────────────────────────────────────────

/** Recent bookings whose footage came back and that have no item yet. */
export async function syncBookingItems(venue: Venue, now = new Date()): Promise<number> {
  // Earlier days' games too: they fill the calendar when there are no fresh ones (planSlots).
  const since = new Date(now.getTime() - IG_BACKFILL_DAYS * 86_400_000);
  const rows = await db.select({ b: venueBookingsTable }).from(venueBookingsTable)
    .innerJoin(footageRequestsTable, eq(footageRequestsTable.id, venueBookingsTable.footageRequestId))
    .where(and(
      eq(venueBookingsTable.academyId, venue.id),
      inArray(venueBookingsTable.status, ["confirmed", "completed"]),
      gte(venueBookingsTable.startsAt, since),
      lt(venueBookingsTable.endsAt, now),
      inArray(footageRequestsTable.status, ["ready", "partial"]),
      isNotNull(footageRequestsTable.videoId),
      sql`not exists (select 1 from ${venueIgItemsTable} i where i.academy_id = ${venue.id} and i.origin_key = 'booking:' || ${venueBookingsTable.id})`,
    )).orderBy(desc(venueBookingsTable.startsAt)).limit(30);
  let made = 0;
  for (const { b } of rows) {
    const consent = await consentNow(venue, b);
    if (!consent.ok) continue; // shown under "Not posted", never made into an item
    const pick = await pickBookingClip(b, now).catch((error) => {
      logger.warn({ bookingId: b.id, error: (error as Error).message }, "Instagram: picking a booking's clip failed");
      return null;
    });
    if (!pick) continue;
    if (!pick.ok) {
      if (pick.wait) continue;
      await db.insert(venueIgItemsTable).values({
        academyId: venue.id, originKey: `booking:${b.id}`, kind: "booking_clip", bookingId: b.id, source: "saved_clip",
        status: "skipped", error: pick.reason, consentMode: consent.mode, consentRef: consent.ref,
      }).onConflictDoNothing();
      continue;
    }
    const p = pick.pick;
    const inserted = await db.insert(venueIgItemsTable).values({
      academyId: venue.id,
      originKey: `booking:${b.id}`,
      kind: "booking_clip",
      placement: "story",
      bookingId: b.id,
      recordingId: p.recordingId,
      clipId: p.clipId,
      source: p.source,
      moment: { recordingId: p.recordingId, fromMs: p.fromMs, toMs: p.toMs, atSeconds: p.atSeconds },
      score: p.score,
      status: "planned",
      consentMode: consent.mode,
      consentRef: consent.ref,
    }).onConflictDoNothing().returning({ id: venueIgItemsTable.id });
    made += inserted.length;
  }
  return made;
}

// ─── 2. The planner ──────────────────────────────────────────────────────────

export async function planVenue(venue: Venue, now = new Date()): Promise<number> {
  const s = igSettings(venue);
  const nowM = nowWall(now);
  // Too old to post: a clip that never went out within IG_BACKFILL_DAYS (its footage is about to go).
  await db.update(venueIgItemsTable).set({ status: "skipped", error: "Too old to post", updatedAt: now }).where(and(
    eq(venueIgItemsTable.academyId, venue.id),
    eq(venueIgItemsTable.kind, "booking_clip"),
    inArray(venueIgItemsTable.status, [...WAITING]),
    or(
      lt(venueIgItemsTable.createdAt, new Date(now.getTime() - IG_BACKFILL_DAYS * 86_400_000)),
      sql`exists (select 1 from ${venueBookingsTable} b where b.id = ${venueIgItemsTable.bookingId} and b.starts_at < ${new Date(now.getTime() - IG_BACKFILL_DAYS * 86_400_000)})`,
    ),
  ));
  // A pinned slot that passed without the owner's OK unpins: the clip rolls on.
  await db.update(venueIgItemsTable).set({ pinned: false, updatedAt: now }).where(and(
    eq(venueIgItemsTable.academyId, venue.id),
    eq(venueIgItemsTable.kind, "booking_clip"),
    eq(venueIgItemsTable.status, "planned"),
    eq(venueIgItemsTable.pinned, true),
    lt(venueIgItemsTable.slotAt, new Date(now.getTime() - IG_GRACE_MINUTES * 60_000)),
  ));
  // Anything else has its own time (an award, a weekly post): a slot that passed without the
  // owner's OK is gone, not rolled.
  await db.update(venueIgItemsTable).set({ status: "skipped", error: "Its time passed without an OK", updatedAt: now }).where(and(
    eq(venueIgItemsTable.academyId, venue.id),
    ne(venueIgItemsTable.kind, "booking_clip"),
    inArray(venueIgItemsTable.status, [...WAITING]),
    lt(venueIgItemsTable.slotAt, new Date(now.getTime() - IG_GRACE_MINUTES * 60_000)),
  ));
  const items = await db.select().from(venueIgItemsTable).where(and(
    eq(venueIgItemsTable.academyId, venue.id),
    inArray(venueIgItemsTable.status, [...LIVE]),
  ));
  const today = ammanLocal(now).slice(0, 10);
  const slots = slotsFor(s.slots, normaliseHours(venue.settings.openingHours), today, IG.calendarDays);
  const bookingIds = [...new Set(items.map((i) => i.bookingId).filter((x): x is number => x !== null))];
  const gameAt = new Map((bookingIds.length
    ? await db.select({ id: venueBookingsTable.id, at: venueBookingsTable.startsAt }).from(venueBookingsTable).where(inArray(venueBookingsTable.id, bookingIds))
    : []).map((r) => [r.id, wallOf(r.at) ?? nowM]));
  // A slot that has just come round for a post that may go out (approved, or the field posts
  // automatically) is held: publishing takes it this minute, the planner must not roll it on.
  const graceFrom = now.getTime() - IG_GRACE_MINUTES * 60_000;
  const due = (i: VenueIgItem) => Boolean(i.slotAt) && i.slotAt!.getTime() <= now.getTime() && i.slotAt!.getTime() >= graceFrom
    && (i.status === "approved" || (s.publishMode === "auto" && i.status === "planned"));
  const planned = planSlots({
    now: nowM,
    slots,
    items: items.map((i) => ({
      id: i.id,
      kind: i.kind,
      status: i.status,
      placement: i.placement as "story" | "reel" | "carousel",
      slotAt: wallOf(i.slotAt),
      pinned: i.pinned || due(i),
      score: i.score,
      readyAt: wallOf(i.createdAt) ?? nowM,
      ...(i.bookingId && gameAt.has(i.bookingId) ? { gameAt: gameAt.get(i.bookingId)! } : {}),
    })),
  });
  let changed = 0;
  for (const item of items) {
    const next = planned.get(item.id);
    if (!next) continue;
    const at = next.slotAt === null ? null : dateOfWall(next.slotAt);
    if ((at?.getTime() ?? null) === (item.slotAt?.getTime() ?? null) && next.placement === item.placement) continue;
    // A clip moving between a Story and a Reel needs its design made again (a Reel has a caption, same picture).
    await db.update(venueIgItemsTable).set({ slotAt: at, placement: next.placement, updatedAt: now }).where(eq(venueIgItemsTable.id, item.id));
    changed += 1;
  }
  return changed;
}

// ─── 3. Rendering ────────────────────────────────────────────────────────────

const HEADLINES: Record<string, { en: string; ar: string }> = {
  confirmed_goal: { en: "Goal!", ar: "جووول" },
  shot: { en: "What a shot", ar: "شو هالتسديدة" },
  dribble: { en: "Skills", ar: "مهارة" },
  saved_clip: { en: "Match highlight", ar: "لقطة الماتش" },
};

async function bookingFacts(b: VenueBooking, locale: Locale) {
  const [pitch] = await db.select({ name: venuePitchesTable.name, nameAr: venuePitchesTable.nameAr }).from(venuePitchesTable).where(eq(venuePitchesTable.id, b.pitchId));
  return {
    date: dayLabel(b.startLocal.slice(0, 10), locale),
    time: timeLabel(b.startLocal.slice(11), locale),
    place: (locale === "ar" ? pitch?.nameAr || pitch?.name : pitch?.name) ?? "",
  };
}

async function awardOf(item: VenueIgItem): Promise<VenueIgAward | null> {
  if (!item.awardId) return null;
  const [award] = await db.select().from(venueIgAwardsTable).where(eq(venueIgAwardsTable.id, item.awardId));
  return award ?? null;
}

/** What an item shows: the field template pack filled from its games (igFieldPosts.ts). */
export async function designFor(venue: Venue, academy: Academy, item: VenueIgItem, locale: Locale, now = new Date()): Promise<FieldDesign> {
  const ar = locale === "ar";
  const slots = igSettings(venue).slots;
  const slotAt = item.slotAt ?? now;
  // The clips the owner picked, in play order (an empty list: the design picks its own).
  const picks = readNominees(item.picks);
  switch (item.kind) {
    case "booking_clip": {
      const b = await bookingFor(item.bookingId);
      if (!b) return { skip: "The booking is gone" };
      return bookingClipDesign(venue, academy, b, item, locale, await bookingFacts(b, locale), HEADLINES[item.source] ?? HEADLINES.saved_clip);
    }
    case "award_nominees": {
      const award = await awardOf(item);
      if (!award) return { skip: "The award is gone" };
      const closeLocal = wallString(awardTimes(slots, award.weekStart).votingEnds);
      const closes = ar
        ? `التصويت لـ${dayLabel(closeLocal.slice(0, 10), "ar")} ${timeLabel(closeLocal.slice(11), "ar")}`
        : `Voting closes ${dayLabel(closeLocal.slice(0, 10), "en")} ${timeLabel(closeLocal.slice(11), "en")}`;
      return nomineesDesign(venue, academy, award, locale, closes);
    }
    case "award_winner": {
      const award = await awardOf(item);
      const winner = readNominees(award?.nominees).find((n) => n.key === award?.winnerKey);
      const b = winner ? await bookingFor(winner.bookingId) : null;
      if (!award || !winner || !b) return { skip: "Its footage is gone" };
      return winnerDesign(venue, academy, award, winner, b, locale, await bookingFacts(b, locale));
    }
    case "versus": return versusDesign(venue, academy, slots, slotAt, locale, picks);
    case "top5": return top5Design(venue, academy, slots, slotAt, locale, picks);
    case "match_highlights": {
      const b = await bookingFor(item.bookingId);
      if (!b) return { skip: "The booking is gone" };
      return highlightsDesign(venue, academy, b, locale, await bookingFacts(b, locale), picks);
    }
    case "day_best": return dayBestDesign(venue, academy, item.originKey.slice("day:".length), locale, picks);
    case "thanks": return thanksDesign(venue, academy, slots, slotAt, locale);
    case "match_week": return matchWeekDesign(venue, academy, slots, slotAt, locale, picks);
    case "moment_day": {
      const d = await momentDayDesign(venue, academy, item.originKey.slice("moment:".length), now, locale, picks);
      // Nothing of any one kind yesterday: the day's best, as before.
      return "skip" in d ? dayBestDesign(venue, academy, addDays(item.originKey.slice("moment:".length), -1), locale) : d;
    }
    case "same_hour": return sameHourDesign(venue, academy, item.originKey.slice("samehour:".length), now, locale, picks);
    case "so_close": return soCloseDesign(venue, academy, slots, slotAt, locale, picks);
    case "pass_week": return passWeekDesign(venue, academy, slots, slotAt, locale, picks, picks.length ? null : await passNominee(venue, item, slots, slotAt));
    case "skill_week": return skillWeekDesign(venue, academy, slots, slotAt, locale, picks);
    case "best_goals": return bestGoalsDesign(venue, academy, slots, slotAt, locale, picks);
    case "player_week": return playerWeekDesign(venue, academy, slots, slotAt, locale);
    case "milestone": return milestoneDesign(venue, academy, Number((item.moment as { count?: number } | null)?.count ?? 0), now, locale);
    case "open_slots": return openSlotsDesign(venue, academy, item.originKey.slice("slots:".length), now, locale);
    case "leaderboard": return leaderboardDesign(venue, academy, item.originKey.slice("board:".length), locale);
    default: return { skip: `Unknown kind ${item.kind}` };
  }
}

/**
 * Pass of the week's clip when the owner picked none: last week's clip cut as a pass (the
 * library's "pass" clips; a player's own cut before Replay's), from games the field may post.
 */
async function passNominee(venue: Venue, item: VenueIgItem, s: IgSlotSettings, slotAt: Date): Promise<Nominee | null> {
  const week = weeklyTimes(s, "pass_week", nowWall(slotAt)).gamesWeek;
  const filters = { ...parseLibraryFilters({}, { limit: 24, maxLimit: 24 }), from: fromAmmanLocal(`${week} 00:00`), until: fromAmmanLocal(`${addDays(week, 7)} 00:00`) };
  for (const origin of ["player", "auto"] as const) {
    const { clips } = await itemLibraryClips(venue, item, { filters, origin, kind: "pass", sort: "newest" });
    for (const c of clips) {
      const n = await libraryNominee(venue, item, c.clipId);
      if (n) return n;
    }
  }
  return null;
}

/**
 * A part's scene in the field style: every clip on it framed by the ball (the 9:16 or 4:5 window
 * follows play across the panorama, or holds the middle), and its music.
 */
async function sceneFor(part: FieldPart, locale: Locale, own: Map<string, Scene> = new Map()): Promise<Scene> {
  // The field's own version of the template (My templates, "use instead"), else the catalogue's.
  // A montage is laid out for its own number of clips, unless the field replaced the template.
  // A library template laid out for this many clips counts as the field's for this post.
  const replaced = replacementFor(own, part.templateKey, part.format, part.clips);
  let scene = sceneSchema.parse(replaced
    ?? (part.clips
      ? buildFieldMontage(part.templateKey as FieldTemplateKey, part.clips, part.format, locale, { bars: part.bars })
      : withReplacements(own, buildTemplateScene)(part.templateKey, FIELD_STYLE, part.format, locale)));
  if (scene.durationMs === undefined) return scene;
  const framed = new Map<string, Promise<Awaited<ReturnType<typeof framingFor>> | null>>();
  const layers = await Promise.all(scene.layers.map(async (l) => {
    if (l.kind !== "video") return l;
    const src = resolveSource(l.src, part.data);
    if (src?.type !== "recording") return l;
    const key = `${src.recordingId}:${src.fromMs}:${src.toMs}`;
    if (!framed.has(key)) framed.set(key, framingFor(src.recordingId, src.fromMs, src.toMs).catch(() => null));
    const answer = await framed.get(key)!;
    return answer ? { ...l, framing: answer.framing } : l;
  }));
  scene = { ...scene, layers } as Scene;
  try {
    await ensureReplayMusic();
    scene = await sceneWithDefaultMusic(scene, part.templateKey, await replayLibrary(), await templateMusicOverrides().catch(() => new Map()));
  } catch {
    // no music: the clip still goes out
  }
  return scene;
}

const projectKey = (itemId: number, part: number) => (part === 0 ? `ig:item:${itemId}` : `ig:item:${itemId}:${part}`);

async function itemProjects(venueId: number, itemId: number): Promise<AcademyCreativeProject[]> {
  const rows = await db.select().from(academyCreativeProjectsTable).where(and(
    eq(academyCreativeProjectsTable.academyId, venueId),
    or(eq(academyCreativeProjectsTable.originKey, projectKey(itemId, 0)), sql`${academyCreativeProjectsTable.originKey} like ${`ig:item:${itemId}:%`}`),
  ));
  const part = (p: AcademyCreativeProject) => Number(p.originKey?.split(":")[3] ?? 0);
  return rows.sort((a, b) => part(a) - part(b));
}

/**
 * The item's design as Creative hub projects (made once: a carousel is one per slide), rendered.
 * Null while there is nothing to render yet (the week's numbers are being counted) or when the
 * item was skipped.
 */
export async function ensureRenderedAll(venue: Venue, item: VenueIgItem, now = new Date()): Promise<AcademyCreativeProject[] | null> {
  const access = await ownerAccess(venue.id);
  if (!access) {
    await db.update(venueIgItemsTable).set({ error: "This field has no owner account to render as", updatedAt: now }).where(eq(venueIgItemsTable.id, item.id));
    return null;
  }
  let projects = await itemProjects(venue.id, item.id);
  if (!projects.length) {
    const locale = await localeFor(venue.id);
    const design = await designFor(venue, access.academy, item, locale, now);
    if ("wait" in design) {
      await db.update(venueIgItemsTable).set({ error: design.wait, updatedAt: now }).where(eq(venueIgItemsTable.id, item.id));
      return null;
    }
    if ("skip" in design) {
      await db.update(venueIgItemsTable).set({ status: "skipped", error: design.skip, updatedAt: now }).where(eq(venueIgItemsTable.id, item.id));
      return null;
    }
    const own = await replacementScenes(venue.id).catch(() => new Map<string, Scene>());
    for (const [i, part] of design.parts.entries()) {
      const scene = await sceneFor(part, locale, own);
      await db.insert(academyCreativeProjectsTable).values({
        academyId: venue.id,
        kind: scene.durationMs !== undefined ? "video" : "image",
        format: part.format,
        title: part.title.slice(0, 120),
        templateKey: part.templateKey,
        style: FIELD_STYLE,
        status: "draft",
        origin: "auto",
        originKey: projectKey(item.id, i),
        scene,
        data: part.data,
        createdBy: access.user.id,
      }).onConflictDoNothing();
    }
    projects = await itemProjects(venue.id, item.id);
    if (!projects.length) return null;
    // Booking clips and winners keep their footage window; the rest keep what they chose (the
    // which-is-nicer pair, the bookings shown) so consent and the vote count read the same thing.
    const keepMoment = item.kind === "booking_clip" || item.kind === "award_winner";
    await db.update(venueIgItemsTable).set({
      projectId: projects[0].id,
      error: null,
      updatedAt: now,
      ...(!keepMoment && design.moment ? { moment: design.moment } : {}),
      ...(!keepMoment && design.parts[0].windows[0] ? { recordingId: design.parts[0].windows[0].recordingId } : {}),
    }).where(eq(venueIgItemsTable.id, item.id));
  }
  const out: AcademyCreativeProject[] = [];
  for (const p of projects) {
    out.push(p.renderStatus === "none" || p.renderStatus === "failed" ? (p.kind === "video" ? await queueVideoRender(access, p) : await renderStillNow(access, p)) : p);
  }
  return out;
}

// ─── 3b. The owner picks the clips ───────────────────────────────────────────

/** Can the owner pick this item's clips, and how many? Null when not (awards are voted, the rest choose their own). */
export function pickRule(item: Pick<VenueIgItem, "kind" | "status">): { min: number; max: number } | null {
  const rule = PICKABLE[item.kind];
  return rule && ["planned", "approved", "skipped", "failed"].includes(item.status) ? rule : null;
}

/**
 * What the owner may pick from for this item, every one from a postable booking: players' own
 * clips first, then the analysis's moments (best first), then moments spread through each game.
 * `empty` says why there is nothing: no game filmed in its time, or none the field may post.
 */
export async function itemPickList(venue: Venue, item: VenueIgItem, now = new Date()): Promise<{ candidates: Nominee[]; empty: "no_games" | "not_allowed" | null }> {
  const booking = await bookingFor(item.bookingId);
  const slots = igSettings(venue).slots;
  const moments = await itemMoments(venue, item, booking, slots, now);
  const extra = await itemExtraClips(venue, item, booking, slots, now);
  const out: Nominee[] = [...extra.saved];
  for (const m of pickSpread(moments, 30, 30)) out.push(await toNominee(m));
  out.push(...extra.footage);
  const seen = new Set<string>();
  const candidates = out.filter((n) => !seen.has(n.key) && seen.add(n.key));
  const empty = candidates.length ? null : extra.filmed > extra.games ? "not_allowed" : "no_games";
  return { candidates, empty };
}

/** The candidates alone (what a pick is checked against). */
export async function itemCandidates(venue: Venue, item: VenueIgItem, now = new Date()): Promise<Nominee[]> {
  return (await itemPickList(venue, item, now)).candidates;
}

/**
 * The owner's clips for an item, in play order: the design is made again from them (its old
 * render is dropped) and rendered straight away, so the calendar shows the new edit. A skipped
 * or failed item comes back. A booking clip takes its one pick as its moment.
 */
export async function setItemPicks(venue: Venue, item: VenueIgItem, picks: Nominee[], now = new Date()): Promise<VenueIgItem> {
  const old = await itemProjects(venue.id, item.id);
  await db.update(venueIgItemsTable).set({
    picks: item.kind === "booking_clip" ? null : picks,
    ...(item.kind === "booking_clip" && picks[0] ? {
      moment: { recordingId: picks[0].recordingId, fromMs: picks[0].fromMs, toMs: picks[0].toMs, atSeconds: picks[0].atSeconds },
      recordingId: picks[0].recordingId,
      clipId: picks[0].clipId ?? null,
      source: picks[0].source,
    } : {}),
    projectId: null,
    error: null,
    ...(item.status === "skipped" || item.status === "failed" ? { status: "planned", pinned: true } : {}),
    updatedAt: now,
  }).where(eq(venueIgItemsTable.id, item.id));
  if (old.length) {
    await db.delete(academyCreativeProjectsTable).where(inArray(academyCreativeProjectsTable.id, old.map((p) => p.id)));
    for (const p of old) if (p.outputPath) void deleteOutput(p.outputPath, venue.id);
  }
  const [row] = await db.select().from(venueIgItemsTable).where(eq(venueIgItemsTable.id, item.id));
  await ensureRendered(venue, row, now).catch((error) => logger.warn({ itemId: item.id, error: (error as Error).message }, "Instagram: re-edit after picks failed"));
  const [after] = await db.select().from(venueIgItemsTable).where(eq(venueIgItemsTable.id, item.id));
  return after;
}

/** The item's first project (a carousel's cover), rendered. */
export async function ensureRendered(venue: Venue, item: VenueIgItem, now = new Date()): Promise<AcademyCreativeProject | null> {
  return (await ensureRenderedAll(venue, item, now))?.[0] ?? null;
}

async function prepareRenders(venue: Venue, now: Date): Promise<number> {
  const soon = new Date(now.getTime() + IG.renderAheadHours * 3_600_000);
  const due = await db.select().from(venueIgItemsTable).where(and(
    eq(venueIgItemsTable.academyId, venue.id),
    inArray(venueIgItemsTable.status, [...WAITING]),
    isNotNull(venueIgItemsTable.slotAt),
    lte(venueIgItemsTable.slotAt, soon),
    isNull(venueIgItemsTable.projectId),
    // Free pitches are read as the story renders: only in its last hour, even if it was added days ago.
    or(ne(venueIgItemsTable.kind, "open_slots"), lte(venueIgItemsTable.slotAt, new Date(now.getTime() + 3_600_000))),
  )).orderBy(asc(venueIgItemsTable.slotAt)).limit(3);
  for (const item of due) await ensureRendered(venue, item, now).catch((error) => logger.warn({ itemId: item.id, error: (error as Error).message }, "Instagram: render failed"));
  return due.length;
}

// ─── 4. Publishing ───────────────────────────────────────────────────────────

/** The bookings an item shows footage from. */
async function bookingsShown(item: VenueIgItem): Promise<number[]> {
  if (item.kind === "booking_clip") return item.bookingId ? [item.bookingId] : [];
  const picked = readNominees(item.picks).map((n) => n.bookingId).filter((id) => id > 0);
  if (item.kind === "match_highlights") return [...new Set([...(item.bookingId ? [item.bookingId] : []), ...picked])];
  if (item.kind === "award_winner" || item.kind === "award_nominees") {
    const award = await awardOf(item);
    const nominees = readNominees(award?.nominees);
    return item.kind === "award_winner" ? nominees.filter((n) => n.key === award?.winnerKey).map((n) => n.bookingId) : nominees.map((n) => n.bookingId);
  }
  const m = (item.moment ?? {}) as { bookingIds?: number[]; choices?: Array<{ bookingId: number }> };
  return [...new Set([...(m.bookingIds ?? []), ...(m.choices ?? []).map((c) => c.bookingId), ...picked])].filter((id) => id > 0);
}

/**
 * Is everything this item shows still postable, right now? Every booking it shows footage from
 * (consent on, nobody under 18, not an academy's), and every player it names still agreeing to be
 * shown. Totals (games, goals, km) and open slots show nobody.
 */
async function consentForItem(venue: Venue, item: VenueIgItem): Promise<{ ok: true; ref: ConsentRef | ConsentRef[]; mode: string } | { ok: false; reason: string }> {
  const refs: ConsentRef[] = [];
  for (const id of await bookingsShown(item)) {
    const b = await bookingFor(id);
    if (!b) return { ok: false, reason: "The booking is gone" };
    const c = await consentNow(venue, b);
    if (!c.ok) return { ok: false, reason: item.kind === "booking_clip" || item.kind === "award_winner" ? CONSENT_REASON_TEXT[c.reason].en : "A booking it shows can't be posted any more" };
    refs.push(c.ref);
  }
  // Picked clips from games with no booking: the field's own consent (owner mode), checked again now.
  const unbooked = readNominees(item.picks).filter((n) => n.unbooked || n.bookingId === 0);
  if (unbooked.length) {
    for (const n of unbooked) {
      if (!(await unbookedStillPostable(venue, n))) return { ok: false, reason: "A clip it shows can't be posted any more" };
    }
    const s = igSettings(venue);
    for (const _ of unbooked) refs.push({ bookingId: 0, mode: "owner", consent: "yes", source: "owner_default", at: null, modeSince: s.since?.toISOString() ?? null, wording: s.wording ?? null });
  }
  const m = (item.moment ?? {}) as { userId?: number; userIds?: number[] };
  const userIds = [...(m.userId ? [m.userId] : []), ...(m.userIds ?? [])];
  if (userIds.length) {
    const agreed = await db.select({ id: usersTable.id }).from(usersTable).where(and(inArray(usersTable.id, userIds), eq(usersTable.socialMediaConsent, true)));
    if (agreed.length !== new Set(userIds).size) return { ok: false, reason: "A player it names no longer agrees to be shown" };
  }
  if ((item.kind === "award_nominees" || item.kind === "versus") && refs.length < 2) return { ok: false, reason: "Fewer than two clips to vote on" };
  const mode = refs[0]?.mode ?? igSettings(venue).mode;
  return { ok: true, ref: refs.length === 1 && (item.kind === "booking_clip" || item.kind === "award_winner") ? refs[0] : refs, mode };
}

function captionFor(venue: Venue, item: VenueIgItem, locale: Locale, title: string, extra: string | null = null): string {
  if (item.placement === "story") return "";
  const ar = locale === "ar";
  const site = `${publicBaseUrl().replace(/^https?:\/\//, "")}/v/${venue.settings.slug}`;
  const tag = `#${(venue.name || "Replay").replace(/[^\p{L}\p{N}]+/gu, "")}`;
  const lines = [title];
  if (extra) lines.push(extra);
  lines.push(ar ? `احجز ملعبك: ${site}` : `Book your pitch: ${site}`);
  lines.push(ar ? `${tag} #ريبلاي` : `${tag} #Replay`);
  return lines.join("\n");
}

/** The voting line under a carousel or a which-is-nicer Reel. */
async function voteLine(venue: Venue, item: VenueIgItem, locale: Locale): Promise<string | null> {
  const ar = locale === "ar";
  if (item.kind === "versus") return ar ? "أي واحد أحلى؟ علّقوا أ أو ب 👇" : "Which one is nicer? Comment A or B 👇";
  if (item.kind !== "award_nominees") return null;
  const award = await awardOf(item);
  if (!award) return null;
  const n = readNominees(award.nominees).slice(0, AWARDS.nomineesPerAward).length;
  const close = wallString(awardTimes(igSettings(venue).slots, award.weekStart).votingEnds);
  const when = `${dayLabel(close.slice(0, 10), locale)} ${timeLabel(close.slice(11), locale)}`;
  return ar
    ? `صوّتوا بالتعليقات: اكتبوا رقم اللقطة اللي عجبتكم (1–${n}). صوت واحد لكل حساب، التصويت لـ${when}.`
    : `Vote in the comments: write the number of your pick (1–${n}). One vote per account, until ${when}.`;
}

async function usedToday(venueId: number, now: Date): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(venueIgItemsTable).where(and(
    eq(venueIgItemsTable.academyId, venueId),
    gte(venueIgItemsTable.publishedAt, new Date(now.getTime() - 86_400_000)),
  ));
  return row?.n ?? 0;
}

export async function publishItem(venue: Venue, item: VenueIgItem, now = new Date()): Promise<VenueIgItem> {
  const set = async (patch: Partial<typeof venueIgItemsTable.$inferInsert>) => {
    const [row] = await db.update(venueIgItemsTable).set({ ...patch, updatedAt: now }).where(eq(venueIgItemsTable.id, item.id)).returning();
    return row;
  };
  const reread = async () => (await db.select().from(venueIgItemsTable).where(eq(venueIgItemsTable.id, item.id)))[0];
  // A booking clip or an award shows known bookings: check them before rendering anything. The
  // rest (a which-is-nicer pair, the week's bookings) are only known once designed.
  if (item.kind === "booking_clip" || item.kind === "award_winner" || item.kind === "award_nominees") {
    const early = await consentForItem(venue, item);
    if (!early.ok) return set({ status: "skipped", error: early.reason });
  }
  const projects = await ensureRenderedAll(venue, item, now);
  if (!projects?.length) return reread();
  const fresh = await reread();
  const consent = await consentForItem(venue, fresh);
  if (!consent.ok) return set({ status: "skipped", error: consent.reason });
  let account = await getSocialAccount(venue.id);
  if (account?.status === "error") {
    account = await refreshSocialAccountHealth(account, "instagram.autopilot.insights");
  }
  const check = await checkInstagram(account);
  if (!check.ok) return set({ ...(check.code === "reconnect" ? { status: "failed" as const } : {}), error: check.error });
  const room = pacing(check.limit?.used ?? (await usedToday(venue.id, now)), check.limit?.total);
  if (room.paused) return set({ error: `Waiting: ${room.used} of ${room.total} Instagram posts used in the last 24 hours` });
  const failed = projects.find((p) => p.renderStatus === "failed");
  if (failed) return set({ error: failed.renderError ?? "The render failed" });
  if (!projects.every(renderIsDone)) return set({ status: item.status, error: null });
  const owner = await ownerAccess(venue.id);
  const media = [];
  for (const p of projects) media.push((await ensureCreativeMedia(p, owner?.user.id ?? 0)).media);
  const locale = await localeFor(venue.id);
  const format = item.placement === "carousel" ? "carousel" : item.placement === "reel" ? "reel" : "story";
  const [post] = await db.insert(academySocialPostsTable).values({
    academyId: venue.id,
    source: "replay",
    targets: ["instagram"],
    format,
    caption: captionFor(venue, fresh, locale, projects[0].title, await voteLine(venue, fresh, locale)),
    media: media.slice(0, 10).map((m) => ({ mediaId: m.id, type: m.kind === "video" ? "video" : "image" })),
    status: "scheduled",
    scheduledFor: now,
    createdBy: owner?.user.id ?? null,
  }).returning();
  return set({ status: "publishing", postId: post.id, error: null, consentMode: consent.mode, consentRef: consent.ref as unknown as Record<string, unknown> });
}

async function publishDue(venue: Venue, now: Date): Promise<number> {
  const s = igSettings(venue);
  const statuses = s.publishMode === "auto" ? [...WAITING] : ["approved"];
  const due = await db.select().from(venueIgItemsTable).where(and(
    eq(venueIgItemsTable.academyId, venue.id),
    inArray(venueIgItemsTable.status, statuses),
    isNotNull(venueIgItemsTable.slotAt),
    lte(venueIgItemsTable.slotAt, now),
    gte(venueIgItemsTable.slotAt, new Date(now.getTime() - IG_GRACE_MINUTES * 60_000)),
  )).orderBy(asc(venueIgItemsTable.slotAt)).limit(3);
  for (const item of due) {
    try {
      await publishItem(venue, item, now);
    } catch (error) {
      logger.warn({ itemId: item.id, error: (error as Error).message }, "Instagram: handing an item to publishing failed");
      await db.update(venueIgItemsTable).set({ error: (error as Error).message.slice(0, 300), updatedAt: now }).where(eq(venueIgItemsTable.id, item.id));
    }
  }
  return due.length;
}

/** Items handed to publishing: follow their post. */
async function followPublishing(venue: Venue, now: Date): Promise<number> {
  const rows = await db.select({ item: venueIgItemsTable, post: academySocialPostsTable }).from(venueIgItemsTable)
    .innerJoin(academySocialPostsTable, eq(academySocialPostsTable.id, venueIgItemsTable.postId))
    .where(and(eq(venueIgItemsTable.academyId, venue.id), eq(venueIgItemsTable.status, "publishing")));
  let n = 0;
  for (const { item, post } of rows) {
    if (post.status === "published" || (post.status === "partial" && post.igMediaId)) {
      await db.update(venueIgItemsTable).set({ status: "published", igMediaId: post.igMediaId, igPermalink: post.igPermalink, publishedAt: post.publishedAt ?? now, error: null, updatedAt: now })
        .where(eq(venueIgItemsTable.id, item.id));
      if (item.kind === "award_winner" && item.awardId) await db.update(venueIgAwardsTable).set({ status: "posted", updatedAt: now }).where(eq(venueIgAwardsTable.id, item.awardId));
      n += 1;
    } else if (post.status === "failed") {
      await db.update(venueIgItemsTable).set({ status: "failed", error: post.error ?? "Instagram refused it", updatedAt: now }).where(eq(venueIgItemsTable.id, item.id));
      n += 1;
    }
  }
  return n;
}

// ─── 5. Awards ───────────────────────────────────────────────────────────────

export async function runAwards(venue: Venue, now = new Date()): Promise<void> {
  const s = igSettings(venue);
  const nowM = nowWall(now);
  const week = announcingWeek(nowM);
  const times = awardTimes(s.slots, week);
  // Nominees are gathered 3 hours before their stories, so the owner has time to look.
  if (nowM >= times.nominees - 180) {
    const existing = await db.select({ id: venueIgAwardsTable.id }).from(venueIgAwardsTable)
      .where(and(eq(venueIgAwardsTable.academyId, venue.id), eq(venueIgAwardsTable.weekStart, week)));
    if (!existing.length) await buildAwards(venue, week, now);
  }
  const awards = await db.select().from(venueIgAwardsTable).where(and(eq(venueIgAwardsTable.academyId, venue.id), gte(venueIgAwardsTable.weekStart, addDays(week, -14))));
  for (const award of awards) {
    const t = awardTimes(s.slots, award.weekStart);
    let current: VenueIgAward = award;
    if (current.status === "voting" && current.votingEndsAt && current.votingEndsAt <= now) {
      const comments = await awardCommentVotes(current, { pull: true }).catch(() => []);
      current = await closeVoting(current, s.slots.minVotes, now, comments);
    }
    if (current.status === "decided") await ensureWinnerItem(venue, current, t.winner + AWARD_ORDER.indexOf(current.category as AwardCategory) * s.slots.winnerGapMinutes, now);
  }
}

async function buildAwards(venue: Venue, week: string, now: Date): Promise<void> {
  const s = igSettings(venue);
  const times = awardTimes(s.slots, week);
  const candidates = await weekCandidates(venue, week);
  let story = 0;
  for (const category of AWARD_ORDER) {
    const nominees = candidates[category];
    const [award] = await db.insert(venueIgAwardsTable).values({
      academyId: venue.id,
      weekStart: week,
      category,
      status: nominees.length ? "voting" : "skipped",
      nominees,
      votingEndsAt: dateOfWall(times.votingEnds),
    }).onConflictDoNothing().returning();
    if (!award || !nominees.length) continue;
    await db.insert(venueIgItemsTable).values({
      academyId: venue.id,
      originKey: `nominees:${award.id}`,
      kind: "award_nominees",
      // A carousel in the feed: a cover then one slide per nominee, voted in its comments.
      placement: "carousel",
      awardId: award.id,
      recordingId: nominees[0].recordingId,
      source: "award",
      score: 0,
      slotAt: dateOfWall(times.nominees + story * IG.nomineeGapMinutes),
      pinned: true,
      status: "planned",
    }).onConflictDoNothing();
    story += 1;
  }
}

async function ensureWinnerItem(venue: Venue, award: VenueIgAward, slotWall: number, now: Date): Promise<void> {
  const winner = readNominees(award.nominees).find((n) => n.key === award.winnerKey);
  if (!winner) return;
  const earliest = nowWall(now) + IG_LEAD_MINUTES;
  await db.insert(venueIgItemsTable).values({
    academyId: venue.id,
    originKey: `winner:${award.id}`,
    kind: "award_winner",
    placement: "reel",
    awardId: award.id,
    bookingId: winner.bookingId,
    recordingId: winner.recordingId,
    source: "award",
    moment: { recordingId: winner.recordingId, fromMs: winner.fromMs, toMs: winner.toMs },
    score: 0,
    slotAt: dateOfWall(Math.max(slotWall, earliest)),
    pinned: true,
    status: "planned",
  }).onConflictDoNothing();
}

/** The owner picks the winner (a thin vote, or he overrides it before it's posted). */
export async function pickWinner(venue: Venue, awardId: number, key: string, userId: number, now = new Date()): Promise<VenueIgAward | null> {
  const [award] = await db.select().from(venueIgAwardsTable).where(and(eq(venueIgAwardsTable.id, awardId), eq(venueIgAwardsTable.academyId, venue.id)));
  if (!award || award.status === "posted" || award.status === "skipped") return null;
  if (!readNominees(award.nominees).some((n) => n.key === key)) return null;
  const [row] = await db.update(venueIgAwardsTable).set({ status: "decided", winnerKey: key, decidedBy: "owner", decidedAt: now, decidedByUser: userId, updatedAt: now })
    .where(eq(venueIgAwardsTable.id, award.id)).returning();
  // A winner item made before (an earlier pick) is made again around the new winner.
  await db.delete(venueIgItemsTable).where(and(eq(venueIgItemsTable.originKey, `winner:${award.id}`), eq(venueIgItemsTable.academyId, venue.id), inArray(venueIgItemsTable.status, [...WAITING])));
  const s = igSettings(venue);
  await ensureWinnerItem(venue, row, awardTimes(s.slots, award.weekStart).winner + AWARD_ORDER.indexOf(award.category as AwardCategory) * s.slots.winnerGapMinutes, now);
  return row;
}

// ─── 5b. Weekly, daily, monthly posts and milestones ─────────────────────────

/** Put an item on the calendar at its own time (once: its origin key is unique per field). */
export async function pinItem(venue: Venue, originKey: string, kind: string, placement: "story" | "reel", at: number, now: Date, moment: Record<string, unknown> | null = null): Promise<boolean> {
  const rows = await db.insert(venueIgItemsTable).values({
    academyId: venue.id,
    originKey,
    kind,
    placement,
    source: "field",
    moment,
    score: 0,
    slotAt: dateOfWall(Math.max(at, nowWall(now) + IG_LEAD_MINUTES)),
    pinned: true,
    status: "planned",
  }).onConflictDoNothing().returning({ id: venueIgItemsTable.id });
  return rows.length > 0;
}

/**
 * The posts that come round on their own: last week's thank-you, top 5, match and player of the
 * week; this week's "which is nicer?"; tonight's open slots; last month's scorers on the 1st; a
 * milestone the field just passed. Each is made a few hours before its time (render ahead), so
 * the owner sees it on the calendar; what it shows is worked out when it renders.
 */
export async function scheduleFieldPosts(venue: Venue, now = new Date()): Promise<number> {
  const s = igSettings(venue).slots;
  const nowM = nowWall(now);
  const ahead = IG.renderAheadHours * 60;
  const inWindow = (at: number) => nowM >= at - ahead && nowM < at + IG_GRACE_MINUTES;
  const off = new Set(s.off);
  let added = 0;
  for (const kind of WEEKLY_KINDS) {
    if (off.has(kind)) continue;
    const t = weeklyTimes(s, kind, nowM);
    if (inWindow(t.at) && await pinItem(venue, `${kind}:${t.gamesWeek}`, kind, "reel", t.at, now)) added += 1;
  }
  if (!off.has("open_slots")) {
    const today = ammanLocal(now).slice(0, 10);
    const at = wallMinutes(`${today} ${s.openSlotsTime}`);
    // Late: what's free is read as it renders, so it is made just an hour before.
    if (nowM >= at - 60 && nowM < at + IG_GRACE_MINUTES && await pinItem(venue, `slots:${today}`, "open_slots", "story", at, now)) added += 1;
  }
  // The moment of the day takes the best of the day's slot while it is on (dailyOff).
  const daily = dailyOff(s);
  if (!daily.has("day_best")) {
    // Yesterday's best clips, at dayBestTime (the key is the games' day).
    const today = ammanLocal(now).slice(0, 10);
    const at = wallMinutes(`${today} ${s.dayBestTime}`);
    if (inWindow(at) && await pinItem(venue, `day:${addDays(today, -1)}`, "day_best", "reel", at, now)) added += 1;
  }
  if (!daily.has("moment_day")) {
    // Yesterday's moment, at dayBestTime; it ends on tonight's free kick-offs, so it is made just an hour before.
    const today = ammanLocal(now).slice(0, 10);
    const at = wallMinutes(`${today} ${s.dayBestTime}`);
    if (nowM >= at - 60 && nowM < at + IG_GRACE_MINUTES && await pinItem(venue, `moment:${today}`, "moment_day", "reel", at, now)) added += 1;
  }
  if (!daily.has("same_hour")) {
    // An afternoon hour still free today, read from the booking grid: made an hour before too.
    const today = ammanLocal(now).slice(0, 10);
    const at = wallMinutes(`${today} ${s.sameHourTime}`);
    if (nowM >= at - 60 && nowM < at + IG_GRACE_MINUTES && await pinItem(venue, `samehour:${today}`, "same_hour", "story", at, now)) added += 1;
  }
  if (!off.has("match_highlights")) added += await scheduleHighlights(venue, s, now);
  if (!off.has("leaderboard")) {
    const b = boardTimes(s, nowM);
    if (inWindow(b.at) && await pinItem(venue, `board:${b.month}`, "leaderboard", "story", b.at, now)) added += 1;
  }
  if (!off.has("milestone")) {
    const [before, current] = await Promise.all([gamesFilmed(venue, new Date(now.getTime() - 14 * 86_400_000)), gamesFilmed(venue, now)]);
    const n = milestoneCrossed(before, current);
    if (n !== null) {
      // The next Reel time with room for it.
      const reel = slotsFor(s, normaliseHours(venue.settings.openingHours), ammanLocal(now).slice(0, 10), 2)
        .find((x) => x.kind === "reel" && x.at >= nowM + IG_LEAD_MINUTES + 60);
      if (reel && await pinItem(venue, `milestone:${n}`, "milestone", "reel", reel.at, now, { count: n })) added += 1;
    }
  }
  return added;
}

/**
 * Match highlights: each Amman day, the games with the best clips (their booking clips' scores:
 * confirmed goals first), up to highlightsPerDay, each a Reel two hours after it ends (not at
 * night: then at the end of the quiet hours). Only games whose booking clip went on the calendar,
 * so consent was already checked; it is checked again at posting.
 */
async function scheduleHighlights(venue: Venue, s: IgSlotSettings, now: Date): Promise<number> {
  const since = new Date(now.getTime() - 2 * 86_400_000);
  const clips = await db.select({ item: venueIgItemsTable, booking: venueBookingsTable }).from(venueIgItemsTable)
    .innerJoin(venueBookingsTable, eq(venueBookingsTable.id, venueIgItemsTable.bookingId))
    .where(and(
      eq(venueIgItemsTable.academyId, venue.id),
      eq(venueIgItemsTable.kind, "booking_clip"),
      notInArray(venueIgItemsTable.status, ["skipped", "failed", "removed", "removal_flagged"]),
      gte(venueBookingsTable.startsAt, since),
      lt(venueBookingsTable.endsAt, now),
    ));
  if (!clips.length) return 0;
  const existing = await db.select({ originKey: venueIgItemsTable.originKey, bookingId: venueIgItemsTable.bookingId }).from(venueIgItemsTable).where(and(
    eq(venueIgItemsTable.academyId, venue.id),
    eq(venueIgItemsTable.kind, "match_highlights"),
    gte(venueIgItemsTable.createdAt, new Date(since.getTime() - 86_400_000)),
  ));
  const have = new Set(existing.map((e) => e.bookingId));
  const perDay = new Map<string, number>();
  for (const c of clips) if (have.has(c.booking.id)) perDay.set(c.booking.startLocal.slice(0, 10), (perDay.get(c.booking.startLocal.slice(0, 10)) ?? 0) + 1);
  const ranked = [...clips].sort((a, b) => b.item.score - a.item.score || b.booking.startsAt.getTime() - a.booking.startsAt.getTime());
  let added = 0;
  for (const { booking } of ranked) {
    if (have.has(booking.id)) continue;
    const day = booking.startLocal.slice(0, 10);
    if ((perDay.get(day) ?? 0) >= s.highlightsPerDay) continue;
    // Still postable now (a player may have asked to take it down since its clip was planned).
    if (!(await consentNow(venue, booking)).ok) continue;
    let at = Math.max(nowWall(now) + IG_LEAD_MINUTES + 30, wallMinutes(ammanLocal(booking.endsAt)) + 120);
    for (let i = 0; i < 24 * 4 && isQuiet(s, at); i += 1) at += 15;
    const rows = await db.insert(venueIgItemsTable).values({
      academyId: venue.id, originKey: `highlights:${booking.id}`, kind: "match_highlights", placement: "reel", bookingId: booking.id,
      source: "field", score: 0, slotAt: dateOfWall(at), pinned: true, status: "planned",
    }).onConflictDoNothing().returning({ id: venueIgItemsTable.id });
    if (rows.length) {
      added += 1;
      perDay.set(day, (perDay.get(day) ?? 0) + 1);
      have.add(booking.id);
    }
  }
  return added;
}

// ─── 6. Numbers ──────────────────────────────────────────────────────────────

async function refreshInsights(venue: Venue, now: Date): Promise<number> {
  const stale = new Date(now.getTime() - IG.insightsEveryHours * 3_600_000);
  const rows = await db.select().from(venueIgItemsTable).where(and(
    eq(venueIgItemsTable.academyId, venue.id),
    eq(venueIgItemsTable.status, "published"),
    isNotNull(venueIgItemsTable.igMediaId),
    gte(venueIgItemsTable.publishedAt, new Date(now.getTime() - 30 * 86_400_000)),
    or(isNull(venueIgItemsTable.insightsAt), lt(venueIgItemsTable.insightsAt, stale)),
  )).limit(5);
  if (!rows.length) return 0;
  const account = await getSocialAccount(venue.id);
  if ((!account?.pageTokenEnc && !account?.tokenEnc) || account.status !== "connected") return 0;
  const { pageToken } = await import("../social/account");
  const token = pageToken(account);
  for (const item of rows) {
    // A Story's numbers exist for 24 hours: keep what was read before, add what's new.
    let reconnectRequired = false;
    const fresh = await mediaInsights(item.igMediaId!, item.placement as "story" | "reel", token).catch(async (error) => {
      const { markSocialReconnect } = await import("../social/account");
      reconnectRequired = await markSocialReconnect(venue.id, error, "instagram.autopilot.media_insights", { optionalRead: true }).catch(() => false);
      return {};
    });
    if (reconnectRequired) return 0;
    const kept = (item.insights ?? {}) as Record<string, number | null>;
    const merged: Record<string, number | null> = { ...kept };
    for (const [k, v] of Object.entries(fresh)) if (v !== null && v !== undefined) merged[k] = v;
    await db.update(venueIgItemsTable).set({ insights: merged, insightsAt: now }).where(eq(venueIgItemsTable.id, item.id));
  }
  return rows.length;
}

// ─── The tick ────────────────────────────────────────────────────────────────

let lastTick = 0;
let running = false;

/** Every venue with the autopilot on and a consent mode other than off. */
export async function runIgAutopilotTick(now = new Date(), opts: { force?: boolean } = {}): Promise<{ venues: number } | "skipped"> {
  if (running || (!opts.force && Date.now() - lastTick < 50_000)) return "skipped";
  running = true;
  lastTick = Date.now();
  try {
    const rows = await db.select({ academyId: venueSettingsTable.academyId }).from(venueSettingsTable)
      .where(and(eq(venueSettingsTable.igAutopilot, true), ne(venueSettingsTable.igConsentMode, "off")));
    for (const { academyId } of rows) {
      const venue = await loadVenue(academyId);
      if (!venue) continue;
      try {
        await syncBookingItems(venue, now);
        await runAwards(venue, now);
        await scheduleFieldPosts(venue, now);
        await planVenue(venue, now);
        await prepareRenders(venue, now);
        await publishDue(venue, now);
        await followPublishing(venue, now);
        await pullOpenVotes(venue.id, now).catch(() => 0);
        await refreshInsights(venue, now);
      } catch (error) {
        logger.warn({ venueId: academyId, error: (error as Error).message }, "Instagram autopilot tick failed");
      }
    }
    // A field whose consent was switched off takes everything waiting back off the calendar.
    await db.update(venueIgItemsTable).set({ status: "skipped", error: "Instagram consent was switched off", updatedAt: now })
      .where(and(inArray(venueIgItemsTable.status, [...WAITING]), sql`${venueIgItemsTable.academyId} in (select academy_id from ${venueSettingsTable} where ig_consent_mode = 'off')`));
    return { venues: rows.length };
  } finally {
    running = false;
  }
}

/** For tests. */
export function resetIgTick(): void {
  lastTick = 0;
  running = false;
}

// ─── Removal (the match page) ────────────────────────────────────────────────

export type RemovalOutcome = { itemId: number | null; outcome: "deleted" | "flagged" | "withdrawn"; error: string | null };

/**
 * A player in the match asked to take it off Instagram. Whatever went out is deleted through
 * the API (or flagged for the owner when Meta refuses, e.g. a Story); whatever was waiting is
 * withdrawn; the booking is marked "no" so nothing from it is posted again, awards included.
 */
export async function removeBookingFromInstagram(venue: Venue, bookingId: number, userId: number, now = new Date()): Promise<RemovalOutcome[]> {
  const out: RemovalOutcome[] = [];
  await db.update(venueBookingsTable).set({ igConsent: "no", igConsentSource: "removal", igConsentAt: now, updatedAt: now })
    .where(and(eq(venueBookingsTable.id, bookingId), eq(venueBookingsTable.academyId, venue.id)));
  // Items showing this booking: its own clip, and award items whose winner or nominees come from it.
  const awards = await db.select().from(venueIgAwardsTable).where(eq(venueIgAwardsTable.academyId, venue.id));
  const awardIds = awards.filter((a) => readNominees(a.nominees).some((n) => n.bookingId === bookingId)).map((a) => a.id);
  const items = await db.select().from(venueIgItemsTable).where(and(
    eq(venueIgItemsTable.academyId, venue.id),
    or(eq(venueIgItemsTable.bookingId, bookingId), awardIds.length ? inArray(venueIgItemsTable.awardId, awardIds) : sql`false`)!,
    notInArray(venueIgItemsTable.status, ["removed", "skipped"]),
  ));
  const account = await getSocialAccount(venue.id);
  for (const item of items) {
    let outcome: RemovalOutcome["outcome"];
    let error: string | null = null;
    if (item.status === "published" && item.igMediaId) {
      const res = account ? await deleteInstagramMedia(account, item.igMediaId) : { ok: false as const, error: "Instagram isn't connected" };
      if (res.ok) {
        outcome = "deleted";
        await db.update(venueIgItemsTable).set({ status: "removed", error: null, updatedAt: now }).where(eq(venueIgItemsTable.id, item.id));
      } else {
        outcome = "flagged";
        error = item.placement === "story" ? `Instagram doesn't let apps delete Stories (${res.error}). It disappears on its own 24 hours after posting.` : res.error;
        await db.update(venueIgItemsTable).set({ status: "removal_flagged", error, updatedAt: now }).where(eq(venueIgItemsTable.id, item.id));
      }
    } else if (item.status === "publishing") {
      // It may already be out: let the owner check rather than guess.
      outcome = "flagged";
      error = "It was going out when removal was asked. Check Instagram and delete it there.";
      await db.update(venueIgItemsTable).set({ status: "removal_flagged", error, updatedAt: now }).where(eq(venueIgItemsTable.id, item.id));
      if (item.postId) await db.delete(academySocialPostsTable).where(and(eq(academySocialPostsTable.id, item.postId), eq(academySocialPostsTable.status, "scheduled")));
    } else {
      outcome = "withdrawn";
      await db.update(venueIgItemsTable).set({ status: "removed", error: null, updatedAt: now }).where(eq(venueIgItemsTable.id, item.id));
    }
    await db.insert(venueIgRemovalsTable).values({ academyId: venue.id, itemId: item.id, bookingId, requestedBy: userId, outcome, error });
    out.push({ itemId: item.id, outcome, error });
  }
  // Take the booking's moments off any award still open.
  for (const award of awards.filter((a) => awardIds.includes(a.id) && a.status !== "posted")) {
    const nominees = readNominees(award.nominees).filter((n) => n.bookingId !== bookingId);
    const winnerGone = award.winnerKey && !nominees.some((n) => n.key === award.winnerKey);
    await db.update(venueIgAwardsTable).set({
      nominees,
      ...(nominees.length === 0 ? { status: "skipped" } : winnerGone ? { status: "owner_pick", winnerKey: null } : {}),
      updatedAt: now,
    }).where(eq(venueIgAwardsTable.id, award.id));
  }
  if (!items.length) {
    await db.insert(venueIgRemovalsTable).values({ academyId: venue.id, bookingId, requestedBy: userId, outcome: "withdrawn", error: null });
    out.push({ itemId: null, outcome: "withdrawn", error: null });
  }
  return out;
}

// ─── Views ───────────────────────────────────────────────────────────────────

export function itemView(i: VenueIgItem, extra: { project?: AcademyCreativeProject | null; booking?: VenueBooking | null; award?: VenueIgAward | null } = {}) {
  const p = extra.project;
  return {
    id: i.id,
    kind: i.kind,
    placement: i.placement,
    source: i.source,
    status: i.status,
    pinned: i.pinned,
    score: i.score,
    slotAt: i.slotAt?.toISOString() ?? null,
    slotLocal: i.slotAt ? ammanLocal(i.slotAt) : null,
    bookingId: i.bookingId,
    reference: extra.booking?.reference ?? null,
    bookingStartLocal: extra.booking?.startLocal ?? null,
    awardId: i.awardId,
    category: extra.award?.category ?? null,
    error: i.error,
    render: p ? { status: p.renderStatus, error: p.renderError, kind: p.kind, outputUrl: p.outputPath ? `/api/academy/console/academies/${i.academyId}/creative/projects/${p.id}/output` : null } : null,
    projectId: i.projectId,
    igPermalink: i.igPermalink,
    publishedAt: i.publishedAt?.toISOString() ?? null,
    consentMode: i.consentMode,
    consentRef: i.consentRef,
    insights: i.insights,
    picks: readNominees(i.picks).map((n) => ({ key: n.key, recordingId: n.recordingId, atMs: n.atMs, source: n.source, label: n.label, labelAr: n.labelAr })),
    thumbnailFrom: readNominees(i.picks)[0]
      ? { recordingId: readNominees(i.picks)[0]!.recordingId, atMs: readNominees(i.picks)[0]!.atMs }
      : typeof (i.moment as { recordingId?: unknown } | null)?.recordingId === "number"
      ? { recordingId: (i.moment as { recordingId: number }).recordingId, atMs: (i.moment as { fromMs: number }).fromMs + 3000 }
      : null,
  };
}
export type IgItemView = ReturnType<typeof itemView>;

/** Recent bookings that will not be posted, and why (the calendar's "Not posted" list). */
export async function notPosted(venue: Venue, now = new Date()) {
  const since = new Date(now.getTime() - 7 * 86_400_000);
  const rows = await db.select().from(venueBookingsTable).where(and(
    eq(venueBookingsTable.academyId, venue.id),
    gte(venueBookingsTable.startsAt, since),
    lt(venueBookingsTable.endsAt, now),
    inArray(venueBookingsTable.status, ["confirmed", "completed"]),
    isNotNull(venueBookingsTable.footageRequestId),
  )).orderBy(desc(venueBookingsTable.startsAt)).limit(60);
  const items = rows.length ? await db.select({ bookingId: venueIgItemsTable.bookingId, status: venueIgItemsTable.status, error: venueIgItemsTable.error }).from(venueIgItemsTable)
    .where(and(eq(venueIgItemsTable.academyId, venue.id), inArray(venueIgItemsTable.bookingId, rows.map((r) => r.id)), eq(venueIgItemsTable.kind, "booking_clip"))) : [];
  const byBooking = new Map(items.map((i) => [i.bookingId, i]));
  const out: Array<{ bookingId: number; reference: string; startLocal: string; reason: string; reasonAr: string }> = [];
  for (const b of rows) {
    const item = byBooking.get(b.id);
    if (item && item.status !== "skipped") continue;
    if (item?.status === "skipped") { out.push({ bookingId: b.id, reference: b.reference, startLocal: b.startLocal, reason: item.error ?? "Skipped", reasonAr: item.error ?? "انشال" }); continue; }
    const c = await consentNow(venue, b);
    if (!c.ok) out.push({ bookingId: b.id, reference: b.reference, startLocal: b.startLocal, reason: CONSENT_REASON_TEXT[c.reason].en, reasonAr: CONSENT_REASON_TEXT[c.reason].ar });
  }
  return out;
}

// ─── Monthly report ──────────────────────────────────────────────────────────

export async function monthlyReport(venue: Venue, month: string) {
  const from = fromAmmanLocal(`${month}-01 00:00`);
  const [y, m] = month.split("-").map(Number);
  const next = `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, "0")}`;
  const to = fromAmmanLocal(`${next}-01 00:00`);
  if (!from || !to) return null;
  const posted = await db.select().from(venueIgItemsTable).where(and(
    eq(venueIgItemsTable.academyId, venue.id),
    inArray(venueIgItemsTable.status, ["published", "removed", "removal_flagged"]),
    isNotNull(venueIgItemsTable.publishedAt),
    gte(venueIgItemsTable.publishedAt, from),
    lt(venueIgItemsTable.publishedAt, to),
  ));
  const type = (i: VenueIgItem) => (i.kind === "booking_clip" ? (i.placement === "reel" ? "reel" : "story") : i.kind === "award_nominees" ? "nominees" : i.kind === "award_winner" ? "award" : "field");
  const byType: Record<string, { posts: number; reach: number | null; views: number | null }> = {
    story: { posts: 0, reach: null, views: null }, reel: { posts: 0, reach: null, views: null }, nominees: { posts: 0, reach: null, views: null }, award: { posts: 0, reach: null, views: null },
    field: { posts: 0, reach: null, views: null },
  };
  const add = (a: number | null, b: unknown) => (typeof b === "number" ? (a ?? 0) + b : a);
  for (const i of posted) {
    const t = byType[type(i)];
    t.posts += 1;
    const ins = (i.insights ?? {}) as Record<string, unknown>;
    t.reach = add(t.reach, ins.reach);
    t.views = add(t.views, ins.views ?? ins.plays);
  }
  const [bookings] = await db.select({
    website: sql<number>`count(*) filter (where ${venueBookingsTable.source} = 'website')::int`,
    whatsapp: sql<number>`count(*) filter (where ${venueBookingsTable.source} = 'whatsapp')::int`,
    console: sql<number>`count(*) filter (where ${venueBookingsTable.source} = 'console')::int`,
  }).from(venueBookingsTable).where(and(
    eq(venueBookingsTable.academyId, venue.id),
    gte(venueBookingsTable.createdAt, from),
    lt(venueBookingsTable.createdAt, to),
    ne(venueBookingsTable.status, "cancelled"),
  ));
  const removals = await db.select().from(venueIgRemovalsTable).where(and(
    eq(venueIgRemovalsTable.academyId, venue.id),
    gte(venueIgRemovalsTable.createdAt, from),
    lt(venueIgRemovalsTable.createdAt, to),
  ));
  const reached = Object.values(byType).some((t) => t.reach !== null || t.views !== null);
  return {
    month,
    posts: { total: posted.length, byType },
    insightsAvailable: reached,
    bookings: { website: bookings?.website ?? 0, whatsapp: bookings?.whatsapp ?? 0, console: bookings?.console ?? 0 },
    removals: {
      total: removals.length,
      deleted: removals.filter((r) => r.outcome === "deleted").length,
      flagged: removals.filter((r) => r.outcome === "flagged").length,
      withdrawn: removals.filter((r) => r.outcome === "withdrawn").length,
    },
  };
}

export { AWARDS };
export type { Nominee };
