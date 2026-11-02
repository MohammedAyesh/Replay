import { createHmac } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express, { type Express } from "express";
import { and, eq } from "drizzle-orm";
import {
  academiesTable,
  academyAttendanceTable,
  academyFeesTable,
  academyMembersTable,
  academyPlayerGuardiansTable,
  academyPlayersTable,
  academySessionsTable,
  academySquadsTable,
  academyWhatsappMessagesTable,
  academyWhatsappOptOutsTable,
  academyWhatsappSettingsTable,
  academyContactsTable,
  db,
  fieldsTable,
  usersTable,
} from "@workspace/db";

process.env.CONTABO_CONTROL_KEY = "test-control-key";
process.env.CONTABO_CONTROL_URL = "http://127.0.0.1:9";
process.env.WHATSAPP_MIN_GAP_MS = "0";
process.env.WHATSAPP_MAX_GAP_MS = "0";

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
    getSession: vi.fn(async (name: string) => ({ name, status: "WORKING", me: { id: "962700000000@c.us", pushName: "Academy" } })),
    listSessions: vi.fn(async () => []),
    wahaVersion: vi.fn(async () => ({ version: "test" })),
    checkNumber: vi.fn(async (_session: string, phone: string) => `${phone}@c.us`),
    sendText: vi.fn(async () => `wamid-${Math.random().toString(36).slice(2)}`),
    ensureSessionStarted: vi.fn(async (name: string) => ({ name, status: "SCAN_QR_CODE", me: null })),
    getQrDataUrl: vi.fn(async () => "data:image/png;base64,AAAA"),
    requestPairingCode: vi.fn(async () => "ABCD-EFGH"),
    logoutSession: vi.fn(async () => undefined),
  };
});

import whatsappRouter from "./academyWhatsapp";
import * as waha from "../lib/whatsapp/waha";
import {
  onAttendanceMarked,
  onSessionCancelled,
  onSessionCreated,
  loadSessionSnapshot,
  runScheduledAutomations,
} from "../lib/whatsapp/automations";

const tag = `wa_${Date.now()}`;
let app: Express;
let ownerId: number;
let coachId: number;
let guardianId: number;
let outsiderId: number;
let fieldId: number;
let academyId: number;
let squadA: number;
let squadB: number;
let ali: number;
let omar: number;
let zaid: number;

const base = () => `/api/academy/console/academies/${academyId}/whatsapp`;
const auth = (id: number) => ({ "x-test-user": String(id) });

async function messages() {
  return db.select().from(academyWhatsappMessagesTable).where(eq(academyWhatsappMessagesTable.academyId, academyId));
}

async function clearMessages() {
  await db.delete(academyWhatsappMessagesTable).where(eq(academyWhatsappMessagesTable.academyId, academyId));
}

async function setAutomation(key: string, patch: Record<string, unknown>) {
  await request(app).put(`${base()}/automations`).set(auth(ownerId)).send({ key, ...patch }).expect(200);
}

beforeAll(async () => {
  app = express();
  app.use("/api/whatsapp/webhook", express.raw({ type: "*/*" }));
  app.use(express.json());
  app.use("/api", whatsappRouter);

  const users = await db.insert(usersTable).values([
    { name: `Owner ${tag}`, email: `owner-${tag}@test.local`, phone: "0790000001" },
    { name: `Coach ${tag}`, email: `coach-${tag}@test.local`, phone: "0790000002" },
    { name: `Guardian ${tag}`, email: `guardian-${tag}@test.local`, phone: "+962 79 000 0003" },
    { name: `Outsider ${tag}`, email: `outsider-${tag}@test.local` },
  ]).returning({ id: usersTable.id });
  [ownerId, coachId, guardianId, outsiderId] = users.map((u) => u.id);
  const [field] = await db.insert(fieldsTable).values({ name: `WA field ${tag}`, cameraId: "camera1" }).returning({ id: fieldsTable.id });
  fieldId = field.id;
  const [academy] = await db.insert(academiesTable).values({ name: `WA Academy ${tag}`, fieldId }).returning({ id: academiesTable.id });
  academyId = academy.id;
  const squads = await db.insert(academySquadsTable).values([
    { academyId, name: "U12" }, { academyId, name: "U15" },
  ]).returning({ id: academySquadsTable.id });
  [squadA, squadB] = squads.map((s) => s.id);
  await db.insert(academyMembersTable).values([
    { academyId, userId: ownerId, role: "owner" },
    { academyId, userId: coachId, role: "coach" },
  ]);
  const players = await db.insert(academyPlayersTable).values([
    // Ali and Omar are siblings: one guardian account, and Ali also has the same number typed in.
    { academyId, squadId: squadA, name: "Ali", guardianPhone: "079 000 0003" },
    { academyId, squadId: squadA, name: "Omar" },
    { academyId, squadId: squadB, name: "Zaid", guardianPhone: "0790000009" },
    { academyId, squadId: squadB, name: "Inactive", guardianPhone: "0790000010", isActive: false },
    { academyId, squadId: squadB, name: "NoPhone" },
  ]).returning({ id: academyPlayersTable.id });
  [ali, omar, zaid] = players.map((p) => p.id);
  await db.insert(academyPlayerGuardiansTable).values([
    { playerId: ali, userId: guardianId, addedBy: "owner" },
    { playerId: omar, userId: guardianId, addedBy: "owner" },
  ]);
});

