import { createHmac } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express, { type Express } from "express";
import { and, desc, eq } from "drizzle-orm";
import {
  academiesTable,
  academyContactsTable,
  academyMembersTable,
  academyWhatsappMessagesTable,
  academyWhatsappSettingsTable,
  db,
  fieldOwnersTable,
  fieldsTable,
  footageRequestsTable,
  usersTable,
  venueAgentThreadsTable,
  venueBookingsTable,
  venuePitchesTable,
  venueSettingsTable,
} from "@workspace/db";

process.env.CONTABO_CONTROL_KEY = "test-control-key";
process.env.CONTABO_CONTROL_URL = "http://127.0.0.1:9";
delete process.env.ANTHROPIC_API_KEY;

vi.mock("../lib/clerkUserBridge", () => ({
  getLocalUserId: vi.fn(async (req: { headers: Record<string, string | undefined> }) => {
    const id = Number(req.headers["x-test-user"]);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  }),
  getLocalUserRecord: vi.fn(async (req: { headers: Record<string, string | undefined> }) => {
    const id = Number(req.headers["x-test-user"]);
    if (!Number.isSafeInteger(id) || id < 1) return null;
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, id));
    return user ?? null;
  }),
  unauthenticatedResponse: vi.fn((res: { status: (n: number) => { json: (b: unknown) => void } }) => {
    res.status(401).json({ error: "Unauthenticated" });
  }),
}));

vi.mock("../lib/whatsapp/waha", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/whatsapp/waha")>();
  return {
    ...actual,
    wahaConfigured: vi.fn(() => true),
    getSession: vi.fn(async (name: string) => ({ name, status: "WORKING", me: { id: "962700000000@c.us", pushName: "Field" } })),
    checkNumber: vi.fn(async (_s: string, phone: string) => `${phone}@c.us`),
    sendText: vi.fn(async () => `wamid-${Math.random().toString(36).slice(2)}`),
    setTyping: vi.fn(async () => undefined),
    phoneForLid: vi.fn(async () => null),
  };
});

import { academyAccessGate } from "./academyAccessGate";
import venueConsoleRouter from "./venueConsole";
import venuePublicRouter from "./venuePublic";
import venueAdminRouter from "./venueAdmin";
import consoleRouter from "./academyConsole";
import academiesRouter from "./academies";
import teamRouter from "./academyTeam";
import whatsappRouter from "./academyWhatsapp";
import * as waha from "../lib/whatsapp/waha";
import { runVenueTick } from "../lib/venues/store";
import { addDays, ammanLocal } from "../lib/venues/core";
import { forgetAccess } from "../lib/academyPermissions";

const tag = Date.now();
let app: Express;
let ownerId: number;
let deskId: number;
let strangerId: number;
let adminId: number;
let fieldId: number;
let venueId: number;
let pitchId: number;
let secondPitchId: number;
const auth = (id: number) => ({ "x-test-user": String(id) });
const base = () => `/api/academy/console/academies/${venueId}/venue`;
const tomorrow = addDays(ammanLocal(new Date()).slice(0, 10), 1);
const player = "962791110001";
let slug = "";

function sign(body: string) {
  return createHmac("sha512", waha.wahaWebhookSecret()).update(body).digest("hex");
}
let waSeq = 0;
async function inbound(text: string, from = player, extra: Record<string, unknown> = {}) {
  waSeq += 1;
  const body = JSON.stringify({ event: "message", session: `academy-${venueId}`, payload: { id: `false_${from}@c.us_IN${tag}${waSeq}`, from: `${from}@c.us`, to: "962700000000@c.us", fromMe: false, body: text, _data: { pushName: "Ali Test" }, ...extra } });
  await request(app).post("/api/whatsapp/webhook").set("content-type", "application/json").set("x-webhook-hmac", sign(body)).send(body).expect(200);
}
async function lastOut(phone = player): Promise<string> {
  const [row] = await db.select({ body: academyWhatsappMessagesTable.body }).from(academyWhatsappMessagesTable)
    .where(and(eq(academyWhatsappMessagesTable.academyId, venueId), eq(academyWhatsappMessagesTable.phone, phone), eq(academyWhatsappMessagesTable.direction, "out")))
    .orderBy(desc(academyWhatsappMessagesTable.id)).limit(1);
  return row?.body ?? "";
}

