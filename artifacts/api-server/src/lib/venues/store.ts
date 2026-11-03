/**
 * Field console: venues, pitches and bookings in the database. Pure rules live in core.ts.
 *
 * A booking's life:
 *   held       — made online with something to pay first; holds the slot until holdExpiresAt.
 *   confirmed  — the slot is theirs (paid, deposit paid, pay-at-field, or made by staff).
 *   completed / no_show — after kick-off, set by staff.
 *   cancelled  — by staff, by the player, or a hold that lapsed.
 * Payment is tracked beside it: unpaid → receipt (a screenshot arrived) → paid, with paidFils
 * against amountFils (a deposit leaves a balance to collect at the field).
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { and, asc, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import {
  academiesTable,
  academyMembersTable,
  academyWhatsappMessagesTable,
  db,
  fieldsTable,
  footageRequestsTable,
  venueBookingsTable,
  venuePitchesTable,
  venueSettingsTable,
  type VenueBooking,
  type VenuePitch,
  type VenueSettings,
} from "@workspace/db";
import { loadCommerce } from "../commerce";
import { cancelFootageRequest, createFootageRequest, startCameraJob } from "../footageBooking";
import { logger } from "../logger";
import { normalizePhone } from "../whatsapp/phone";
import { upsertContact } from "../whatsapp/contacts";
import { mediaUrl } from "../whatsapp/media";
import { dispatchMessageNow, getWhatsappSettings, senderSessionFor } from "../whatsapp/queue";
import { publicBaseUrl } from "../whatsapp/waha";
import {
  DEFAULT_OPENING_HOURS,
  ammanLocal,
  bookingReference,
  checkRequest,
  formatJod,
  fromAmmanLocal,
  normaliseDurations,
  normaliseHours,
  normaliseRules,
  priceFor,
  slotsFor,
  slugify,
  wallMinutes,
  wallString,
  type Busy,
  type OpeningHours,
} from "./core";
import { balanceOf, cancelQuote, changeQuote, noShowQuote, policyOf, requirement, type History, type Policy } from "./rules";
import { consentForNewBooking, consentMode } from "./igConsent";
import {
  cancelledMessage,
  changedMessage,
  confirmedMessage,
  dayLabel,
  expiredMessage,
  paidMessage,
  paymentInstructions,
  reminderMessage,
  timeLabel,
  videoReadyMessage,
  type BookingFacts,
  type Locale,
} from "./messages";

export const BLOCKING_STATUSES = ["held", "confirmed", "completed"] as const;
const ACTIVE_FOOTAGE = ["queued", "running", "scheduled", "recording"] as const;
const FOOTAGE_HOLD = [...ACTIVE_FOOTAGE, "awaiting_payment"] as const;
/** pg_advisory_xact_lock(namespace, pitchId): one booking at a time per pitch. */
const PITCH_LOCK = 7743;

export class VenueError extends Error {
  constructor(message: string, readonly status = 400, readonly code?: string) {
    super(message);
  }
}

// ─── Secrets (card gateway credentials) ───────────────────────────────────────

function secretKey(): Buffer {
  const base = process.env.VENUE_SECRET_KEY?.trim() || process.env.CONTABO_CONTROL_KEY?.trim() || "";
  if (!base) throw new VenueError("Payments secret key is not set on the server", 503);
  return createHash("sha256").update(`venue-secrets:${base}`).digest();
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", secretKey(), iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), body.toString("base64url")].join(".");
}

