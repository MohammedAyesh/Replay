import { createHmac } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express, { type Express } from "express";
import { and, eq } from "drizzle-orm";
import {
  academiesTable,
  academyContactsTable,
  academyMembersTable,
  academyWhatsappGroupsTable,
  academyWhatsappMessagesTable,
  academyWhatsappPostsTable,
  academyWhatsappSavedRepliesTable,
  academyWhatsappSettingsTable,
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

let sequence = 0;
const nextId = () => `WB${++sequence}X`;

vi.mock("../lib/whatsapp/waha", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/whatsapp/waha")>();
  return {
    ...actual,
    wahaConfigured: vi.fn(() => true),
    getSession: vi.fn(async (name: string) => ({ name, status: "WORKING", me: { id: "962700000000@c.us", pushName: "Academy" } })),
    listSessions: vi.fn(async () => []),
    checkNumber: vi.fn(async (_s: string, phone: string) => `${phone}@c.us`),
    sendText: vi.fn(async () => nextId()),
    sendImage: vi.fn(async () => nextId()),
    sendVideo: vi.fn(async () => nextId()),
    sendContacts: vi.fn(async () => nextId()),
    sendPoll: vi.fn(async () => nextId()),
    setReaction: vi.fn(async () => undefined),
    deleteMessage: vi.fn(async () => undefined),
    editMessage: vi.fn(async () => undefined),
    sendSeen: vi.fn(async () => undefined),
    setTyping: vi.fn(async () => undefined),
    subscribePresence: vi.fn(async () => undefined),
    getPictureUrl: vi.fn(async () => "https://pps.whatsapp.net/v/photo.jpg"),
    fetchImageBytes: vi.fn(async () => ({ buffer: Buffer.from("jpg"), mimetype: "image/jpeg" })),
    postStatus: vi.fn(async () => nextId()),
    deleteStatus: vi.fn(async () => undefined),
    createChannel: vi.fn(async (_s: string, name: string) => ({ id: "120363999@newsletter", name, invite: "https://whatsapp.com/channel/abc" })),
    getGroupMembers: vi.fn(async () => [
      { id: "962795550003@c.us", phone: "962795550003", admin: true },
      { id: "962795550004@c.us", phone: "962795550004", admin: false },
    ]),
    setGroupSubject: vi.fn(async () => undefined),
    setGroupDescription: vi.fn(async () => undefined),
    setGroupPicture: vi.fn(async () => undefined),
    setGroupAdminsOnly: vi.fn(async () => undefined),
    removeGroupMembers: vi.fn(async () => undefined),
    setGroupAdmins: vi.fn(async () => undefined),
    getGroupInviteLink: vi.fn(async (_s: string, _g: string, revoke?: boolean) => (revoke ? "https://chat.whatsapp.com/NEW" : "https://chat.whatsapp.com/OLD")),
    phoneForLid: vi.fn(async () => null),
  };
});

vi.mock("../lib/whatsapp/media", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/whatsapp/media")>();
  return {
    ...actual,
    storeChatMedia: vi.fn(async (academyId: number, buffer: Buffer, mimetype: string) => ({
      path: `wa-media/${academyId}/${"c".repeat(31)}${(++sequence % 10)}.jpg`, mimetype, filename: null, size: buffer.length,
    })),
  };
});

import whatsappRouter from "./academyWhatsapp";
import whatsappChatRouter from "./academyWhatsappChat";
import * as waha from "../lib/whatsapp/waha";

const tag = `wac_${Date.now()}`;
let app: Express;
let ownerId: number;
let coachId: number;
let fieldId: number;
let academyId: number;

const base = () => `/api/academy/console/academies/${academyId}/whatsapp`;
const auth = (id: number) => ({ "x-test-user": String(id) });
const session = () => `academy-${academyId}`;
const sign = (body: string) => createHmac("sha512", waha.wahaWebhookSecret()).update(body).digest("hex");
async function hook(event: Record<string, unknown>) {
  const body = JSON.stringify(event);
  await request(app).post("/api/whatsapp/webhook").set("content-type", "application/json").set("x-webhook-hmac", sign(body)).send(body).expect(200);
}
const rows = () => db.select().from(academyWhatsappMessagesTable).where(eq(academyWhatsappMessagesTable.academyId, academyId));
const inbound = (id: string, body: string, extra: Record<string, unknown> = {}) =>
  hook({ event: "message.any", session: session(), payload: { id, from: "962795550001@c.us", fromMe: false, body, ...extra } });
