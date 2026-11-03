import { createHmac } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express, { type Express } from "express";
import { eq } from "drizzle-orm";
import {
  academiesTable,
  academyContactsTable,
  academyMembersTable,
  academyWhatsappGroupsTable,
  academyWhatsappMessagesTable,
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
const nextId = () => `WA${++sequence}X`;

vi.mock("../lib/whatsapp/waha", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/whatsapp/waha")>();
  return {
    ...actual,
    wahaConfigured: vi.fn(() => true),
    getSession: vi.fn(async (name: string) => ({ name, status: "WORKING", me: { id: "962700000000@c.us", pushName: "Academy" } })),
    listSessions: vi.fn(async () => []),
    checkNumber: vi.fn(async (_session: string, phone: string) => `${phone}@c.us`),
    sendText: vi.fn(async () => nextId()),
    sendImage: vi.fn(async () => nextId()),
    sendVideo: vi.fn(async () => nextId()),
    sendVoice: vi.fn(async () => nextId()),
    sendFile: vi.fn(async () => nextId()),
    sendSticker: vi.fn(async () => nextId()),
    sendLocation: vi.fn(async () => nextId()),
    sendPoll: vi.fn(async () => `true_962795550001@c.us_POLL${++sequence}`),
    createGroup: vi.fn(async (_session: string, subject: string) => ({ id: "120363000000000001", subject, participants: 3 })),
    listGroups: vi.fn(async () => [
      { id: "120363000000000002", subject: "Family", participants: 5 },
      { id: "120363000000000003", subject: "U12 parents", participants: 20 },
    ]),
    addGroupParticipants: vi.fn(async () => undefined),
    downloadWahaFile: vi.fn(async () => ({ buffer: Buffer.from("jpegbytes"), mimetype: "image/jpeg" })),
    phoneForLid: vi.fn(async () => null),
  };
});

vi.mock("../lib/whatsapp/media", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/whatsapp/media")>();
  return {
    ...actual,
    storeChatMedia: vi.fn(async (academyId: number, buffer: Buffer, mimetype: string, filename?: string | null) => ({
      path: `wa-media/${academyId}/${"a".repeat(31)}${(++sequence % 10)}.${actual.extensionFor(mimetype, filename)}`,
      mimetype, filename: filename ?? null, size: buffer.length,
    })),
    gifToMp4: vi.fn(async () => Buffer.from("mp4bytes")),
  };
});

import whatsappRouter from "./academyWhatsapp";
import * as waha from "../lib/whatsapp/waha";
import * as media from "../lib/whatsapp/media";

const tag = `wan_${Date.now()}`;
let app: Express;
let ownerId: number;
let coachId: number;
let outsiderId: number;
let fieldId: number;
let academyId: number;
let otherAcademyId: number;

const base = () => `/api/academy/console/academies/${academyId}/whatsapp`;
const auth = (id: number) => ({ "x-test-user": String(id) });
const session = () => `academy-${academyId}`;

function sign(body: string) {
  return createHmac("sha512", waha.wahaWebhookSecret()).update(body).digest("hex");
}
async function hook(event: Record<string, unknown>) {
  const body = JSON.stringify(event);
  await request(app).post("/api/whatsapp/webhook").set("content-type", "application/json").set("x-webhook-hmac", sign(body)).send(body).expect(200);
}
async function rows() {
  return db.select().from(academyWhatsappMessagesTable).where(eq(academyWhatsappMessagesTable.academyId, academyId));
}
function upload(bytes: string, type: string, filename: string) {
  return request(app).post(`${base()}/media?filename=${encodeURIComponent(filename)}`).set(auth(coachId)).set("content-type", type).send(Buffer.from(bytes));
}

beforeAll(async () => {
  app = express();
  app.use("/api/whatsapp/webhook", express.raw({ type: "*/*" }));
  app.use("/api/academy/console/academies/:academyId/whatsapp/media", express.raw({ type: "*/*", limit: "31mb" }));
  app.use(express.json());
  app.use("/api", whatsappRouter);
  const users = await db.insert(usersTable).values([
    { name: `Owner ${tag}`, email: `owner-${tag}@test.local` },
    { name: `Coach ${tag}`, email: `coach-${tag}@test.local` },
    { name: `Outsider ${tag}`, email: `outsider-${tag}@test.local` },
  ]).returning({ id: usersTable.id });
  [ownerId, coachId, outsiderId] = users.map((u) => u.id);
  const [field] = await db.insert(fieldsTable).values({ name: `WAN field ${tag}`, cameraId: "camera1" }).returning({ id: fieldsTable.id });
  fieldId = field.id;
  const academies = await db.insert(academiesTable).values([
    { name: `WAN Academy ${tag}`, fieldId },
    { name: `WAN Other ${tag}`, fieldId },
  ]).returning({ id: academiesTable.id });
  [academyId, otherAcademyId] = academies.map((a) => a.id);
  await db.insert(academyMembersTable).values([
    { academyId, userId: ownerId, role: "owner" },
    { academyId, userId: coachId, role: "coach" },
  ]);
  await request(app).put(`${base()}/settings`).set(auth(ownerId)).send({ sender: "own" }).expect(200);
});

