import { and, eq } from "drizzle-orm";
import { Router, type IRouter, type Request, type Response } from "express";
import QRCode from "qrcode";
import { z } from "zod";
import { academiesTable, db, fieldsTable, venueBookingsTable } from "@workspace/db";
import { logger } from "../lib/logger";
import { normalizePhone } from "../lib/whatsapp/phone";
import { publicBaseUrl } from "../lib/whatsapp/waha";
import { getWhatsappSettings } from "../lib/whatsapp/queue";
import { addDays, ammanLocal, isDate, normaliseDurations, normaliseHours, normaliseRules } from "../lib/venues/core";
import {
  VenueError,
  availability,
  bookingFacts,
  bookingPolicy,
  cancelBooking,
  changeByPlayer,
  createBookings,
  listPitches,
  loadVenue,
  markPaid,
  moneyOf,
  paymentTarget,
  quoteFor,
  venueByDomain,
  venueBySlug,
  type Venue,
} from "../lib/venues/store";
import { domainAllowed } from "../lib/venues/domains";
import { balanceOf, cancelQuote, changeQuote, policyOf, requirement, rulesSummary } from "../lib/venues/rules";
import { bookingByReference, verifyCardPayment } from "../lib/venues/payments";

/**
 * A field's public booking website: replayjo.com/v/<slug>, or the field's own domain (the
 * web app reads the hostname and asks /venue-site/by-host). No sign-in: a booking needs a
 * name and a WhatsApp number, and its confirmation and payment details go to WhatsApp.
 */
const router: IRouter = Router();

// A few bookings per person per hour is plenty; this stops a script from holding every slot.
const attempts = new Map<string, number[]>();
function limited(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const list = (attempts.get(key) ?? []).filter((t) => now - t < windowMs);
  list.push(now);
  attempts.set(key, list);
  if (attempts.size > 5000) for (const [k, v] of attempts) if (!v.some((t) => now - t < windowMs)) attempts.delete(k);
  return list.length > max;
}

function clientIp(req: Request): string {
  const forwarded = String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim();
  return forwarded || req.ip || "unknown";
}

async function site(venue: Venue) {
  const s = venue.settings;
  const policy = policyOf(s as unknown as Record<string, unknown>);
  const [academy] = await db.select().from(academiesTable).where(eq(academiesTable.id, venue.id));
  const [field] = await db.select({ lat: fieldsTable.latitude, lng: fieldsTable.longitude, location: fieldsTable.location, thumbnailUrl: fieldsTable.thumbnailUrl })
    .from(fieldsTable).where(eq(fieldsTable.id, venue.fieldId));
  const pitches = (await listPitches(venue.id, true)).map((p) => ({
    id: p.id, name: p.name, nameAr: p.nameAr, size: p.size, surface: p.surface, indoor: p.indoor,
    pricePerHourFils: p.pricePerHourFils, priceRules: normaliseRules(p.priceRules), imageUrl: p.imageUrl, hasCamera: p.fieldId != null && p.recordBookings,
  }));
  const target = await paymentTarget(s);
  const wa = await getWhatsappSettings(venue.id).catch(() => null);
  return {
    id: venue.id,
    slug: s.slug,
    name: venue.name,
    nameAr: venue.nameAr,
    logoUrl: venue.logoUrl,
    tagline: s.siteTagline,
    taglineAr: s.siteTaglineAr,
    about: s.siteAbout,
    aboutAr: s.siteAboutAr,
    heroImageUrl: s.heroImageUrl ?? field?.thumbnailUrl ?? null,
    accentColor: s.accentColor,
    address: academy?.address || field?.location || null,
    latitude: academy?.latitude ?? field?.lat ?? null,
    longitude: academy?.longitude ?? field?.lng ?? null,
    instagramUrl: academy?.instagramUrl ?? null,
    facebookUrl: academy?.facebookUrl ?? null,
    whatsappPhone: wa?.connectedPhone || academy?.whatsappPhone || academy?.contactPhone || null,
    fieldId: venue.fieldId,
    bookingEnabled: s.bookingEnabled,
    openingHours: normaliseHours(s.openingHours),
    durations: normaliseDurations(s.durations),
    maxDaysAhead: s.maxDaysAhead,
    pitches,
    payment: {
      cliq: Boolean(target.alias) && s.depositMode !== "none",
      card: target.card && s.depositMode !== "none",
      // For a returning player in good standing; the quote narrows it per phone number.
      field: requirement(policy, { played: 1, noShows: 0 }, 10_000, { cliq: Boolean(target.alias), card: target.card }).fieldAllowed,
      depositMode: s.depositMode,
      depositFils: s.depositFils,
      depositPercent: policy.depositPercent,
      cancelHours: s.cancelHours,
      /** A first-time or past no-show player may be asked for more online: ask for a quote once the phone is in. */
      perPlayer: policy.newCustomerPolicy !== "same" || policy.noShowPolicy !== "same",
      allowChanges: policy.allowChanges && policy.maxChanges > 0,
    },
    rules: { en: rulesSummary(policy, "en"), ar: rulesSummary(policy, "ar") },
    today: ammanLocal(new Date()).slice(0, 10),
  };
}