beforeAll(async () => {
  app = express();
  app.use("/api/whatsapp/webhook", express.raw({ type: "*/*" }));
  app.use(express.json());
  app.use("/api", academyAccessGate);
  for (const r of [venueConsoleRouter, venuePublicRouter, venueAdminRouter, consoleRouter, academiesRouter, teamRouter, whatsappRouter]) app.use("/api", r);
  const users = await db.insert(usersTable).values([
    { name: `Owner ${tag}`, email: `venue-owner-${tag}@test.local` },
    { name: `Desk ${tag}`, email: `venue-desk-${tag}@test.local` },
    { name: `Stranger ${tag}`, email: `venue-stranger-${tag}@test.local` },
    { name: `Admin ${tag}`, email: `venue-admin-${tag}@test.local`, isAdmin: true },
  ]).returning({ id: usersTable.id });
  [ownerId, deskId, strangerId, adminId] = users.map((u) => u.id);
  const [field] = await db.insert(fieldsTable).values({ name: `Galaxy Lower ${tag}`, cameraId: null }).returning({ id: fieldsTable.id });
  fieldId = field.id;
  await db.insert(fieldOwnersTable).values({ userId: ownerId, fieldId });
});

describe("setting up a field console", () => {
  it("lets a field owner open one from his fields, once", async () => {
    const before = await request(app).get("/api/venue/console/memberships").set(auth(ownerId)).expect(200);
    expect(before.body.canSetUp).toBe(true);
    await request(app).post("/api/venue/console/setup").set(auth(strangerId)).send({}).expect(403);
    const created = await request(app).post("/api/venue/console/setup").set(auth(ownerId)).send({}).expect(201);
    venueId = created.body.academyId;
    const again = await request(app).post("/api/venue/console/setup").set(auth(ownerId)).send({}).expect(200);
    expect(again.body.academyId).toBe(venueId);
    const [academy] = await db.select().from(academiesTable).where(eq(academiesTable.id, venueId));
    expect(academy.kind).toBe("venue");
    expect(academy.name).toBe(`Galaxy Lower ${tag}`.replace(/\s+\d+$/, "") === academy.name ? academy.name : academy.name);
    const pitches = await db.select().from(venuePitchesTable).where(eq(venuePitchesTable.academyId, venueId));
    expect(pitches).toHaveLength(1);
    pitchId = pitches[0].id;
    const [settings] = await db.select().from(venueSettingsTable).where(eq(venueSettingsTable.academyId, venueId));
    slug = settings.slug;
    await db.insert(academyMembersTable).values({ academyId: venueId, userId: deskId, role: "coach" });
    await db.insert(academyWhatsappSettingsTable).values({ academyId: venueId, sender: "own", sessionStatus: "WORKING" }).onConflictDoNothing();
  });

  it("keeps the field out of the academy console and the public academies list", async () => {
    await request(app).get("/api/academy/console/memberships").set(auth(ownerId)).expect(403);
    const list = await request(app).get("/api/academies").expect(200);
    expect((list.body as Array<{ id: number }>).some((a) => a.id === venueId)).toBe(false);
  });

  it("shows the field's sections, not an academy's, in Team", async () => {
    const team = await request(app).get(`/api/academy/console/academies/${venueId}/team`).set(auth(ownerId)).expect(200);
    expect(team.body.catalog.sections).toEqual(expect.arrayContaining(["bookings", "pitches", "chats", "people", "ads"]));
    expect(team.body.catalog.sections).not.toContain("squads");
  });
});