export function decryptSecret(stored: string): string {
  const [v, iv, tag, body] = stored.split(".");
  if (v !== "v1" || !iv || !tag || !body) throw new Error("Unreadable stored secret");
  const decipher = createDecipheriv("aes-256-gcm", secretKey(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8");
}

// ─── Venues ───────────────────────────────────────────────────────────────────

export type Venue = { id: number; name: string; nameAr: string | null; fieldId: number; logoUrl: string | null; settings: VenueSettings };

export async function isVenue(academyId: number): Promise<boolean> {
  const [row] = await db.select({ kind: academiesTable.kind }).from(academiesTable).where(eq(academiesTable.id, academyId));
  return row?.kind === "venue";
}

async function uniqueSlug(name: string): Promise<string> {
  const base = slugify(name);
  for (let i = 0; i < 50; i += 1) {
    const candidate = i === 0 ? base : `${base}-${i + 1}`;
    const [taken] = await db.select({ id: venueSettingsTable.academyId }).from(venueSettingsTable).where(eq(venueSettingsTable.slug, candidate));
    if (!taken) return candidate;
  }
  return `${base}-${randomBytes(3).toString("hex")}`;
}

/** The venue's settings row, created with defaults the first time. */
export async function ensureSettings(academyId: number, name: string): Promise<VenueSettings> {
  const [existing] = await db.select().from(venueSettingsTable).where(eq(venueSettingsTable.academyId, academyId));
  if (existing) return existing;
  const [created] = await db.insert(venueSettingsTable).values({
    academyId,
    slug: await uniqueSlug(name),
    openingHours: DEFAULT_OPENING_HOURS,
  }).onConflictDoNothing().returning();
  if (created) return created;
  const [again] = await db.select().from(venueSettingsTable).where(eq(venueSettingsTable.academyId, academyId));
  return again!;
}

export async function loadVenue(academyId: number): Promise<Venue | null> {
  const [academy] = await db.select().from(academiesTable).where(eq(academiesTable.id, academyId));
  if (!academy || academy.kind !== "venue") return null;
  const settings = await ensureSettings(academy.id, academy.name);
  return { id: academy.id, name: academy.name, nameAr: academy.nameAr, fieldId: academy.fieldId, logoUrl: academy.logoUrl, settings };
}

export async function venueBySlug(slug: string): Promise<Venue | null> {
  const [row] = await db.select({ academyId: venueSettingsTable.academyId }).from(venueSettingsTable).where(eq(venueSettingsTable.slug, slug.toLowerCase()));
  return row ? loadVenue(row.academyId) : null;
}

export async function venueByDomain(host: string): Promise<Venue | null> {
  const clean = host.toLowerCase().replace(/:\d+$/, "").replace(/^www\./, "");
  const [row] = await db.select({ academyId: venueSettingsTable.academyId }).from(venueSettingsTable)
    .where(or(eq(venueSettingsTable.customDomain, clean), eq(venueSettingsTable.customDomain, `www.${clean}`)));
  return row ? loadVenue(row.academyId) : null;
}

/**
 * Turn a field into a venue run by `ownerUserId`: one `academies` row (kind venue) on the
 * field, the owner as its owner, and a pitch for each field given (with its camera).
 */
export async function createVenue(input: { name: string; fieldIds: number[]; ownerUserId: number }): Promise<Venue> {
  if (!input.fieldIds.length) throw new VenueError("Pick at least one field");
  const fields = await db.select().from(fieldsTable).where(inArray(fieldsTable.id, input.fieldIds));
  if (!fields.length) throw new VenueError("Field not found", 404);
  const id = await db.transaction(async (tx) => {
    const [academy] = await tx.insert(academiesTable).values({
      name: input.name.trim().slice(0, 120) || fields[0].name,
      kind: "venue",
      fieldId: fields[0].id,
    }).returning({ id: academiesTable.id });
    await tx.insert(academyMembersTable).values({ userId: input.ownerUserId, academyId: academy.id, role: "owner" }).onConflictDoNothing();
    await tx.insert(venuePitchesTable).values(fields.map((f, i) => ({
      academyId: academy.id,
      name: f.name,
      fieldId: f.id,
      recordBookings: Boolean(f.cameraId),
      sortOrder: i,
    })));
    return academy.id;
  });
  const venue = await loadVenue(id);
  return venue!;
}

/** Venues a user belongs to, with their roles. */
export async function venueMemberships(userId: number): Promise<Array<{ academyId: number; academyName: string; roles: string[] }>> {
  const rows = await db.select({ academyId: academiesTable.id, academyName: academiesTable.name, role: academyMembersTable.role })
    .from(academyMembersTable)
    .innerJoin(academiesTable, eq(academiesTable.id, academyMembersTable.academyId))
    .where(and(eq(academyMembersTable.userId, userId), eq(academiesTable.kind, "venue")))
    .orderBy(asc(academiesTable.name));
  const order = ["owner", "manager", "coach"];
  const map = new Map<number, { academyId: number; academyName: string; roles: string[] }>();
  for (const r of rows) {
    const m = map.get(r.academyId) ?? { academyId: r.academyId, academyName: r.academyName, roles: [] };
    m.roles.push(r.role);
    map.set(r.academyId, m);
  }
  return [...map.values()].map((m) => ({ ...m, roles: m.roles.sort((a, b) => order.indexOf(a) - order.indexOf(b)) }));
}

async function venueOwnerId(academyId: number): Promise<number | null> {
  const [row] = await db.select({ userId: academyMembersTable.userId }).from(academyMembersTable)
    .where(and(eq(academyMembersTable.academyId, academyId), eq(academyMembersTable.role, "owner")))
    .orderBy(asc(academyMembersTable.id)).limit(1);
  return row?.userId ?? null;
}

/** How a player pays this venue: whose CliQ, and whether a card link can be made. */
export async function paymentTarget(settings: VenueSettings): Promise<{ alias: string | null; aliasName: string | null; card: boolean }> {
  if (settings.moneyTo === "replay") {
    const commerce = await loadCommerce({});
    return { alias: settings.acceptCliq === false ? null : commerce.cliqAlias, aliasName: "Replay", card: false };
  }
  return { alias: settings.acceptCliq === false ? null : settings.cliqAlias?.trim() || null, aliasName: settings.cliqName?.trim() || null, card: settings.cardEnabled && settings.cardProvider !== "none" && Boolean(settings.cardConfigEnc) };
}

// ─── Pitches and availability ────────────────────────────────────────────────

export async function listPitches(academyId: number, onlyActive = false): Promise<VenuePitch[]> {
  return db.select().from(venuePitchesTable)
    .where(onlyActive ? and(eq(venuePitchesTable.academyId, academyId), eq(venuePitchesTable.active, true)) : eq(venuePitchesTable.academyId, academyId))
    .orderBy(asc(venuePitchesTable.sortOrder), asc(venuePitchesTable.id));
}

/** Bookings that hold time on these pitches between two instants (lapsed holds don't). */
export async function busyFor(pitchIds: number[], from: Date, to: Date, exceptId?: number): Promise<Map<number, Busy[]>> {
  const out = new Map<number, Busy[]>();
  if (!pitchIds.length) return out;
  const rows = await db.select({
    id: venueBookingsTable.id,
    pitchId: venueBookingsTable.pitchId,
    startLocal: venueBookingsTable.startLocal,
    endLocal: venueBookingsTable.endLocal,
    status: venueBookingsTable.status,
    holdExpiresAt: venueBookingsTable.holdExpiresAt,
  }).from(venueBookingsTable).where(and(
    inArray(venueBookingsTable.pitchId, pitchIds),
    inArray(venueBookingsTable.status, [...BLOCKING_STATUSES]),
    lt(venueBookingsTable.startsAt, to),
    gt(venueBookingsTable.endsAt, from),
    exceptId ? ne(venueBookingsTable.id, exceptId) : sql`true`,
  ));
  const now = Date.now();
  for (const r of rows) {
    if (r.status === "held" && r.holdExpiresAt && r.holdExpiresAt.getTime() <= now) continue;
    const list = out.get(r.pitchId) ?? [];
    list.push({ start: wallMinutes(r.startLocal), end: wallMinutes(r.endLocal) });
    out.set(r.pitchId, list);
  }
  return out;
}

export function nowWallMinute(): number {
  return wallMinutes(ammanLocal(new Date()));
}

/** Free kick-offs on a business day, pitch by pitch. */
export async function availability(venue: Venue, date: string, pitchId?: number) {
  const s = venue.settings;
  const hours = normaliseHours(s.openingHours);
  const durations = normaliseDurations(s.durations);
  const pitches = (await listPitches(venue.id, true)).filter((p) => !pitchId || p.id === pitchId);
  const from = fromAmmanLocal(`${date} 00:00`)!;
  const to = new Date(from.getTime() + 2 * 86_400_000);
  const busy = await busyFor(pitches.map((p) => p.id), from, to);
  const now = nowWallMinute();
  const tooFar = wallMinutes(`${date} 00:00`) > now + s.maxDaysAhead * 1440;
  return pitches.map((p) => ({
    pitchId: p.id,
    name: p.name,
    nameAr: p.nameAr,
    size: p.size,
    slots: tooFar ? [] : slotsFor({
      date,
      hours,
      stepMinutes: s.slotStepMinutes,
      durations,
      busy: busy.get(p.id) ?? [],
      pitch: p,
      nowMinute: now,
      minNoticeMinutes: s.minNoticeMinutes,
    }),
  }));
}

// ─── Bookings ────────────────────────────────────────────────────────────────

export type NewBooking = {
  pitchId: number;
  startLocal: string;
  minutes: number;
  customerName?: string | null;
  customerPhone?: string | null;
  teamName?: string | null;
  notes?: string | null;
  source: "console" | "whatsapp" | "website" | "app";
  /**
   * Instagram: the captain's answer (site, WhatsApp) or the front desk's switch. Undefined: not
   * asked. What is stored depends on the field's consent mode (igConsent.consentForNewBooking).
   */
  igConsent?: boolean | null;
  /** Players under 18 in this booking: it is never posted. */
  under18?: boolean;
  /** cliq / card: pay online first (held). field: pay at the field. none: staff booking, nothing to collect online. */
  payWith: "cliq" | "card" | "field" | "none";
  staff?: boolean;
  createdBy?: number | null;
  /** Staff: the same slot every week for this many weeks (1 = just this one). */
  repeatWeeks?: number;
  /** Staff: override the price (fils). */
  amountFils?: number | null;
  /** Staff: already paid in full. */
  paid?: boolean;
  /** Send the WhatsApp confirmation / payment message. */
  notify?: boolean;
};

export async function createBookings(venue: Venue, input: NewBooking): Promise<VenueBooking[]> {
  const s = venue.settings;
  if (!input.staff && !s.bookingEnabled) throw new VenueError("Online booking is closed right now", 403, "closed");
  const [pitch] = await db.select().from(venuePitchesTable).where(and(eq(venuePitchesTable.id, input.pitchId), eq(venuePitchesTable.academyId, venue.id)));
  if (!pitch || (!pitch.active && !input.staff)) throw new VenueError("Pitch not found", 404);
  const hours = normaliseHours(s.openingHours);
  const durations = normaliseDurations(s.durations);
  const weeks = input.staff ? Math.max(1, Math.min(26, Math.floor(input.repeatWeeks ?? 1))) : 1;
  const phone = input.customerPhone ? normalizePhone(input.customerPhone) : null;
  if (input.customerPhone && !phone) throw new VenueError("That phone number doesn't look right");
  if (!input.staff && !phone) throw new VenueError("A WhatsApp number is needed to book");
  const target = await paymentTarget(s);
  const policy = policyOf(s as unknown as Record<string, unknown>);
  // Staff book under the standard rules; a player's history can ask for more up front.
  const history: History = !input.staff && phone ? await customerHistory(venue.id, phone) : { played: 1, noShows: 0 };
  let payWith = input.payWith;
  if (payWith === "card" && !target.card) throw new VenueError("Card payment isn't available here");
  if (payWith === "cliq" && !target.alias) {
    if (input.staff) payWith = "none";
    else throw new VenueError("Online payment isn't set up yet. Pay at the field instead.");
  }

  const seriesId = weeks > 1 ? randomBytes(8).toString("hex") : null;
  const ig = consentForNewBooking(consentMode(s.igConsentMode), { answer: input.igConsent, source: input.source });
  const created: VenueBooking[] = [];
  const now = nowWallMinute();
  for (let w = 0; w < weeks; w += 1) {
    const startLocal = wallString(wallMinutes(input.startLocal) + w * 7 * 1440);
    const check = checkRequest({
      startLocal,
      minutes: input.minutes,
      hours,
      stepMinutes: s.slotStepMinutes,
      durations,
      nowMinute: now,
      minNoticeMinutes: s.minNoticeMinutes,
      maxDaysAhead: input.staff ? 400 : s.maxDaysAhead,
      staff: input.staff,
    });
    if (!check.ok) {
      if (w === 0) throw new VenueError(check.error);
      continue; // a later week that falls on a closed day is skipped
    }
    const endLocal = wallString(wallMinutes(startLocal) + input.minutes);
    const startsAt = fromAmmanLocal(startLocal)!;
    const endsAt = fromAmmanLocal(endLocal)!;
    const amountFils = input.amountFils != null && input.staff ? Math.max(0, Math.round(input.amountFils)) : priceFor(pitch, startLocal, input.minutes);
    const req = requirement(policy, history, amountFils, { cliq: Boolean(target.alias), card: target.card });
    if (!input.staff) {
      if (req.blocked) throw new VenueError("Please message the field to book.", 403, "blocked");
      if (payWith === "field" && !req.fieldAllowed) {
        throw new VenueError(req.minimumOnlineFils > 0
          ? `This booking needs ${formatJod(req.minimumOnlineFils)} paid online first`
          : "Paying at the field isn't available here", 409, req.minimumOnlineFils > 0 ? "deposit_required" : "field_off");
      }
    }
    const online = payWith === "cliq" || payWith === "card" ? (req.onlineDueFils || (input.staff ? amountFils : 0)) : 0;
    const held = !input.staff && online > 0;
    const row = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${PITCH_LOCK}, ${pitch.id})`);
      const clash = await tx.select({ id: venueBookingsTable.id, status: venueBookingsTable.status, holdExpiresAt: venueBookingsTable.holdExpiresAt })
        .from(venueBookingsTable).where(and(
          eq(venueBookingsTable.pitchId, pitch.id),
          inArray(venueBookingsTable.status, [...BLOCKING_STATUSES]),
          lt(venueBookingsTable.startsAt, endsAt),
          gt(venueBookingsTable.endsAt, startsAt),
        ));
      if (clash.some((c) => c.status !== "held" || !c.holdExpiresAt || c.holdExpiresAt.getTime() > Date.now())) return null;
      const [inserted] = await tx.insert(venueBookingsTable).values({
        academyId: venue.id,
        pitchId: pitch.id,
        startsAt,
        endsAt,
        startLocal,
        endLocal,
        status: held ? "held" : "confirmed",
        paymentStatus: input.paid ? "paid" : "unpaid",
        payWith: online > 0 ? payWith : payWith === "field" ? "field" : "none",
        moneyTo: s.moneyTo,
        amountFils,
        dueOnlineFils: online,
        paidFils: input.paid ? amountFils : 0,
        reference: bookingReference(venue.name),
        customerName: input.customerName?.trim().slice(0, 80) || null,
        customerPhone: phone,
        teamName: input.teamName?.trim().slice(0, 80) || null,
        notes: input.notes?.trim().slice(0, 1000) || null,
        source: input.source,
        seriesId,
        policy: { ...policy, reason: req.reason },
        holdExpiresAt: held ? new Date(Date.now() + Math.max(5, s.holdMinutes) * 60_000) : null,
        confirmedAt: held ? null : new Date(),
        paidAt: input.paid ? new Date() : null,
        paidBy: input.paid ? input.createdBy ?? null : null,
        createdBy: input.createdBy ?? null,
        igConsent: ig.igConsent,
        igConsentSource: ig.igConsentSource,
        igConsentAt: ig.igConsent ? new Date() : null,
        under18: Boolean(input.under18),
      }).returning();
      return inserted;
    });
    if (!row) {
      if (w === 0) throw new VenueError("Someone already booked that time", 409, "taken");
      continue;
    }
    created.push(row);
  }
  if (!created.length) throw new VenueError("None of those weeks are free", 409, "taken");

  if (phone) {
    try {
      const contact = await upsertContact(venue.id, phone, { kind: "player", source: "booking", name: input.customerName ?? null });
      await db.update(venueBookingsTable).set({ contactId: contact.id }).where(inArray(venueBookingsTable.id, created.map((b) => b.id)));
    } catch (error) {
      logger.warn({ venueId: venue.id, error: (error as Error).message }, "Linking a booking to People failed");
    }
  }
  for (const b of created) {
    if (b.status === "confirmed") await bookFootage(venue, b).catch((error) => logger.warn({ bookingId: b.id, error: (error as Error).message }, "Booking the camera failed"));
  }
  const first = created[0];
  if (input.notify !== false && phone) {
    if (first.status === "held") {
      if (payWith === "card") await attachCardLink(venue, first).catch((error) => logger.warn({ bookingId: first.id, error: (error as Error).message }, "Card link failed"));
      await notify(venue, first.id, "held");
    } else {
      await notify(venue, first.id, "confirmed");
    }
  }
  return db.select().from(venueBookingsTable).where(inArray(venueBookingsTable.id, created.map((b) => b.id))).orderBy(asc(venueBookingsTable.startsAt));
}

export async function getBooking(venueId: number, bookingId: number): Promise<VenueBooking | null> {
  const [row] = await db.select().from(venueBookingsTable).where(and(eq(venueBookingsTable.id, bookingId), eq(venueBookingsTable.academyId, venueId)));
  return row ?? null;
}

/** Payment came in (CliQ confirmed, card callback, or cash at the field). */
export async function markPaid(venue: Venue, booking: VenueBooking, by: number | null, options: { full?: boolean; notify?: boolean } = {}): Promise<VenueBooking> {
  if (booking.status === "cancelled") throw new VenueError("This booking was cancelled", 409);
  const paidFils = options.full ? booking.amountFils + booking.feeFils : Math.max(booking.paidFils, booking.dueOnlineFils || booking.amountFils);
  const [row] = await db.update(venueBookingsTable).set({
    paymentStatus: "paid",
    paidFils,
    paidAt: new Date(),
    paidBy: by,
    status: booking.status === "held" ? "confirmed" : booking.status,
    confirmedAt: booking.confirmedAt ?? new Date(),
    holdExpiresAt: null,
    updatedAt: new Date(),
  }).where(eq(venueBookingsTable.id, booking.id)).returning();
  if (booking.status === "held") await bookFootage(venue, row).catch((error) => logger.warn({ bookingId: row.id, error: (error as Error).message }, "Booking the camera failed"));
  if (options.notify !== false && booking.status === "held") await notify(venue, row.id, "paid");
  return (await getBooking(venue.id, row.id))!;
}

/** Hold a slot confirmed without payment (the owner trusts them). */
export async function confirmWithoutPayment(venue: Venue, booking: VenueBooking): Promise<VenueBooking> {
  if (booking.status !== "held") return booking;
  const [row] = await db.update(venueBookingsTable).set({ status: "confirmed", confirmedAt: new Date(), holdExpiresAt: null, updatedAt: new Date() })
    .where(eq(venueBookingsTable.id, booking.id)).returning();
  await bookFootage(venue, row).catch(() => undefined);
  await notify(venue, row.id, "confirmed");
  return (await getBooking(venue.id, row.id))!;
}

/**
 * Cancel a booking. `by` decides the money: the field (or the system, for a lapsed hold)
 * owes back everything paid; a player cancelling late pays the field's late-cancel fee, and
 * is refused when the rule is "ask the field".
 */
export async function cancelBooking(venue: Venue, booking: VenueBooking, reason: string, options: { notify?: boolean; lapsed?: boolean; by?: "field" | "player" | "system" } = {}): Promise<VenueBooking> {
  if (booking.status === "cancelled") return booking;
  const by = options.by ?? (options.lapsed ? "system" : "field");
  const quote = cancelQuote(bookingPolicy(venue, booking), moneyOf(booking), by === "player" ? "player" : "field");
  if (!quote.allowed) throw new VenueError(`Too close to kick-off to cancel online (less than ${bookingPolicy(venue, booking).cancelHours} hours). Message the field.`, 409, "too_late");
  const [row] = await db.update(venueBookingsTable).set({
    status: "cancelled",
    cancelledAt: new Date(),
    cancelReason: reason.slice(0, 200),
    cancelledBy: by,
    feeFils: booking.feeFils + quote.feeFils,
    feeReason: quote.feeFils > 0 ? "late_cancel" : booking.feeReason,
    refundDueFils: quote.refundFils,
    holdExpiresAt: null,
    updatedAt: new Date(),
  }).where(and(eq(venueBookingsTable.id, booking.id), ne(venueBookingsTable.status, "cancelled"))).returning();
  if (!row) return (await getBooking(venue.id, booking.id))!;
  await releaseFootage(row).catch((error) => logger.warn({ bookingId: row.id, error: (error as Error).message }, "Cancelling the camera failed"));
  if (options.notify !== false) await notify(venue, row.id, options.lapsed ? "expired" : "cancelled");
  return row;
}

/** Staff (or, through changeByPlayer, the player) move a booking to another time, length or pitch. */
export async function moveBooking(venue: Venue, booking: VenueBooking, next: { pitchId?: number; startLocal?: string; minutes?: number; amountFils?: number | null }, options: { player?: boolean } = {}): Promise<VenueBooking> {
  if (booking.status === "cancelled") throw new VenueError("This booking was cancelled", 409);
  const pitchId = next.pitchId ?? booking.pitchId;
  const startLocal = next.startLocal ?? booking.startLocal;
  const minutes = next.minutes ?? wallMinutes(booking.endLocal) - wallMinutes(booking.startLocal);
  const [pitch] = await db.select().from(venuePitchesTable).where(and(eq(venuePitchesTable.id, pitchId), eq(venuePitchesTable.academyId, venue.id)));
  if (!pitch) throw new VenueError("Pitch not found", 404);
  const check = checkRequest({
    startLocal, minutes, hours: normaliseHours(venue.settings.openingHours), stepMinutes: venue.settings.slotStepMinutes,
    durations: normaliseDurations(venue.settings.durations), nowMinute: nowWallMinute(),
    minNoticeMinutes: options.player ? venue.settings.minNoticeMinutes : 0, maxDaysAhead: options.player ? venue.settings.maxDaysAhead : 400, staff: !options.player,
  });
  if (!check.ok) throw new VenueError(check.error);
  const endLocal = wallString(wallMinutes(startLocal) + minutes);
  const startsAt = fromAmmanLocal(startLocal)!;
  const endsAt = fromAmmanLocal(endLocal)!;
  const timeChanged = startLocal !== booking.startLocal || endLocal !== booking.endLocal || pitchId !== booking.pitchId;
  const amountFils = next.amountFils != null ? Math.max(0, Math.round(next.amountFils)) : timeChanged ? priceFor(pitch, startLocal, minutes) : booking.amountFils;
  const row = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${PITCH_LOCK}, ${pitch.id})`);
    const clash = await tx.select({ id: venueBookingsTable.id, status: venueBookingsTable.status, holdExpiresAt: venueBookingsTable.holdExpiresAt }).from(venueBookingsTable).where(and(
      eq(venueBookingsTable.pitchId, pitch.id), ne(venueBookingsTable.id, booking.id),
      inArray(venueBookingsTable.status, [...BLOCKING_STATUSES]), lt(venueBookingsTable.startsAt, endsAt), gt(venueBookingsTable.endsAt, startsAt),
    ));
    if (clash.some((c) => c.status !== "held" || !c.holdExpiresAt || c.holdExpiresAt.getTime() > Date.now())) return null;
    const [updated] = await tx.update(venueBookingsTable).set({ pitchId, startLocal, endLocal, startsAt, endsAt, amountFils, remindedAt: timeChanged ? null : booking.remindedAt, updatedAt: new Date() })
      .where(eq(venueBookingsTable.id, booking.id)).returning();
    return updated;
  });
  if (!row) throw new VenueError("Someone already booked that time", 409, "taken");
  if (timeChanged && row.status === "confirmed") {
    await releaseFootage(booking).catch(() => undefined);
    await db.update(venueBookingsTable).set({ footageRequestId: null, footageNote: null }).where(eq(venueBookingsTable.id, row.id));
    await bookFootage(venue, { ...row, footageRequestId: null }).catch(() => undefined);
  }
  return (await getBooking(venue.id, row.id))!;
}