async function venueFromSlug(req: Request, res: Response): Promise<Venue | null> {
  const venue = await venueBySlug(String(req.params.slug ?? ""));
  if (!venue || !venue.settings.siteEnabled) {
    res.status(404).json({ error: "Not found" });
    return null;
  }
  return venue;
}

router.get("/venue-site/domain-allowed", async (req, res): Promise<void> => {
  const domain = typeof req.query.domain === "string" ? req.query.domain : "";
  const ok = await domainAllowed(domain).catch(() => false);
  res.status(ok ? 200 : 404).send(ok ? "ok" : "no");
});

router.get("/venue-site/by-host", async (req, res): Promise<void> => {
  const host = typeof req.query.host === "string" ? req.query.host : "";
  const venue = host ? await venueByDomain(host) : null;
  if (!venue || !venue.settings.siteEnabled) { res.status(404).json({ error: "Not found" }); return; }
  res.setHeader("Cache-Control", "public, max-age=60");
  res.json(await site(venue));
});

router.get("/venue-site/:slug", async (req, res): Promise<void> => {
  const venue = await venueFromSlug(req, res);
  if (!venue) return;
  res.setHeader("Cache-Control", "public, max-age=60");
  res.json(await site(venue));
});

/** A QR code of the booking page, for a poster at the field. */
router.get("/venue-site/:slug/qr.png", async (req, res): Promise<void> => {
  const venue = await venueFromSlug(req, res);
  if (!venue) return;
  const s = venue.settings;
  const url = s.customDomain && s.domainStatus === "live" ? `https://${s.customDomain}` : `${publicBaseUrl()}/v/${s.slug}`;
  const png = await QRCode.toBuffer(url, { width: 720, margin: 2, errorCorrectionLevel: "M" });
  res.setHeader("Content-Type", "image/png");
  res.setHeader("Cache-Control", "public, max-age=300");
  res.send(png);
});

router.get("/venue-site/:slug/availability", async (req, res): Promise<void> => {
  const venue = await venueFromSlug(req, res);
  if (!venue) return;
  const today = ammanLocal(new Date()).slice(0, 10);
  const date = isDate(req.query.date) ? req.query.date : today;
  if (date < addDays(today, -1)) { res.json({ date, pitches: [] }); return; }
  res.setHeader("Cache-Control", "no-store");
  const pitches = await availability(venue, date);
  // The public only needs what's free.
  res.json({
    date,
    pitches: pitches.map((p) => ({
      ...p,
      slots: p.slots.filter((s) => s.available).map((s) => ({ ...s, options: s.options.filter((o) => o.available) })),
    })),
  });
});