beforeEach(async () => {
  vi.mocked(waha.sendText).mockClear();
  vi.mocked(waha.checkNumber).mockClear();
  vi.mocked(waha.getSession).mockClear();
  await clearMessages();
  await db.delete(academyWhatsappOptOutsTable).where(eq(academyWhatsappOptOutsTable.academyId, academyId));
});

afterAll(async () => {
  if (academyId) await db.delete(academiesTable).where(eq(academiesTable.id, academyId));
  if (fieldId) await db.delete(fieldsTable).where(eq(fieldsTable.id, fieldId));
  for (const id of [ownerId, coachId, guardianId, outsiderId]) if (id) await db.delete(usersTable).where(eq(usersTable.id, id));
});

describe("access", () => {
  it("lets members read and only owners change settings", async () => {
    await request(app).get(base()).set(auth(outsiderId)).expect(403);
    const read = await request(app).get(base()).set(auth(coachId)).expect(200);
    expect(read.body).toMatchObject({ role: "coach", sender: "off", configured: true });
    expect(read.body.automations.length).toBeGreaterThan(10);
    await request(app).put(`${base()}/settings`).set(auth(coachId)).send({ sender: "replay" }).expect(403);
    const saved = await request(app).put(`${base()}/settings`).set(auth(ownerId)).send({ sender: "replay" }).expect(200);
    expect(saved.body.sender).toBe("replay");
  });

  it("starts linking with a pairing code for a Jordanian number", async () => {
    await request(app).post(`${base()}/connect`).set(auth(ownerId)).send({ method: "code", phone: "nope" }).expect(400);
    const res = await request(app).post(`${base()}/connect`).set(auth(ownerId)).send({ method: "code", phone: "0791112233" }).expect(200);
    expect(res.body.code).toBe("ABCD-EFGH");
    expect(vi.mocked(waha.requestPairingCode)).toHaveBeenCalledWith(`academy-${academyId}`, "962791112233");
  });
});