// ─── Rules: history, quotes, no-shows, changes ───────────────────────────────

/** Games this number has played here (confirmed or played, already started) and its no-shows. */
export async function customerHistory(venueId: number, phone: string): Promise<History> {
  const [row] = await db.select({
    played: sql<number>`count(*) filter (where ${venueBookingsTable.status} in ('confirmed', 'completed') and ${venueBookingsTable.startsAt} <= now())::int`,
    noShows: sql<number>`count(*) filter (where ${venueBookingsTable.status} = 'no_show')::int`,
  }).from(venueBookingsTable).where(and(eq(venueBookingsTable.academyId, venueId), eq(venueBookingsTable.customerPhone, phone)));
  return { played: row?.played ?? 0, noShows: row?.noShows ?? 0 };
}

/** The rules a booking was made under (older bookings: the field's current rules). */
export function bookingPolicy(venue: Venue, booking: VenueBooking): Policy {
  const stored = booking.policy as Record<string, unknown> | null;
  return policyOf(stored ?? (venue.settings as unknown as Record<string, unknown>));
}

export function moneyOf(b: VenueBooking) {
  return { amountFils: b.amountFils, paidFils: b.paidFils, dueOnlineFils: b.dueOnlineFils, feeFils: b.feeFils, startsAt: b.startsAt, changeCount: b.changeCount, status: b.status };
}

