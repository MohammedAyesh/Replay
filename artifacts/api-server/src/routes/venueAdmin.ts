import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import {
  academiesTable,
  academyMembersTable,
  db,
  fieldOwnersTable,
  usersTable,
  venueBookingsTable,
  venuePayoutsTable,
  venuePitchesTable,
  venueSettingsTable,
} from "@workspace/db";
import { getLocalUserRecord, unauthenticatedResponse } from "../lib/clerkUserBridge";
import { VenueError, bookingView, cancelBooking, createVenue, getBooking, loadVenue, markPaid } from "../lib/venues/store";

/**
 * Admin → Field consoles: open one for a field, set Replay's fee on bookings paid to Replay,
 * confirm those payments, and record what Replay paid each field.
 */
const router: IRouter = Router();

async function admin(req: Request, res: Response) {
  const user = await getLocalUserRecord(req);
  if (!user) { unauthenticatedResponse(res, req); return null; }
  if (!user.isAdmin) { res.status(403).json({ error: "Admin access required" }); return null; }
  return user;
}

function intParam(value: string | string[] | undefined): number | null {
  const n = Number(Array.isArray(value) ? value[0] : value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

router.get("/admin/venues", async (req, res): Promise<void> => {
  if (!(await admin(req, res))) return;
  const venues = await db.select({ id: academiesTable.id, name: academiesTable.name, fieldId: academiesTable.fieldId, settings: venueSettingsTable })
    .from(academiesTable).leftJoin(venueSettingsTable, eq(venueSettingsTable.academyId, academiesTable.id))
    .where(eq(academiesTable.kind, "venue")).orderBy(asc(academiesTable.name));
  const ids = venues.map((v) => v.id);
  const owners = ids.length ? await db.select({ academyId: academyMembersTable.academyId, email: usersTable.email, name: usersTable.name })
    .from(academyMembersTable).innerJoin(usersTable, eq(usersTable.id, academyMembersTable.userId))
    .where(and(inArray(academyMembersTable.academyId, ids), eq(academyMembersTable.role, "owner"))) : [];
  const money = ids.length ? await db.select({
    academyId: venueBookingsTable.academyId,
    viaReplay: sql<number>`coalesce(sum(least(${venueBookingsTable.paidFils}, ${venueBookingsTable.dueOnlineFils})) filter (where ${venueBookingsTable.moneyTo} = 'replay' and ${venueBookingsTable.payWith} in ('cliq', 'card') and ${venueBookingsTable.paymentStatus} = 'paid' and ${venueBookingsTable.status} <> 'cancelled'), 0)::int`,
    bookings: sql<number>`count(*) filter (where ${venueBookingsTable.status} in ('confirmed', 'completed'))::int`,
    toConfirm: sql<number>`count(*) filter (where ${venueBookingsTable.moneyTo} = 'replay' and ${venueBookingsTable.payWith} in ('cliq') and ${venueBookingsTable.paymentStatus} in ('receipt', 'unpaid') and ${venueBookingsTable.status} in ('held', 'confirmed'))::int`,
  }).from(venueBookingsTable).where(inArray(venueBookingsTable.academyId, ids)).groupBy(venueBookingsTable.academyId) : [];
  const paid = ids.length ? await db.select({ academyId: venuePayoutsTable.academyId, n: sql<number>`coalesce(sum(${venuePayoutsTable.amountFils}), 0)::int` })
    .from(venuePayoutsTable).where(inArray(venuePayoutsTable.academyId, ids)).groupBy(venuePayoutsTable.academyId) : [];
  const moneyBy = new Map(money.map((m) => [m.academyId, m]));
  const paidBy = new Map(paid.map((p) => [p.academyId, p.n]));
  res.json({
    venues: venues.map((v) => {
      const m = moneyBy.get(v.id);
      const fee = Math.round(((m?.viaReplay ?? 0) * (v.settings?.replayFeeBps ?? 0)) / 10_000);
      return {
        id: v.id,
        name: v.name,
        fieldId: v.fieldId,
        slug: v.settings?.slug ?? null,
        moneyTo: v.settings?.moneyTo ?? "venue",
        agentMode: v.settings?.agentMode ?? "off",
        customDomain: v.settings?.customDomain ?? null,
        domainStatus: v.settings?.domainStatus ?? "none",
        replayFeeBps: v.settings?.replayFeeBps ?? 0,
        owners: owners.filter((o) => o.academyId === v.id).map((o) => ({ email: o.email, name: o.name })),
        bookings: m?.bookings ?? 0,
        toConfirm: m?.toConfirm ?? 0,
        viaReplayFils: m?.viaReplay ?? 0,
        feeFils: fee,
        paidOutFils: paidBy.get(v.id) ?? 0,
        owedFils: Math.max(0, (m?.viaReplay ?? 0) - fee - (paidBy.get(v.id) ?? 0)),
      };
    }),
  });
});

const createSchema = z.object({ name: z.string().trim().min(2).max(120), fieldIds: z.array(z.number().int().positive()).min(1).max(20), ownerEmail: z.string().trim().email() });

router.post("/admin/venues", async (req, res): Promise<void> => {
  if (!(await admin(req, res))) return;
  const body = createSchema.safeParse(req.body ?? {});
  if (!body.success) { res.status(400).json({ error: "Name, fields and the owner's email" }); return; }
  const [owner] = await db.select({ id: usersTable.id }).from(usersTable).where(sql`lower(${usersTable.email}) = ${body.data.ownerEmail.toLowerCase()}`);
  if (!owner) { res.status(404).json({ error: "No Replay account with that email. Ask the owner to sign up first." }); return; }
  try {
    const venue = await createVenue({ name: body.data.name, fieldIds: body.data.fieldIds, ownerUserId: owner.id });
    // The owner of the field console also owns the fields' footage (owner console and billing).
    await db.insert(fieldOwnersTable).values(body.data.fieldIds.map((fieldId) => ({ userId: owner.id, fieldId }))).onConflictDoNothing();
    res.status(201).json({ id: venue.id, slug: venue.settings.slug });
  } catch (error) {
    if (error instanceof VenueError) { res.status(error.status).json({ error: error.message }); return; }
    throw error;
  }
});

router.patch("/admin/venues/:id", async (req, res): Promise<void> => {
  if (!(await admin(req, res))) return;
  const id = intParam(req.params.id);
  const body = z.object({ replayFeeBps: z.number().int().min(0).max(5000) }).safeParse(req.body ?? {});
  if (!id || !body.success) { res.status(400).json({ error: "Fee is 0–50%" }); return; }
  await db.update(venueSettingsTable).set({ replayFeeBps: body.data.replayFeeBps, updatedAt: new Date() }).where(eq(venueSettingsTable.academyId, id));
  res.json({ ok: true });
});

/** Bookings paid (or to be paid) to Replay's CliQ, waiting for Replay to confirm. */
router.get("/admin/venues/payments", async (req, res): Promise<void> => {
  if (!(await admin(req, res))) return;
  const rows = await db.select({ b: venueBookingsTable, venue: academiesTable.name, pitch: venuePitchesTable })
    .from(venueBookingsTable)
    .innerJoin(academiesTable, eq(academiesTable.id, venueBookingsTable.academyId))
    .innerJoin(venuePitchesTable, eq(venuePitchesTable.id, venueBookingsTable.pitchId))
    .where(and(
      eq(venueBookingsTable.moneyTo, "replay"),
      eq(venueBookingsTable.payWith, "cliq"),
      inArray(venueBookingsTable.paymentStatus, ["receipt", "unpaid"]),
      inArray(venueBookingsTable.status, ["held", "confirmed"]),
    )).orderBy(desc(venueBookingsTable.paymentStatus), asc(venueBookingsTable.createdAt)).limit(300);
  res.json({ bookings: rows.map((r) => ({ ...bookingView(r.b, new Map([[r.pitch.id, r.pitch]])), venueName: r.venue, venueId: r.b.academyId })) });
});

router.post("/admin/venues/bookings/:bookingId/:action", async (req, res): Promise<void> => {
  const user = await admin(req, res);
  if (!user) return;
  const id = intParam(req.params.bookingId);
  const [row] = id ? await db.select({ academyId: venueBookingsTable.academyId }).from(venueBookingsTable).where(eq(venueBookingsTable.id, id)) : [];
  const venue = row ? await loadVenue(row.academyId) : null;
  const booking = venue && id ? await getBooking(venue.id, id) : null;
  if (!venue || !booking) { res.status(404).json({ error: "Booking not found" }); return; }
  if (req.params.action === "confirm") {
    const updated = await markPaid(venue, booking, user.id);
    res.json({ booking: bookingView(updated) });
    return;
  }
  if (req.params.action === "reject") {
    const updated = await cancelBooking(venue, booking, "Payment not received", { notify: true, lapsed: true });
    res.json({ booking: bookingView(updated) });
    return;
  }
  res.status(400).json({ error: "Unknown action" });
});

router.post("/admin/venues/:id/payouts", async (req, res): Promise<void> => {
  const user = await admin(req, res);
  if (!user) return;
  const id = intParam(req.params.id);
  const body = z.object({ amountFils: z.number().int().min(1).max(100_000_000), method: z.string().trim().max(20).default("cliq"), note: z.string().trim().max(200).optional() }).safeParse(req.body ?? {});
  if (!id || !body.success) { res.status(400).json({ error: "Amount in fils" }); return; }
  const [row] = await db.insert(venuePayoutsTable).values({ academyId: id, amountFils: body.data.amountFils, method: body.data.method, note: body.data.note ?? null, createdBy: user.id }).returning();
  res.status(201).json({ payout: row });
});

export default router;