describe("broadcasts", () => {
  it("previews one recipient per phone, skips inactive players and lists missing numbers", async () => {
    const res = await request(app).post(`${base()}/preview`).set(auth(coachId))
      .send({ audience: { roles: ["parents"], squadIds: null, playerIds: null } }).expect(200);
    expect(res.body.count).toBe(2);
    const guardian = res.body.recipients.find((r: { phone: string }) => r.phone === "+962 79 000 0003");
    expect(guardian.players.sort()).toEqual(["Ali", "Omar"]);
    expect(res.body.missing.map((m: { playerName: string }) => m.playerName)).toEqual(["NoPhone"]);
  });

  it("queues personalised messages, excludes opt-outs, and the tick sends them", async () => {
    await db.insert(academyWhatsappOptOutsTable).values({ academyId, phone: "962790000009" });
    const res = await request(app).post(`${base()}/broadcasts`).set(auth(coachId)).send({
      body: "Hello {name}, {player} trains Friday at {academy}",
      audience: { roles: ["parents", "coaches"], squadIds: null, playerIds: null },
    }).expect(201);
    expect(res.body.queued).toBe(2);
    const rows = await messages();
    const parent = rows.find((m) => m.phone === "962790000003")!;
    expect(parent.body).toBe(`Hello Guardian ${tag}, Ali وOmar trains Friday at WA Academy ${tag}`);
    expect(rows.find((m) => m.phone === "962790000002")?.recipientRole).toBe("coach");

    await request(app).post("/api/whatsapp/tick").expect(401);
    const tick = await request(app).post("/api/whatsapp/tick").set("x-api-key", "test-control-key").expect(200);
    expect(tick.body.dispatched.sent).toBe(2);
    const sentTo = vi.mocked(waha.sendText).mock.calls.map((c) => c[1]).sort();
    expect(sentTo).toEqual(["962790000002@c.us", "962790000003@c.us"]);
    // Replay's shared number puts the academy's name on top.
    expect(vi.mocked(waha.sendText).mock.calls[0][0]).toBe("replay");
    expect(vi.mocked(waha.sendText).mock.calls[0][2]).toMatch(new RegExp(`^\\*WA Academy ${tag}\\*\\n`));
    expect((await messages()).every((m) => m.status === "sent" && m.waMessageId)).toBe(true);
  });

  it("refuses to broadcast while WhatsApp is off", async () => {
    await request(app).put(`${base()}/settings`).set(auth(ownerId)).send({ sender: "off" }).expect(200);
    await request(app).post(`${base()}/broadcasts`).set(auth(ownerId))
      .send({ body: "x", audience: { roles: ["parents"], squadIds: null, playerIds: null } }).expect(409);
    await request(app).put(`${base()}/settings`).set(auth(ownerId)).send({ sender: "replay" }).expect(200);
  });

  it("holds messages while the number is disconnected", async () => {
    vi.mocked(waha.getSession).mockResolvedValue({ name: "replay", status: "SCAN_QR_CODE", me: null });
    await request(app).post(`${base()}/broadcasts`).set(auth(ownerId))
      .send({ body: "x", audience: { roles: ["parents"], squadIds: [squadA], playerIds: null } }).expect(201);
    await request(app).post("/api/whatsapp/tick").set("x-api-key", "test-control-key").expect(200);
    expect(vi.mocked(waha.sendText)).not.toHaveBeenCalled();
    expect((await messages()).every((m) => m.status === "queued")).toBe(true);
    vi.mocked(waha.getSession).mockImplementation(async (name: string) => ({ name, status: "WORKING", me: { id: "962700000000@c.us", pushName: "x" } }));
  });
});

describe("automations", () => {
  it("does nothing until the owner turns an automation on, and never queues twice", async () => {
    const [session] = await db.insert(academySessionsTable).values({
      academyId, squadId: squadA, type: "match", opponent: "Rivals", startsAt: new Date(Date.now() + 2 * 86_400_000), location: "Pitch 2",
    }).returning({ id: academySessionsTable.id });
    await onSessionCreated(academyId, session.id);
    expect(await messages()).toHaveLength(0);

    await setAutomation("session_created", { enabled: true, audiences: ["parents"] });
    await onSessionCreated(academyId, session.id);
    await onSessionCreated(academyId, session.id);
    const rows = await messages();
    expect(rows).toHaveLength(1);
    expect(rows[0].body).toContain("ضد Rivals");
    expect(rows[0].body).toContain("U12");

    await setAutomation("session_cancelled", { enabled: true, audiences: ["parents"] });
    const snapshot = await loadSessionSnapshot(academyId, session.id);
    await db.delete(academySessionsTable).where(eq(academySessionsTable.id, session.id));
    await onSessionCancelled(snapshot);
    expect((await messages()).filter((m) => m.kind === "session_cancelled")).toHaveLength(1);
  });

  it("tells each absent player's parents, naming the right child", async () => {
    await setAutomation("absence_notice", { enabled: true, audiences: ["parents"] });
    await db.update(academyWhatsappSettingsTable).set({ locale: "en" }).where(eq(academyWhatsappSettingsTable.academyId, academyId));
    const [session] = await db.insert(academySessionsTable).values({
      academyId, squadId: squadA, type: "training", startsAt: new Date(Date.now() - 3_600_000), location: "Pitch 1",
    }).returning({ id: academySessionsTable.id });
    await db.insert(academyAttendanceTable).values([
      { sessionId: session.id, playerId: ali, status: "absent" },
      { sessionId: session.id, playerId: omar, status: "present" },
    ]);
    await onAttendanceMarked(academyId, session.id, [{ playerId: ali, status: "absent" }, { playerId: omar, status: "present" }]);
    const rows = await messages();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ phone: "962790000003", playerId: ali, kind: "absence_notice" });
    expect(rows[0].body).toContain("Ali was marked absent");
    await db.update(academyWhatsappSettingsTable).set({ locale: "ar" }).where(eq(academyWhatsappSettingsTable.academyId, academyId));
  });

  it("queues reminders and fee nudges from the scheduler", async () => {
    await setAutomation("session_reminder", { enabled: true, timing: 3, audiences: ["parents", "coaches"] });
    await setAutomation("fee_reminder", { enabled: true, timing: 3 });
    await db.delete(academySessionsTable).where(eq(academySessionsTable.academyId, academyId));
    // 12:00 in Amman today.
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Amman" }).format(new Date());
    const now = new Date(`${today}T09:00:00Z`);
    await db.insert(academySessionsTable).values({
      academyId, squadId: squadB, type: "training", startsAt: new Date(now.getTime() + 2 * 3_600_000), location: "Pitch 3",
      createdAt: new Date(now.getTime() - 86_400_000),
    });
    await db.insert(academyFeesTable).values({ academyId, playerId: zaid, label: "November", amountFils: 35000, dueDate: today });
    const first = await runScheduledAutomations(now);
    const second = await runScheduledAutomations(now);
    expect(first.reminders).toBe(2); // Zaid's parent + the coach
    expect(first.fees).toBe(1);
    expect(second).toMatchObject({ reminders: 0, fees: 0 });
    const fee = (await messages()).find((m) => m.kind === "fee_reminder")!;
    expect(fee.body).toContain("35 دينار");
  });
});