/** What a player would pay, and how they may pay, for a slot. Used before booking on the site and by the agent. */
export async function quoteFor(venue: Venue, input: { phone: string | null; pitchId: number; startLocal: string; minutes: number }) {
  const [pitch] = await db.select().from(venuePitchesTable).where(and(eq(venuePitchesTable.id, input.pitchId), eq(venuePitchesTable.academyId, venue.id)));
  if (!pitch) throw new VenueError("Pitch not found", 404);
  const phone = input.phone ? normalizePhone(input.phone) : null;
  const history = phone ? await customerHistory(venue.id, phone) : { played: 0, noShows: 0 };
  const amountFils = priceFor(pitch, input.startLocal, input.minutes);
  const target = await paymentTarget(venue.settings);
  const policy = policyOf(venue.settings as unknown as Record<string, unknown>);
  const req = requirement(policy, history, amountFils, { cliq: Boolean(target.alias), card: target.card });
  return {
    amountFils,
    onlineDueFils: req.onlineDueFils,
    minimumOnlineFils: req.minimumOnlineFils,
    reason: req.reason,
    blocked: req.blocked,
    methods: {
      cliq: Boolean(target.alias) && !req.blocked && (req.onlineDueFils > 0 || policy.depositMode !== "none"),
      card: target.card && !req.blocked,
      field: req.fieldAllowed && !req.blocked,
    },
    newCustomer: history.played === 0,
  };
}