const bookSchema = z.object({
  pitchId: z.number().int().positive(),
  startLocal: z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/),
  minutes: z.number().int().min(30).max(360),
  name: z.string().trim().min(2).max(80),
  phone: z.string().trim().min(7).max(30),
  teamName: z.string().trim().max(80).optional(),
  payWith: z.enum(["cliq", "card", "field"]),
  /** A hidden field people don't fill in; bots do. */
  website: z.string().max(0).optional(),
});

router.post("/venue-site/:slug/bookings", async (req, res): Promise<void> => {
  const venue = await venueFromSlug(req, res);
  if (!venue) return;
  const body = bookSchema.safeParse(req.body ?? {});
  if (!body.success) { res.status(400).json({ error: "Fill in your name, your WhatsApp number and a time" }); return; }
  const phone = normalizePhone(body.data.phone);
  if (!phone) { res.status(400).json({ error: "That WhatsApp number doesn't look right" }); return; }
  if (limited(`ip:${clientIp(req)}`, 8, 3_600_000) || limited(`phone:${venue.id}:${phone}`, 4, 3_600_000)) {
    res.status(429).json({ error: "Too many bookings from here. Message the field on WhatsApp instead." });
    return;
  }
  try {
    const [booking] = await createBookings(venue, {
      pitchId: body.data.pitchId,
      startLocal: body.data.startLocal,
      minutes: body.data.minutes,
      customerName: body.data.name,
      customerPhone: phone,
      teamName: body.data.teamName ?? null,
      source: "website",
      payWith: body.data.payWith,
      notify: true,
    });
    res.status(201).json(await publicBooking(venue, booking.reference));
  } catch (error) {
    if (error instanceof VenueError) { res.status(error.status).json({ error: error.message, code: error.code }); return; }
    logger.warn({ error: (error as Error)?.message }, "Website booking failed");
    res.status(500).json({ error: "Booking failed. Try again or message the field on WhatsApp." });
  }
});

async function publicBooking(venue: Venue, reference: string) {
  const [b] = await db.select().from(venueBookingsTable).where(and(eq(venueBookingsTable.academyId, venue.id), eq(venueBookingsTable.reference, reference)));
  if (!b) return null;
  const facts = await bookingFacts(venue, b, "en");
  const ar = await bookingFacts(venue, b, "ar");
  return {
    pitchNameAr: ar.pitch,
    reference: b.reference,
    status: b.status,
    paymentStatus: b.paymentStatus,
    pitchName: facts.pitch,
    startLocal: b.startLocal,
    endLocal: b.endLocal,
    amountFils: b.amountFils,
    dueOnlineFils: b.dueOnlineFils,
    balanceFils: b.status === "cancelled" || b.status === "no_show" ? Math.max(0, b.feeFils - b.paidFils) : balanceOf(b),
    feeFils: b.feeFils,
    refundFils: Math.max(0, b.refundDueFils - b.refundedFils),
    depositReason: (b.policy as { reason?: string } | null)?.reason ?? "standard",
    payWith: b.payWith,
    cliqAlias: b.payWith === "cliq" ? facts.alias : null,
    cliqName: b.payWith === "cliq" ? facts.aliasName : null,
    cardUrl: b.cardUrl,
    holdExpiresAt: b.holdExpiresAt?.toISOString() ?? null,
  };
}

const quoteSchema = z.object({
  pitchId: z.number().int().positive(),
  startLocal: z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/),
  minutes: z.number().int().min(30).max(360),
  phone: z.string().trim().max(30).optional(),
});