describe("webhook", () => {
  function sign(body: string) {
    return createHmac("sha512", waha.wahaWebhookSecret()).update(body).digest("hex");
  }

  it("rejects an unsigned event and applies a signed read receipt", async () => {
    const [row] = await db.insert(academyWhatsappMessagesTable).values({
      academyId, kind: "test", phone: "962790000003", body: "x", status: "sent", waMessageId: "ABC123", sentAt: new Date(),
    }).returning({ id: academyWhatsappMessagesTable.id });
    const body = JSON.stringify({ event: "message.ack", session: `academy-${academyId}`, payload: { id: "true_962790000003@c.us_ABC123", ack: 3 } });
    await request(app).post("/api/whatsapp/webhook").set("content-type", "application/json").send(body).expect(401);
    await request(app).post("/api/whatsapp/webhook").set("content-type", "application/json").set("x-webhook-hmac", sign(body)).send(body).expect(200);
    const [after] = await db.select().from(academyWhatsappMessagesTable).where(eq(academyWhatsappMessagesTable.id, row.id));
    expect(after.status).toBe("read");
  });

  it("records a STOP reply as an opt-out and confirms it", async () => {
    const body = JSON.stringify({
      event: "message", session: `academy-${academyId}`,
      payload: { id: "IN1", from: "962790000003@c.us", fromMe: false, body: "إيقاف" },
    });
    await request(app).post("/api/whatsapp/webhook").set("content-type", "application/json").set("x-webhook-hmac", sign(body)).send(body).expect(200);
    const optOut = await db.select().from(academyWhatsappOptOutsTable)
      .where(and(eq(academyWhatsappOptOutsTable.academyId, academyId), eq(academyWhatsappOptOutsTable.phone, "962790000003")));
    expect(optOut).toHaveLength(1);
    const rows = await messages();
    expect(rows.find((m) => m.direction === "in")?.body).toBe("إيقاف");
    expect(rows.find((m) => m.kind === "reply" && m.direction === "out")).toBeTruthy();
  });
});