/** Staff mark a no-show: the field's no-show fee applies. */
export async function markNoShow(venue: Venue, booking: VenueBooking): Promise<VenueBooking> {
  if (booking.status === "cancelled") throw new VenueError("This booking was cancelled", 409);
  const q = noShowQuote(bookingPolicy(venue, booking), moneyOf(booking));
  const [row] = await db.update(venueBookingsTable).set({
    status: "no_show",
    feeFils: Math.max(booking.feeFils, q.feeFils),
    feeReason: q.feeFils > 0 ? "no_show" : booking.feeReason,
    updatedAt: new Date(),
  }).where(eq(venueBookingsTable.id, booking.id)).returning();
  return row;
}

/** A player moves their own booking: only inside the field's change rules, and the change fee is added. */
export async function changeByPlayer(venue: Venue, booking: VenueBooking, next: { pitchId?: number; startLocal: string; minutes?: number }): Promise<VenueBooking> {
  const q = changeQuote(bookingPolicy(venue, booking), moneyOf(booking));
  if (!q.allowed) {
    const policy = bookingPolicy(venue, booking);
    const why = q.reason === "off" ? "This field doesn't take changes online. Message the field."
      : q.reason === "too_many" ? "This booking can't be changed again online. Message the field."
      : q.reason === "too_late" ? `Changes close ${policy.changeHours} hours before kick-off. Message the field.`
      : "This booking can't be changed.";
    throw new VenueError(why, 409, `change_${q.reason}`);
  }
  const moved = await moveBooking(venue, booking, { pitchId: next.pitchId, startLocal: next.startLocal, minutes: next.minutes }, { player: true });
  const extraRefund = Math.max(0, moved.paidFils - (moved.amountFils + booking.feeFils + q.feeFils));
  const [row] = await db.update(venueBookingsTable).set({
    changeCount: booking.changeCount + 1,
    feeFils: booking.feeFils + q.feeFils,
    feeReason: q.feeFils > 0 ? "change" : booking.feeReason,
    refundDueFils: booking.refundDueFils + extraRefund,
    updatedAt: new Date(),
  }).where(eq(venueBookingsTable.id, booking.id)).returning();
  await notify(venue, row.id, "changed");
  return row;
}

// ─── Camera ──────────────────────────────────────────────────────────────────