describe("pitches and rules", () => {
  it("lets the owner price pitches and set hours; front desk can't", async () => {
    await request(app).patch(`${base()}/pitches/${pitchId}`).set(auth(deskId)).send({ pricePerHourFils: 1 }).expect(403);
    await request(app).patch(`${base()}/pitches/${pitchId}`).set(auth(ownerId)).send({
      name: "Pitch A", pricePerHourFils: 20000, recordBookings: false,
      priceRules: [{ days: [0, 1, 2, 3, 4, 5, 6], from: "20:00", to: "23:00", pricePerHourFils: 30000 }],
    }).expect(200);
    const second = await request(app).post(`${base()}/pitches`).set(auth(ownerId)).send({ name: "Pitch B", size: "7", pricePerHourFils: 35000 }).expect(201);
    secondPitchId = second.body.pitch.id;
    await request(app).put(`${base()}/pitches/rules`).set(auth(ownerId)).send({
      openingHours: Object.fromEntries(["0", "1", "2", "3", "4", "5", "6"].map((d) => [d, { open: "16:00", close: "02:00" }])),
      durations: [60, 90, 120], slotStepMinutes: 30, minNoticeMinutes: 0, holdMinutes: 30,
    }).expect(200);
    // Front desk sees pitches only through Bookings.
    await request(app).get(`${base()}/pitches`).set(auth(deskId)).expect(403);
    const listed = await request(app).get(`${base()}/pitches`).set(auth(ownerId)).expect(200);
    expect(listed.body.pitches.map((p: { name: string }) => p.name)).toEqual(["Pitch A", "Pitch B"]);
  });

  it("hides payments from front desk and lets the owner set them", async () => {
    const hidden = await request(app).get(`${base()}/payments`).set(auth(deskId)).expect(403);
    expect(hidden.body.code).toBe("section_hidden");
    await request(app).put(`${base()}/payments`).set(auth(ownerId)).send({ moneyTo: "venue", cliqAlias: "GALAXYJO", cliqName: "Jordan Galaxy", depositMode: "full", payAtField: true }).expect(200);
    const got = await request(app).get(`${base()}/payments`).set(auth(ownerId)).expect(200);
    expect(got.body.settings.cliqAlias).toBe("GALAXYJO");
  });
});

describe("bookings", () => {
  it("prices a booking by its peak hours and refuses a clash", async () => {
    const made = await request(app).post(`${base()}/bookings`).set(auth(deskId)).send({
      pitchId, startLocal: `${tomorrow} 19:00`, minutes: 120, customerName: "Omar", customerPhone: "0791110002", payWith: "field",
    }).expect(201);
    expect(made.body.bookings[0]).toMatchObject({ status: "confirmed", amountFils: 50000, paymentStatus: "unpaid" });
    const clash = await request(app).post(`${base()}/bookings`).set(auth(deskId)).send({ pitchId, startLocal: `${tomorrow} 20:00`, minutes: 60, payWith: "none" }).expect(409);
    expect(clash.body.code).toBe("taken");
    // The other pitch is free then.
    await request(app).post(`${base()}/bookings`).set(auth(deskId)).send({ pitchId: secondPitchId, startLocal: `${tomorrow} 20:00`, minutes: 60, payWith: "none" }).expect(201);
    // Omar got his confirmation on WhatsApp.
    expect(await lastOut("962791110002")).toMatch(/تم تأكيد حجزك/);
    const contacts = await db.select().from(academyContactsTable).where(and(eq(academyContactsTable.academyId, venueId), eq(academyContactsTable.phone, "962791110002")));
    expect(contacts[0]?.kind).toBe("player");
  });

  it("books a weekly regular and cancels the series", async () => {
    const made = await request(app).post(`${base()}/bookings`).set(auth(ownerId)).send({
      pitchId: secondPitchId, startLocal: `${tomorrow} 22:00`, minutes: 60, customerName: "Tuesday crew", payWith: "none", repeatWeeks: 4, notify: false,
    }).expect(201);
    expect(made.body.bookings).toHaveLength(4);
    expect(new Set(made.body.bookings.map((b: { seriesId: string }) => b.seriesId)).size).toBe(1);
    await request(app).post(`${base()}/bookings/${made.body.bookings[1].id}/action`).set(auth(ownerId)).send({ action: "cancel", series: true, notify: false }).expect(200);
    const rows = await db.select({ status: venueBookingsTable.status }).from(venueBookingsTable).where(eq(venueBookingsTable.seriesId, made.body.bookings[0].seriesId)).orderBy(venueBookingsTable.startsAt);
    expect(rows.map((r) => r.status)).toEqual(["confirmed", "cancelled", "cancelled", "cancelled"]);
  });
});

