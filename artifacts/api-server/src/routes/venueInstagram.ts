import { and, desc, eq, gte, inArray, isNull, ne, sql } from "drizzle-orm";
import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import {
  academyCreativeProjectsTable,
  db,
  recordingsTable,
  usersTable,
  venueBookingsTable,
  venueIgAwardVotesTable,
  venueIgAwardsTable,
  venueIgConsentEventsTable,
  venueIgItemsTable,
  venueIgNominationsTable,
  venueIgRemovalsTable,
  venueSettingsTable,
  type VenueIgAward,
} from "@workspace/db";
import { requireAcademyConsoleUser, requireAcademyMembership, type AcademyConsoleUser } from "../lib/academyAccess";
import { getBunnyProxiedThumbnailUrl, isBunnyConfigured } from "../lib/bunny";
import { getLocalUserRecord, unauthenticatedResponse } from "../lib/clerkUserBridge";
import { mayConfirmGoalsInRoom } from "../lib/goalRights";
import { logger } from "../lib/logger";
import { recordingsForRoom, type LinkedRecording } from "../lib/matchFeed";
import { loadRoomByCode } from "../lib/matchRooms";
import { getSocialAccount } from "../lib/social/account";
import { ammanLocal, fromAmmanLocal, normaliseHours, wallMinutes } from "../lib/venues/core";
import { readNominees, saveCandidates, skillCandidates, awardVotes } from "../lib/venues/igAwards";
import {
  ensureRendered,
  igSettings,
  itemCandidates,
  itemPickList,
  pickRule,
  setItemPicks,
  itemView,
  monthlyReport,
  notPosted,
  pickWinner,
  pinItem,
  removeBookingFromInstagram,
  type IgItemView,
} from "../lib/venues/igAutopilot";
import { DEFAULT_IG_SLOTS, OPTIONAL_KINDS, WEEKLY_KINDS, isQuiet, normaliseIgSlots, nowWall, pacing, slotsFor } from "../lib/venues/igCalendar";
import { awardCommentVotes, versusVotes } from "../lib/venues/igVotes";
import { SUGGEST_KINDS, suggestPosts, suggestionFor, type SuggestKind } from "../lib/venues/igSuggest";
import { IG_CONSENT_MODES, consentMode } from "../lib/venues/igConsent";
import { checkInstagram } from "../lib/venues/igGraph";
import { itemLibraryClips, libraryClipId, libraryNominee } from "../lib/venues/igLibrary";
import { parseLibraryFilters } from "../lib/creative/library";
import { CLIP_KINDS, type ClipKind } from "../lib/creative/venueLibrary";
import { loadVenue, venueBySlug, type Venue } from "../lib/venues/store";

/**
 * Field console → Instagram autopilot, its admin consent switch, the match page's
 * "Remove from Instagram" and save nominations, and the awards vote in the app.
 *
 * Console paths sit under /academy/console/academies/:academyId/venue/instagram so the academy
 * access gate applies; everything here is the owner's (it posts in the field's name).
 */
const router: IRouter = Router();

