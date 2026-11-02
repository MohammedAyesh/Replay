import { createHmac } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express, { type Express } from "express";
import { and, eq } from "drizzle-orm";
import {
  academiesTable,
  academyContactsTable,
  academyMembersTable,
  academyPlayersTable,
  academyWhatsappMessagesTable,
  academyWhatsappSettingsTable,
  db,
  fieldsTable,
  usersTable,
} from "@workspace/db";

process.env.CONTABO_CONTROL_KEY = "test-control-key";
process.env.CONTABO_CONTROL_URL = "http://127.0.0.1:9";

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
    checkNumber: vi.fn(async (_s: string, phone: string) => `${phone}@c.us`),
    sendText: vi.fn(async () => `wamid-${Math.random().toString(36).slice(2)}`),
    phoneForLid: vi.fn(async () => null),
  };
});

import { academyAccessGate } from "./academyAccessGate";
import teamRouter from "./academyTeam";
import whatsappRouter from "./academyWhatsapp";
import profileRouter from "./academyProfile";
import consoleRouter from "./academyConsole";
import walletRouter from "./academyAdWallet";
import familyRouter from "./academyFamily";
import * as waha from "../lib/whatsapp/waha";
import { forgetAccess } from "../lib/academyPermissions";

const tag = Date.now();
let app: Express;
let ownerId: number;
let managerId: number;
let coachId: number;
let playerUserId: number;
let academyId: number;
const auth = (id: number) => ({ "x-test-user": String(id) });
const base = () => `/api/academy/console/academies/${academyId}`;

function sign(body: string) {
  return createHmac("sha512", waha.wahaWebhookSecret()).update(body).digest("hex");
}
async function hook(event: Record<string, unknown>) {
  const body = JSON.stringify(event);
  await request(app).post("/api/whatsapp/webhook").set("content-type", "application/json").set("x-webhook-hmac", sign(body)).send(body).expect(200);
}

beforeAll(async () => {
  app = express();
  app.use("/api/whatsapp/webhook", express.raw({ type: "*/*" }));
  app.use(express.json());
  app.use("/api", academyAccessGate);
  for (const r of [teamRouter, whatsappRouter, profileRouter, consoleRouter, walletRouter, familyRouter]) app.use("/api", r);
  const users = await db.insert(usersTable).values([
    { name: `Owner ${tag}`, email: `owner-team-${tag}@test.local` },
    { name: `Manager ${tag}`, email: `manager-team-${tag}@test.local` },
    { name: `Coach ${tag}`, email: `coach-team-${tag}@test.local` },
    { name: `Player ${tag}`, email: `player-team-${tag}@test.local` },
  ]).returning({ id: usersTable.id });
  [ownerId, managerId, coachId, playerUserId] = users.map((u) => u.id);
  const [field] = await db.insert(fieldsTable).values({ name: `Team field ${tag}`, cameraId: "camera1" }).returning({ id: fieldsTable.id });
  const [academy] = await db.insert(academiesTable).values({ name: `Team ${tag}`, fieldId: field.id }).returning({ id: academiesTable.id });
  academyId = academy.id;
  await db.insert(academyMembersTable).values([
    { academyId, userId: ownerId, role: "owner" },
    { academyId, userId: coachId, role: "coach" },
  ]);
  await db.insert(academyPlayersTable).values({ academyId, name: "Self Player", userId: playerUserId });
  await db.insert(academyWhatsappSettingsTable).values({ academyId, sender: "own", sessionStatus: "WORKING" }).onConflictDoNothing();
});