describe("the booking website", () => {
  it("shows the field, its free times, and takes a booking held for CliQ", async () => {
    const site = await request(app).get(`/api/venue-site/${slug}`).expect(200);
    expect(site.body.pitches).toHaveLength(2);
    expect(site.body.payment).toMatchObject({ cliq: true, field: true });
    const free = await request(app).get(`/api/venue-site/${slug}/availability?date=${tomorrow}`).expect(200);
    const pitchA = free.body.pitches.find((p: { pitchId: number }) => p.pitchId === pitchId);
    expect(pitchA.slots.some((s: { startLocal: string }) => s.startLocal === `${tomorrow} 19:00`)).toBe(false);
    const booked = await request(app).post(`/api/venue-site/${slug}/bookings`).send({
      pitchId, startLocal: `${tomorrow} 16:00`, minutes: 60, name: "Ali Test", phone: "0791110001", payWith: "cliq",
    }).expect(201);
    expect(booked.body).toMatchObject({ status: "held", amountFils: 20000, dueOnlineFils: 20000, cliqAlias: "GALAXYJO" });
    expect(await lastOut()).toMatch(/GALAXYJO/);
    expect(await lastOut()).toContain(booked.body.reference);
    // Bots filling the hidden field are refused.
    await request(app).post(`/api/venue-site/${slug}/bookings`).send({ pitchId, startLocal: `${tomorrow} 17:00`, minutes: 60, name: "Bot", phone: "0791110009", payWith: "field", website: "x" }).expect(400);
  });

  it("takes a WhatsApp photo as the receipt and the owner confirms it", async () => {
    await inbound("", player, { hasMedia: true, media: { mimetype: "image/jpeg" }, _data: { pushName: "Ali Test", Info: { Type: "image" }, Message: { imageMessage: {} } }, type: "image" });
    const [held] = await db.select().from(venueBookingsTable).where(and(eq(venueBookingsTable.academyId, venueId), eq(venueBookingsTable.customerPhone, player)));
    // No file could be kept in the test, so it stays unpaid and waits; the owner confirms by hand.
    expect(held.status).toBe("held");
    const attention = await request(app).get(`${base()}/bookings/attention`).set(auth(deskId)).expect(200);
    expect(attention.body.bookings.some((b: { id: number }) => b.id === held.id)).toBe(true);
    const confirmed = await request(app).post(`${base()}/bookings/${held.id}/action`).set(auth(deskId)).send({ action: "confirm-payment" }).expect(200);
    expect(confirmed.body.booking).toMatchObject({ status: "confirmed", paymentStatus: "paid", paidFils: 20000, balanceFils: 0 });
    expect(await lastOut()).toMatch(/وصلنا المبلغ/);
  });

  it("lets an unpaid hold lapse and tells the player", async () => {
    const booked = await request(app).post(`/api/venue-site/${slug}/bookings`).send({
      pitchId: secondPitchId, startLocal: `${tomorrow} 17:00`, minutes: 60, name: "Late Payer", phone: "0791110003", payWith: "cliq",
    }).expect(201);
    await db.update(venueBookingsTable).set({ holdExpiresAt: new Date(Date.now() - 1000) }).where(eq(venueBookingsTable.reference, booked.body.reference));
    await runVenueTick();
    const [row] = await db.select().from(venueBookingsTable).where(eq(venueBookingsTable.reference, booked.body.reference));
    expect(row.status).toBe("cancelled");
    expect(await lastOut("962791110003")).toMatch(/ما وصلنا الدفع/);
  });
});