function intParam(value: string | string[] | undefined): number | null {
  const n = Number(Array.isArray(value) ? value[0] : value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

type Access = { user: AcademyConsoleUser; venue: Venue };

async function owner(req: Request, res: Response): Promise<Access | null> {
  const user = await requireAcademyConsoleUser(req, res);
  if (!user) return null;
  const academyId = intParam(req.params.academyId);
  if (!academyId) { res.status(400).json({ error: "Invalid id" }); return null; }
  const roles = await requireAcademyMembership(user.id, academyId, res);
  if (!roles) return null;
  if (!roles.includes("owner") && !user.isAdmin) { res.status(403).json({ error: "Only the field owner can use the Instagram autopilot." }); return null; }
  const venue = await loadVenue(academyId);
  if (!venue) { res.status(404).json({ error: "Field not found" }); return null; }
  return { user, venue };
}

async function admin(req: Request, res: Response) {
  const user = await getLocalUserRecord(req);
  if (!user) { unauthenticatedResponse(res, req); return null; }
  if (!user.isAdmin) { res.status(403).json({ error: "Admin access required" }); return null; }
  return user;
}

const thumb = (recordingId: number, videoUrls: Map<number, string>, atMs: number) => {
  const url = videoUrls.get(recordingId) ?? "";
  const id = /\/([0-9a-f-]{36})\//i.exec(url)?.[1];
  return id && isBunnyConfigured() ? getBunnyProxiedThumbnailUrl(id, Math.max(0, atMs / 1000)) : null;
};

async function videoUrlsFor(ids: number[]): Promise<Map<number, string>> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return new Map();
  const rows = await db.select({ id: recordingsTable.id, videoUrl: recordingsTable.videoUrl }).from(recordingsTable).where(inArray(recordingsTable.id, unique));
  return new Map(rows.map((r) => [r.id, r.videoUrl]));
}

function consentHistoryView(rows: Array<typeof venueIgConsentEventsTable.$inferSelect & { by: string | null }>) {
  return rows.map((r) => ({ id: r.id, oldMode: r.oldMode, newMode: r.newMode, wording: r.wording, by: r.by, at: r.createdAt.toISOString() }));
}

async function consentHistory(venueId: number) {
  const rows = await db.select({ e: venueIgConsentEventsTable, by: usersTable.email }).from(venueIgConsentEventsTable)
    .leftJoin(usersTable, eq(usersTable.id, venueIgConsentEventsTable.changedBy))
    .where(eq(venueIgConsentEventsTable.academyId, venueId)).orderBy(desc(venueIgConsentEventsTable.createdAt)).limit(50);
  return consentHistoryView(rows.map((r) => ({ ...r.e, by: r.by })));
}

function awardView(a: VenueIgAward, votes: Array<{ awardId: number; nomineeKey: string }>, videoUrls: Map<number, string>) {
  const mine = votes.filter((v) => v.awardId === a.id);
  return {
    id: a.id,
    weekStart: a.weekStart,
    category: a.category,
    status: a.status,
    votingEndsAt: a.votingEndsAt?.toISOString() ?? null,
    winnerKey: a.winnerKey,
    decidedBy: a.decidedBy,
    totalVotes: mine.length,
    nominees: readNominees(a.nominees).map((n) => ({
      key: n.key, label: n.label, labelAr: n.labelAr, source: n.source, value: n.value ?? null, bookingId: n.bookingId,
      votes: mine.filter((v) => v.nomineeKey === n.key).length,
      thumbnailUrl: thumb(n.recordingId, videoUrls, n.atMs),
    })),
  };
}

// ─── Suggestions (lib/venues/igSuggest.ts) ───────────────────────────────────

/** What the autopilot would post on its own in the next `days` days and isn't on the calendar yet. */
async function suggestionsFor(venue: Venue, now: Date, days: number) {
  const s = igSettings(venue).slots;
  const nowM = nowWall(now);
  const all = suggestPosts({ s, now: nowM, days, taken: new Set() });
  const keys = all.map((x) => x.originKey);
  const taken = keys.length
    ? new Set((await db.select({ k: venueIgItemsTable.originKey }).from(venueIgItemsTable)
      .where(and(eq(venueIgItemsTable.academyId, venue.id), inArray(venueIgItemsTable.originKey, keys)))).map((r) => r.k))
    : new Set<string>();
  return all.filter((x) => !taken.has(x.originKey)).map((x) => ({ kind: x.kind, placement: x.placement, at: ammanLocalOfWall(x.at), originKey: x.originKey }));
}

// ─── Console: everything on one screen ───────────────────────────────────────

const base = "/academy/console/academies/:academyId/venue/instagram";

router.get(base, async (req, res): Promise<void> => {
  const a = await owner(req, res);
  if (!a) return;
  try {
    const s = igSettings(a.venue);
    const days = Math.min(14, Math.max(7, Number(req.query.days) || 7));
    const now = new Date();
    const from = new Date(now.getTime() - 86_400_000);
    const to = new Date(now.getTime() + days * 86_400_000);
    const [account, history] = await Promise.all([getSocialAccount(a.venue.id), consentHistory(a.venue.id)]);
    const check = await checkInstagram(account);
    const items = await db.select().from(venueIgItemsTable).where(and(
      eq(venueIgItemsTable.academyId, a.venue.id),
      // In brackets: and() doesn't bracket a raw sql chunk, so without them every field's posts in
      // the window showed on this field's calendar (2026-11-05: "Pick clips" on another field's
      // post answered Not found).
      sql`((${venueIgItemsTable.slotAt} is null and ${venueIgItemsTable.status} in ('planned', 'approved')) or (${venueIgItemsTable.slotAt} >= ${from} and ${venueIgItemsTable.slotAt} < ${to}) or ${venueIgItemsTable.status} in ('removal_flagged', 'publishing'))`,
    )).orderBy(venueIgItemsTable.slotAt).limit(400);
    const bookingIds = [...new Set(items.map((i) => i.bookingId).filter((x): x is number => x !== null))];
    const awardIds = [...new Set(items.map((i) => i.awardId).filter((x): x is number => x !== null))];
    const projectIds = [...new Set(items.map((i) => i.projectId).filter((x): x is number => x !== null))];
    const [bookings, awardsForItems, projects] = await Promise.all([
      bookingIds.length ? db.select().from(venueBookingsTable).where(inArray(venueBookingsTable.id, bookingIds)) : [],
      awardIds.length ? db.select().from(venueIgAwardsTable).where(inArray(venueIgAwardsTable.id, awardIds)) : [],
      projectIds.length ? db.select().from(academyCreativeProjectsTable).where(inArray(academyCreativeProjectsTable.id, projectIds)) : [],
    ]);
    const bById = new Map(bookings.map((b) => [b.id, b]));
    const aById = new Map(awardsForItems.map((x) => [x.id, x]));
    const pById = new Map(projects.map((p) => [p.id, p]));
    const videoUrls = await videoUrlsFor(items.map((i) => i.recordingId ?? 0));
    const views: Array<IgItemView & { thumbnailUrl: string | null; votes: { a: number; b: number } | null }> = await Promise.all(items.map(async (i) => {
      const v = itemView(i, { booking: i.bookingId ? bById.get(i.bookingId) : null, award: i.awardId ? aById.get(i.awardId) : null, project: i.projectId ? pById.get(i.projectId) : null });
      const atMs = v.thumbnailFrom?.atMs ?? 15_000;
      const thumbRec = v.thumbnailFrom?.recordingId ?? i.recordingId;
      return {
        ...v,
        thumbnailUrl: thumbRec ? thumb(thumbRec, videoUrls, atMs) : null,
        votes: i.kind === "versus" ? await versusVotes(i).catch(() => null) : null,
      };
    }));
    const today = ammanLocal(now).slice(0, 10);
    const slots = slotsFor(s.slots, normaliseHours(a.venue.settings.openingHours), today, days).filter((x) => x.at >= nowWall(now));
    const awards = await db.select().from(venueIgAwardsTable).where(and(eq(venueIgAwardsTable.academyId, a.venue.id), gte(venueIgAwardsTable.createdAt, new Date(now.getTime() - 21 * 86_400_000))))
      .orderBy(desc(venueIgAwardsTable.weekStart), venueIgAwardsTable.id);
    // The app's votes and the Instagram comments' (one per account) on each nominees carousel.
    const votes = [
      ...(await awardVotes(awards.map((x) => x.id))),
      ...(await Promise.all(awards.filter((x) => x.status === "voting" || x.status === "owner_pick").map(async (x) => (await awardCommentVotes(x).catch(() => [])).map((v) => ({ awardId: x.id, nomineeKey: v.nomineeKey }))))).flat(),
    ];
    const awardUrls = await videoUrlsFor(awards.flatMap((x) => readNominees(x.nominees).map((n) => n.recordingId)));
    const nominations = await db.select({ n: venueIgNominationsTable, booking: venueBookingsTable.reference, startLocal: venueBookingsTable.startLocal }).from(venueIgNominationsTable)
      .leftJoin(venueBookingsTable, eq(venueBookingsTable.id, venueIgNominationsTable.bookingId))
      .where(and(eq(venueIgNominationsTable.academyId, a.venue.id), eq(venueIgNominationsTable.status, "pending"))).orderBy(desc(venueIgNominationsTable.createdAt)).limit(50);
    const nomUrls = await videoUrlsFor(nominations.map((r) => r.n.recordingId));
    const flagged = await db.select().from(venueIgRemovalsTable).where(and(eq(venueIgRemovalsTable.academyId, a.venue.id), eq(venueIgRemovalsTable.outcome, "flagged"), isNull(venueIgRemovalsTable.resolvedAt)));
    const usedOurs = items.filter((i) => i.publishedAt && i.publishedAt.getTime() > now.getTime() - 86_400_000).length;
    res.json({
      settings: {
        consentMode: s.mode,
        consentSince: s.since?.toISOString() ?? null,
        consentWording: s.wording,
        consentHistory: history,
        autopilot: s.autopilot,
        publishMode: s.publishMode,
        slots: s.slots,
        defaults: DEFAULT_IG_SLOTS,
      },
      account: check.ok
        ? { ok: true, username: check.username, limit: pacing(check.limit?.used ?? usedOurs, check.limit?.total), limitFromMeta: Boolean(check.limit), limitError: check.limitError }
        : { ok: false, code: check.code, error: check.error, limit: pacing(usedOurs) },
      items: views,
      slots: slots.map((x) => ({ at: ammanLocalOfWall(x.at), kind: x.kind, capacity: x.capacity })),
      notPosted: await notPosted(a.venue, now),
      awards: awards.map((x) => awardView(x, votes, awardUrls)),
      nominations: nominations.map((r) => ({
        id: r.n.id, category: r.n.category, source: r.n.source, recordingId: r.n.recordingId, bookingId: r.n.bookingId, atSeconds: r.n.atSeconds,
        reference: r.booking, startLocal: r.startLocal, createdAt: r.n.createdAt.toISOString(),
        thumbnailUrl: thumb(r.n.recordingId, nomUrls, r.n.atSeconds * 1000),
      })),
      flaggedRemovals: flagged.map((r) => ({ id: r.id, itemId: r.itemId, bookingId: r.bookingId, error: r.error, at: r.createdAt.toISOString() })),
      suggestions: await suggestionsFor(a.venue, now, days),
      days,
    });
  } catch (error) {
    logger.warn({ error: (error as Error).message }, "Reading the Instagram autopilot failed");
    res.status(500).json({ error: "Reading the Instagram autopilot failed" });
  }
});

function ammanLocalOfWall(m: number): string {
  const d = new Date(m * 60_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

const timeRe = /^([01]\d|2[0-3]):[0-5]\d$/;
const settingsSchema = z.object({
  autopilot: z.boolean().optional(),
  publishMode: z.enum(["approve", "auto"]).optional(),
  slots: z.object({
    storyEveryHours: z.number().int().min(1).max(12).optional(),
    storiesPerSlot: z.number().int().min(1).max(5).optional(),
    reelTimes: z.array(z.string().regex(timeRe)).min(1).max(3).optional(),
    quietFrom: z.string().regex(timeRe).optional(),
    quietTo: z.string().regex(timeRe).optional(),
    nomineesDay: z.number().int().min(0).max(6).optional(),
    nomineesTime: z.string().regex(timeRe).optional(),
    votingEndDay: z.number().int().min(0).max(6).optional(),
    votingEndTime: z.string().regex(timeRe).optional(),
    winnerDay: z.number().int().min(0).max(6).optional(),
    winnerTime: z.string().regex(timeRe).optional(),
    winnerGapMinutes: z.number().int().min(15).max(240).optional(),
    minVotes: z.number().int().min(1).max(1000).optional(),
    weekly: z.record(z.enum(WEEKLY_KINDS), z.object({ day: z.number().int().min(0).max(6), time: z.string().regex(timeRe) })).optional(),
    openSlotsTime: z.string().regex(timeRe).optional(),
    boardTime: z.string().regex(timeRe).optional(),
    dayBestTime: z.string().regex(timeRe).optional(),
    highlightsPerDay: z.number().int().min(1).max(10).optional(),
    off: z.array(z.enum(OPTIONAL_KINDS)).optional(),
  }).optional(),
});

/**
 * Field console → Today: what goes out on Instagram today (the calendar's items for the Amman
 * day) and the next suggestions, without the account check the full screen makes.
 */
router.get(`${base}/today`, async (req, res): Promise<void> => {
  const a = await owner(req, res);
  if (!a) return;
  try {
    const s = igSettings(a.venue);
    const now = new Date();
    const today = ammanLocal(now).slice(0, 10);
    const from = fromAmmanLocal(`${today} 00:00`) ?? new Date(now.getTime() - 86_400_000);
    const to = new Date(from.getTime() + 86_400_000);
    const items = await db.select().from(venueIgItemsTable).where(and(
      eq(venueIgItemsTable.academyId, a.venue.id),
      gte(venueIgItemsTable.slotAt, from),
      sql`${venueIgItemsTable.slotAt} < ${to}`,
      ne(venueIgItemsTable.status, "skipped"),
    )).orderBy(venueIgItemsTable.slotAt).limit(50);
    res.json({
      autopilot: s.autopilot,
      consentMode: s.mode,
      publishMode: s.publishMode,
      items: items.map((i) => itemView(i)),
      suggestions: (await suggestionsFor(a.venue, now, 3)).slice(0, 4),
    });
  } catch (error) {
    logger.warn({ error: (error as Error).message }, "Reading Instagram for today failed");
    res.status(500).json({ error: "Reading Instagram for today failed" });
  }
});

const suggestionSchema = z.object({ kind: z.enum(SUGGEST_KINDS), at: z.string().regex(/^\d{4}-\d{2}-\d{2} ([01]\d|2[0-3]):[0-5]\d$/) });

/** Add a suggestion to the calendar now, at its own time, waiting for the owner's OK like any post. */
router.post(`${base}/suggestions`, async (req, res): Promise<void> => {
  const a = await owner(req, res);
  if (!a) return;
  const body = suggestionSchema.safeParse(req.body ?? {});
  if (!body.success) { res.status(400).json({ error: "Invalid suggestion" }); return; }
  const s = igSettings(a.venue);
  if (s.mode === "off") { res.status(409).json({ error: "Instagram consent is off for this field", code: "consent_off" }); return; }
  const now = new Date();
  const hit = suggestionFor(s.slots, body.data.kind as SuggestKind, wallMinutes(body.data.at), nowWall(now));
  if (!hit || s.slots.off.includes(hit.kind)) { res.status(409).json({ error: "That post isn't due then", code: "not_due" }); return; }
  const made = await pinItem(a.venue, hit.originKey, hit.kind, hit.placement, hit.at, now);
  if (!made) { res.status(409).json({ error: "It's on the calendar already", code: "exists" }); return; }
  res.status(201).json({ ok: true, originKey: hit.originKey });
});

/** The owner's own switches. The consent mode is not here: only an admin sets it. */
router.put(`${base}/settings`, async (req, res): Promise<void> => {
  const a = await owner(req, res);
  if (!a) return;
  const body = settingsSchema.safeParse(req.body ?? {});
  if (!body.success) { res.status(400).json({ error: body.error.issues[0]?.message ?? "Check the settings" }); return; }
  const s = igSettings(a.venue);
  if (body.data.autopilot && s.mode === "off") {
    res.status(409).json({ error: "Instagram consent is off for this field. Ask Replay to set it up first.", code: "consent_off" });
    return;
  }
  const slots = body.data.slots
    ? normaliseIgSlots({ ...s.slots, ...body.data.slots, weekly: { ...s.slots.weekly, ...(body.data.slots.weekly ?? {}) } })
    : undefined;
  await db.update(venueSettingsTable).set({
    ...(body.data.autopilot !== undefined ? { igAutopilot: body.data.autopilot } : {}),
    ...(body.data.publishMode ? { igPublishMode: body.data.publishMode } : {}),
    ...(slots ? { igSlots: slots } : {}),
    updatedAt: new Date(),
  }).where(eq(venueSettingsTable.academyId, a.venue.id));
  const venue = (await loadVenue(a.venue.id))!;
  const next = igSettings(venue);
  res.json({ autopilot: next.autopilot, publishMode: next.publishMode, slots: next.slots });
});

// ─── Console: calendar actions ───────────────────────────────────────────────

async function itemOf(a: Access, id: number | null) {
  if (!id) return null;
  const [row] = await db.select().from(venueIgItemsTable).where(and(eq(venueIgItemsTable.id, id), eq(venueIgItemsTable.academyId, a.venue.id)));
  return row ?? null;
}

const actionSchema = z.object({ action: z.enum(["approve", "unapprove", "skip", "restore", "preview", "now"]) });

router.post(`${base}/items/:itemId/action`, async (req, res): Promise<void> => {
  const a = await owner(req, res);
  if (!a) return;
  const item = await itemOf(a, intParam(req.params.itemId));
  if (!item) { res.status(404).json({ error: "Not found" }); return; }
  const body = actionSchema.safeParse(req.body ?? {});
  if (!body.success) { res.status(400).json({ error: "Unknown action" }); return; }
  const now = new Date();
  const waiting = item.status === "planned" || item.status === "approved";
  try {
    switch (body.data.action) {
      case "approve":
        if (!waiting) { res.status(409).json({ error: "It's already on its way or out" }); return; }
        await db.update(venueIgItemsTable).set({ status: "approved", approvedBy: a.user.id, approvedAt: now, updatedAt: now }).where(eq(venueIgItemsTable.id, item.id));
        break;
      case "unapprove":
        if (item.status !== "approved") { res.status(409).json({ error: "It isn't approved" }); return; }
        await db.update(venueIgItemsTable).set({ status: "planned", approvedBy: null, approvedAt: null, updatedAt: now }).where(eq(venueIgItemsTable.id, item.id));
        break;
      case "skip":
        if (!waiting) { res.status(409).json({ error: "It's already on its way or out" }); return; }
        await db.update(venueIgItemsTable).set({ status: "skipped", error: "Skipped by the owner", updatedAt: now }).where(eq(venueIgItemsTable.id, item.id));
        break;
      case "restore":
        if (item.status !== "skipped" && item.status !== "failed") { res.status(409).json({ error: "Only a skipped or failed post can come back" }); return; }
        await db.update(venueIgItemsTable).set({ status: "planned", error: null, pinned: false, postId: null, updatedAt: now }).where(eq(venueIgItemsTable.id, item.id));
        break;
      case "preview":
        await ensureRendered(a.venue, item, now);
        break;
      case "now": {
        // Approve and put it in the next minute's run (still checked for consent and the limit).
        if (!waiting) { res.status(409).json({ error: "It's already on its way or out" }); return; }
        await db.update(venueIgItemsTable).set({ status: "approved", approvedBy: a.user.id, approvedAt: now, slotAt: now, pinned: true, updatedAt: now }).where(eq(venueIgItemsTable.id, item.id));
        break;
      }
    }
    const [row] = await db.select().from(venueIgItemsTable).where(eq(venueIgItemsTable.id, item.id));
    const [project] = row.projectId ? await db.select().from(academyCreativeProjectsTable).where(eq(academyCreativeProjectsTable.id, row.projectId)) : [];
    res.json({ item: itemView(row, { project: project ?? null }) });
  } catch (error) {
    logger.warn({ itemId: item.id, error: (error as Error).message }, "Instagram item action failed");
    res.status(500).json({ error: "That didn't work. Try again." });
  }
});

/** The moments the owner can pick for a post, best first, with a frame each. */
router.get(`${base}/items/:itemId/candidates`, async (req, res): Promise<void> => {
  const a = await owner(req, res);
  if (!a) return;
  const item = await itemOf(a, intParam(req.params.itemId));
  if (!item) { res.status(404).json({ error: "Not found" }); return; }
  const rule = pickRule(item);
  if (!rule) { res.status(409).json({ error: "This post's clips can't be picked", code: "not_pickable" }); return; }
  try {
    const { candidates: list, empty } = await itemPickList(a.venue, item);
    const pickedNominees = readNominees(item.picks);
    const urls = await videoUrlsFor([...list, ...pickedNominees].map((n) => n.recordingId));
    const picked = pickedNominees.map((n) => n.key);
    res.json({
      min: rule.min,
      max: rule.max,
      picked,
      empty,
      pickedItems: pickedNominees.map((n) => ({ key: n.key, source: n.source, label: n.label, labelAr: n.labelAr, bookingId: n.bookingId, thumbnailUrl: thumb(n.recordingId, urls, n.atMs) })),
      candidates: list.map((n) => ({ key: n.key, source: n.source, label: n.label, labelAr: n.labelAr, bookingId: n.bookingId, thumbnailUrl: thumb(n.recordingId, urls, n.atMs) })),
    });
  } catch (error) {
    logger.warn({ itemId: item.id, error: (error as Error).message }, "Instagram: reading clip candidates failed");
    res.status(500).json({ error: "Couldn't read the clips. Try again." });
  }
});

/**
 * The field's clip library for a post: every clip cut from games it may post, any day, filtered
 * like Library → Clips (from/to = the game's day, origin player/auto, kind goal/dribble/pass/shot/other,
 * sort newest/match/player). A post about one game gets only that game's clips.
 */
router.get(`${base}/items/:itemId/library`, async (req, res): Promise<void> => {
  const a = await owner(req, res);
  if (!a) return;
  const item = await itemOf(a, intParam(req.params.itemId));
  if (!item) { res.status(404).json({ error: "Not found" }); return; }
  if (!pickRule(item)) { res.status(409).json({ error: "This post's clips can't be picked", code: "not_pickable" }); return; }
  const query = req.query as Record<string, unknown>;
  const origin = query.origin === "auto" || query.origin === "player" ? query.origin : null;
  const kind = (CLIP_KINDS as readonly string[]).includes(String(query.kind)) ? (query.kind as ClipKind) : null;
  const sort = query.sort === "match" || query.sort === "player" ? query.sort : "newest";
  try {
    res.json(await itemLibraryClips(a.venue, item, { filters: parseLibraryFilters(query, { limit: 48, maxLimit: 96 }), origin, kind, sort }));
  } catch (error) {
    logger.warn({ itemId: item.id, error: (error as Error).message }, "Instagram: reading the clip library failed");
    res.status(500).json({ error: "Couldn't read the clips. Try again." });
  }
});

/** The owner's clips for a post, in play order: it is edited again from them and rendered now. */
router.put(`${base}/items/:itemId/picks`, async (req, res): Promise<void> => {
  const a = await owner(req, res);
  if (!a) return;
  const item = await itemOf(a, intParam(req.params.itemId));
  if (!item) { res.status(404).json({ error: "Not found" }); return; }
  const rule = pickRule(item);
  if (!rule) { res.status(409).json({ error: "This post's clips can't be picked", code: "not_pickable" }); return; }
  const body = z.object({ keys: z.array(z.string().max(80)).max(5) }).safeParse(req.body ?? {});
  if (!body.success) { res.status(400).json({ error: "Pick the clips" }); return; }
  const keys = [...new Set(body.data.keys)];
  if (keys.length && (keys.length < rule.min || keys.length > rule.max)) {
    res.status(400).json({ error: rule.min === rule.max ? `Pick ${rule.min}` : `Pick ${rule.min} to ${rule.max}`, code: "count" });
    return;
  }
  try {
    // Only moments this post may show: the suggestions it was offered, or library clips from games it may post.
    const list = keys.some((k) => libraryClipId(k) === null) ? await itemCandidates(a.venue, item) : [];
    const byKey = new Map(list.map((n) => [n.key, n]));
    const picks = await Promise.all(keys.map(async (k) => {
      const clipId = libraryClipId(k);
      return clipId ? (await libraryNominee(a.venue, item, clipId)) ?? undefined : byKey.get(k);
    }));
    if (picks.some((p) => !p)) { res.status(409).json({ error: "One of those clips can't be used any more", code: "gone" }); return; }
    const row = await setItemPicks(a.venue, item, picks as NonNullable<(typeof picks)[number]>[]);
    const [project] = row.projectId ? await db.select().from(academyCreativeProjectsTable).where(eq(academyCreativeProjectsTable.id, row.projectId)) : [];
    res.json({ item: itemView(row, { project: project ?? null }) });
  } catch (error) {
    logger.warn({ itemId: item.id, error: (error as Error).message }, "Instagram: saving picks failed");
    res.status(500).json({ error: "That didn't work. Try again." });
  }
});

const slotSchema = z.object({ slotLocal: z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/), placement: z.enum(["story", "reel"]).optional() });

/** Drag: put a post at a time the owner chose. It stays there (pinned) until he moves it again. */
router.put(`${base}/items/:itemId/slot`, async (req, res): Promise<void> => {
  const a = await owner(req, res);
  if (!a) return;
  const item = await itemOf(a, intParam(req.params.itemId));
  if (!item) { res.status(404).json({ error: "Not found" }); return; }
  if (item.status !== "planned" && item.status !== "approved") { res.status(409).json({ error: "It's already on its way or out" }); return; }
  const body = slotSchema.safeParse(req.body ?? {});
  if (!body.success) { res.status(400).json({ error: "Pick a day and time" }); return; }
  const at = fromAmmanLocal(body.data.slotLocal);
  if (!at || at.getTime() < Date.now() - 60_000) { res.status(400).json({ error: "Pick a time in the future" }); return; }
  const s = igSettings(a.venue);
  if (isQuiet(s.slots, wallMinutes(body.data.slotLocal))) { res.status(400).json({ error: `Nothing goes out at night (${s.slots.quietFrom}–${s.slots.quietTo})`, code: "quiet" }); return; }
  const placement = item.kind === "booking_clip" ? body.data.placement ?? item.placement : item.placement;
  const [row] = await db.update(venueIgItemsTable).set({
    slotAt: at, pinned: true, placement,
    // A Story made into a Reel (or back) is designed the same; its caption differs at posting.
    updatedAt: new Date(),
  }).where(eq(venueIgItemsTable.id, item.id)).returning();
  res.json({ item: itemView(row) });
});

/** Swap two posts' times (and their Story / Reel places). */
router.post(`${base}/items/swap`, async (req, res): Promise<void> => {
  const a = await owner(req, res);
  if (!a) return;
  const body = z.object({ a: z.number().int().positive(), b: z.number().int().positive() }).safeParse(req.body ?? {});
  if (!body.success || body.data.a === body.data.b) { res.status(400).json({ error: "Pick two posts" }); return; }
  const [x, y] = await Promise.all([itemOf(a, body.data.a), itemOf(a, body.data.b)]);
  if (!x || !y) { res.status(404).json({ error: "Not found" }); return; }
  for (const i of [x, y]) if (i.status !== "planned" && i.status !== "approved") { res.status(409).json({ error: "Only posts that haven't gone out can swap" }); return; }
  const now = new Date();
  const swapPlacement = x.kind === "booking_clip" && y.kind === "booking_clip";
  await db.transaction(async (tx) => {
    await tx.update(venueIgItemsTable).set({ slotAt: y.slotAt, pinned: true, ...(swapPlacement ? { placement: y.placement } : {}), updatedAt: now }).where(eq(venueIgItemsTable.id, x.id));
    await tx.update(venueIgItemsTable).set({ slotAt: x.slotAt, pinned: true, ...(swapPlacement ? { placement: x.placement } : {}), updatedAt: now }).where(eq(venueIgItemsTable.id, y.id));
  });
  const rows = await db.select().from(venueIgItemsTable).where(inArray(venueIgItemsTable.id, [x.id, y.id]));
  res.json({ items: rows.map((r) => itemView(r)) });
});

// ─── Console: awards and nominations ─────────────────────────────────────────

router.post(`${base}/awards/:awardId/winner`, async (req, res): Promise<void> => {
  const a = await owner(req, res);
  if (!a) return;
  const body = z.object({ key: z.string().min(1).max(80) }).safeParse(req.body ?? {});
  if (!body.success) { res.status(400).json({ error: "Pick a nominee" }); return; }
  const award = await pickWinner(a.venue, intParam(req.params.awardId) ?? 0, body.data.key, a.user.id);
  if (!award) { res.status(404).json({ error: "That award or nominee isn't open" }); return; }
  res.json({ award: { id: award.id, status: award.status, winnerKey: award.winnerKey, decidedBy: award.decidedBy } });
});

router.post(`${base}/nominations/:nominationId`, async (req, res): Promise<void> => {
  const a = await owner(req, res);
  if (!a) return;
  const body = z.object({ status: z.enum(["approved", "rejected"]) }).safeParse(req.body ?? {});
  if (!body.success) { res.status(400).json({ error: "Approve or reject" }); return; }
  const [row] = await db.update(venueIgNominationsTable).set({ status: body.data.status, reviewedBy: a.user.id, reviewedAt: new Date() })
    .where(and(eq(venueIgNominationsTable.id, intParam(req.params.nominationId) ?? 0), eq(venueIgNominationsTable.academyId, a.venue.id))).returning();
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  // An approved skill is read by Skill of the week when it renders; a save joins its award.
  if (body.data.status === "approved" && row.category === "save") await addApprovedSave(a.venue, row.id);
  res.json({ nomination: { id: row.id, status: row.status } });
});

/** An approved save joins an award of its week that is still nominating or voting. */
async function addApprovedSave(venue: Venue, nominationId: number) {
  const [n] = await db.select().from(venueIgNominationsTable).where(eq(venueIgNominationsTable.id, nominationId));
  if (!n?.bookingId) return;
  const [b] = await db.select().from(venueBookingsTable).where(eq(venueBookingsTable.id, n.bookingId));
  if (!b) return;
  const { weekStartOf } = await import("../lib/venues/igCalendar");
  const week = weekStartOf(wallMinutes(b.startLocal));
  const [award] = await db.select().from(venueIgAwardsTable).where(and(eq(venueIgAwardsTable.academyId, venue.id), eq(venueIgAwardsTable.weekStart, week), eq(venueIgAwardsTable.category, "save")));
  if (!award || !["voting", "nominating", "skipped"].includes(award.status)) return; // not built yet: buildAwards reads approvals then
  const { weekCandidates } = await import("../lib/venues/igAwards");
  const fresh = (await weekCandidates(venue, week)).save;
  const now = new Date();
  await db.update(venueIgAwardsTable).set({ nominees: fresh, status: fresh.length ? "voting" : "skipped", updatedAt: now }).where(eq(venueIgAwardsTable.id, award.id));
}

/** The owner approves a shot that wasn't a goal as a save, straight from the list Replay offers. */
router.post(`${base}/nominations`, async (req, res): Promise<void> => {
  const a = await owner(req, res);
  if (!a) return;
  const body = z.object({ bookingId: z.number().int().positive(), recordingId: z.number().int().positive(), atSeconds: z.number().min(0) }).safeParse(req.body ?? {});
  if (!body.success) { res.status(400).json({ error: "Pick a moment" }); return; }
  const [b] = await db.select().from(venueBookingsTable).where(and(eq(venueBookingsTable.id, body.data.bookingId), eq(venueBookingsTable.academyId, a.venue.id)));
  if (!b) { res.status(404).json({ error: "Booking not found" }); return; }
  const [row] = await db.insert(venueIgNominationsTable).values({
    academyId: a.venue.id, recordingId: body.data.recordingId, bookingId: b.id, atSeconds: Math.round(body.data.atSeconds), source: "shot",
    nominatedBy: a.user.id, status: "approved", reviewedBy: a.user.id, reviewedAt: new Date(),
  }).onConflictDoUpdate({
    target: [venueIgNominationsTable.academyId, venueIgNominationsTable.category, venueIgNominationsTable.recordingId, venueIgNominationsTable.atSeconds],
    set: { status: "approved", reviewedBy: a.user.id, reviewedAt: new Date() },
  }).returning();
  await addApprovedSave(a.venue, row.id);
  res.status(201).json({ nomination: { id: row.id, status: row.status } });
});

/** Shots that weren't goals in a booking: candidates for Save of the week. */
router.get(`${base}/bookings/:bookingId/save-candidates`, async (req, res): Promise<void> => {
  const a = await owner(req, res);
  if (!a) return;
  const [b] = await db.select().from(venueBookingsTable).where(and(eq(venueBookingsTable.id, intParam(req.params.bookingId) ?? 0), eq(venueBookingsTable.academyId, a.venue.id)));
  if (!b?.footageRequestId) { res.json({ candidates: [] }); return; }
  const { loadRoomByRequestId } = await import("../lib/matchRooms");
  const ctx = await loadRoomByRequestId(b.footageRequestId).catch(() => null);
  if (!ctx) { res.json({ candidates: [] }); return; }
  const links = await recordingsForRoom(ctx).catch(() => []);
  const urls = await videoUrlsFor(links.map((l) => l.recordingId));
  const out = [];
  for (const link of links) {
    const offset = link.manifest.videoStartSeconds ?? 0;
    for (const t of await saveCandidates(link)) out.push({ recordingId: link.recordingId, atSeconds: Math.round(t), thumbnailUrl: thumb(link.recordingId, urls, (t + offset) * 1000) });
  }
  res.json({ candidates: out });
});

router.post(`${base}/removals/:removalId/resolved`, async (req, res): Promise<void> => {
  const a = await owner(req, res);
  if (!a) return;
  const [row] = await db.update(venueIgRemovalsTable).set({ resolvedAt: new Date(), resolvedBy: a.user.id })
    .where(and(eq(venueIgRemovalsTable.id, intParam(req.params.removalId) ?? 0), eq(venueIgRemovalsTable.academyId, a.venue.id))).returning();
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  if (row.itemId) await db.update(venueIgItemsTable).set({ status: "removed", updatedAt: new Date() }).where(and(eq(venueIgItemsTable.id, row.itemId), eq(venueIgItemsTable.status, "removal_flagged")));
  res.json({ ok: true });
});

router.get(`${base}/report`, async (req, res): Promise<void> => {
  const a = await owner(req, res);
  if (!a) return;
  const month = typeof req.query.month === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(req.query.month) ? req.query.month : ammanLocal(new Date()).slice(0, 7);
  const report = await monthlyReport(a.venue, month);
  if (!report) { res.status(400).json({ error: "Pick a month" }); return; }
  res.json(report);
});

// ─── Admin: the consent mode ─────────────────────────────────────────────────

router.get("/admin/venues/:id/instagram-consent", async (req, res): Promise<void> => {
  if (!(await admin(req, res))) return;
  const venue = await loadVenue(intParam(req.params.id) ?? 0);
  if (!venue) { res.status(404).json({ error: "Field not found" }); return; }
  const s = igSettings(venue);
  res.json({ mode: s.mode, since: s.since?.toISOString() ?? null, wording: s.wording, history: await consentHistory(venue.id) });
});

const consentSchema = z.object({ mode: z.enum(IG_CONSENT_MODES as [string, ...string[]]), wording: z.string().trim().max(4000).nullable().optional() });

router.put("/admin/venues/:id/instagram-consent", async (req, res): Promise<void> => {
  const user = await admin(req, res);
  if (!user) return;
  const venue = await loadVenue(intParam(req.params.id) ?? 0);
  if (!venue) { res.status(404).json({ error: "Field not found" }); return; }
  const body = consentSchema.safeParse(req.body ?? {});
  if (!body.success) { res.status(400).json({ error: "Pick ask, owner or off" }); return; }
  const mode = consentMode(body.data.mode);
  const wording = body.data.wording?.trim() || null;
  if (mode === "owner" && !wording) { res.status(400).json({ error: "Paste the field's own consent wording (its signage or booking terms)", code: "wording_required" }); return; }
  const old = consentMode(venue.settings.igConsentMode);
  const now = new Date();
  const changed = old !== mode || (mode === "owner" && wording !== venue.settings.igConsentWording);
  if (!changed) { res.json({ mode, since: venue.settings.igConsentSince?.toISOString() ?? null, wording: venue.settings.igConsentWording, history: await consentHistory(venue.id) }); return; }
  await db.transaction(async (tx) => {
    await tx.update(venueSettingsTable).set({
      igConsentMode: mode,
      igConsentSince: now,
      igConsentBy: user.id,
      igConsentWording: mode === "owner" ? wording : venue.settings.igConsentWording,
      ...(mode === "off" ? { igAutopilot: false } : {}),
      updatedAt: now,
    }).where(eq(venueSettingsTable.academyId, venue.id));
    await tx.insert(venueIgConsentEventsTable).values({ academyId: venue.id, changedBy: user.id, oldMode: old, newMode: mode, wording: mode === "owner" ? wording : null });
  });
  if (mode === "off") {
    await db.update(venueIgItemsTable).set({ status: "skipped", error: "Instagram consent was switched off", updatedAt: now })
      .where(and(eq(venueIgItemsTable.academyId, venue.id), inArray(venueIgItemsTable.status, ["planned", "approved", "rendering", "ready"])));
  }
  const fresh = (await loadVenue(venue.id))!;
  res.json({ mode, since: fresh.settings.igConsentSince?.toISOString() ?? null, wording: fresh.settings.igConsentWording, history: await consentHistory(venue.id) });
});

router.post("/admin/recordings/:id/camera-tilted", async (req, res): Promise<void> => {
  if (!(await admin(req, res))) return;
  const body = z.object({ tilted: z.boolean() }).safeParse(req.body ?? {});
  if (!body.success) { res.status(400).json({ error: "tilted: true or false" }); return; }
  const [row] = await db.update(recordingsTable).set({ cameraTilted: body.data.tilted }).where(eq(recordingsTable.id, intParam(req.params.id) ?? 0)).returning({ id: recordingsTable.id, cameraTilted: recordingsTable.cameraTilted });
  if (!row) { res.status(404).json({ error: "Recording not found" }); return; }
  res.json(row);
});

// ─── The match page ──────────────────────────────────────────────────────────

async function matchContext(req: Request, res: Response) {
  const ctx = await loadRoomByCode(String(req.params.code ?? ""));
  if (!ctx) { res.status(404).json({ error: "Match not found" }); return null; }
  const [booking] = await db.select().from(venueBookingsTable).where(eq(venueBookingsTable.footageRequestId, ctx.request.id)).orderBy(desc(venueBookingsTable.id)).limit(1);
  const venue = booking ? await loadVenue(booking.academyId) : null;
  return { ctx, booking: booking ?? null, venue };
}

router.get("/m/:code/instagram", async (req, res): Promise<void> => {
  const m = await matchContext(req, res);
  if (!m) return;
  if (!m.booking || !m.venue || consentMode(m.venue.settings.igConsentMode) === "off") { res.json({ enabled: false }); return; }
  const user = await getLocalUserRecord(req);
  const inMatch = user && !user.isGuest ? await mayConfirmGoalsInRoom(user, m.ctx.room) : false;
  const items = await db.select().from(venueIgItemsTable).where(and(eq(venueIgItemsTable.academyId, m.venue.id), eq(venueIgItemsTable.bookingId, m.booking.id), ne(venueIgItemsTable.status, "skipped")));
  const s = igSettings(m.venue);
  type Cand = { recordingId: number; atSeconds: number; thumbnailUrl: string | null; nominated: boolean };
  let saveCands: Cand[] = [];
  let skillCands: Cand[] = [];
  if (inMatch && s.autopilot) {
    const links = await recordingsForRoom(m.ctx).catch(() => []);
    const urls = await videoUrlsFor(links.map((l) => l.recordingId));
    const mine = user ? await db.select({ category: venueIgNominationsTable.category, recordingId: venueIgNominationsTable.recordingId, atSeconds: venueIgNominationsTable.atSeconds }).from(venueIgNominationsTable)
      .where(and(eq(venueIgNominationsTable.academyId, m.venue.id), eq(venueIgNominationsTable.bookingId, m.booking.id))) : [];
    const cand = (category: string, link: LinkedRecording, t: number): Cand => {
      const at = Math.round(t);
      return { recordingId: link.recordingId, atSeconds: at, thumbnailUrl: thumb(link.recordingId, urls, (t + (link.manifest.videoStartSeconds ?? 0)) * 1000), nominated: mine.some((n) => n.category === category && n.recordingId === link.recordingId && n.atSeconds === at) };
    };
    for (const link of links) {
      for (const t of await saveCandidates(link)) saveCands.push(cand("save", link, t));
      // Skill of the week: no detection, so the game's dribbles are offered (Mohammed, 2026-11-07).
      for (const t of await skillCandidates(link)) skillCands.push(cand("skill", link, t));
    }
    saveCands = saveCands.slice(0, 12);
    skillCands = skillCands.slice(0, 12);
  }
  const live = items.filter((i) => i.status !== "removed");
  res.json({
    enabled: true,
    field: m.venue.nameAr || m.venue.name ? { name: m.venue.name, nameAr: m.venue.nameAr } : null,
    mode: s.mode,
    posts: live.map((i) => ({ id: i.id, placement: i.placement, status: i.status, permalink: i.igPermalink, publishedAt: i.publishedAt?.toISOString() ?? null })),
    removed: m.booking.igConsent === "no" && m.booking.igConsentSource === "removal",
    optedOut: m.booking.igConsent === "no",
    canRemove: Boolean(inMatch) && !(m.booking.igConsent === "no" && m.booking.igConsentSource === "removal"),
    saveCandidates: saveCands,
    skillCandidates: skillCands,
    awardsUrl: s.autopilot ? `/awards/${m.venue.settings.slug}` : null,
  });
});

router.post("/m/:code/instagram/remove", async (req, res): Promise<void> => {
  const m = await matchContext(req, res);
  if (!m) return;
  const user = await getLocalUserRecord(req);
  if (!user) { unauthenticatedResponse(res, req); return; }
  if (user.isGuest || !(await mayConfirmGoalsInRoom(user, m.ctx.room))) { res.status(403).json({ error: "Only players in this match can take it off Instagram" }); return; }
  if (!m.booking || !m.venue) { res.status(404).json({ error: "This match isn't a field booking" }); return; }
  const outcomes = await removeBookingFromInstagram(m.venue, m.booking.id, user.id);
  res.json({ outcomes });
});

router.post("/m/:code/instagram/nominate-save", async (req, res): Promise<void> => {
  const m = await matchContext(req, res);
  if (!m) return;
  const user = await getLocalUserRecord(req);
  if (!user) { unauthenticatedResponse(res, req); return; }
  if (user.isGuest || !(await mayConfirmGoalsInRoom(user, m.ctx.room))) { res.status(403).json({ error: "Only players in this match can nominate" }); return; }
  if (!m.booking || !m.venue) { res.status(404).json({ error: "This match isn't a field booking" }); return; }
  const body = z.object({ recordingId: z.number().int().positive(), atSeconds: z.number().min(0), note: z.string().trim().max(200).optional(), category: z.enum(["save", "skill"]).default("save") }).safeParse(req.body ?? {});
  if (!body.success) { res.status(400).json({ error: "Pick a moment" }); return; }
  const links = await recordingsForRoom(m.ctx).catch((): LinkedRecording[] => []);
  const link = links.find((l) => l.recordingId === body.data.recordingId);
  if (!link || body.data.atSeconds < link.fromSeconds || body.data.atSeconds > link.toSeconds) { res.status(404).json({ error: "That moment isn't in this match" }); return; }
  const [row] = await db.insert(venueIgNominationsTable).values({
    academyId: m.venue.id, category: body.data.category, recordingId: link.recordingId, bookingId: m.booking.id, atSeconds: Math.round(body.data.atSeconds), source: "player",
    nominatedBy: user.id, note: body.data.note ?? null,
  }).onConflictDoNothing().returning();
  res.status(row ? 201 : 200).json({ nominated: true, id: row?.id ?? null });
});

// ─── The awards vote, in the app ─────────────────────────────────────────────

router.get("/venue-awards/:slug", async (req, res): Promise<void> => {
  const venue = await venueBySlug(String(req.params.slug ?? ""));
  if (!venue || consentMode(venue.settings.igConsentMode) === "off" || !venue.settings.igAutopilot) { res.status(404).json({ error: "Not found" }); return; }
  const user = await getLocalUserRecord(req);
  const awards = await db.select().from(venueIgAwardsTable).where(and(
    eq(venueIgAwardsTable.academyId, venue.id),
    inArray(venueIgAwardsTable.status, ["voting", "owner_pick", "decided", "posted"]),
    gte(venueIgAwardsTable.createdAt, new Date(Date.now() - 14 * 86_400_000)),
  )).orderBy(desc(venueIgAwardsTable.weekStart), venueIgAwardsTable.id);
  const votes = await awardVotes(awards.map((a) => a.id));
  const urls = await videoUrlsFor(awards.flatMap((a) => readNominees(a.nominees).map((n) => n.recordingId)));
  res.json({
    field: { name: venue.name, nameAr: venue.nameAr, logoUrl: venue.logoUrl, slug: venue.settings.slug },
    signedIn: Boolean(user && !user.isGuest),
    awards: awards.map((a) => {
      const view = awardView(a, votes, urls);
      const open = a.status === "voting";
      return {
        ...view,
        // Counts stay hidden while the vote is open.
        nominees: view.nominees.map((n) => ({ ...n, votes: open ? null : n.votes })),
        totalVotes: open ? null : view.totalVotes,
        myVote: user ? votes.find((v) => v.awardId === a.id && v.userId === user.id)?.nomineeKey ?? null : null,
      };
    }),
  });
});

router.post("/venue-awards/:slug/:awardId/vote", async (req, res): Promise<void> => {
  const user = await getLocalUserRecord(req);
  if (!user) { unauthenticatedResponse(res, req); return; }
  if (user.isGuest) { res.status(403).json({ error: "Create an account to vote", reason: "guest" }); return; }
  const venue = await venueBySlug(String(req.params.slug ?? ""));
  if (!venue) { res.status(404).json({ error: "Not found" }); return; }
  const body = z.object({ key: z.string().min(1).max(80) }).safeParse(req.body ?? {});
  if (!body.success) { res.status(400).json({ error: "Pick a nominee" }); return; }
  const [award] = await db.select().from(venueIgAwardsTable).where(and(eq(venueIgAwardsTable.id, intParam(req.params.awardId) ?? 0), eq(venueIgAwardsTable.academyId, venue.id)));
  if (!award || award.status !== "voting" || (award.votingEndsAt && award.votingEndsAt <= new Date())) { res.status(409).json({ error: "Voting has closed" }); return; }
  if (!readNominees(award.nominees).some((n) => n.key === body.data.key)) { res.status(404).json({ error: "No such nominee" }); return; }
  await db.insert(venueIgAwardVotesTable).values({ awardId: award.id, nomineeKey: body.data.key, userId: user.id })
    .onConflictDoUpdate({ target: [venueIgAwardVotesTable.awardId, venueIgAwardVotesTable.userId], set: { nomineeKey: body.data.key, createdAt: new Date() } });
  res.json({ myVote: body.data.key });
});

export default router;
