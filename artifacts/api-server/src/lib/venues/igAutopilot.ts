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
  type AcademyCreativeProject,
  type VenueBooking,
  type VenueIgAward,
  type VenueIgItem,
} from "@workspace/db";
import { awardTemplateKey, awardTitle, buildTemplateScene, sceneSchema, type CreativeData, type Scene } from "@workspace/api-zod";
import type { AcademyOwnerAccess } from "../academyOwner";
import { framingFor } from "../creative/framing";
import { ensureReplayMusic, replayLibrary, sceneWithDefaultMusic, templateMusicOverrides } from "../creative/music";
import { styleFor } from "../creative/autoDrafts";
import { ensureCreativeMedia, renderIsDone } from "../creative/publishMedia";
import { queueVideoRender, renderStillNow } from "../creative/renderJobs";
import { logger } from "../logger";
import { getSocialAccount } from "../social/account";
import { getWhatsappSettings } from "../whatsapp/queue";
import { publicBaseUrl } from "../whatsapp/waha";
import { addDays, ammanLocal, fromAmmanLocal, normaliseHours, wallMinutes, wallString } from "./core";
import { AWARDS, closeVoting, readNominees, weekCandidates, type Nominee } from "./igAwards";
import {
  AWARD_ORDER,
  IG_GRACE_MINUTES,
  IG_LEAD_MINUTES,
  IG_MAX_AGE_HOURS,
  announcingWeek,
  awardTimes,
  normaliseIgSlots,
  nowWall,
  pacing,
  planSlots,
  slotsFor,
  type AwardCategory,
  type IgSlotSettings,
} from "./igCalendar";
import { CONSENT_REASON_TEXT, bookingPostable, consentMode, type ConsentRef, type IgConsentMode } from "./igConsent";
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
  const since = new Date(now.getTime() - IG_MAX_AGE_HOURS * 3_600_000);
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
    )).limit(30);
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
  // Too old to post: a clip that never went out within IG_MAX_AGE_HOURS of its game.
  await db.update(venueIgItemsTable).set({ status: "skipped", error: "Too old to post", updatedAt: now }).where(and(
    eq(venueIgItemsTable.academyId, venue.id),
    eq(venueIgItemsTable.kind, "booking_clip"),
    inArray(venueIgItemsTable.status, [...WAITING]),
    lt(venueIgItemsTable.createdAt, new Date(now.getTime() - IG_MAX_AGE_HOURS * 3_600_000)),
  ));
  // A pinned slot that passed without the owner's OK unpins: the clip rolls on.
  await db.update(venueIgItemsTable).set({ pinned: false, updatedAt: now }).where(and(
    eq(venueIgItemsTable.academyId, venue.id),
    eq(venueIgItemsTable.kind, "booking_clip"),
    eq(venueIgItemsTable.status, "planned"),
    eq(venueIgItemsTable.pinned, true),
    lt(venueIgItemsTable.slotAt, new Date(now.getTime() - IG_GRACE_MINUTES * 60_000)),
  ));
  const items = await db.select().from(venueIgItemsTable).where(and(
    eq(venueIgItemsTable.academyId, venue.id),
    inArray(venueIgItemsTable.status, [...LIVE]),
  ));
  const today = ammanLocal(now).slice(0, 10);
  const slots = slotsFor(s.slots, normaliseHours(venue.settings.openingHours), today, IG.calendarDays);
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
      kind: i.kind as "booking_clip",
      status: i.status,
      placement: i.placement as "story" | "reel",
      slotAt: wallOf(i.slotAt),
      pinned: i.pinned || due(i),
      score: i.score,
      readyAt: wallOf(i.createdAt) ?? nowM,
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

const endLine = (reference: string, locale: Locale) => (locale === "ar" ? `حجز ${reference}` : `Booking ${reference}`);

type Design = { templateKey: string; title: string; data: CreativeData; window: { recordingId: number; fromMs: number; toMs: number } | null };