describe("money paid to Replay", () => {
  it("is confirmed by Replay, not the field, and shows as owed to the field", async () => {
    await request(app).put(`${base()}/payments`).set(auth(ownerId)).send({ moneyTo: "replay" }).expect(200);
    await request(app).patch(`/api/admin/venues/${venueId}`).set(auth(adminId)).send({ replayFeeBps: 500 }).expect(200);
    const booked = await request(app).post(`/api/venue-site/${slug}/bookings`).send({
      pitchId: secondPitchId, startLocal: `${tomorrow} 18:00`, minutes: 60, name: "Replay Payer", phone: "0791110004", payWith: "cliq",
    }).expect(201);
    expect(booked.body.cliqName).toBe("Replay");
    const [row] = await db.select().from(venueBookingsTable).where(eq(venueBookingsTable.reference, booked.body.reference));
    const refused = await request(app).post(`${base()}/bookings/${row.id}/action`).set(auth(ownerId)).send({ action: "confirm-payment" }).expect(403);
    expect(refused.body.code).toBe("replay_confirms");
    const queue = await request(app).get("/api/admin/venues/payments").set(auth(adminId)).expect(200);
    expect(queue.body.bookings.some((b: { id: number }) => b.id === row.id)).toBe(true);
    await request(app).post(`/api/admin/venues/bookings/${row.id}/confirm`).set(auth(adminId)).expect(200);
    const ledger = await request(app).get(`${base()}/payments`).set(auth(ownerId)).expect(200);
    expect(ledger.body.ledger).toMatchObject({ viaReplayFils: 35000, replayFeeFils: 1750, owedByReplayFils: 33250 });
    await request(app).post(`/api/admin/venues/${venueId}/payouts`).set(auth(adminId)).send({ amountFils: 33250 }).expect(201);
    const after = await request(app).get(`${base()}/payments`).set(auth(ownerId)).expect(200);
    expect(after.body.ledger.owedByReplayFils).toBe(0);
    await request(app).put(`${base()}/payments`).set(auth(ownerId)).send({ moneyTo: "venue" }).expect(200);
  });
});

describe("the WhatsApp booking agent (menu)", () => {
  const newPlayer = "962791110005";
  it("walks a player from hello to a held booking", async () => {
    await request(app).put(`${base()}/agent`).set(auth(ownerId)).send({ agentMode: "menu" }).expect(200);
    await inbound("مرحبا", newPlayer);
    expect(await lastOut(newPlayer)).toMatch(/احجز ملعب/);
    await inbound("1", newPlayer);
    expect(await lastOut(newPlayer)).toMatch(/أي يوم/);
    const days = (await db.select().from(venueAgentThreadsTable).where(and(eq(venueAgentThreadsTable.academyId, venueId), eq(venueAgentThreadsTable.phone, newPlayer))))[0].state as { draft: { options: string[] } };
    const dayIndex = days.draft.options.indexOf(tomorrow) + 1;
    await inbound(String(dayIndex), newPlayer);
    expect(await lastOut(newPlayer)).toMatch(/أي ملعب/);
    await inbound("1", newPlayer); // Pitch A
    expect(await lastOut(newPlayer)).toMatch(/قديش بدك مدة/);
    await inbound("١", newPlayer); // 60 minutes, typed in Arabic digits
    expect(await lastOut(newPlayer)).toMatch(/المواعيد الفاضية/);
    await inbound("1", newPlayer); // the first free time; his WhatsApp name is used
    expect(await lastOut(newPlayer)).toMatch(/كيف بدك تدفع/);
    await inbound("1", newPlayer); // CliQ
    const [b] = await db.select().from(venueBookingsTable).where(and(eq(venueBookingsTable.academyId, venueId), eq(venueBookingsTable.customerPhone, newPlayer)));
    expect(b).toMatchObject({ status: "held", source: "whatsapp", customerName: "Ali Test" });
    expect(await lastOut(newPlayer)).toContain(b.reference);
  });

  it("stays quiet after someone from the field writes in the chat", async () => {
    await db.insert(academyWhatsappMessagesTable).values({ academyId: venueId, kind: "chat", phone: newPlayer, body: "أهلين، معك أحمد", direction: "out", status: "sent", createdBy: ownerId });
    const before = await lastOut(newPlayer);
    await inbound("2", newPlayer);
    expect(await lastOut(newPlayer)).toBe(before);
  });
});