const setOptions = (patch: Record<string, unknown>) => request(app).put(`${base()}/options`).set(auth(ownerId)).send(patch).expect(200);

beforeAll(async () => {
  app = express();
  app.use("/api/whatsapp/webhook", express.raw({ type: "*/*" }));
  app.use(express.json());
  app.use("/api", whatsappRouter);
  app.use("/api", whatsappChatRouter);
  const users = await db.insert(usersTable).values([
    { name: `Owner ${tag}`, email: `owner-${tag}@test.local` },
    { name: `Coach ${tag}`, email: `coach-${tag}@test.local` },
  ]).returning({ id: usersTable.id });
  [ownerId, coachId] = users.map((u) => u.id);
  const [field] = await db.insert(fieldsTable).values({ name: `WAC field ${tag}`, cameraId: "camera1" }).returning({ id: fieldsTable.id });
  fieldId = field.id;
  const [academy] = await db.insert(academiesTable).values({ name: `WAC Academy ${tag}`, fieldId }).returning({ id: academiesTable.id });
  academyId = academy.id;
  await db.insert(academyMembersTable).values([{ academyId, userId: ownerId, role: "owner" }, { academyId, userId: coachId, role: "coach" }]);
  await request(app).put(`${base()}/settings`).set(auth(ownerId)).send({ sender: "own" }).expect(200);
});

beforeEach(async () => {
  vi.clearAllMocks();
  await db.delete(academyWhatsappMessagesTable).where(eq(academyWhatsappMessagesTable.academyId, academyId));
  await db.delete(academyContactsTable).where(eq(academyContactsTable.academyId, academyId));
  await db.update(academyWhatsappSettingsTable).set({ chatOptions: {} }).where(eq(academyWhatsappSettingsTable.academyId, academyId));
});

afterAll(async () => {
  if (academyId) await db.delete(academiesTable).where(eq(academiesTable.id, academyId));
  if (fieldId) await db.delete(fieldsTable).where(eq(fieldsTable.id, fieldId));
  for (const id of [ownerId, coachId]) if (id) await db.delete(usersTable).where(eq(usersTable.id, id));
});