/** Book Replay's camera for a confirmed booking on a camera pitch. Billed on the owner's footage ledger. */
export async function bookFootage(venue: Venue, booking: VenueBooking): Promise<void> {
  if (booking.footageRequestId || booking.status !== "confirmed") return;
  const [pitch] = await db.select().from(venuePitchesTable).where(eq(venuePitchesTable.id, booking.pitchId));
  if (!pitch?.fieldId || !pitch.recordBookings) return;
  const [field] = await db.select().from(fieldsTable).where(eq(fieldsTable.id, pitch.fieldId));
  const cameraId = field?.cameraId?.trim();
  const note = async (text: string) => { await db.update(venueBookingsTable).set({ footageNote: text }).where(eq(venueBookingsTable.id, booking.id)); };
  if (!field || !cameraId) return note("This pitch has no camera");
  if (booking.startsAt.getTime() < Date.now() - 5 * 60_000) return note("Booked after kick-off: not recorded");
  const holding = await db.select({ id: footageRequestsTable.id, startLocal: footageRequestsTable.startLocal, endLocal: footageRequestsTable.endLocal })
    .from(footageRequestsTable).where(and(
      or(eq(footageRequestsTable.fieldId, field.id), eq(footageRequestsTable.cameraId, cameraId)),
      inArray(footageRequestsTable.status, [...FOOTAGE_HOLD]),
    ));
  const s = wallMinutes(booking.startLocal);
  const e = wallMinutes(booking.endLocal);
  const covering = holding.find((h) => wallMinutes(h.startLocal) <= s && wallMinutes(h.endLocal) >= e);
  if (covering) {
    await db.update(venueBookingsTable).set({ footageRequestId: covering.id, footageNote: null }).where(eq(venueBookingsTable.id, booking.id));
    return;
  }
  if (holding.some((h) => wallMinutes(h.startLocal) < e && s < wallMinutes(h.endLocal))) return note("The camera is already booked for part of this time");
  const owner = await venueOwnerId(venue.id);
  if (!owner) return note("No owner on this field account");
  const commerce = await loadCommerce({ userId: owner, fieldId: field.id });
  const created = await createFootageRequest({
    fieldId: field.id,
    cameraId,
    requestedBy: owner,
    startLocal: booking.startLocal,
    endLocal: booking.endLocal,
    requestedSeconds: (e - s) * 60,
    rateFils: commerce.ownerFootageFilsPerHour,
    academyId: null,
    status: "scheduled",
  }, { startJob: false });
  await db.update(venueBookingsTable).set({ footageRequestId: created.id, footageNote: null }).where(eq(venueBookingsTable.id, booking.id));
  await startCameraJob(created, cameraId, { pan: false });
}

async function releaseFootage(booking: VenueBooking): Promise<void> {
  if (!booking.footageRequestId) return;
  const others = await db.select({ id: venueBookingsTable.id }).from(venueBookingsTable).where(and(
    eq(venueBookingsTable.footageRequestId, booking.footageRequestId), ne(venueBookingsTable.id, booking.id), ne(venueBookingsTable.status, "cancelled"),
  )).limit(1);
  if (others.length) return;
  const [footage] = await db.select().from(footageRequestsTable).where(eq(footageRequestsTable.id, booking.footageRequestId));
  if (!footage || !(ACTIVE_FOOTAGE as readonly string[]).includes(footage.status)) return;
  // Only a recording that hasn't started yet is given back; one already rolling is kept.
  if (footage.status !== "scheduled" && footage.status !== "queued") return;
  await cancelFootageRequest(footage, { allowedStatuses: ["queued", "scheduled"], message: "Cancelled with the pitch booking" });
}

// ─── Card links ──────────────────────────────────────────────────────────────

export async function attachCardLink(venue: Venue, booking: VenueBooking): Promise<string | null> {
  const { createCardPayment } = await import("./payments");
  const link = await createCardPayment(venue, booking);
  if (!link) return null;
  await db.update(venueBookingsTable).set({ cardRef: link.ref, cardUrl: link.url }).where(eq(venueBookingsTable.id, booking.id));
  return link.url;
}

// ─── Messages ────────────────────────────────────────────────────────────────

export type NotifyKind = "held" | "confirmed" | "paid" | "cancelled" | "expired" | "reminder" | "video" | "changed";

const AUTOMATION_FOR: Record<NotifyKind, string | null> = {
  held: null, // payment instructions always go: the booking can't be kept without them
  confirmed: "confirmed",
  paid: "paid",
  cancelled: "cancelled",
  expired: "expiring",
  reminder: "reminder",
  video: "videoReady",
  changed: "confirmed",
};

export type VenueAutomations = {
  confirmed: { enabled: boolean };
  paid: { enabled: boolean };
  cancelled: { enabled: boolean };
  expiring: { enabled: boolean };
  reminder: { enabled: boolean; hours: number };
  videoReady: { enabled: boolean };
};

export function venueAutomations(value: unknown): VenueAutomations {
  const v = (value && typeof value === "object" ? value : {}) as Record<string, { enabled?: unknown; hours?: unknown }>;
  const on = (key: string) => v[key]?.enabled !== false;
  const hours = Number(v.reminder?.hours);
  return {
    confirmed: { enabled: on("confirmed") },
    paid: { enabled: on("paid") },
    cancelled: { enabled: on("cancelled") },
    expiring: { enabled: on("expiring") },
    reminder: { enabled: on("reminder"), hours: Number.isFinite(hours) && hours >= 1 && hours <= 48 ? Math.round(hours) : 3 },
    videoReady: { enabled: on("videoReady") },
  };
}

export async function bookingFacts(venue: Venue, booking: VenueBooking, locale: Locale): Promise<BookingFacts> {
  const [pitch] = await db.select().from(venuePitchesTable).where(eq(venuePitchesTable.id, booking.pitchId));
  const target = await paymentTarget(venue.settings);
  let link: string | null = null;
  if (booking.footageRequestId) {
    const [f] = await db.select({ shareToken: footageRequestsTable.shareToken, status: footageRequestsTable.status }).from(footageRequestsTable).where(eq(footageRequestsTable.id, booking.footageRequestId));
    if (f?.shareToken && (f.status === "ready" || f.status === "partial")) link = `${publicBaseUrl()}/w/${f.shareToken}`;
  }
  const hold = booking.holdExpiresAt ? ammanLocal(booking.holdExpiresAt).slice(11) : null;
  return {
    venue: locale === "ar" ? venue.nameAr || venue.name : venue.name,
    name: booking.customerName,
    pitch: (locale === "ar" ? pitch?.nameAr || pitch?.name : pitch?.name) ?? "",
    day: dayLabel(booking.startLocal.slice(0, 10), locale),
    time: timeLabel(booking.startLocal.slice(11), locale),
    minutes: wallMinutes(booking.endLocal) - wallMinutes(booking.startLocal),
    amountFils: booking.amountFils,
    dueOnlineFils: booking.dueOnlineFils,
    reference: booking.reference,
    alias: booking.moneyTo === "replay" ? (await loadCommerce({})).cliqAlias : target.alias,
    aliasName: booking.moneyTo === "replay" ? "Replay" : target.aliasName,
    holdUntil: hold ? timeLabel(hold, locale) : null,
    cardUrl: booking.cardUrl,
    balanceFils: booking.status === "cancelled" ? Math.max(0, booking.feeFils - booking.paidFils) : balanceOf(booking),
    link,
    feeFils: booking.feeFils,
    refundFils: Math.max(0, booking.refundDueFils - booking.refundedFils),
    reason: ((booking.policy as { reason?: string } | null)?.reason as BookingFacts["reason"]) ?? "standard",
  };
}

