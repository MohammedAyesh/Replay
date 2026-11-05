import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express, { type Express } from "express";
import { eq } from "drizzle-orm";
import { academiesTable, academyAccessSettingsTable, academyMembersTable, db, fieldsTable, pushSubscriptionsTable, usersTable } from "@workspace/db";

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

import notificationsRouter from "./academyNotifications";
import { forgetAccess } from "../lib/academyPermissions";
import { COALESCE_MS, forgetChatPushes, notifyChatMessage, setPushSender } from "../lib/push/webPush";

const stamp = Date.now();
let app: Express;
let ownerId: number, managerId: number, coachId: number, strangerId: number, academyId: number, venueId: number;
const auth = (id: number) => ({ "x-test-user": String(id) });
const url = (id = academyId) => `/api/academy/console/academies/${id}/notifications`;
const device = (n: string) => ({ endpoint: `https://push.example.test/${stamp}/${n}`, keys: { p256dh: `BPk${n}${"x".repeat(80)}`, auth: `auth-${n}-xyz` } });
const sent: Array<{ endpoint: string; payload: { title: string; body: string; url: string; tag: string } }> = [];

beforeAll(async () => {
  app = express();
  app.use(express.json());
  app.use("/api", notificationsRouter);
  const users = await db.insert(usersTable).values([
    { name: `Owner ${stamp}`, email: `push-owner-${stamp}@test.local` },
    { name: `Manager ${stamp}`, email: `push-mgr-${stamp}@test.local` },
    { name: `Coach ${stamp}`, email: `push-coach-${stamp}@test.local` },
    { name: `Stranger ${stamp}`, email: `push-x-${stamp}@test.local` },
  ]).returning({ id: usersTable.id });
  [ownerId, managerId, coachId, strangerId] = users.map((u) => u.id);
  const [field] = await db.insert(fieldsTable).values({ name: `Push field ${stamp}`, cameraId: "camera1" }).returning({ id: fieldsTable.id });
  const rows = await db.insert(academiesTable).values([
    { name: `JUFA ${stamp}`, fieldId: field.id },
    { name: `Galaxy ${stamp}`, fieldId: field.id, kind: "venue" },
  ]).returning({ id: academiesTable.id });
  [academyId, venueId] = rows.map((a) => a.id);
  await db.insert(academyMembersTable).values([
    { academyId, userId: ownerId, role: "owner" },
    { academyId, userId: managerId, role: "manager" },
    { academyId, userId: coachId, role: "coach" },
    { academyId: venueId, userId: ownerId, role: "owner" },
  ]);
  // The owner hides Chats from coaches.
  await db.insert(academyAccessSettingsTable).values({ academyId, sections: { coach: ["dashboard", "squads"] }, permissions: {} });
  forgetAccess(academyId);
  setPushSender(async (sub, payload) => {
    if (sub.endpoint.endsWith("/gone")) throw Object.assign(new Error("Gone"), { statusCode: 410 });
    sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) });
    return { statusCode: 201 };
  });
});

afterAll(() => setPushSender(null));

describe("chat notifications (2026-11-05: field owners and academy owners, for chats)", () => {
  it("turns a device on and off, gives the key, and keeps strangers out", async () => {
    const first = await request(app).get(url()).query({ endpoint: device("owner-phone").endpoint }).set(auth(ownerId)).expect(200);
    expect(first.body).toMatchObject({ on: false, publicKey: expect.stringMatching(/^[A-Za-z0-9_-]{80,}$/) });
    // The same key every time (made once, kept).
    expect((await request(app).get(url()).set(auth(managerId)).expect(200)).body.publicKey).toBe(first.body.publicKey);
    await request(app).post(url()).set(auth(ownerId)).send({ subscription: device("owner-phone") }).expect(201);
    await request(app).post(url()).set(auth(ownerId)).send({ subscription: device("owner-phone") }).expect(201);
    expect((await request(app).get(url()).query({ endpoint: device("owner-phone").endpoint }).set(auth(ownerId)).expect(200)).body.on).toBe(true);
    expect(await db.select().from(pushSubscriptionsTable).where(eq(pushSubscriptionsTable.userId, ownerId))).toHaveLength(1);
    await request(app).post(url()).set(auth(ownerId)).send({ subscription: { endpoint: "http://insecure.test/x", keys: device("a").keys } }).expect(400);
    await request(app).post(url()).set(auth(strangerId)).send({ subscription: device("stranger") }).expect((r) => expect([403, 404]).toContain(r.status));
    await request(app).delete(url()).set(auth(ownerId)).send({ endpoint: device("owner-phone").endpoint }).expect(200);
    expect((await request(app).get(url()).query({ endpoint: device("owner-phone").endpoint }).set(auth(ownerId)).expect(200)).body.on).toBe(false);
  });

  it("tells whoever sees Chats, once per burst; an assigned chat tells its person; muted tells no one", async () => {
    for (const [id, n] of [[ownerId, "owner"], [managerId, "manager"], [coachId, "coach"]] as const) {
      await request(app).post(url()).set(auth(id)).send({ subscription: device(n) }).expect(201);
    }
    forgetChatPushes();
    sent.length = 0;
    const t0 = Date.now();
    expect(await notifyChatMessage({ academyId, channel: "whatsapp", chatKey: "962790000001", from: "Abu Omar", preview: "Is there training\\ntomorrow?" }, t0)).toBe(2);
    expect(sent.map((s) => s.endpoint.split("/").pop()).sort()).toEqual(["manager", "owner"]);
    expect(sent[0].payload).toMatchObject({
      title: `Abu Omar · JUFA ${stamp}`,
      url: `/academy/chats?a=${academyId}&phone=962790000001`,
      tag: `chat-${academyId}-whatsapp-962790000001`,
    });
    // A second message straight after: no second buzz.
    expect(await notifyChatMessage({ academyId, channel: "whatsapp", chatKey: "962790000001", from: "Abu Omar", preview: "?" }, t0 + 5000)).toBe(0);
    expect(await notifyChatMessage({ academyId, channel: "whatsapp", chatKey: "962790000001", from: "Abu Omar", preview: "?" }, t0 + COALESCE_MS + 1)).toBe(2);
    sent.length = 0;
    expect(await notifyChatMessage({ academyId, channel: "instagram", chatKey: "41", from: "@coach.sami", preview: "Hi", assignedUserId: managerId }, t0)).toBe(1);
    expect(sent[0]).toMatchObject({ endpoint: device("manager").endpoint, payload: { url: `/academy/chats?a=${academyId}&thread=41` } });
    expect(await notifyChatMessage({ academyId, channel: "messenger", chatKey: "42", from: "Sara", preview: "Hi", muted: true }, t0)).toBe(0);
  });

  it("a field's chats open in the field console, and a device that's gone is dropped", async () => {
    forgetChatPushes();
    sent.length = 0;
    await db.insert(pushSubscriptionsTable).values({ userId: ownerId, endpoint: `https://push.example.test/${stamp}/gone`, p256dh: "x".repeat(40), auth: "y".repeat(10) });
    expect(await notifyChatMessage({ academyId: venueId, channel: "whatsapp", chatKey: "962791111111", from: "+962791111111", preview: "Any pitch at 9?" })).toBe(1);
    expect(sent[0].payload.url).toBe(`/field/chats?a=${venueId}&phone=962791111111`);
    expect(await db.select().from(pushSubscriptionsTable).where(eq(pushSubscriptionsTable.endpoint, `https://push.example.test/${stamp}/gone`))).toEqual([]);
  });
});