describe("replies, reactions, edit and delete", () => {
  it("quotes a message in a reply and shows the quote when they reply to ours", async () => {
    await inbound("IN-Q1", "Can Ali come Friday?");
    const quoted = (await rows()).find((m) => m.waMessageId === "IN-Q1")!;
    await request(app).post(`${base()}/chats/962795550001/messages`).set(auth(coachId)).send({ body: "Yes, 5pm", replyToId: quoted.id }).expect(201);
    expect(vi.mocked(waha.sendText).mock.calls[0][3]).toMatchObject({ replyTo: "false_962795550001@c.us_IN-Q1" });
    const sent = (await rows()).find((m) => m.direction === "out")!;
    await inbound("IN-Q2", "Thanks", { replyTo: { id: `true_962795550001@c.us_${sent.waMessageId}` } });
    const thread = await request(app).get(`${base()}/chats/962795550001`).set(auth(coachId)).expect(200);
    const reply = thread.body.messages.find((m: { body: string }) => m.body === "Thanks");
    expect(reply.replyTo).toMatchObject({ id: sent.id, body: "Yes, 5pm", author: "me" });
    const mine = thread.body.messages.find((m: { id: number }) => m.id === sent.id);
    expect(mine.replyTo).toMatchObject({ id: quoted.id, body: "Can Ali come Friday?" });
    await request(app).post(`${base()}/chats/962795550001/messages`).set(auth(coachId)).send({ body: "x", replyToId: 999999 }).expect(400);
  });

  it("reacts to a message and records reactions that arrive", async () => {
    await inbound("IN-R1", "Great session");
    const m = (await rows()).find((r) => r.waMessageId === "IN-R1")!;
    await request(app).post(`${base()}/chats/962795550001/messages/${m.id}/reaction`).set(auth(coachId)).send({ emoji: "👍" }).expect(200);
    expect(vi.mocked(waha.setReaction)).toHaveBeenCalledWith(session(), "false_962795550001@c.us_IN-R1", "👍");
    await hook({ event: "message.reaction", session: session(), payload: { id: "RX1", from: "962795550001@c.us", fromMe: false, reaction: { text: "❤️", messageId: "false_962795550001@c.us_IN-R1" } } });
    let thread = await request(app).get(`${base()}/chats/962795550001`).set(auth(coachId)).expect(200);
    expect(thread.body.messages[0].reactions.map((r: { emoji: string }) => r.emoji).sort()).toEqual(["❤️", "👍"]);
    await hook({ event: "message.reaction", session: session(), payload: { id: "RX2", from: "962795550001@c.us", fromMe: false, reaction: { text: "", messageId: "false_962795550001@c.us_IN-R1" } } });
    thread = await request(app).get(`${base()}/chats/962795550001`).set(auth(coachId)).expect(200);
    expect(thread.body.messages[0].reactions.map((r: { emoji: string }) => r.emoji)).toEqual(["👍"]);
  });

  it("deletes our own message for everyone, and clears one the other person deletes", async () => {
    const sent = await request(app).post(`${base()}/chats/962795550001/messages`).set(auth(coachId)).send({ body: "Oops wrong chat" }).expect(201);
    await request(app).delete(`${base()}/chats/962795550001/messages/${sent.body.id}`).set(auth(coachId)).expect(200);
    expect(vi.mocked(waha.deleteMessage).mock.calls[0][2]).toMatch(/^true_962795550001@c\.us_WB/);
    expect((await rows()).find((m) => m.id === sent.body.id)).toMatchObject({ body: "", content: null });
    await inbound("IN-D1", "secret");
    await hook({ event: "message.revoked", session: session(), payload: { revokedMessageId: "IN-D1" } });
    expect((await rows()).find((m) => m.waMessageId === "IN-D1")).toMatchObject({ body: "" });
    const thread = await request(app).get(`${base()}/chats/962795550001`).set(auth(coachId)).expect(200);
    expect(thread.body.messages.every((m: { deleted: boolean }) => m.deleted)).toBe(true);
  });

  it("edits a text message we sent, and follows edits made by the other person", async () => {
    const sent = await request(app).post(`${base()}/chats/962795550001/messages`).set(auth(coachId)).send({ body: "See you at 5" }).expect(201);
    await request(app).put(`${base()}/chats/962795550001/messages/${sent.body.id}`).set(auth(coachId)).send({ text: "See you at 6" }).expect(200);
    expect(vi.mocked(waha.editMessage).mock.calls[0][3]).toBe("See you at 6");
    expect((await rows()).find((m) => m.id === sent.body.id)).toMatchObject({ body: "See you at 6" });
    // Older than 15 minutes: refused.
    await db.update(academyWhatsappMessagesTable).set({ sentAt: new Date(Date.now() - 20 * 60_000) }).where(eq(academyWhatsappMessagesTable.id, sent.body.id));
    await request(app).put(`${base()}/chats/962795550001/messages/${sent.body.id}`).set(auth(coachId)).send({ text: "late" }).expect(409);
    await inbound("IN-E1", "Ill be there");
    await hook({ event: "message.edited", session: session(), payload: { id: "IN-E1b", editedMessageId: "IN-E1", body: "I'll be there" } });
    expect((await rows()).find((m) => m.waMessageId === "IN-E1")).toMatchObject({ body: "I'll be there" });
  });
});