/** Put a message in the venue's WhatsApp queue and try to send it now. */
export async function sendVenueMessage(venueId: number, phone: string, kind: string, body: string, dedupeKey: string | null): Promise<number | null> {
  const settings = await getWhatsappSettings(venueId);
  if (!senderSessionFor(settings)) return null;
  const [row] = await db.insert(academyWhatsappMessagesTable).values({
    academyId: venueId,
    kind,
    phone,
    body,
    dedupeKey,
  }).onConflictDoNothing().returning({ id: academyWhatsappMessagesTable.id });
  if (!row) return null;
  await dispatchMessageNow(row.id).catch(() => "queued");
  return row.id;
}

export async function notify(venue: Venue, bookingId: number, kind: NotifyKind): Promise<void> {
  try {
    const booking = await getBooking(venue.id, bookingId);
    if (!booking?.customerPhone) return;
    const automation = AUTOMATION_FOR[kind];
    if (automation && !venueAutomations(venue.settings.automations)[automation as keyof VenueAutomations].enabled) return;
    const wa = await getWhatsappSettings(venue.id);
    const locale: Locale = wa.locale === "en" ? "en" : "ar";
    const f = await bookingFacts(venue, booking, locale);
    const body = kind === "held" ? paymentInstructions(f, locale)
      : kind === "confirmed" ? confirmedMessage(f, locale)
      : kind === "paid" ? paidMessage(f, locale)
      : kind === "cancelled" ? cancelledMessage(f, locale)
      : kind === "expired" ? expiredMessage(f, locale)
      : kind === "reminder" ? reminderMessage(f, locale)
      : kind === "changed" ? changedMessage(f, locale)
      : f.link ? videoReadyMessage(f, locale) : null;
    if (!body) return;
    const dedupe = kind === "held" || kind === "changed" ? `v${venue.id}:b${booking.id}:${kind}:${booking.updatedAt.getTime()}` : `v${venue.id}:b${booking.id}:${kind}${kind === "reminder" ? `:${booking.startLocal}` : ""}`;
    await sendVenueMessage(venue.id, booking.customerPhone, `booking_${kind}`, body, dedupe);
  } catch (error) {
    logger.warn({ venueId: venue.id, bookingId, kind, error: (error as Error).message }, "Booking message failed");
  }
}

// ─── Every minute (from the WhatsApp tick) ───────────────────────────────────

let lastTick = 0;

export async function runVenueTick(): Promise<{ lapsed: number; reminded: number; videos: number }> {
  if (Date.now() - lastTick < 50_000) return { lapsed: 0, reminded: 0, videos: 0 };
  lastTick = Date.now();
  const out = { lapsed: 0, reminded: 0, videos: 0 };
  const venues = new Map<number, Venue | null>();
  const venueFor = async (id: number) => {
    if (!venues.has(id)) venues.set(id, await loadVenue(id));
    return venues.get(id) ?? null;
  };
  // Holds that ran out without payment (a receipt that arrived keeps it a little longer: the owner is checking).
  const lapsed = await db.select().from(venueBookingsTable).where(and(
    eq(venueBookingsTable.status, "held"),
    isNotNull(venueBookingsTable.holdExpiresAt),
    lte(venueBookingsTable.holdExpiresAt, new Date()),
    ne(venueBookingsTable.paymentStatus, "receipt"),
  )).limit(100);
  for (const b of lapsed) {
    const venue = await venueFor(b.academyId);
    if (!venue) continue;
    await cancelBooking(venue, b, "Payment not received in time", { lapsed: true });
    out.lapsed += 1;
  }
  // Reminders: up to 48 h ahead, filtered per venue by its own lead time.
  const soon = await db.select().from(venueBookingsTable).where(and(
    eq(venueBookingsTable.status, "confirmed"),
    isNull(venueBookingsTable.remindedAt),
    isNotNull(venueBookingsTable.customerPhone),
    gt(venueBookingsTable.startsAt, new Date()),
    lt(venueBookingsTable.startsAt, new Date(Date.now() + 48 * 3_600_000)),
  )).limit(300);
  for (const b of soon) {
    const venue = await venueFor(b.academyId);
    if (!venue) continue;
    const auto = venueAutomations(venue.settings.automations).reminder;
    if (b.startsAt.getTime() - Date.now() > auto.hours * 3_600_000) continue;
    // Booked inside the reminder window: they just got a confirmation, no reminder needed.
    if (b.createdAt.getTime() > b.startsAt.getTime() - auto.hours * 3_600_000) {
      await db.update(venueBookingsTable).set({ remindedAt: new Date() }).where(eq(venueBookingsTable.id, b.id));
      continue;
    }
    await db.update(venueBookingsTable).set({ remindedAt: new Date() }).where(eq(venueBookingsTable.id, b.id));
    if (auto.enabled) {
      await notify(venue, b.id, "reminder");
      out.reminded += 1;
    }
  }
  // Recordings that came back: send the booker the link once.
  const recorded = await db.select({ b: venueBookingsTable, status: footageRequestsTable.status, token: footageRequestsTable.shareToken })
    .from(venueBookingsTable)
    .innerJoin(footageRequestsTable, eq(footageRequestsTable.id, venueBookingsTable.footageRequestId))
    .where(and(
      isNull(venueBookingsTable.videoSentAt),
      isNotNull(venueBookingsTable.customerPhone),
      inArray(footageRequestsTable.status, ["ready", "partial"]),
      isNotNull(footageRequestsTable.shareToken),
      gte(venueBookingsTable.startsAt, new Date(Date.now() - 3 * 86_400_000)),
    )).limit(100);
  for (const { b } of recorded) {
    const venue = await venueFor(b.academyId);
    if (!venue) continue;
    await db.update(venueBookingsTable).set({ videoSentAt: new Date() }).where(eq(venueBookingsTable.id, b.id));
    await notify(venue, b.id, "video");
    out.videos += 1;
  }
  return out;
}

// ─── Views ───────────────────────────────────────────────────────────────────

export function bookingView(b: VenueBooking, pitches?: Map<number, VenuePitch>) {
  const pitch = pitches?.get(b.pitchId);
  return {
    id: b.id,
    pitchId: b.pitchId,
    pitchName: pitch?.name ?? null,
    pitchNameAr: pitch?.nameAr ?? null,
    startLocal: b.startLocal,
    endLocal: b.endLocal,
    minutes: wallMinutes(b.endLocal) - wallMinutes(b.startLocal),
    status: b.status,
    paymentStatus: b.paymentStatus,
    payWith: b.payWith,
    moneyTo: b.moneyTo,
    amountFils: b.amountFils,
    dueOnlineFils: b.dueOnlineFils,
    paidFils: b.paidFils,
    balanceFils: b.status === "cancelled" || b.status === "no_show" ? Math.max(0, b.feeFils - b.paidFils) : balanceOf(b),
    feeFils: b.feeFils,
    feeReason: b.feeReason,
    refundDueFils: Math.max(0, b.refundDueFils - b.refundedFils),
    refundedFils: b.refundedFils,
    changeCount: b.changeCount,
    cancelledBy: b.cancelledBy,
    depositReason: ((b.policy as { reason?: string } | null)?.reason ?? "standard"),
    reference: b.reference,
    customerName: b.customerName,
    customerPhone: b.customerPhone,
    contactId: b.contactId,
    teamName: b.teamName,
    notes: b.notes,
    source: b.source,
    seriesId: b.seriesId,
    holdExpiresAt: b.holdExpiresAt?.toISOString() ?? null,
    footageRequestId: b.footageRequestId,
    footageNote: b.footageNote,
    receiptUrl: mediaUrl(b.receiptPath ? { path: b.receiptPath } : null),
    receiptPath: b.receiptPath,
    receiptCheck: b.receiptCheck,
    cardUrl: b.cardUrl,
    cancelReason: b.cancelReason,
    igConsent: b.igConsent,
    igConsentSource: b.igConsentSource,
    under18: b.under18,
    createdAt: b.createdAt.toISOString(),
  };
}