async function designFor(venue: Venue, item: VenueIgItem, locale: Locale): Promise<Design | null> {
  const ar = locale === "ar";
  const venueName = ar ? venue.nameAr || venue.name : venue.name;
  if (item.kind === "booking_clip") {
    const b = await bookingFor(item.bookingId);
    const m = item.moment as { recordingId: number; fromMs: number; toMs: number } | null;
    if (!b || !m) return null;
    const head = HEADLINES[item.source] ?? HEADLINES.saved_clip;
    return {
      templateKey: "ig-booking-clip",
      title: `${ar ? head.ar : head.en} · ${b.reference}`,
      window: { recordingId: m.recordingId, fromMs: m.fromMs, toMs: m.toMs },
      data: {
        match: await bookingFacts(b, locale),
        media: { type: "recording", recordingId: m.recordingId, fromMs: m.fromMs, toMs: m.toMs },
        custom: { kicker: ar ? `من ملاعب ${venueName}` : `On the pitch at ${venueName}`, headline: ar ? head.ar : head.en, endLine: endLine(b.reference, locale) },
      },
    };
  }
  const [award] = item.awardId ? await db.select().from(venueIgAwardsTable).where(eq(venueIgAwardsTable.id, item.awardId)) : [];
  if (!award) return null;
  const nominees = readNominees(award.nominees);
  if (item.kind === "award_nominees") {
    const first = nominees[0];
    if (!first) return null;
    const s = igSettings(venue).slots;
    const closes = awardTimes(s, award.weekStart).votingEnds;
    const closeLocal = wallString(closes);
    return {
      templateKey: "ig-award-nominees",
      title: `${awardTitle(award.category, ar)} · ${award.weekStart}`,
      window: null,
      data: {
        media: { type: "frame", recordingId: first.recordingId, atMs: first.atMs },
        custom: {
          award: awardTitle(award.category, ar),
          nominees: nominees.map((n) => (ar ? n.labelAr : n.label)).join(" | ").slice(0, 160),
          closes: ar ? `التصويت لـ${dayLabel(closeLocal.slice(0, 10), "ar")} ${timeLabel(closeLocal.slice(11), "ar")}` : `Voting closes ${dayLabel(closeLocal.slice(0, 10), "en")} ${timeLabel(closeLocal.slice(11), "en")}`,
          count: ar ? `${nominees.length} مرشحين` : `${nominees.length} nominees`,
        },
      },
    };
  }
  const winner = nominees.find((n) => n.key === award.winnerKey);
  if (!winner) return null;
  const b = await bookingFor(winner.bookingId);
  if (!b) return null;
  return {
    templateKey: awardTemplateKey(award.category),
    title: `${awardTitle(award.category, ar)} · ${award.weekStart}`,
    window: { recordingId: winner.recordingId, fromMs: winner.fromMs, toMs: winner.toMs },
    data: {
      match: await bookingFacts(b, locale),
      media: { type: "recording", recordingId: winner.recordingId, fromMs: winner.fromMs, toMs: winner.toMs },
      custom: { speed: winner.value != null ? `${winner.value.toFixed(1)} ${locale === "ar" ? "كم/س" : "km/h"}` : "", endLine: endLine(b.reference, locale) },
    },
  };
}

async function sceneFor(templateKey: string, style: Awaited<ReturnType<typeof styleFor>>, locale: Locale, window: Design["window"]): Promise<Scene> {
  let scene = sceneSchema.parse(buildTemplateScene(templateKey, style, "story", locale));
  if (window) {
    // The 9:16 camera follows the ball across the panorama (or holds the middle).
    const answer = await framingFor(window.recordingId, window.fromMs, window.toMs).catch(() => null);
    if (answer) scene = { ...scene, layers: scene.layers.map((l) => (l.kind === "video" && l.id === "video" ? { ...l, framing: answer.framing } : l)) } as Scene;
    try {
      await ensureReplayMusic();
      scene = await sceneWithDefaultMusic(scene, templateKey, await replayLibrary(), await templateMusicOverrides().catch(() => new Map()));
    } catch {
      // no music: the clip still goes out
    }
  }
  return scene;
}