describe("scheduling, forwarding, typing, read receipts", () => {
  it("schedules a message for later and can cancel it", async () => {
    const at = new Date(Date.now() + 3 * 3_600_000).toISOString();
    const res = await request(app).post(`${base()}/chats/962795550001/messages`).set(auth(coachId)).send({ body: "Reminder", scheduledFor: at }).expect(201);
    expect(res.body).toMatchObject({ outcome: "queued", scheduled: true });
    expect(vi.mocked(waha.sendText)).not.toHaveBeenCalled();
    const thread = await request(app).get(`${base()}/chats/962795550001`).set(auth(coachId)).expect(200);
    expect(thread.body.messages[0].scheduledFor).toBeTruthy();
    await request(app).delete(`${base()}/chats/962795550001/messages/${res.body.id}`).set(auth(coachId)).expect(200);
    expect(await rows()).toHaveLength(0);
    await request(app).post(`${base()}/chats/962795550001/messages`).set(auth(coachId)).send({ body: "x", scheduledFor: "2020-01-01T00:00:00Z" }).expect(400);
  });

  it("forwards a message to a number and to a group", async () => {
    await db.insert(academyWhatsappGroupsTable).values({ academyId, groupId: "120363111", session: session(), subject: "Coaches" });
    const sent = await request(app).post(`${base()}/chats/962795550001/messages`).set(auth(coachId)).send({ body: "Kit list attached" }).expect(201);
    vi.mocked(waha.sendText).mockClear();
    const res = await request(app).post(`${base()}/chats/962795550001/messages/${sent.body.id}/forward`).set(auth(coachId))
      .send({ targets: ["0795550002", "g:120363111", "g:999"] }).expect(200);
    expect(res.body).toMatchObject({ sent: 2, skipped: ["g:999"] });
    expect(vi.mocked(waha.sendText).mock.calls.map((c) => c[1]).sort()).toEqual(["120363111@g.us", "962795550002@c.us"]);
  });

  it("sends blue ticks when a chat is opened, unless read receipts are off, and shows typing", async () => {
    await inbound("IN-S1", "Hello");
    await request(app).get(`${base()}/chats/962795550001`).set(auth(coachId)).expect(200);
    expect(vi.mocked(waha.sendSeen)).toHaveBeenCalledWith(session(), "962795550001@c.us", ["false_962795550001@c.us_IN-S1"]);
    vi.mocked(waha.sendSeen).mockClear();
    await setOptions({ readReceipts: false });
    await inbound("IN-S2", "Again");
    await request(app).get(`${base()}/chats/962795550001`).set(auth(coachId)).expect(200);
    expect(vi.mocked(waha.sendSeen)).not.toHaveBeenCalled();

    await hook({ event: "presence.update", session: session(), payload: { id: "962795550001@c.us", presences: [{ participant: "962795550001@c.us", lastKnownPresence: "typing" }] } });
    let thread = await request(app).get(`${base()}/chats/962795550001`).set(auth(coachId)).expect(200);
    expect(thread.body.typing).toBe(true);
    await hook({ event: "presence.update", session: session(), payload: { id: "962795550001@c.us", presences: [{ participant: "962795550001@c.us", lastKnownPresence: "paused" }] } });
    thread = await request(app).get(`${base()}/chats/962795550001`).set(auth(coachId)).expect(200);
    expect(thread.body.typing).toBe(false);
    await request(app).post(`${base()}/chats/962795550001/typing`).set(auth(coachId)).send({ typing: true }).expect(200);
    expect(vi.mocked(waha.setTyping)).toHaveBeenCalledWith(session(), "962795550001@c.us", true);
  });

  it("copies profile photos to storage in the background", async () => {
    await inbound("IN-A1", "Hi");
    await request(app).get(`${base()}/chats`).set(auth(coachId)).expect(200);
    await vi.waitFor(async () => {
      const [c] = await db.select().from(academyContactsTable).where(and(eq(academyContactsTable.academyId, academyId), eq(academyContactsTable.phone, "962795550001")));
      expect(c.avatarPath).toMatch(/^wa-media\//);
    });
    const chats = await request(app).get(`${base()}/chats`).set(auth(coachId)).expect(200);
    expect(chats.body[0].avatarUrl).toMatch(/^https:\/\/.+\/wa-media\//);
  });
});

describe("search, media, contact cards and mentions", () => {
  it("searches a chat and lists its media", async () => {
    await inbound("IN-F1", "Registration form attached");
    await inbound("IN-F2", "Thanks!");
    await db.update(academyWhatsappMessagesTable).set({ content: { type: "document", media: { path: `wa-media/${academyId}/${"d".repeat(32)}.pdf`, mimetype: "application/pdf", filename: "form.pdf" } } }).where(eq(academyWhatsappMessagesTable.waMessageId, "IN-F1"));
    const found = await request(app).get(`${base()}/chats/962795550001/search?q=form`).set(auth(coachId)).expect(200);
    expect(found.body.map((m: { body: string }) => m.body)).toEqual(["Registration form attached"]);
    expect((await request(app).get(`${base()}/chats/962795550001/search?q=%25`).set(auth(coachId)).expect(200)).body).toEqual([]);
    const media = await request(app).get(`${base()}/chats/962795550001/media`).set(auth(coachId)).expect(200);
    expect(media.body).toHaveLength(1);
    expect(media.body[0].content).toMatchObject({ type: "document", media: { filename: "form.pdf" } });
  });

  it("sends a contact card and files one that arrives", async () => {
    await request(app).post(`${base()}/chats/962795550001/messages`).set(auth(coachId))
      .send({ content: { type: "contact", contacts: [{ name: "Coach Sami", phone: "962795550030" }] } }).expect(201);
    expect(vi.mocked(waha.sendContacts).mock.calls[0][2]).toEqual([{ name: "Coach Sami", phone: "962795550030" }]);
    await inbound("IN-C1", "", { vCards: ["BEGIN:VCARD\nVERSION:3.0\nFN:Abu Omar\nTEL;type=CELL;waid=962795550031:+962 79 555 0031\nEND:VCARD"], _data: { Message: { contactMessage: {} } } });
    const row = (await rows()).find((m) => m.waMessageId === "IN-C1")!;
    expect(row.content).toMatchObject({ type: "contact", contacts: [{ name: "Abu Omar", phone: "962795550031" }] });
    expect(row.body).toBe("👤 Abu Omar");
  });

  it("mentions people in a group message", async () => {
    await db.insert(academyWhatsappGroupsTable).values({ academyId, groupId: "120363222", session: session(), subject: "U12" });
    await request(app).post(`${base()}/chats/${encodeURIComponent("g:120363222")}/messages`).set(auth(coachId)).send({ body: "@962795550003 please confirm" }).expect(201);
    expect(vi.mocked(waha.sendText).mock.calls[0][3]).toMatchObject({ mentions: ["962795550003@c.us"] });
  });
});

describe("saved replies, auto-replies and missed calls", () => {
  it("lets the owner keep saved replies; coaches read but can't change them", async () => {
    await request(app).post(`${base()}/saved-replies`).set(auth(coachId)).send({ shortcut: "price", title: "Prices", body: "35 JOD a month" }).expect(403);
    await request(app).post(`${base()}/saved-replies`).set(auth(ownerId)).send({ shortcut: "Price", title: "Prices", body: "35 JOD a month" }).expect(201);
    await request(app).post(`${base()}/saved-replies`).set(auth(ownerId)).send({ shortcut: "two words", title: "x", body: "y" }).expect(400);
    const list = await request(app).get(`${base()}/saved-replies`).set(auth(coachId)).expect(200);
    expect(list.body).toMatchObject({ canEdit: false, replies: [{ shortcut: "price", body: "35 JOD a month" }] });
    await db.delete(academyWhatsappSavedRepliesTable).where(eq(academyWhatsappSavedRepliesTable.academyId, academyId));
  });

  it("greets a new number once and sends the closed message once per half-day", async () => {
    await setOptions({ greeting: { enabled: true, text: "Welcome!" }, away: { enabled: true, text: "We are closed", days: [], start: "09:00", end: "21:00" } });
    await inbound("IN-G1", "Hello");
    await inbound("IN-G2", "Anyone there?");
    const bodies = (await rows()).filter((m) => m.direction === "out" && m.phone === "962795550001").map((m) => m.body);
    // The first message is greeted; the closed message goes out once for the second one (the first got the greeting).
    expect(bodies.filter((b) => b === "Welcome!")).toHaveLength(1);
    expect(bodies.filter((b) => b === "We are closed")).toHaveLength(1);
    // Not for STOP, and a different number is greeted separately.
    await hook({ event: "message.any", session: session(), payload: { id: "IN-G3", from: "962795550040@c.us", fromMe: false, body: "stop" } });
    expect((await rows()).filter((m) => m.phone === "962795550040" && m.direction === "out").map((m) => m.body).join("|")).not.toMatch(/Welcome|closed/);
  });

  it("notes a missed call and replies once an hour when enabled", async () => {
    await setOptions({ missedCall: { enabled: true, text: "Please message us" } });
    await hook({ event: "call.received", session: session(), payload: { id: "CALL1", from: "962795550050@c.us", isVideo: false, isGroup: false } });
    await hook({ event: "call.received", session: session(), payload: { id: "CALL2", from: "962795550050@c.us", isVideo: true, isGroup: false } });
    const stored = (await rows()).filter((m) => m.phone === "962795550050");
    expect(stored.filter((m) => m.kind === "call").map((m) => m.body)).toEqual(["📞 مكالمة فائتة", "📹 مكالمة فيديو فائتة"]);
    expect(stored.filter((m) => m.kind === "auto_reply")).toHaveLength(1);
  });
});

describe("options, Status, Channel and group management", () => {
  it("keeps chat options owner-only to change", async () => {
    await request(app).put(`${base()}/options`).set(auth(coachId)).send({ readReceipts: false }).expect(403);
    const saved = await setOptions({ readReceipts: false, greeting: { enabled: true, text: "Hi there" } });
    expect(saved.body).toMatchObject({ readReceipts: false, greeting: { enabled: true, text: "Hi there" } });
    expect((await request(app).get(`${base()}/options`).set(auth(coachId)).expect(200)).body.readReceipts).toBe(false);
  });

  it("posts to Status and the Channel, owner only", async () => {
    await request(app).post(`${base()}/posts`).set(auth(coachId)).send({ target: "status", kind: "text", text: "Hi" }).expect(403);
    const status = await request(app).post(`${base()}/posts`).set(auth(ownerId)).send({ target: "status", kind: "text", text: "Match day!", backgroundColor: "#112233" }).expect(201);
    expect(vi.mocked(waha.postStatus).mock.calls[0][1]).toMatchObject({ kind: "text", text: "Match day!", backgroundColor: "#112233" });
    await request(app).post(`${base()}/posts`).set(auth(ownerId)).send({ target: "channel", kind: "text", text: "News" }).expect(409);
    await request(app).post(`${base()}/channel`).set(auth(ownerId)).send({ name: "GUVA News", description: "Updates" }).expect(201);
    await request(app).post(`${base()}/channel`).set(auth(ownerId)).send({ name: "Again" }).expect(409);
    await request(app).post(`${base()}/posts`).set(auth(ownerId)).send({ target: "channel", kind: "text", text: "Registration open" }).expect(201);
    expect(vi.mocked(waha.sendText).mock.calls.at(-1)?.[1]).toBe("120363999@newsletter");
    await request(app).delete(`${base()}/posts/${status.body.id}`).set(auth(ownerId)).expect(204);
    expect(vi.mocked(waha.deleteStatus)).toHaveBeenCalledTimes(1);
    const list = await request(app).get(`${base()}/posts`).set(auth(ownerId)).expect(200);
    expect(list.body.channel).toMatchObject({ name: "GUVA News" });
    expect(list.body.posts).toHaveLength(1);
    await db.delete(academyWhatsappPostsTable).where(eq(academyWhatsappPostsTable.academyId, academyId));
  });

  it("manages a group: members, rename, announcement-only, admins, remove, invite link", async () => {
    await db.insert(academyWhatsappGroupsTable).values({ academyId, groupId: "120363333", session: session(), subject: "Parents" });
    const g = `${base()}/groups/120363333`;
    const members = await request(app).get(`${g}/members`).set(auth(coachId)).expect(200);
    expect(members.body.map((m: { admin: boolean }) => m.admin)).toEqual([true, false]);
    await request(app).put(g).set(auth(coachId)).send({ subject: "Nope" }).expect(403);
    await request(app).put(g).set(auth(ownerId)).send({ subject: "U12 Parents", description: "News only", adminsOnlyMessages: true }).expect(200);
    expect(vi.mocked(waha.setGroupSubject)).toHaveBeenCalledWith(session(), "120363333", "U12 Parents");
    expect(vi.mocked(waha.setGroupAdminsOnly)).toHaveBeenCalledWith(session(), "120363333", "messages", true);
    expect((await db.select().from(academyWhatsappGroupsTable).where(eq(academyWhatsappGroupsTable.groupId, "120363333")))[0].subject).toBe("U12 Parents");
    await request(app).post(`${g}/admins`).set(auth(ownerId)).send({ phones: ["0795550004"], admin: true }).expect(200);
    expect(vi.mocked(waha.setGroupAdmins)).toHaveBeenCalledWith(session(), "120363333", ["962795550004@c.us"], true);
    await request(app).post(`${g}/members/remove`).set(auth(ownerId)).send({ phones: ["0795550004"] }).expect(200);
    expect((await request(app).get(`${g}/invite`).set(auth(coachId)).expect(200)).body.link).toBe("https://chat.whatsapp.com/OLD");
    expect((await request(app).post(`${g}/invite/revoke`).set(auth(ownerId)).expect(200)).body.link).toBe("https://chat.whatsapp.com/NEW");
    await request(app).put(`${base()}/groups/999`).set(auth(ownerId)).send({ subject: "x" }).expect(404);
  });
});