export function pitchView(p: VenuePitch, cameraFieldIds?: Set<number>) {
  return {
    id: p.id,
    name: p.name,
    nameAr: p.nameAr,
    size: p.size,
    surface: p.surface,
    indoor: p.indoor,
    fieldId: p.fieldId,
    hasCamera: p.fieldId != null && (cameraFieldIds ? cameraFieldIds.has(p.fieldId) : false),
    recordBookings: p.recordBookings,
    pricePerHourFils: p.pricePerHourFils,
    priceRules: normaliseRules(p.priceRules),
    imageUrl: p.imageUrl,
    active: p.active,
    sortOrder: p.sortOrder,
  };
}

/** The booking-rule settings (Payments → Booking rules), as the console edits them. */
export function rulesView(s: Pick<VenueSettings, "acceptCliq" | "depositPercent" | "newCustomerPolicy" | "noShowPolicy" | "lateCancelMode" | "lateCancelValue" | "noShowFeeMode" | "noShowFeeValue" | "allowChanges" | "changeHours" | "changeFeeFils" | "maxChanges">) {
  const p = policyOf(s as unknown as Record<string, unknown>);
  return {
    acceptCliq: p.acceptCliq,
    depositPercent: p.depositPercent,
    newCustomerPolicy: p.newCustomerPolicy,
    noShowPolicy: p.noShowPolicy,
    lateCancelMode: p.lateCancelMode,
    lateCancelValue: p.lateCancelValue,
    noShowFeeMode: p.noShowFeeMode,
    noShowFeeValue: p.noShowFeeValue,
    allowChanges: p.allowChanges,
    changeHours: p.changeHours,
    changeFeeFils: p.changeFeeFils,
    maxChanges: p.maxChanges,
  };
}

export function settingsView(s: VenueSettings, options: { admin?: boolean } = {}) {
  return {
    slug: s.slug,
    bookingEnabled: s.bookingEnabled,
    openingHours: normaliseHours(s.openingHours) as OpeningHours,
    slotStepMinutes: s.slotStepMinutes,
    durations: normaliseDurations(s.durations),
    maxDaysAhead: s.maxDaysAhead,
    minNoticeMinutes: s.minNoticeMinutes,
    holdMinutes: s.holdMinutes,
    moneyTo: s.moneyTo,
    cliqAlias: s.cliqAlias,
    cliqName: s.cliqName,
    payAtField: s.payAtField,
    depositMode: s.depositMode,
    depositFils: s.depositFils,
    cancelHours: s.cancelHours,
    ...rulesView(s),
    autoConfirmReceipts: s.autoConfirmReceipts,
    replayFeeBps: s.replayFeeBps,
    cardProvider: s.cardProvider,
    cardEnabled: s.cardEnabled,
    cardConfigured: Boolean(s.cardConfigEnc),
    agentMode: s.agentMode,
    agentName: s.agentName,
    agentNotes: s.agentNotes,
    agentPauseMinutes: s.agentPauseMinutes,
    automations: venueAutomations(s.automations),
    siteEnabled: s.siteEnabled,
    siteTagline: s.siteTagline,
    siteTaglineAr: s.siteTaglineAr,
    siteAbout: s.siteAbout,
    siteAboutAr: s.siteAboutAr,
    heroImageUrl: s.heroImageUrl,
    accentColor: s.accentColor,
    customDomain: s.customDomain,
    domainStatus: s.domainStatus,
    domainToken: s.domainToken,
    domainCheckedAt: s.domainCheckedAt?.toISOString() ?? null,
    domainError: s.domainError,
    siteUrl: `${publicBaseUrl()}/v/${s.slug}`,
    /** Instagram consent (set by Replay in Admin); the owner sees it, the booking forms follow it. */
    igConsentMode: consentMode(s.igConsentMode),
    igConsentWording: s.igConsentWording,
    ...(options.admin ? {} : {}),
  };
}

/** Booking count, last booking, money and no-shows per phone: the CRM's view of each customer. */
export async function customerStats(venueId: number): Promise<Map<string, { bookings: number; lastStartLocal: string | null; nextStartLocal: string | null; spentFils: number; noShows: number; cancelled: number; owedFils: number }>> {
  const rows = await db.select({
    phone: venueBookingsTable.customerPhone,
    bookings: sql<number>`count(*) filter (where ${venueBookingsTable.status} in ('confirmed', 'completed'))::int`,
    last: sql<string | null>`max(${venueBookingsTable.startLocal}) filter (where ${venueBookingsTable.status} in ('confirmed', 'completed') and ${venueBookingsTable.startsAt} <= now())`,
    next: sql<string | null>`min(${venueBookingsTable.startLocal}) filter (where ${venueBookingsTable.status} in ('confirmed', 'held') and ${venueBookingsTable.startsAt} > now())`,
    spent: sql<number>`coalesce(sum(${venueBookingsTable.paidFils}) filter (where ${venueBookingsTable.status} <> 'cancelled'), 0)::int`,
    noShows: sql<number>`count(*) filter (where ${venueBookingsTable.status} = 'no_show')::int`,
    cancelled: sql<number>`count(*) filter (where ${venueBookingsTable.status} = 'cancelled')::int`,
    owed: sql<number>`coalesce(sum(greatest(0, ${venueBookingsTable.feeFils} - ${venueBookingsTable.paidFils})) filter (where ${venueBookingsTable.status} in ('cancelled', 'no_show')), 0)::int`,
  }).from(venueBookingsTable)
    .where(and(eq(venueBookingsTable.academyId, venueId), isNotNull(venueBookingsTable.customerPhone)))
    .groupBy(venueBookingsTable.customerPhone);
  return new Map(rows.map((r) => [r.phone!, { bookings: r.bookings, lastStartLocal: r.last, nextStartLocal: r.next, spentFils: r.spent, noShows: r.noShows, cancelled: r.cancelled, owedFils: r.owed }]));
}