/** What this player pays for this slot, and how: a first booking may need a deposit online. */
router.post("/venue-site/:slug/quote", async (req, res): Promise<void> => {
  const venue = await venueFromSlug(req, res);
  if (!venue) return;
  const body = quoteSchema.safeParse(req.body ?? {});
  if (!body.success) { res.status(400).json({ error: "Pick a time" }); return; }
  if (limited(`quote:${clientIp(req)}`, 60, 600_000)) { res.status(429).json({ error: "Slow down a little" }); return; }
  try {
    const q = await quoteFor(venue, { phone: body.data.phone ? normalizePhone(body.data.phone) : null, pitchId: body.data.pitchId, startLocal: body.data.startLocal, minutes: body.data.minutes });
    // Don't tell a stranger whether a number has booked here: only what to pay.
    res.json({ amountFils: q.amountFils, onlineDueFils: q.onlineDueFils, minimumOnlineFils: q.minimumOnlineFils, reason: q.reason === "standard" ? "standard" : "rule", methods: q.methods, blocked: q.blocked });
  } catch (error) {
    if (error instanceof VenueError) { res.status(error.status).json({ error: error.message, code: error.code }); return; }
    res.status(500).json({ error: "That didn't work" });
  }
});

const manageSchema = z.object({
  reference: z.string().trim().min(4).max(20),
  phone: z.string().trim().min(7).max(30),
});

/** "Manage my booking": the booking code and the WhatsApp number it was made with, together. */
async function managed(req: Request, res: Response): Promise<{ venue: Venue; booking: typeof venueBookingsTable.$inferSelect } | null> {
  const venue = await venueFromSlug(req, res);
  if (!venue) return null;
  const body = manageSchema.safeParse(req.body ?? {});
  if (!body.success) { res.status(400).json({ error: "Enter your booking code and WhatsApp number" }); return null; }
  if (limited(`manage:${clientIp(req)}`, 20, 3_600_000)) { res.status(429).json({ error: "Too many tries. Message the field on WhatsApp." }); return null; }
  const phone = normalizePhone(body.data.phone);
  const [booking] = phone ? await db.select().from(venueBookingsTable).where(and(
    eq(venueBookingsTable.academyId, venue.id), eq(venueBookingsTable.reference, body.data.reference.toUpperCase()), eq(venueBookingsTable.customerPhone, phone),
  )) : [];
  if (!booking) { res.status(404).json({ error: "No booking with that code and number" }); return null; }
  return { venue, booking };
}

async function manageView(venue: Venue, booking: typeof venueBookingsTable.$inferSelect) {
  const policy = bookingPolicy(venue, booking);
  const cq = cancelQuote(policy, moneyOf(booking), "player");
  const ch = changeQuote(policy, moneyOf(booking));
  const active = booking.status === "held" || booking.status === "confirmed";
  return {
    booking: await publicBooking(venue, booking.reference),
    minutes: (Date.parse(`${booking.endLocal.replace(" ", "T")}:00Z`) - Date.parse(`${booking.startLocal.replace(" ", "T")}:00Z`)) / 60_000,
    pitchId: booking.pitchId,
    cancel: active ? { allowed: cq.allowed, late: cq.late, feeFils: cq.feeFils, refundFils: cq.refundFils, owedFils: cq.owedFils, hours: policy.cancelHours } : { allowed: false, late: false, feeFils: 0, refundFils: 0, owedFils: 0, hours: policy.cancelHours },
    change: { allowed: active && ch.allowed, reason: active ? ch.reason : "not_active", feeFils: ch.feeFils, changesLeft: ch.changesLeft, hours: policy.changeHours },
  };
}

router.post("/venue-site/:slug/manage", async (req, res): Promise<void> => {
  const m = await managed(req, res);
  if (!m) return;
  res.setHeader("Cache-Control", "no-store");
  res.json(await manageView(m.venue, m.booking));
});