describe("team and invites", () => {
  it("lets the owner invite a manager by link, and nobody else", async () => {
    await request(app).get(`${base()}/team`).set(auth(coachId)).expect(403);
    await request(app).post(`${base()}/team/invites`).set(auth(coachId)).send({ role: "manager" }).expect(403);
    const invite = await request(app).post(`${base()}/team/invites`).set(auth(ownerId)).send({ role: "manager", label: "Sami" }).expect(201);
    const token = invite.body.url.split("/").pop();
    expect(invite.body.url).toMatch(/\/academy\/invite\//);
    const peek = await request(app).get(`/api/academy/invites/${token}`).expect(200);
    expect(peek.body).toMatchObject({ state: "open", role: "manager" });
    await request(app).post(`/api/academy/invites/${token}/accept`).set(auth(managerId)).expect(200);
    await request(app).post(`/api/academy/invites/${token}/accept`).set(auth(coachId)).expect(410);
    const team = await request(app).get(`${base()}/team`).set(auth(ownerId)).expect(200);
    expect(team.body.members.map((m: { userId: number; role: string }) => [m.userId, m.role])).toEqual(
      expect.arrayContaining([[ownerId, "owner"], [managerId, "manager"], [coachId, "coach"]]),
    );
    // A manager doesn't manage the team.
    await request(app).get(`${base()}/team`).set(auth(managerId)).expect(403);
    await request(app).put(`${base()}/access`).set(auth(managerId)).send({ sections: { coach: [] } }).expect(403);
  });

  it("gives a manager the owner's controls in every section he can see", async () => {
    const access = await request(app).get(`${base()}/access`).set(auth(managerId)).expect(200);
    expect(access.body.role).toBe("manager");
    expect(access.body.manages).toEqual(expect.arrayContaining(["fees", "profile", "ads"]));
    // Owner-only routes work for him.
    await request(app).put(`${base()}/profile`).set(auth(managerId)).send({ name: "Renamed by manager" }).expect(200);
    await request(app).get(`${base()}/ads/wallet`).set(auth(managerId)).expect(200);
    // …but not for a coach.
    await request(app).put(`${base()}/profile`).set(auth(coachId)).send({ name: "Nope" }).expect(403);
    await request(app).get(`${base()}/ads/wallet`).set(auth(coachId)).expect(403);
  });

  it("lets the owner hide sections from a role, and open owner-only ones to coaches", async () => {
    await request(app).put(`${base()}/access`).set(auth(ownerId)).send({ sections: { manager: ["dashboard", "squads", "players"], coach: ["dashboard", "players", "ads"] } }).expect(200);
    forgetAccess(academyId);
    // Hidden from the manager: no owner controls there any more.
    const hidden = await request(app).get(`${base()}/ads/wallet`).set(auth(managerId)).expect(403);
    expect(hidden.body.code).toBe("section_hidden");
    // Opened to coaches: a coach now runs the academy's ads wallet.
    await request(app).get(`${base()}/ads/wallet`).set(auth(coachId)).expect(200);
    // Squads hidden from coaches: changes refused, reads still allowed (other screens use the list).
    await request(app).post(`${base()}/squads`).set(auth(coachId)).send({ name: "U9" }).expect(403);
    await request(app).get(`${base()}/squads`).set(auth(coachId)).expect(200);
    const coachAccess = await request(app).get(`${base()}/access`).set(auth(coachId)).expect(200);
    expect(coachAccess.body).toMatchObject({ sections: ["dashboard", "players", "ads"], manages: ["ads"] });
    // Back to the defaults for the rest of the file.
    await request(app).put(`${base()}/access`).set(auth(ownerId)).send({ sections: { manager: [...access.CONSOLE], coach: [...access.COACH] } }).expect(200);
    forgetAccess(academyId);
  });

  it("lets the owner hide family screens from players", async () => {
    await request(app).put(`${base()}/access`).set(auth(ownerId)).send({ sections: { player: ["schedule", "news"] } }).expect(200);
    forgetAccess(academyId);
    const screens = await request(app).get("/api/academy/family/screens").set(auth(playerUserId)).expect(200);
    expect(screens.body).toEqual({ role: "player", screens: ["schedule", "news"] });
    const me = await request(app).get("/api/academy/family/me").set(auth(playerUserId)).expect(200);
    expect(me.body.finance).toBeNull();
    expect(me.body.payments).toEqual([]);
    expect(me.body.attendance).toEqual([]);
  });
});

const access = {
  CONSOLE: ["dashboard", "squads", "players", "registrations", "attendance", "schedule", "recordings", "matches", "fees", "announcements", "chats", "people", "whatsapp", "ads", "profile", "branding", "studio"],
  COACH: ["dashboard", "squads", "players", "registrations", "attendance", "schedule", "recordings", "matches", "announcements", "chats", "people", "whatsapp", "profile"],
};

describe("chat controls", () => {
  const phone = "962795551234";
  async function chats(userId = ownerId) {
    return (await request(app).get(`${base()}/whatsapp/chats`).set(auth(userId)).expect(200)).body as Array<{ phone: string; archived: boolean; muted: boolean; blocked: boolean; linkLater: boolean }>;
  }

  it("archives and mutes; only the owner (or a role he allows) may", async () => {
    await hook({ event: "message.any", session: `academy-${academyId}`, payload: { id: `T-${tag}-1`, from: `${phone}@c.us`, fromMe: false, body: "Hello" } });
    await request(app).post(`${base()}/whatsapp/chats/${phone}/state`).set(auth(coachId)).send({ archived: true }).expect(403);
    // Managers have it by default.
    await request(app).post(`${base()}/whatsapp/chats/${phone}/state`).set(auth(managerId)).send({ muted: true }).expect(200);
    await request(app).post(`${base()}/whatsapp/chats/${phone}/state`).set(auth(ownerId)).send({ archived: true }).expect(200);
    expect((await chats()).find((c) => c.phone === phone)).toMatchObject({ archived: true, muted: true, blocked: false });
    // The owner gives it to coaches.
    await request(app).put(`${base()}/access`).set(auth(ownerId)).send({ permissions: { coach: ["chats.manage"] } }).expect(200);
    forgetAccess(academyId);
    await request(app).post(`${base()}/whatsapp/chats/${phone}/state`).set(auth(coachId)).send({ archived: false }).expect(200);
  });

  it("answers 'who is this' with not-a-player or later", async () => {
    const later = await request(app).post(`${base()}/whatsapp/chats/${phone}/who`).set(auth(coachId)).send({ action: "later" }).expect(200);
    expect(later.body).toMatchObject({ kind: "unknown", linkLater: true });
    const none = await request(app).post(`${base()}/whatsapp/chats/${phone}/who`).set(auth(coachId)).send({ action: "none" }).expect(200);
    expect(none.body.kind).toBe("other");
  });

  it("blocks: nothing more is stored or sent", async () => {
    await request(app).post(`${base()}/whatsapp/chats/${phone}/state`).set(auth(ownerId)).send({ blocked: true }).expect(200);
    await hook({ event: "message.any", session: `academy-${academyId}`, payload: { id: `T-${tag}-2`, from: `${phone}@c.us`, fromMe: false, body: "Are you there?" } });
    const rows = await db.select().from(academyWhatsappMessagesTable).where(and(eq(academyWhatsappMessagesTable.academyId, academyId), eq(academyWhatsappMessagesTable.phone, phone)));
    expect(rows.some((r) => r.body === "Are you there?")).toBe(false);
    await request(app).post(`${base()}/whatsapp/chats/${phone}/messages`).set(auth(ownerId)).send({ body: "hi" }).expect(409);
    const hiddenList = await request(app).get(`${base()}/whatsapp/hidden`).set(auth(ownerId)).expect(200);
    expect(hiddenList.body).toEqual([expect.objectContaining({ phone, blocked: true })]);
    await request(app).post(`${base()}/whatsapp/chats/${phone}/state`).set(auth(ownerId)).send({ blocked: false }).expect(200);
  });

  it("marks a chat personal: its messages go, it leaves Chats and People, and new ones aren't kept", async () => {
    await request(app).post(`${base()}/whatsapp/chats/${phone}/state`).set(auth(ownerId)).send({ personal: true }).expect(200);
    expect((await chats()).some((c) => c.phone === phone)).toBe(false);
    const stored = await db.select().from(academyWhatsappMessagesTable).where(and(eq(academyWhatsappMessagesTable.academyId, academyId), eq(academyWhatsappMessagesTable.phone, phone)));
    expect(stored).toHaveLength(0);
    await hook({ event: "message.any", session: `academy-${academyId}`, payload: { id: `T-${tag}-3`, from: `${phone}@c.us`, fromMe: false, body: "dinner tonight?" } });
    await hook({ event: "message.any", session: `academy-${academyId}`, payload: { id: `T-${tag}-4`, to: `${phone}@c.us`, fromMe: true, source: "app", body: "yes" } });
    const after = await db.select().from(academyWhatsappMessagesTable).where(and(eq(academyWhatsappMessagesTable.academyId, academyId), eq(academyWhatsappMessagesTable.phone, phone)));
    expect(after).toHaveLength(0);
    const people = await request(app).get(`${base()}/contacts`).set(auth(ownerId)).expect(200);
    expect(people.body.some((p: { phone: string }) => p.phone === phone)).toBe(false);
    const [contact] = await db.select().from(academyContactsTable).where(and(eq(academyContactsTable.academyId, academyId), eq(academyContactsTable.phone, phone)));
    expect(contact.personalAt).not.toBeNull();
  });
});