beforeEach(async () => {
  vi.clearAllMocks();
  await db.delete(academyWhatsappMessagesTable).where(eq(academyWhatsappMessagesTable.academyId, academyId));
});

afterAll(async () => {
  for (const id of [academyId, otherAcademyId]) if (id) await db.delete(academiesTable).where(eq(academiesTable.id, id));
  if (fieldId) await db.delete(fieldsTable).where(eq(fieldsTable.id, fieldId));
  for (const id of [ownerId, coachId, outsiderId]) if (id) await db.delete(usersTable).where(eq(usersTable.id, id));
});

describe("files", () => {
  it("uploads a photo and sends it with its caption; the chat shows it", async () => {
    const up = await upload("jpegbytes", "image/jpeg", "team.jpg").expect(201);
    expect(up.body.media.path).toMatch(new RegExp(`^wa-media/${academyId}/`));
    const sent = await request(app).post(`${base()}/chats/0795550001/messages`).set(auth(coachId))
      .send({ content: { type: "image", media: up.body.media, caption: "Friday's team" } }).expect(201);
    expect(sent.body.outcome).toBe("sent");
    const [, chatId, file, caption] = vi.mocked(waha.sendImage).mock.calls[0];
    expect(chatId).toBe("962795550001@c.us");
    expect(file.url).toMatch(/\/wa-media\//);
    expect(caption).toBe("Friday's team");
    const thread = await request(app).get(`${base()}/chats/962795550001`).set(auth(coachId)).expect(200);
    expect(thread.body.messages[0]).toMatchObject({ body: "Friday's team", sentBy: `Coach ${tag}`, content: { type: "image" } });
    expect(thread.body.messages[0].content.media.url).toMatch(/^https:\/\/.+\/wa-media\//);
  });

  it("turns an uploaded GIF into a looping video and sends it as a GIF", async () => {
    const up = await upload("GIF89a", "image/gif", "goal.gif").expect(201);
    expect(up.body.gif).toBe(true);
    expect(vi.mocked(media.gifToMp4)).toHaveBeenCalledTimes(1);
    expect(up.body.media.mimetype).toBe("video/mp4");
    await request(app).post(`${base()}/chats/962795550001/messages`).set(auth(coachId))
      .send({ content: { type: "video", media: up.body.media, gif: true } }).expect(201);
    expect(vi.mocked(waha.sendVideo).mock.calls[0][4]).toBe(true);
  });

  it("refuses a file that belongs to another academy", async () => {
    const res = await request(app).post(`${base()}/chats/962795550001/messages`).set(auth(coachId))
      .send({ content: { type: "image", media: { path: `wa-media/${otherAcademyId}/${"b".repeat(32)}.jpg`, mimetype: "image/jpeg" } } });
    expect(res.status).toBe(400);
    expect(vi.mocked(waha.sendImage)).not.toHaveBeenCalled();
  });

  it("keeps a photo someone sends, copied from WAHA", async () => {
    await hook({
      event: "message.any", session: session(),
      payload: {
        id: "IN-IMG-1", from: "962795550002@c.us", fromMe: false, body: "Ali's medical form", hasMedia: true,
        media: { url: "http://localhost:3000/api/files/academy-1/IN-IMG-1.jpeg", mimetype: "image/jpeg" },
        _data: { Message: { imageMessage: {} }, pushName: "Abu Ali" },
      },
    });
    expect(vi.mocked(waha.downloadWahaFile)).toHaveBeenCalledWith("http://localhost:3000/api/files/academy-1/IN-IMG-1.jpeg", media.MAX_CHAT_MEDIA_BYTES);
    const [row] = (await rows()).filter((m) => m.waMessageId === "IN-IMG-1");
    expect(row).toMatchObject({ direction: "in", body: "Ali's medical form" });
    expect(row.content).toMatchObject({ type: "image", media: { mimetype: "image/jpeg" } });
    expect((row.content as { media: { path: string } }).media.path).toMatch(/^wa-media\//);
  });
});

describe("locations and polls", () => {
  it("sends a location and files one that arrives", async () => {
    await request(app).post(`${base()}/chats/962795550001/messages`).set(auth(coachId))
      .send({ content: { type: "location", latitude: 31.95, longitude: 35.91, name: "Galaxy pitch" } }).expect(201);
    expect(vi.mocked(waha.sendLocation).mock.calls[0].slice(1)).toEqual(["962795550001@c.us", 31.95, 35.91, "Galaxy pitch"]);
    await hook({
      event: "message.any", session: session(),
      payload: { id: "IN-LOC-1", from: "962795550001@c.us", fromMe: false, body: "", location: { latitude: 31.9, longitude: 35.8, name: "Home" } },
    });
    const row = (await rows()).find((m) => m.waMessageId === "IN-LOC-1");
    expect(row).toMatchObject({ body: "📍 Home", content: { type: "location", latitude: 31.9, longitude: 35.8 } });
  });

  it("sends a poll and counts votes, letting people change or take back their vote", async () => {
    const res = await request(app).post(`${base()}/chats/962795550001/messages`).set(auth(coachId))
      .send({ content: { type: "poll", name: "Training Friday?", options: ["Yes", "No"], multipleAnswers: false } }).expect(201);
    const [poll] = (await rows()).filter((m) => m.id === res.body.id);
    expect(poll.waMessageId).toMatch(/^POLL/);
    const vote = (selectedOptions: string[]) => hook({
      event: "poll.vote", session: session(),
      payload: { vote: { id: "V", from: "962795550001@c.us", fromMe: false, selectedOptions, timestamp: 1700000000 }, poll: { id: `true_962795550001@c.us_${poll.waMessageId}` } },
    });
    await vote(["No"]);
    await vote(["Yes"]);
    let thread = await request(app).get(`${base()}/chats/962795550001`).set(auth(coachId)).expect(200);
    let content = thread.body.messages.find((m: { id: number }) => m.id === poll.id).content;
    expect(content).toMatchObject({ voters: 1, tally: [{ option: "Yes", count: 1 }, { option: "No", count: 0 }] });
    await vote([]);
    thread = await request(app).get(`${base()}/chats/962795550001`).set(auth(coachId)).expect(200);
    content = thread.body.messages.find((m: { id: number }) => m.id === poll.id).content;
    expect(content.voters).toBe(0);
  });

  it("rejects a poll with repeated options", async () => {
    await request(app).post(`${base()}/chats/962795550001/messages`).set(auth(coachId))
      .send({ content: { type: "poll", name: "?", options: ["Yes", "yes"] } }).expect(400);
  });
});

describe("groups", () => {
  it("creates a group, lists it before any message, posts in it and keeps members' replies with their names", async () => {
    const [contact] = await db.insert(academyContactsTable).values({ academyId, phone: "962795550003", name: "Um Zaid", kind: "parent" }).returning();
    const created = await request(app).post(`${base()}/groups`).set(auth(coachId))
      .send({ subject: "U12 parents", contactIds: [contact.id], phones: ["0795550004"] }).expect(201);
    expect(created.body.phone).toBe("g:120363000000000001");
    expect(vi.mocked(waha.createGroup).mock.calls[0][2].sort()).toEqual(["962795550003@c.us", "962795550004@c.us"]);

    let chats = await request(app).get(`${base()}/chats`).set(auth(coachId)).expect(200);
    expect(chats.body.find((c: { phone: string }) => c.phone === "g:120363000000000001")).toMatchObject({ display: "U12 parents", group: { subject: "U12 parents" } });

    await request(app).post(`${base()}/chats/${encodeURIComponent("g:120363000000000001")}/messages`).set(auth(coachId)).send({ body: "Kit day Saturday" }).expect(201);
    expect(vi.mocked(waha.sendText).mock.calls[0][1]).toBe("120363000000000001@g.us");
    expect(vi.mocked(waha.checkNumber)).not.toHaveBeenCalled();

    await hook({
      event: "message.any", session: session(),
      payload: { id: "IN-GRP-1", from: "120363000000000001@g.us", participant: "962795550003@c.us", fromMe: false, body: "Thanks coach", _data: { pushName: "Um Zaid" } },
    });
    // A group the academy doesn't follow (a family group on the phone) is never stored.
    await hook({
      event: "message.any", session: session(),
      payload: { id: "IN-GRP-2", from: "120363000000000002@g.us", participant: "962795550009@c.us", fromMe: false, body: "Dinner at 8" },
    });
    const stored = await rows();
    expect(stored.find((m) => m.waMessageId === "IN-GRP-1")).toMatchObject({ phone: "g:120363000000000001", authorPhone: "962795550003", authorName: "Um Zaid" });
    expect(stored.some((m) => m.waMessageId === "IN-GRP-2")).toBe(false);
    chats = await request(app).get(`${base()}/chats`).set(auth(coachId)).expect(200);
    expect(chats.body.find((c: { phone: string }) => c.phone === "g:120363000000000001")).toMatchObject({ unread: 1, lastBody: "Um Zaid: Thanks coach" });
  });

  it("lets the owner follow a group the phone is already in, and stop following it", async () => {
    await request(app).get(`${base()}/groups/available`).set(auth(coachId)).expect(403);
    const available = await request(app).get(`${base()}/groups/available`).set(auth(ownerId)).expect(200);
    expect(available.body.map((g: { subject: string }) => g.subject)).toEqual(["Family", "U12 parents"]);
    await request(app).post(`${base()}/groups/follow`).set(auth(ownerId)).send({ groupId: "120363000000000003@g.us", subject: "U12 parents" }).expect(201);
    await hook({ event: "message.any", session: session(), payload: { id: "IN-GRP-3", from: "120363000000000003@g.us", participant: "962795550005@c.us", fromMe: false, body: "Hi" } });
    expect((await rows()).some((m) => m.waMessageId === "IN-GRP-3")).toBe(true);
    await request(app).post(`${base()}/chats/${encodeURIComponent("g:120363000000000003")}/state`).set(auth(ownerId)).send({ personal: true }).expect(200);
    expect((await rows()).some((m) => m.phone === "g:120363000000000003")).toBe(false);
    const groups = await db.select().from(academyWhatsappGroupsTable).where(eq(academyWhatsappGroupsTable.groupId, "120363000000000003"));
    expect(groups).toHaveLength(0);
  });
});

describe("assigning and starting chats", () => {
  it("hands a chat to a coach, only to someone on the team", async () => {
    const team = await request(app).get(`${base()}/assignees`).set(auth(coachId)).expect(200);
    expect(team.body.map((m: { role: string }) => m.role)).toEqual(["owner", "coach"]);
    await request(app).post(`${base()}/chats/962795550006/assign`).set(auth(ownerId)).send({ userId: outsiderId }).expect(404);
    await request(app).post(`${base()}/chats/962795550006/assign`).set(auth(ownerId)).send({ userId: coachId }).expect(200);
    await hook({ event: "message.any", session: session(), payload: { id: "IN-AS-1", from: "962795550006@c.us", fromMe: false, body: "Hello" } });
    const chats = await request(app).get(`${base()}/chats`).set(auth(coachId)).expect(200);
    expect(chats.body.find((c: { phone: string }) => c.phone === "962795550006").assignedUserId).toBe(coachId);
    await request(app).post(`${base()}/chats/962795550006/assign`).set(auth(coachId)).send({ userId: null }).expect(200);
  });

  it("checks a new number before a chat starts", async () => {
    const res = await request(app).post(`${base()}/check`).set(auth(coachId)).send({ phone: "079 555 0010" }).expect(200);
    expect(res.body).toMatchObject({ phone: "962795550010", onWhatsapp: true });
    await request(app).post(`${base()}/check`).set(auth(coachId)).send({ phone: "12" }).expect(400);
  });

  it("files a message to Replay's number from someone exactly one Replay-sending academy knows", async () => {
    await request(app).put(`${base()}/settings`).set(auth(ownerId)).send({ sender: "replay" }).expect(200);
    try {
      await db.insert(academyContactsTable).values({ academyId, phone: "962795550020", name: "Abu Omar", kind: "parent" });
      await hook({ event: "message.any", session: "replay", payload: { id: "IN-RP-1", from: "962795550020@c.us", fromMe: false, body: "Is training on?" } });
      // A stranger with no history stays out.
      await hook({ event: "message.any", session: "replay", payload: { id: "IN-RP-2", from: "962795550021@c.us", fromMe: false, body: "hey" } });
      const stored = await rows();
      expect(stored.find((m) => m.waMessageId === "IN-RP-1")).toMatchObject({ direction: "in", phone: "962795550020" });
      expect(stored.some((m) => m.waMessageId === "IN-RP-2")).toBe(false);
    } finally {
      await request(app).put(`${base()}/settings`).set(auth(ownerId)).send({ sender: "own" }).expect(200);
    }
  });
});