router.post("/venue-site/:slug/manage/cancel", async (req, res): Promise<void> => {
  const m = await managed(req, res);
  if (!m) return;
  if (!["held", "confirmed"].includes(m.booking.status)) { res.status(409).json({ error: "This booking can't be cancelled" }); return; }
  try {
    const row = await cancelBooking(m.venue, m.booking, "Cancelled by the player on the website", { by: "player" });
    res.json(await manageView(m.venue, row));
  } catch (error) {
    if (error instanceof VenueError) { res.status(error.status).json({ error: error.message, code: error.code }); return; }
    res.status(500).json({ error: "That didn't work" });
  }
});

const changeSchema = manageSchema.extend({
  startLocal: z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/),
  pitchId: z.number().int().positive().optional(),
  minutes: z.number().int().min(30).max(360).optional(),
});

router.post("/venue-site/:slug/manage/change", async (req, res): Promise<void> => {
  const m = await managed(req, res);
  if (!m) return;
  const body = changeSchema.safeParse(req.body ?? {});
  if (!body.success) { res.status(400).json({ error: "Pick a new time" }); return; }
  try {
    const row = await changeByPlayer(m.venue, m.booking, { startLocal: body.data.startLocal, pitchId: body.data.pitchId, minutes: body.data.minutes });
    res.json(await manageView(m.venue, row));
  } catch (error) {
    if (error instanceof VenueError) { res.status(error.status).json({ error: error.message, code: error.code }); return; }
    res.status(500).json({ error: "That didn't work" });
  }
});

/** The booking page polls this after the player pays. The reference is the secret. */
router.get("/venue-site/:slug/bookings/:reference", async (req, res): Promise<void> => {
  const venue = await venueFromSlug(req, res);
  if (!venue) return;
  res.setHeader("Cache-Control", "no-store");
  const booking = await publicBooking(venue, String(req.params.reference).toUpperCase());
  if (!booking) { res.status(404).json({ error: "Not found" }); return; }
  res.json(booking);
});

// ─── Card payments (PayTabs) ─────────────────────────────────────────────────

async function settleCard(tranRef: string, cartId: string): Promise<{ venue: Venue; status: string } | null> {
  const booking = await bookingByReference(cartId);
  if (!booking || booking.cardRef !== tranRef) return null;
  const venue = await loadVenue(booking.academyId);
  if (!venue) return null;
  const status = await verifyCardPayment(venue, booking, tranRef);
  if (status === "paid" && booking.paymentStatus !== "paid") await markPaid(venue, booking, null);
  return { venue, status };
}

router.post("/venue-pay/paytabs/callback", async (req, res): Promise<void> => {
  const body = (req.body ?? {}) as { tran_ref?: unknown; cart_id?: unknown };
  const tranRef = typeof body.tran_ref === "string" ? body.tran_ref : "";
  const cartId = typeof body.cart_id === "string" ? body.cart_id : "";
  if (tranRef && cartId) await settleCard(tranRef, cartId).catch((error) => logger.warn({ error: (error as Error).message }, "PayTabs callback failed"));
  res.json({ ok: true });
});

/** PayTabs sends the player back here (POST or GET) after paying. */
async function returned(req: Request, res: Response) {
  const source = { ...(req.query as Record<string, unknown>), ...((req.body ?? {}) as Record<string, unknown>) };
  const reference = String(source.ref ?? source.cartId ?? source.cart_id ?? "");
  const tranRef = String(source.tranRef ?? source.tran_ref ?? "");
  const booking = reference ? await bookingByReference(reference) : null;
  if (!booking) { res.redirect(302, "/"); return; }
  if (tranRef) await settleCard(tranRef, booking.reference).catch(() => null);
  const venue = await loadVenue(booking.academyId);
  const s = venue?.settings;
  const home = s?.customDomain && s.domainStatus === "live" ? `https://${s.customDomain}` : `/v/${s?.slug ?? ""}`;
  res.redirect(302, `${home}?booking=${encodeURIComponent(booking.reference)}`);
}
router.get("/venue-pay/paytabs/return", returned);
router.post("/venue-pay/paytabs/return", returned);

export default router;