/** The item's design as a Creative hub project (made once), rendered. */
export async function ensureRendered(venue: Venue, item: VenueIgItem, now = new Date()): Promise<AcademyCreativeProject | null> {
  const access = await ownerAccess(venue.id);
  if (!access) {
    await db.update(venueIgItemsTable).set({ error: "This field has no owner account to render as", updatedAt: now }).where(eq(venueIgItemsTable.id, item.id));
    return null;
  }
  let project: AcademyCreativeProject | null = null;
  if (item.projectId) {
    const [row] = await db.select().from(academyCreativeProjectsTable).where(eq(academyCreativeProjectsTable.id, item.projectId));
    project = row ?? null;
  }
  if (!project) {
    const locale = await localeFor(venue.id);
    const design = await designFor(venue, item, locale);
    if (!design) {
      await db.update(venueIgItemsTable).set({ status: "skipped", error: "Its footage is gone", updatedAt: now }).where(eq(venueIgItemsTable.id, item.id));
      return null;
    }
    const style = await styleFor(access.academy);
    const scene = await sceneFor(design.templateKey, style, locale, design.window);
    const [row] = await db.insert(academyCreativeProjectsTable).values({
      academyId: venue.id,
      kind: scene.durationMs !== undefined ? "video" : "image",
      format: "story",
      title: design.title.slice(0, 120),
      templateKey: design.templateKey,
      style,
      status: "draft",
      origin: "auto",
      originKey: `ig:item:${item.id}`,
      scene,
      data: design.data,
      createdBy: access.user.id,
    }).onConflictDoNothing().returning();
    project = row ?? (await db.select().from(academyCreativeProjectsTable).where(and(eq(academyCreativeProjectsTable.academyId, venue.id), eq(academyCreativeProjectsTable.originKey, `ig:item:${item.id}`))))[0] ?? null;
    if (!project) return null;
    await db.update(venueIgItemsTable).set({ projectId: project.id, error: null, updatedAt: now }).where(eq(venueIgItemsTable.id, item.id));
  }
  if (project.renderStatus === "none" || project.renderStatus === "failed") {
    project = project.kind === "video" ? await queueVideoRender(access, project) : await renderStillNow(access, project);
  }
  return project;
}

async function prepareRenders(venue: Venue, now: Date): Promise<number> {
  const soon = new Date(now.getTime() + IG.renderAheadHours * 3_600_000);
  const due = await db.select().from(venueIgItemsTable).where(and(
    eq(venueIgItemsTable.academyId, venue.id),
    inArray(venueIgItemsTable.status, [...WAITING]),
    isNotNull(venueIgItemsTable.slotAt),
    lte(venueIgItemsTable.slotAt, soon),
    isNull(venueIgItemsTable.projectId),
  )).orderBy(asc(venueIgItemsTable.slotAt)).limit(3);
  for (const item of due) await ensureRendered(venue, item, now).catch((error) => logger.warn({ itemId: item.id, error: (error as Error).message }, "Instagram: render failed"));
  return due.length;
}

// ─── 4. Publishing ───────────────────────────────────────────────────────────

/** Is every booking this item shows still postable? Award nominees drop the ones that aren't. */
async function consentForItem(venue: Venue, item: VenueIgItem): Promise<{ ok: true; ref: ConsentRef | ConsentRef[]; mode: string } | { ok: false; reason: string }> {
  if (item.kind === "booking_clip" || item.kind === "award_winner") {
    let bookingId = item.bookingId;
    if (item.kind === "award_winner") {
      const [award] = item.awardId ? await db.select().from(venueIgAwardsTable).where(eq(venueIgAwardsTable.id, item.awardId)) : [];
      bookingId = readNominees(award?.nominees).find((n) => n.key === award?.winnerKey)?.bookingId ?? null;
    }
    const b = await bookingFor(bookingId);
    if (!b) return { ok: false, reason: "The booking is gone" };
    const c = await consentNow(venue, b);
    return c.ok ? { ok: true, ref: c.ref, mode: c.mode } : { ok: false, reason: CONSENT_REASON_TEXT[c.reason].en };
  }
  const [award] = item.awardId ? await db.select().from(venueIgAwardsTable).where(eq(venueIgAwardsTable.id, item.awardId)) : [];
  const refs: ConsentRef[] = [];
  let mode = "";
  for (const n of readNominees(award?.nominees)) {
    const b = await bookingFor(n.bookingId);
    const c = b ? await consentNow(venue, b) : null;
    if (!c?.ok) return { ok: false, reason: "A nominee's booking can't be posted any more" };
    refs.push(c.ref);
    mode = c.mode;
  }
  return refs.length ? { ok: true, ref: refs, mode } : { ok: false, reason: "No nominees" };
}

