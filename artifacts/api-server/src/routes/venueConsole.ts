import { and, asc, desc, eq, gte, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import {
  db,
  fieldOwnersTable,
  fieldsTable,
  venueAgentThreadsTable,
  venueBookingsTable,
  venuePayoutsTable,
  venuePitchesTable,
  venueSettingsTable,
  type VenueBooking,
} from "@workspace/db";
import { requireAcademyConsoleUser, requireAcademyMembership, type AcademyConsoleUser } from "../lib/academyAccess";
import { logger } from "../lib/logger";
import { normalizePhone, formatPhoneForDisplay } from "../lib/whatsapp/phone";
import { listContacts } from "../lib/whatsapp/contacts";
import { cancelQuote, policyOf, rulesSummary } from "../lib/venues/rules";
import { addDays, ammanLocal, isDate, isTime, normaliseDurations, normaliseHours, normaliseRules, slugify, wallMinutes } from "../lib/venues/core";
import {
  VenueError,
  availability,
  bookingView,
  bookingPolicy,
  cancelBooking,
  confirmWithoutPayment,
  createBookings,
  createVenue,
  customerStats,
  getBooking,
  listPitches,
  loadVenue,
  markPaid,
  markNoShow,
  moneyOf,
  moveBooking,
  rulesView,
  notify,
  pitchView,
  settingsView,
  venueAutomations,
  venueMemberships,
  type Venue,
} from "../lib/venues/store";
import { agentApiKey } from "../lib/venues/agent";
import { consentMode } from "../lib/venues/igConsent";
import { checkDomain, setDomain, sitesIp } from "../lib/venues/domains";
import { sealCardConfig } from "../lib/venues/payments";

/**
 * Field console API: everything only a field has. The rest of the console (chats, people,
 * WhatsApp, ads, social, creative, branding, profile, team) is the academy console's own API,
 * because a field business is an `academies` row of kind venue.
 *
 * All paths sit under /academy/console/academies/:academyId/venue/<section>/… so the academy
 * access gate applies the owner's Team settings to them (lib/academyPermissions.ts).
 */
const router: IRouter = Router();

type Access = { user: AcademyConsoleUser; venue: Venue; isOwner: boolean; roles: string[] };

function intParam(value: string | string[] | undefined): number | null {
  const n = Number(Array.isArray(value) ? value[0] : value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

async function access(req: Request, res: Response, ownerOnly = false): Promise<Access | null> {
  const user = await requireAcademyConsoleUser(req, res);
  if (!user) return null;
  const academyId = intParam(req.params.academyId);
  if (!academyId) { res.status(400).json({ error: "Invalid id" }); return null; }
  const roles = await requireAcademyMembership(user.id, academyId, res);
  if (!roles) return null;
  const venue = await loadVenue(academyId);
  if (!venue) { res.status(404).json({ error: "Field not found" }); return null; }
  const isOwner = roles.includes("owner");
  if (ownerOnly && !isOwner) { res.status(403).json({ error: "Only the field owner can change this." }); return null; }
  return { user, venue, isOwner, roles };
}

function fail(res: Response, error: unknown, fallback: string) {
  if (error instanceof VenueError) {
    res.status(error.status).json({ error: error.message, code: error.code });
    return;
  }
  logger.warn({ error: (error as Error)?.message }, fallback);
  res.status(500).json({ error: fallback });
}

const base = "/academy/console/academies/:academyId/venue";

// ─── Memberships and set-up ──────────────────────────────────────────────────

router.get("/venue/console/memberships", async (req, res): Promise<void> => {
  const user = await requireAcademyConsoleUser(req, res);
  if (!user) return;
  const memberships = await venueMemberships(user.id);
  const owned = await db.select({ fieldId: fieldOwnersTable.fieldId, name: fieldsTable.name })
    .from(fieldOwnersTable).innerJoin(fieldsTable, eq(fieldsTable.id, fieldOwnersTable.fieldId))
    .where(eq(fieldOwnersTable.userId, user.id));
  res.json({ memberships, ownedFields: owned, canSetUp: memberships.length === 0 && owned.length > 0 });
});

/** A field owner (Admin → Fields → Owners) opens the field console for the first time. */
router.post("/venue/console/setup", async (req, res): Promise<void> => {
  const user = await requireAcademyConsoleUser(req, res);
  if (!user) return;
  const existing = await venueMemberships(user.id);
  if (existing.length) { res.json({ academyId: existing[0].academyId }); return; }
  const owned = await db.select({ fieldId: fieldOwnersTable.fieldId, name: fieldsTable.name })
    .from(fieldOwnersTable).innerJoin(fieldsTable, eq(fieldsTable.id, fieldOwnersTable.fieldId))
    .where(eq(fieldOwnersTable.userId, user.id)).orderBy(asc(fieldsTable.id));
  if (!owned.length) { res.status(403).json({ error: "Only a field owner can open a field console. Ask Replay to add you to your field." }); return; }
  const body = z.object({ name: z.string().trim().min(2).max(120).optional() }).safeParse(req.body ?? {});
  const name = body.success && body.data.name ? body.data.name : owned[0].name.replace(/\s+(lower|upper|north|south|east|west|\d+)$/i, "").trim() || owned[0].name;
  try {
    const venue = await createVenue({ name, fieldIds: owned.map((o) => o.fieldId), ownerUserId: user.id });
    res.status(201).json({ academyId: venue.id });
  } catch (error) {
    fail(res, error, "Setting up the field console failed");
  }
});

// ─── Dashboard ───────────────────────────────────────────────────────────────

router.get(`${base}/dashboard`, async (req, res): Promise<void> => {
  const a = await access(req, res);
  if (!a) return;
  const venueId = a.venue.id;
  const now = new Date();
  const today = ammanLocal(now).slice(0, 10);
  const monthStart = `${today.slice(0, 8)}01 00:00`;
  const pitches = await listPitches(venueId);
  const pitchMap = new Map(pitches.map((p) => [p.id, p]));
  const todayRows = await db.select().from(venueBookingsTable).where(and(
    eq(venueBookingsTable.academyId, venueId),
    inArray(venueBookingsTable.status, ["held", "confirmed", "completed", "no_show"]),
    gte(venueBookingsTable.startLocal, `${today} 00:00`),
    lt(venueBookingsTable.startLocal, `${addDays(today, 1)} 06:00`),
  )).orderBy(asc(venueBookingsTable.startsAt));
  const [month] = await db.select({
    bookings: sql<number>`count(*) filter (where ${venueBookingsTable.status} in ('confirmed', 'completed'))::int`,
    revenue: sql<number>`coalesce(sum(${venueBookingsTable.amountFils}) filter (where ${venueBookingsTable.status} in ('confirmed', 'completed')), 0)::int`,
    collected: sql<number>`coalesce(sum(${venueBookingsTable.paidFils}) filter (where ${venueBookingsTable.status} <> 'cancelled'), 0)::int`,
    minutes: sql<number>`coalesce(sum(extract(epoch from (${venueBookingsTable.endsAt} - ${venueBookingsTable.startsAt})) / 60) filter (where ${venueBookingsTable.status} in ('confirmed', 'completed')), 0)::int`,
    noShows: sql<number>`count(*) filter (where ${venueBookingsTable.status} = 'no_show')::int`,
    online: sql<number>`count(*) filter (where ${venueBookingsTable.source} in ('whatsapp', 'website') and ${venueBookingsTable.status} in ('confirmed', 'completed'))::int`,
  }).from(venueBookingsTable).where(and(eq(venueBookingsTable.academyId, venueId), gte(venueBookingsTable.startLocal, monthStart)));
  const [receipts] = await db.select({ n: sql<number>`count(*)::int` }).from(venueBookingsTable)
    .where(and(eq(venueBookingsTable.academyId, venueId), eq(venueBookingsTable.paymentStatus, "receipt"), inArray(venueBookingsTable.status, ["held", "confirmed"])));
  const [held] = await db.select({ n: sql<number>`count(*)::int` }).from(venueBookingsTable)
    .where(and(eq(venueBookingsTable.academyId, venueId), eq(venueBookingsTable.status, "held")));
  const [handovers] = await db.select({ n: sql<number>`count(*)::int` }).from(venueAgentThreadsTable)
    .where(and(eq(venueAgentThreadsTable.academyId, venueId), isNotNull(venueAgentThreadsTable.handoverAt)));
  // Occupancy this month: booked minutes over open minutes so far, all active pitches.
  const hours = normaliseHours(a.venue.settings.openingHours);
  let openMinutes = 0;
  for (let d = `${today.slice(0, 8)}01`; d <= today; d = addDays(d, 1)) {
    const day = hours[String(new Date(`${d}T00:00:00Z`).getUTCDay()) as "0"];
    if (!day) continue;
    let span = wallMinutes(`2000-01-01 ${day.close === "24:00" ? "23:59" : day.close}`) - wallMinutes(`2000-01-01 ${day.open}`);
    if (span <= 0) span += 1440;
    openMinutes += span;
  }
  const activePitches = pitches.filter((p) => p.active).length || 1;
  res.json({
    venue: { id: a.venue.id, name: a.venue.name, nameAr: a.venue.nameAr, logoUrl: a.venue.logoUrl },
    settings: { slug: a.venue.settings.slug, agentMode: a.venue.settings.agentMode, moneyTo: a.venue.settings.moneyTo, bookingEnabled: a.venue.settings.bookingEnabled, siteUrl: settingsView(a.venue.settings).siteUrl, customDomain: a.venue.settings.customDomain, domainStatus: a.venue.settings.domainStatus },
    pitchCount: pitches.filter((p) => p.active).length,
    today: todayRows.map((b) => bookingView(b, pitchMap)),
    month: { ...month, occupancy: openMinutes ? Math.min(1, month.minutes / (openMinutes * activePitches)) : 0 },
    attention: { receipts: receipts.n, held: held.n, handovers: handovers.n },
    isOwner: a.isOwner,
  });
});

// ─── Bookings ────────────────────────────────────────────────────────────────

router.get(`${base}/bookings`, async (req, res): Promise<void> => {
  const a = await access(req, res);
  if (!a) return;
  const from = isDate(req.query.from) ? req.query.from : ammanLocal(new Date()).slice(0, 10);
  const to = isDate(req.query.to) ? req.query.to : addDays(from, 7);
  const statuses = typeof req.query.status === "string" ? req.query.status.split(",").filter(Boolean) : null;
  const rows = await db.select().from(venueBookingsTable).where(and(
    eq(venueBookingsTable.academyId, a.venue.id),
    gte(venueBookingsTable.startLocal, `${from} 00:00`),
    lt(venueBookingsTable.startLocal, `${addDays(to, 1)} 06:00`),
    statuses?.length ? inArray(venueBookingsTable.status, statuses) : sql`true`,
  )).orderBy(asc(venueBookingsTable.startsAt)).limit(2000);
  const pitches = await listPitches(a.venue.id);
  // The front desk's booking forms follow the field's Instagram consent mode (set by Replay).
  res.json({ from, to, bookings: rows.map((b) => bookingView(b, new Map(pitches.map((p) => [p.id, p])))), pitches: pitches.map((p) => pitchView(p)), igConsentMode: consentMode(a.venue.settings.igConsentMode) });
});

/** Payments waiting on someone: receipts to check and held bookings, oldest first. */
router.get(`${base}/bookings/attention`, async (req, res): Promise<void> => {
  const a = await access(req, res);
  if (!a) return;
  const rows = await db.select().from(venueBookingsTable).where(and(
    eq(venueBookingsTable.academyId, a.venue.id),
    inArray(venueBookingsTable.status, ["held", "confirmed"]),
    inArray(venueBookingsTable.paymentStatus, ["receipt", "unpaid"]),
    sql`(${venueBookingsTable.paymentStatus} = 'receipt' or ${venueBookingsTable.status} = 'held')`,
  )).orderBy(asc(venueBookingsTable.createdAt)).limit(200);
  const pitches = new Map((await listPitches(a.venue.id)).map((p) => [p.id, p]));
  res.json({ bookings: rows.map((b) => bookingView(b, pitches)) });
});

router.get(`${base}/availability`, async (req, res): Promise<void> => {
  const a = await access(req, res);
  if (!a) return;
  const date = isDate(req.query.date) ? req.query.date : ammanLocal(new Date()).slice(0, 10);
  res.json({ date, pitches: await availability(a.venue, date, intParam(req.query.pitchId as string) ?? undefined) });
});

const newBookingSchema = z.object({
  pitchId: z.number().int().positive(),
  startLocal: z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/),
  minutes: z.number().int().min(30).max(360),
  customerName: z.string().trim().max(80).nullable().optional(),
  customerPhone: z.string().trim().max(30).nullable().optional(),
  teamName: z.string().trim().max(80).nullable().optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
  payWith: z.enum(["none", "field", "cliq", "card"]).default("field"),
  repeatWeeks: z.number().int().min(1).max(26).optional(),
  amountFils: z.number().int().min(0).max(10_000_000).nullable().optional(),
  paid: z.boolean().optional(),
  notify: z.boolean().optional(),
  /** Instagram consent from the front desk (ask: the captain's answer; owner: "no" marks a refusal). */
  igConsent: z.boolean().nullable().optional(),
  under18: z.boolean().optional(),
});

router.post(`${base}/bookings`, async (req, res): Promise<void> => {
  const a = await access(req, res);
  if (!a) return;
  const body = newBookingSchema.safeParse(req.body ?? {});
  if (!body.success) { res.status(400).json({ error: "Pick a pitch, a start and a length" }); return; }
  try {
    const rows = await createBookings(a.venue, {
      ...body.data,
      source: "console",
      staff: true,
      createdBy: a.user.id,
      notify: body.data.notify ?? true,
    });
    const pitches = new Map((await listPitches(a.venue.id)).map((p) => [p.id, p]));
    res.status(201).json({ bookings: rows.map((b) => bookingView(b, pitches)) });
  } catch (error) {
    fail(res, error, "Booking failed");
  }
});

const editSchema = z.object({
  pitchId: z.number().int().positive().optional(),
  startLocal: z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/).optional(),
  minutes: z.number().int().min(30).max(360).optional(),
  amountFils: z.number().int().min(0).max(10_000_000).nullable().optional(),
  customerName: z.string().trim().max(80).nullable().optional(),
  customerPhone: z.string().trim().max(30).nullable().optional(),
  teamName: z.string().trim().max(80).nullable().optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
  /** The front desk's Instagram answer for this booking; null clears it (not asked). */
  igConsent: z.enum(["yes", "no"]).nullable().optional(),
  under18: z.boolean().optional(),
});

router.patch(`${base}/bookings/:bookingId`, async (req, res): Promise<void> => {
  const a = await access(req, res);
  if (!a) return;
  const booking = await getBooking(a.venue.id, intParam(req.params.bookingId) ?? 0);
  if (!booking) { res.status(404).json({ error: "Booking not found" }); return; }
  const body = editSchema.safeParse(req.body ?? {});
  if (!body.success) { res.status(400).json({ error: "Check the booking details" }); return; }
  try {
    let row = booking;
    if (body.data.pitchId || body.data.startLocal || body.data.minutes || body.data.amountFils !== undefined) {
      row = await moveBooking(a.venue, booking, body.data);
    }
    const patch: Partial<VenueBooking> = {};
    if (body.data.customerName !== undefined) patch.customerName = body.data.customerName || null;
    if (body.data.teamName !== undefined) patch.teamName = body.data.teamName || null;
    if (body.data.notes !== undefined) patch.notes = body.data.notes || null;
    if (body.data.igConsent !== undefined) {
      patch.igConsent = body.data.igConsent;
      patch.igConsentSource = body.data.igConsent ? "staff" : null;
      patch.igConsentAt = body.data.igConsent ? new Date() : null;
    }
    if (body.data.under18 !== undefined) patch.under18 = body.data.under18;
    if (body.data.customerPhone !== undefined) {
      const phone = body.data.customerPhone ? normalizePhone(body.data.customerPhone) : null;
      if (body.data.customerPhone && !phone) { res.status(400).json({ error: "That phone number doesn't look right" }); return; }
      patch.customerPhone = phone;
    }
    if (Object.keys(patch).length) {
      [row] = await db.update(venueBookingsTable).set({ ...patch, updatedAt: new Date() }).where(eq(venueBookingsTable.id, booking.id)).returning();
    }
    const pitches = new Map((await listPitches(a.venue.id)).map((p) => [p.id, p]));
    res.json({ booking: bookingView(row, pitches) });
  } catch (error) {
    fail(res, error, "Saving the booking failed");
  }
});

const actionSchema = z.object({
  action: z.enum(["confirm-payment", "collect-balance", "confirm-hold", "reject-receipt", "cancel", "complete", "no-show", "reopen", "resend", "refund-sent", "waive-fee", "fee-collected"]),
  reason: z.string().trim().max(200).optional(),
  /** Cancel: the player asked to cancel, so the field's late-cancel fee applies. */
  byPlayer: z.boolean().optional(),
  notify: z.boolean().optional(),
  /** Cancel every later booking of the same weekly series too. */
  series: z.boolean().optional(),
});

router.post(`${base}/bookings/:bookingId/action`, async (req, res): Promise<void> => {
  const a = await access(req, res);
  if (!a) return;
  const booking = await getBooking(a.venue.id, intParam(req.params.bookingId) ?? 0);
  if (!booking) { res.status(404).json({ error: "Booking not found" }); return; }
  const body = actionSchema.safeParse(req.body ?? {});
  if (!body.success) { res.status(400).json({ error: "Unknown action" }); return; }
  const { action } = body.data;
  try {
    let row = booking;
    if (action === "confirm-payment") {
      // Online money paid to Replay's CliQ is Replay's to confirm.
      if (booking.moneyTo === "replay" && booking.payWith !== "field" && !a.user.isAdmin) {
        res.status(403).json({ error: "This booking was paid to Replay. Replay confirms it (usually within the hour).", code: "replay_confirms" });
        return;
      }
      row = await markPaid(a.venue, booking, a.user.id, { notify: body.data.notify !== false });
    } else if (action === "collect-balance") {
      row = await markPaid(a.venue, booking, a.user.id, { full: true, notify: false });
    } else if (action === "confirm-hold") {
      row = await confirmWithoutPayment(a.venue, booking);
    } else if (action === "reject-receipt") {
      [row] = await db.update(venueBookingsTable).set({ paymentStatus: "unpaid", receiptCheck: null, updatedAt: new Date(), holdExpiresAt: booking.status === "held" ? new Date(Date.now() + 30 * 60_000) : null })
        .where(eq(venueBookingsTable.id, booking.id)).returning();
    } else if (action === "cancel") {
      if (body.data.byPlayer) {
        // Staff recording a player's cancellation: the fee applies, and a late "ask the field" rule doesn't refuse (they are the field).
        const quote = cancelQuote(bookingPolicy(a.venue, booking), moneyOf(booking), "player");
        row = quote.allowed
          ? await cancelBooking(a.venue, booking, body.data.reason || "The player cancelled", { notify: body.data.notify !== false, by: "player" })
          : await cancelBooking(a.venue, booking, body.data.reason || "The player cancelled", { notify: body.data.notify !== false, by: "field" });
      } else {
        row = await cancelBooking(a.venue, booking, body.data.reason || "Cancelled by the field", { notify: body.data.notify !== false });
      }
      if (body.data.series && booking.seriesId) {
        const later = await db.select().from(venueBookingsTable).where(and(
          eq(venueBookingsTable.seriesId, booking.seriesId), eq(venueBookingsTable.academyId, a.venue.id),
          inArray(venueBookingsTable.status, ["held", "confirmed"]), gte(venueBookingsTable.startsAt, booking.startsAt),
        ));
        for (const b of later) await cancelBooking(a.venue, b, body.data.reason || "Cancelled by the field", { notify: false });
      }
    } else if (action === "complete") {
      if (booking.status === "cancelled") { res.status(409).json({ error: "This booking was cancelled" }); return; }
      [row] = await db.update(venueBookingsTable).set({ status: "completed", updatedAt: new Date() }).where(eq(venueBookingsTable.id, booking.id)).returning();
    } else if (action === "no-show") {
      row = await markNoShow(a.venue, booking);
    } else if (action === "reopen") {
      if (booking.status !== "completed" && booking.status !== "no_show") { res.status(409).json({ error: "Only a finished booking can be reopened" }); return; }
      // Reopening a no-show takes its no-show fee off again.
      const fee = booking.status === "no_show" && booking.feeReason === "no_show" ? 0 : booking.feeFils;
      [row] = await db.update(venueBookingsTable).set({ status: "confirmed", feeFils: fee, feeReason: fee ? booking.feeReason : null, updatedAt: new Date() }).where(eq(venueBookingsTable.id, booking.id)).returning();
    } else if (action === "refund-sent") {
      if (booking.refundDueFils <= booking.refundedFils) { res.status(409).json({ error: "Nothing to refund on this booking" }); return; }
      [row] = await db.update(venueBookingsTable).set({ refundedFils: booking.refundDueFils, paymentStatus: booking.paidFils <= booking.refundDueFils ? "refunded" : booking.paymentStatus, updatedAt: new Date() })
        .where(eq(venueBookingsTable.id, booking.id)).returning();
    } else if (action === "fee-collected") {
      if (booking.feeFils <= booking.paidFils) { res.status(409).json({ error: "Nothing owed on this booking" }); return; }
      [row] = await db.update(venueBookingsTable).set({ paidFils: booking.feeFils, paidAt: new Date(), paidBy: a.user.id, updatedAt: new Date() }).where(eq(venueBookingsTable.id, booking.id)).returning();
    } else if (action === "waive-fee") {
      if (!booking.feeFils) { res.status(409).json({ error: "This booking has no fee" }); return; }
      // Without the fee, whatever was kept for it goes back (for a cancelled booking).
      const refund = booking.status === "cancelled" ? booking.paidFils : booking.refundDueFils;
      [row] = await db.update(venueBookingsTable).set({ feeFils: 0, feeReason: null, refundDueFils: refund, updatedAt: new Date() }).where(eq(venueBookingsTable.id, booking.id)).returning();
    } else if (action === "resend") {
      await notify(a.venue, booking.id, booking.status === "held" ? "held" : "confirmed");
    }
    const pitches = new Map((await listPitches(a.venue.id)).map((p) => [p.id, p]));
    res.json({ booking: bookingView((await getBooking(a.venue.id, row.id))!, pitches) });
  } catch (error) {
    fail(res, error, "That didn't work");
  }
});

// ─── Customers (the CRM's booking view) ──────────────────────────────────────

router.get(`${base}/customers`, async (req, res): Promise<void> => {
  const a = await access(req, res);
  if (!a) return;
  const [contacts, stats] = await Promise.all([listContacts(a.venue.id), customerStats(a.venue.id)]);
  const today = ammanLocal(new Date()).slice(0, 10);
  const recent = await db.select({ phone: venueBookingsTable.customerPhone, n: sql<number>`count(*)::int` }).from(venueBookingsTable).where(and(
    eq(venueBookingsTable.academyId, a.venue.id), inArray(venueBookingsTable.status, ["confirmed", "completed"]),
    gte(venueBookingsTable.startLocal, `${addDays(today, -60)} 00:00`),
  )).groupBy(venueBookingsTable.customerPhone);
  const recentByPhone = new Map(recent.map((r) => [r.phone, r.n]));
  const seen = new Set<string>();
  const people = contacts.map((c) => {
    seen.add(c.phone);
    const s = stats.get(c.phone);
    return { contactId: c.id, phone: c.phone, display: formatPhoneForDisplay(c.phone), name: c.name, kind: c.kind, stage: c.stage, tags: Array.isArray(c.tags) ? c.tags : [], ...summarise(s, recentByPhone.get(c.phone) ?? 0, today) };
  });
  for (const [phone, s] of stats) {
    if (seen.has(phone)) continue;
    people.push({ contactId: null as unknown as number, phone, display: formatPhoneForDisplay(phone), name: null, kind: "player", stage: null, tags: [], ...summarise(s, recentByPhone.get(phone) ?? 0, today) });
  }
  people.sort((x, y) => (y.lastStartLocal ?? "").localeCompare(x.lastStartLocal ?? ""));
  res.json({ customers: people });
});

function summarise(s: { bookings: number; lastStartLocal: string | null; nextStartLocal: string | null; spentFils: number; noShows: number; cancelled: number; owedFils: number } | undefined, recent: number, today: string) {
  const bookings = s?.bookings ?? 0;
  const last = s?.lastStartLocal ?? null;
  const segment = bookings === 0 ? "lead"
    : recent >= 3 ? "regular"
    : last && last.slice(0, 10) < addDays(today, -30) && !s?.nextStartLocal ? "lapsed"
    : bookings === 1 ? "new" : "returning";
  return { bookings, lastStartLocal: last, nextStartLocal: s?.nextStartLocal ?? null, spentFils: s?.spentFils ?? 0, noShows: s?.noShows ?? 0, cancelled: s?.cancelled ?? 0, owedFils: s?.owedFils ?? 0, segment };
}

// ─── Pitches and booking rules ───────────────────────────────────────────────

async function cameraFields(a: Access) {
  const owned = await db.select({ fieldId: fieldOwnersTable.fieldId }).from(fieldOwnersTable).where(eq(fieldOwnersTable.userId, a.user.id));
  const ids = [...new Set([a.venue.fieldId, ...owned.map((o) => o.fieldId), ...(await listPitches(a.venue.id)).map((p) => p.fieldId).filter((x): x is number => x != null)])];
  return db.select({ id: fieldsTable.id, name: fieldsTable.name, cameraId: fieldsTable.cameraId }).from(fieldsTable).where(inArray(fieldsTable.id, ids));
}

router.get(`${base}/pitches`, async (req, res): Promise<void> => {
  const a = await access(req, res);
  if (!a) return;
  const fields = await cameraFields(a);
  const withCamera = new Set(fields.filter((f) => f.cameraId).map((f) => f.id));
  const s = settingsView(a.venue.settings);
  res.json({
    pitches: (await listPitches(a.venue.id)).map((p) => pitchView(p, withCamera)),
    fields: fields.map((f) => ({ id: f.id, name: f.name, hasCamera: Boolean(f.cameraId) })),
    rules: { bookingEnabled: s.bookingEnabled, openingHours: s.openingHours, slotStepMinutes: s.slotStepMinutes, durations: s.durations, maxDaysAhead: s.maxDaysAhead, minNoticeMinutes: s.minNoticeMinutes, holdMinutes: s.holdMinutes },
    isOwner: a.isOwner,
  });
});

const ruleSchema = z.object({ days: z.array(z.number().int().min(0).max(6)).min(1), from: z.string(), to: z.string(), pricePerHourFils: z.number().int().min(0).max(1_000_000) });
const pitchSchema = z.object({
  name: z.string().trim().min(1).max(60),
  nameAr: z.string().trim().max(60).nullable().optional(),
  size: z.enum(["5", "6", "7", "8", "9", "11"]).default("5"),
  surface: z.string().trim().max(40).nullable().optional(),
  indoor: z.boolean().optional(),
  fieldId: z.number().int().positive().nullable().optional(),
  recordBookings: z.boolean().optional(),
  pricePerHourFils: z.number().int().min(0).max(1_000_000),
  priceRules: z.array(ruleSchema).max(20).optional(),
  imageUrl: z.string().trim().url().max(500).nullable().optional(),
  active: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(1000).optional(),
});

async function checkField(a: Access, fieldId: number | null | undefined): Promise<boolean> {
  if (fieldId == null) return true;
  return (await cameraFields(a)).some((f) => f.id === fieldId);
}

router.post(`${base}/pitches`, async (req, res): Promise<void> => {
  const a = await access(req, res, true);
  if (!a) return;
  const body = pitchSchema.safeParse(req.body ?? {});
  if (!body.success) { res.status(400).json({ error: "Give the pitch a name and a price" }); return; }
  if (!(await checkField(a, body.data.fieldId))) { res.status(400).json({ error: "That camera isn't one of yours" }); return; }
  const [row] = await db.insert(venuePitchesTable).values({ ...body.data, priceRules: normaliseRules(body.data.priceRules ?? []), academyId: a.venue.id }).returning();
  res.status(201).json({ pitch: pitchView(row) });
});

router.patch(`${base}/pitches/:pitchId`, async (req, res): Promise<void> => {
  const a = await access(req, res, true);
  if (!a) return;
  const body = pitchSchema.partial().safeParse(req.body ?? {});
  if (!body.success) { res.status(400).json({ error: "Check the pitch details" }); return; }
  if (!(await checkField(a, body.data.fieldId))) { res.status(400).json({ error: "That camera isn't one of yours" }); return; }
  const patch = { ...body.data, ...(body.data.priceRules ? { priceRules: normaliseRules(body.data.priceRules) } : {}), updatedAt: new Date() };
  const [row] = await db.update(venuePitchesTable).set(patch).where(and(eq(venuePitchesTable.id, intParam(req.params.pitchId) ?? 0), eq(venuePitchesTable.academyId, a.venue.id))).returning();
  if (!row) { res.status(404).json({ error: "Pitch not found" }); return; }
  res.json({ pitch: pitchView(row) });
});

router.delete(`${base}/pitches/:pitchId`, async (req, res): Promise<void> => {
  const a = await access(req, res, true);
  if (!a) return;
  const id = intParam(req.params.pitchId) ?? 0;
  const [used] = await db.select({ id: venueBookingsTable.id }).from(venueBookingsTable).where(eq(venueBookingsTable.pitchId, id)).limit(1);
  if (used) {
    await db.update(venuePitchesTable).set({ active: false, updatedAt: new Date() }).where(and(eq(venuePitchesTable.id, id), eq(venuePitchesTable.academyId, a.venue.id)));
    res.json({ archived: true });
    return;
  }
  await db.delete(venuePitchesTable).where(and(eq(venuePitchesTable.id, id), eq(venuePitchesTable.academyId, a.venue.id)));
  res.json({ deleted: true });
});

const rulesSchema = z.object({
  bookingEnabled: z.boolean().optional(),
  openingHours: z.record(z.string(), z.object({ open: z.string(), close: z.string() }).nullable()).optional(),
  slotStepMinutes: z.number().int().refine((n) => [15, 30, 60].includes(n)).optional(),
  durations: z.array(z.number().int()).min(1).max(6).optional(),
  maxDaysAhead: z.number().int().min(1).max(90).optional(),
  minNoticeMinutes: z.number().int().min(0).max(24 * 60).optional(),
  holdMinutes: z.number().int().min(5).max(24 * 60).optional(),
});

router.put(`${base}/pitches/rules`, async (req, res): Promise<void> => {
  const a = await access(req, res, true);
  if (!a) return;
  const body = rulesSchema.safeParse(req.body ?? {});
  if (!body.success) { res.status(400).json({ error: "Check the booking rules" }); return; }
  const d = body.data;
  if (d.openingHours) {
    for (const v of Object.values(d.openingHours)) {
      if (v && (!isTime(v.open) || !isTime(v.close))) { res.status(400).json({ error: "Times are HH:MM" }); return; }
    }
  }
  await db.update(venueSettingsTable).set({
    ...(d.bookingEnabled !== undefined ? { bookingEnabled: d.bookingEnabled } : {}),
    ...(d.openingHours ? { openingHours: normaliseHours(d.openingHours) } : {}),
    ...(d.slotStepMinutes ? { slotStepMinutes: d.slotStepMinutes } : {}),
    ...(d.durations ? { durations: normaliseDurations(d.durations) } : {}),
    ...(d.maxDaysAhead ? { maxDaysAhead: d.maxDaysAhead } : {}),
    ...(d.minNoticeMinutes !== undefined ? { minNoticeMinutes: d.minNoticeMinutes } : {}),
    ...(d.holdMinutes ? { holdMinutes: d.holdMinutes } : {}),
    updatedAt: new Date(),
  }).where(eq(venueSettingsTable.academyId, a.venue.id));
  res.json({ settings: settingsView((await loadVenue(a.venue.id))!.settings) });
});

// ─── Payments ────────────────────────────────────────────────────────────────

router.get(`${base}/payments`, async (req, res): Promise<void> => {
  const a = await access(req, res, true);
  if (!a) return;
  const venueId = a.venue.id;
  const today = ammanLocal(new Date()).slice(0, 10);
  const monthStart = `${today.slice(0, 8)}01 00:00`;
  const [totals] = await db.select({
    month: sql<number>`coalesce(sum(${venueBookingsTable.paidFils}) filter (where ${venueBookingsTable.startLocal} >= ${monthStart}), 0)::int`,
    viaReplay: sql<number>`coalesce(sum(least(${venueBookingsTable.paidFils}, ${venueBookingsTable.dueOnlineFils})) filter (where ${venueBookingsTable.moneyTo} = 'replay' and ${venueBookingsTable.payWith} in ('cliq', 'card') and ${venueBookingsTable.paymentStatus} = 'paid'), 0)::int`,
    online: sql<number>`coalesce(sum(least(${venueBookingsTable.paidFils}, ${venueBookingsTable.dueOnlineFils})) filter (where ${venueBookingsTable.startLocal} >= ${monthStart} and ${venueBookingsTable.payWith} in ('cliq', 'card') and ${venueBookingsTable.paymentStatus} = 'paid'), 0)::int`,
    due: sql<number>`coalesce(sum(greatest(0, ${venueBookingsTable.amountFils} + ${venueBookingsTable.feeFils} - ${venueBookingsTable.paidFils})) filter (where ${venueBookingsTable.status} in ('confirmed', 'completed') and ${venueBookingsTable.startsAt} <= now()), 0)::int`,
  }).from(venueBookingsTable).where(and(eq(venueBookingsTable.academyId, venueId), sql`${venueBookingsTable.status} <> 'cancelled'`));
  const [owed] = await db.select({
    refunds: sql<number>`coalesce(sum(greatest(0, ${venueBookingsTable.refundDueFils} - ${venueBookingsTable.refundedFils})), 0)::int`,
    refundCount: sql<number>`count(*) filter (where ${venueBookingsTable.refundDueFils} > ${venueBookingsTable.refundedFils})::int`,
    fees: sql<number>`coalesce(sum(greatest(0, ${venueBookingsTable.feeFils} - ${venueBookingsTable.paidFils})) filter (where ${venueBookingsTable.status} in ('cancelled', 'no_show')), 0)::int`,
    feeCount: sql<number>`count(*) filter (where ${venueBookingsTable.status} in ('cancelled', 'no_show') and ${venueBookingsTable.feeFils} > ${venueBookingsTable.paidFils})::int`,
  }).from(venueBookingsTable).where(eq(venueBookingsTable.academyId, venueId));
  const [paidOut] = await db.select({ n: sql<number>`coalesce(sum(${venuePayoutsTable.amountFils}), 0)::int` }).from(venuePayoutsTable).where(eq(venuePayoutsTable.academyId, venueId));
  const payouts = await db.select().from(venuePayoutsTable).where(eq(venuePayoutsTable.academyId, venueId)).orderBy(desc(venuePayoutsTable.createdAt)).limit(50);
  const fee = Math.round((totals.viaReplay * a.venue.settings.replayFeeBps) / 10_000);
  const s = settingsView(a.venue.settings);
  res.json({
    settings: {
      moneyTo: s.moneyTo, cliqAlias: s.cliqAlias, cliqName: s.cliqName, payAtField: s.payAtField, depositMode: s.depositMode, depositFils: s.depositFils,
      cancelHours: s.cancelHours, autoConfirmReceipts: s.autoConfirmReceipts, cardProvider: s.cardProvider, cardEnabled: s.cardEnabled, cardConfigured: s.cardConfigured,
      replayFeeBps: s.replayFeeBps,
      ...rulesView(s),
    },
    preview: { en: rulesSummary(policyOf(a.venue.settings as unknown as Record<string, unknown>), "en"), ar: rulesSummary(policyOf(a.venue.settings as unknown as Record<string, unknown>), "ar") },
    ledger: {
      collectedThisMonthFils: totals.month,
      onlineThisMonthFils: totals.online,
      unpaidAfterPlayFils: totals.due,
      viaReplayFils: totals.viaReplay,
      replayFeeFils: fee,
      paidOutFils: paidOut.n,
      owedByReplayFils: Math.max(0, totals.viaReplay - fee - paidOut.n),
      refundsToSendFils: owed.refunds,
      refundsToSendCount: owed.refundCount,
      feesOwedFils: owed.fees,
      feesOwedCount: owed.feeCount,
      payouts: payouts.map((p) => ({ id: p.id, amountFils: p.amountFils, method: p.method, note: p.note, createdAt: p.createdAt.toISOString() })),
    },
  });
});

const paymentsSchema = z.object({
  moneyTo: z.enum(["venue", "replay"]).optional(),
  cliqAlias: z.string().trim().max(60).nullable().optional(),
  cliqName: z.string().trim().max(80).nullable().optional(),
  payAtField: z.boolean().optional(),
  depositMode: z.enum(["full", "deposit", "none"]).optional(),
  depositFils: z.number().int().min(0).max(1_000_000).optional(),
  cancelHours: z.number().int().min(0).max(168).optional(),
  autoConfirmReceipts: z.boolean().optional(),
  acceptCliq: z.boolean().optional(),
  depositPercent: z.number().int().min(0).max(100).optional(),
  newCustomerPolicy: z.enum(["same", "deposit", "full"]).optional(),
  noShowPolicy: z.enum(["same", "deposit", "full", "block"]).optional(),
  lateCancelMode: z.enum(["refuse", "free", "deposit", "percent", "fixed"]).optional(),
  lateCancelValue: z.number().int().min(0).max(1_000_000).optional(),
  noShowFeeMode: z.enum(["none", "deposit", "percent", "fixed"]).optional(),
  noShowFeeValue: z.number().int().min(0).max(1_000_000).optional(),
  allowChanges: z.boolean().optional(),
  changeHours: z.number().int().min(0).max(168).optional(),
  changeFeeFils: z.number().int().min(0).max(1_000_000).optional(),
  maxChanges: z.number().int().min(0).max(20).optional(),
});

router.put(`${base}/payments`, async (req, res): Promise<void> => {
  const a = await access(req, res, true);
  if (!a) return;
  const body = paymentsSchema.safeParse(req.body ?? {});
  if (!body.success) { res.status(400).json({ error: "Check the payment settings" }); return; }
  const next = { ...a.venue.settings, ...body.data };
  const cliq = next.acceptCliq !== false && (next.moneyTo === "replay" || Boolean(next.cliqAlias?.trim()));
  const card = Boolean(next.cardEnabled && next.cardConfigEnc);
  if (!next.payAtField && !cliq && !card) { res.status(400).json({ error: "Players need at least one way to pay: CliQ, card, or cash at the field", code: "no_method" }); return; }
  if (next.moneyTo === "venue" && next.acceptCliq !== false && next.depositMode !== "none" && !next.cliqAlias?.trim() && !card && !next.payAtField) {
    res.status(400).json({ error: "Add your CliQ alias, or allow paying at the field" }); return;
  }
  if ((body.data.lateCancelMode === "percent" || body.data.noShowFeeMode === "percent") && ((body.data.lateCancelMode === "percent" && (body.data.lateCancelValue ?? next.lateCancelValue) > 100) || (body.data.noShowFeeMode === "percent" && (body.data.noShowFeeValue ?? next.noShowFeeValue) > 100))) {
    res.status(400).json({ error: "A percentage can't be more than 100" }); return;
  }
  await db.update(venueSettingsTable).set({ ...body.data, updatedAt: new Date() }).where(eq(venueSettingsTable.academyId, a.venue.id));
  res.json({ ok: true });
});

const cardSchema = z.object({
  provider: z.literal("paytabs"),
  profileId: z.string().trim().max(20).optional(),
  serverKey: z.string().trim().max(200).optional(),
  region: z.enum(["jordan", "global", "uae", "ksa"]).optional(),
  enabled: z.boolean(),
});

router.put(`${base}/payments/card`, async (req, res): Promise<void> => {
  const a = await access(req, res, true);
  if (!a) return;
  const body = cardSchema.safeParse(req.body ?? {});
  if (!body.success) { res.status(400).json({ error: "Check the gateway details" }); return; }
  try {
    const sealed = body.data.serverKey ? sealCardConfig({ profileId: body.data.profileId ?? "", serverKey: body.data.serverKey, region: body.data.region }) : a.venue.settings.cardConfigEnc;
    if (body.data.enabled && !sealed) { res.status(400).json({ error: "Add the gateway keys first" }); return; }
    await db.update(venueSettingsTable).set({ cardProvider: "paytabs", cardConfigEnc: sealed, cardEnabled: body.data.enabled, updatedAt: new Date() }).where(eq(venueSettingsTable.academyId, a.venue.id));
    res.json({ ok: true });
  } catch (error) {
    fail(res, error, "Saving the gateway failed");
  }
});

router.delete(`${base}/payments/card`, async (req, res): Promise<void> => {
  const a = await access(req, res, true);
  if (!a) return;
  await db.update(venueSettingsTable).set({ cardProvider: "none", cardConfigEnc: null, cardEnabled: false, updatedAt: new Date() }).where(eq(venueSettingsTable.academyId, a.venue.id));
  res.json({ ok: true });
});

// ─── Booking agent ───────────────────────────────────────────────────────────

router.get(`${base}/agent`, async (req, res): Promise<void> => {
  const a = await access(req, res);
  if (!a) return;
  const s = settingsView(a.venue.settings);
  const threads = await db.select().from(venueAgentThreadsTable).where(eq(venueAgentThreadsTable.academyId, a.venue.id)).orderBy(desc(venueAgentThreadsTable.lastInAt)).limit(100);
  const since = new Date(Date.now() - 30 * 86_400_000);
  const [stats] = await db.select({
    chats: sql<number>`count(*) filter (where ${venueAgentThreadsTable.lastInAt} >= ${since})::int`,
    handovers: sql<number>`count(*) filter (where ${venueAgentThreadsTable.handoverAt} is not null)::int`,
  }).from(venueAgentThreadsTable).where(eq(venueAgentThreadsTable.academyId, a.venue.id));
  const [booked] = await db.select({ n: sql<number>`count(*)::int`, fils: sql<number>`coalesce(sum(${venueBookingsTable.amountFils}), 0)::int` }).from(venueBookingsTable).where(and(
    eq(venueBookingsTable.academyId, a.venue.id), eq(venueBookingsTable.source, "whatsapp"), inArray(venueBookingsTable.status, ["confirmed", "completed"]), gte(venueBookingsTable.createdAt, since),
  ));
  res.json({
    settings: { agentMode: s.agentMode, agentName: s.agentName, agentNotes: s.agentNotes, agentPauseMinutes: s.agentPauseMinutes, automations: s.automations },
    aiAvailable: Boolean(agentApiKey()),
    stats: { chats30d: stats.chats, handovers: stats.handovers, bookings30d: booked.n, bookedFils30d: booked.fils },
    threads: threads.map((t) => ({
      phone: t.phone,
      display: formatPhoneForDisplay(t.phone),
      lastInAt: t.lastInAt?.toISOString() ?? null,
      pausedUntil: t.pausedUntil && t.pausedUntil.getTime() > Date.now() ? t.pausedUntil.toISOString() : null,
      handoverAt: t.handoverAt?.toISOString() ?? null,
      turns: t.turns,
    })),
    isOwner: a.isOwner,
  });
});

const agentSchema = z.object({
  agentMode: z.enum(["off", "ai", "menu"]).optional(),
  agentName: z.string().trim().max(40).nullable().optional(),
  agentNotes: z.string().trim().max(4000).nullable().optional(),
  agentPauseMinutes: z.number().int().min(5).max(24 * 60).optional(),
  automations: z.record(z.string(), z.object({ enabled: z.boolean().optional(), hours: z.number().int().min(1).max(48).optional() })).optional(),
});

router.put(`${base}/agent`, async (req, res): Promise<void> => {
  const a = await access(req, res, true);
  if (!a) return;
  const body = agentSchema.safeParse(req.body ?? {});
  if (!body.success) { res.status(400).json({ error: "Check the agent settings" }); return; }
  const automations = body.data.automations ? venueAutomations({ ...(a.venue.settings.automations as object), ...body.data.automations }) : undefined;
  await db.update(venueSettingsTable).set({
    ...(body.data.agentMode ? { agentMode: body.data.agentMode } : {}),
    ...(body.data.agentName !== undefined ? { agentName: body.data.agentName || null } : {}),
    ...(body.data.agentNotes !== undefined ? { agentNotes: body.data.agentNotes || null } : {}),
    ...(body.data.agentPauseMinutes ? { agentPauseMinutes: body.data.agentPauseMinutes } : {}),
    ...(automations ? { automations } : {}),
    updatedAt: new Date(),
  }).where(eq(venueSettingsTable.academyId, a.venue.id));
  res.json({ ok: true });
});

/** The team is done with a chat: the agent may answer it again. */
router.post(`${base}/agent/threads/:phone/resume`, async (req, res): Promise<void> => {
  const a = await access(req, res);
  if (!a) return;
  const phone = normalizePhone(String(req.params.phone));
  if (!phone) { res.status(400).json({ error: "Invalid phone" }); return; }
  await db.update(venueAgentThreadsTable).set({ pausedUntil: null, handoverAt: null, state: {}, updatedAt: new Date() })
    .where(and(eq(venueAgentThreadsTable.academyId, a.venue.id), eq(venueAgentThreadsTable.phone, phone)));
  res.json({ ok: true });
});

/** Pause the agent in one chat (the team is handling it). */
router.post(`${base}/agent/threads/:phone/pause`, async (req, res): Promise<void> => {
  const a = await access(req, res);
  if (!a) return;
  const phone = normalizePhone(String(req.params.phone));
  if (!phone) { res.status(400).json({ error: "Invalid phone" }); return; }
  const hours = Math.max(1, Math.min(24 * 30, Number((req.body as { hours?: unknown })?.hours) || 24));
  await db.insert(venueAgentThreadsTable).values({ academyId: a.venue.id, phone, pausedUntil: new Date(Date.now() + hours * 3_600_000) })
    .onConflictDoUpdate({ target: [venueAgentThreadsTable.academyId, venueAgentThreadsTable.phone], set: { pausedUntil: new Date(Date.now() + hours * 3_600_000), updatedAt: new Date() } });
  res.json({ ok: true });
});

// ─── Website and domain ──────────────────────────────────────────────────────

router.get(`${base}/website`, async (req, res): Promise<void> => {
  const a = await access(req, res, true);
  if (!a) return;
  const s = settingsView(a.venue.settings);
  res.json({
    settings: {
      slug: s.slug, siteEnabled: s.siteEnabled, siteTagline: s.siteTagline, siteTaglineAr: s.siteTaglineAr, siteAbout: s.siteAbout, siteAboutAr: s.siteAboutAr,
      heroImageUrl: s.heroImageUrl, accentColor: s.accentColor, siteUrl: s.siteUrl,
      customDomain: s.customDomain, domainStatus: s.domainStatus, domainError: s.domainError, domainCheckedAt: s.domainCheckedAt,
    },
    dns: { type: "A", value: sitesIp(), hosts: ["@", "www"] },
  });
});

const websiteSchema = z.object({
  slug: z.string().trim().min(3).max(40).regex(/^[a-z0-9-]+$/).optional(),
  siteEnabled: z.boolean().optional(),
  siteTagline: z.string().trim().max(120).nullable().optional(),
  siteTaglineAr: z.string().trim().max(120).nullable().optional(),
  siteAbout: z.string().trim().max(2000).nullable().optional(),
  siteAboutAr: z.string().trim().max(2000).nullable().optional(),
  heroImageUrl: z.string().trim().url().max(500).nullable().optional(),
  accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
});

router.put(`${base}/website`, async (req, res): Promise<void> => {
  const a = await access(req, res, true);
  if (!a) return;
  const body = websiteSchema.safeParse(req.body ?? {});
  if (!body.success) { res.status(400).json({ error: "Check the website details (the address uses a–z, 0–9 and dashes)" }); return; }
  if (body.data.slug && body.data.slug !== a.venue.settings.slug) {
    const slug = slugify(body.data.slug);
    const [taken] = await db.select({ id: venueSettingsTable.academyId }).from(venueSettingsTable).where(eq(venueSettingsTable.slug, slug));
    if (taken && taken.id !== a.venue.id) { res.status(409).json({ error: "That address is taken" }); return; }
    body.data.slug = slug;
  }
  await db.update(venueSettingsTable).set({ ...body.data, updatedAt: new Date() }).where(eq(venueSettingsTable.academyId, a.venue.id));
  res.json({ ok: true });
});

router.put(`${base}/website/domain`, async (req, res): Promise<void> => {
  const a = await access(req, res, true);
  if (!a) return;
  const value = (req.body as { domain?: unknown })?.domain;
  try {
    await setDomain(a.venue.id, typeof value === "string" && value.trim() ? value : null);
    const result = typeof value === "string" && value.trim() ? await checkDomain(a.venue.id) : { status: "none", error: null, found: {} };
    res.json(result);
  } catch (error) {
    fail(res, error, "Saving the domain failed");
  }
});

router.post(`${base}/website/domain/check`, async (req, res): Promise<void> => {
  const a = await access(req, res, true);
  if (!a) return;
  res.json(await checkDomain(a.venue.id));
});

export default router;