describe("chats and people", () => {
  function sign(body: string) {
    return createHmac("sha512", waha.wahaWebhookSecret()).update(body).digest("hex");
  }
  async function hook(event: Record<string, unknown>) {
    const body = JSON.stringify(event);
    await request(app).post("/api/whatsapp/webhook").set("content-type", "application/json").set("x-webhook-hmac", sign(body)).send(body).expect(200);
  }

  it("files a message from an unknown number as an unread chat and a new person", async () => {
    await hook({ event: "message.any", session: `academy-${academyId}`, payload: { id: "IN-NEW-1", from: "962795550001@c.us", fromMe: false, body: "Hi, how much is the academy?", _data: { pushName: "Sami" } } });
    // The same event delivered twice is stored once.
    await hook({ event: "message.any", session: `academy-${academyId}`, payload: { id: "IN-NEW-1", from: "962795550001@c.us", fromMe: false, body: "Hi, how much is the academy?" } });
    const chats = await request(app).get(`${base()}/chats`).set(auth(coachId)).expect(200);
    const chat = chats.body.find((c: { phone: string }) => c.phone === "962795550001");
    expect(chat).toMatchObject({ unread: 1, lastDirection: "in" });
    expect(chat.contact).toMatchObject({ kind: "unknown", name: "Sami" });
    const thread = await request(app).get(`${base()}/chats/0795550001`).set(auth(coachId)).expect(200);
    expect(thread.body.messages).toHaveLength(1);
    const again = await request(app).get(`${base()}/chats`).set(auth(coachId)).expect(200);
    expect(again.body.find((c: { phone: string }) => c.phone === "962795550001").unread).toBe(0);
  });

  it("keeps what the owner typed on the phone, but not what the app sent", async () => {
    await hook({ event: "message.any", session: `academy-${academyId}`, payload: { id: "OUT-PHONE-1", to: "962795550001@c.us", fromMe: true, source: "app", body: "35 JOD a month" } });
    await hook({ event: "message.any", session: `academy-${academyId}`, payload: { id: "OUT-API-1", to: "962795550001@c.us", fromMe: true, source: "api", body: "ignored" } });
    const rows = (await messages()).filter((m) => m.phone === "962795550001");
    expect(rows.map((m) => [m.direction, m.kind])).toEqual([["out", "phone"]]);
  });

  it("sends a chat reply straight away", async () => {
    const res = await request(app).post(`${base()}/chats/962795550001/messages`).set(auth(coachId)).send({ body: "Come try Friday at 5" }).expect(201);
    expect(res.body.outcome).toBe("sent");
    expect(vi.mocked(waha.sendText)).toHaveBeenCalledTimes(1);
  });

  it("links a number to a player with a relationship, and audiences use it", async () => {
    const people = await request(app).get(`/api/academy/console/academies/${academyId}/contacts`).set(auth(ownerId)).expect(200);
    // Synced from what was already on file: Zaid's guardian number, linked as guardian.
    const zaidParent = people.body.find((p: { phone: string }) => p.phone === "962790000009");
    expect(zaidParent).toMatchObject({ kind: "parent" });
    expect(zaidParent.players.map((p: { playerName: string; relationship: string }) => [p.playerName, p.relationship])).toEqual([["Zaid", "guardian"]]);

    const [sami] = await db.select().from(academyContactsTable)
      .where(and(eq(academyContactsTable.academyId, academyId), eq(academyContactsTable.phone, "962795550001")));
    const linked = await request(app).put(`/api/academy/console/academies/${academyId}/contacts/${sami.id}/players/${omar}`)
      .set(auth(ownerId)).send({ relationship: "father" }).expect(200);
    expect(linked.body).toMatchObject({ kind: "parent", players: [{ playerName: "Omar", relationship: "father" }] });

    const preview = await request(app).post(`${base()}/preview`).set(auth(ownerId))
      .send({ audience: { roles: ["parents"], squadIds: null, playerIds: [omar] } }).expect(200);
    expect(preview.body.recipients.map((r: { phone: string }) => r.phone).sort()).toEqual(["+962 79 000 0003", "+962 79 555 0001"]);
  });

  it("adds an interested person, moves them through stages and messages a selection", async () => {
    const created = await request(app).post(`/api/academy/console/academies/${academyId}/contacts`).set(auth(ownerId))
      .send({ phone: "0795550002", name: "Lead Lina", kind: "lead", tags: ["U10", "Instagram"] }).expect(201);
    expect(created.body).toMatchObject({ kind: "lead", stage: "new", tags: ["U10", "Instagram"] });
    const moved = await request(app).patch(`/api/academy/console/academies/${academyId}/contacts/${created.body.id}`).set(auth(ownerId))
      .send({ stage: "trial", notes: "Trial Friday" }).expect(200);
    expect(moved.body).toMatchObject({ stage: "trial", notes: "Trial Friday" });
    const sent = await request(app).post(`${base()}/broadcasts`).set(auth(ownerId))
      .send({ body: "Hi {name}, see you Friday", contactIds: [created.body.id] }).expect(201);
    expect(sent.body.queued).toBe(1);
    expect((await messages()).find((m) => m.phone === "962795550002")?.body).toBe("Hi Lead Lina, see you Friday");
  });
});