function captionFor(venue: Venue, item: VenueIgItem, locale: Locale, title: string): string {
  if (item.placement === "story") return "";
  const site = `${publicBaseUrl().replace(/^https?:\/\//, "")}/v/${venue.settings.slug}`;
  const tag = `#${(venue.name || "Replay").replace(/[^\p{L}\p{N}]+/gu, "")}`;
  return locale === "ar" ? `${title}\nاحجز ملعبك: ${site}\n${tag} #ريبلاي` : `${title}\nBook your pitch: ${site}\n${tag} #Replay`;
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
  const consent = await consentForItem(venue, item);
  if (!consent.ok) return set({ status: "skipped", error: consent.reason });
  const account = await getSocialAccount(venue.id);
  const check = await checkInstagram(account);
  if (!check.ok) return set({ error: check.error });
  const room = pacing(check.limit?.used ?? (await usedToday(venue.id, now)), check.limit?.total);
  if (room.paused) return set({ error: `Waiting: ${room.used} of ${room.total} Instagram posts used in the last 24 hours` });
  const project = await ensureRendered(venue, item, now);
  if (!project) return (await db.select().from(venueIgItemsTable).where(eq(venueIgItemsTable.id, item.id)))[0];
  if (!renderIsDone(project)) {
    if (project.renderStatus === "failed") return set({ error: project.renderError ?? "The render failed" });
    return set({ status: item.status, error: null });
  }
  const owner = await ownerAccess(venue.id);
  const { media } = await ensureCreativeMedia(project, owner?.user.id ?? 0);
  const locale = await localeFor(venue.id);
  const [post] = await db.insert(academySocialPostsTable).values({
    academyId: venue.id,
    source: "replay",
    targets: ["instagram"],
    format: item.placement === "reel" ? "reel" : "story",
    caption: captionFor(venue, item, locale, project.title),
    media: [{ mediaId: media.id, type: media.kind === "video" ? "video" : "image" }],
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
    if (current.status === "voting" && current.votingEndsAt && current.votingEndsAt <= now) current = await closeVoting(current, s.slots.minVotes, now);
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
      placement: "story",
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
  if (!account?.pageTokenEnc || account.status !== "connected") return 0;
  const { pageToken } = await import("../social/account");
  const token = pageToken(account);
  for (const item of rows) {
    // A Story's numbers exist for 24 hours: keep what was read before, add what's new.
    const fresh = await mediaInsights(item.igMediaId!, item.placement as "story" | "reel", token).catch(() => ({}));
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
        await planVenue(venue, now);
        await prepareRenders(venue, now);
        await publishDue(venue, now);
        await followPublishing(venue, now);
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
    thumbnailFrom: i.moment ? { recordingId: (i.moment as { recordingId: number }).recordingId, atMs: (i.moment as { fromMs: number }).fromMs + 3000 } : null,
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
  const type = (i: VenueIgItem) => (i.kind === "booking_clip" ? (i.placement === "reel" ? "reel" : "story") : i.kind === "award_nominees" ? "nominees" : "award");
  const byType: Record<string, { posts: number; reach: number | null; views: number | null }> = {
    story: { posts: 0, reach: null, views: null }, reel: { posts: 0, reach: null, views: null }, nominees: { posts: 0, reach: null, views: null }, award: { posts: 0, reach: null, views: null },
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