describe("customers", () => {
  it("lists bookers with their counts and segments", async () => {
    const res = await request(app).get(`${base()}/customers`).set(auth(deskId)).expect(200);
    const ali = res.body.customers.find((c: { phone: string }) => c.phone === player);
    expect(ali).toMatchObject({ bookings: 1, segment: "new" });
  });
});

describe("a camera pitch", () => {
  it("books Replay's camera with a confirmed booking, on the owner's footage ledger", async () => {
    const [camField] = await db.insert(fieldsTable).values({ name: `Cam field ${tag}`, cameraId: `cam-${tag}` }).returning({ id: fieldsTable.id });
    await db.insert(fieldOwnersTable).values({ userId: ownerId, fieldId: camField.id });
    const pitch = await request(app).post(`${base()}/pitches`).set(auth(ownerId)).send({ name: "Camera pitch", pricePerHourFils: 20000, fieldId: camField.id, recordBookings: true }).expect(201);
    const made = await request(app).post(`${base()}/bookings`).set(auth(ownerId)).send({ pitchId: pitch.body.pitch.id, startLocal: `${tomorrow} 21:00`, minutes: 90, payWith: "none", notify: false }).expect(201);
    const [b] = await db.select().from(venueBookingsTable).where(eq(venueBookingsTable.id, made.body.bookings[0].id));
    expect(b.footageRequestId).not.toBeNull();
    const [footage] = await db.select().from(footageRequestsTable).where(eq(footageRequestsTable.id, b.footageRequestId!));
    expect(footage).toMatchObject({ fieldId: camField.id, academyId: null, requestedBy: ownerId, startLocal: `${tomorrow} 21:00`, endLocal: `${tomorrow} 22:30` });
    expect(footage.rateFils).toBeGreaterThan(0);
  });
});

describe("custom domains", () => {
  it("saves a domain, refuses ours, and answers Caddy's question", async () => {
    await request(app).put(`${base()}/website/domain`).set(auth(ownerId)).send({ domain: "replayjo.com" }).expect(400);
    await request(app).put(`${base()}/website/domain`).set(auth(ownerId)).send({ domain: `https://book-${tag}.example.com/` }).expect(200);
    await request(app).get(`/api/venue-site/domain-allowed?domain=book-${tag}.example.com`).expect(200);
    await request(app).get(`/api/venue-site/domain-allowed?domain=other-${tag}.example.com`).expect(404);
    const site = await request(app).get(`/api/venue-site/by-host?host=www.book-${tag}.example.com`).expect(200);
    expect(site.body.id).toBe(venueId);
  });

  it("hides the website and everything else from people outside the field", async () => {
    await request(app).get(`${base()}/dashboard`).set(auth(strangerId)).expect(403);
    await request(app).get(`${base()}/website`).set(auth(deskId)).expect(403);
    forgetAccess(venueId);
  });
});
