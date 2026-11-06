import { createHmac } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express, { type Express } from "express";
import { eq } from "drizzle-orm";
import {
  academiesTable,
  academyAdMediaTable,
  academyContactsTable,
  academyMembersTable,
  academySocialAccountsTable,
  academySocialCommentsTable,
  academySocialMessagesTable,
  academySocialPostsTable,
  academySocialThreadsTable,
  db,
  fieldsTable,
  usersTable,
} from "@workspace/db";

const instagramLoginMock = vi.hoisted(() => ({
  assets: [] as Array<{ id: string; username?: string; profile_picture_url?: string }>,
  lookupResponses: {} as Record<string, {
    accounts?: Array<{ id: string; username?: string; profile_picture_url?: string }>;
    status?: number;
    error?: { message: string; status: number; code?: number; subcode?: number };
  }>,
  lookupCalls: [] as string[],
  clientBusinessId: "123456789012345",
  businessLookupError: null as null | { message: string; status: number; code?: number; subcode?: number },
  limitError: null as null | { message: string; status: number; code?: number },
  mutationError: null as null | { message: string; status: number; code?: number; subcode?: number },
}));

process.env.META_ACCESS_TOKEN = "test-token";
process.env.META_AD_ACCOUNT_ID = "123456";
process.env.META_APP_SECRET = "test-app-secret";
process.env.META_APP_ID = "1401484938413305";

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

const stamp = Date.now();
const TEST_BUSINESS_ID = "123456789012345";
const PAGE = `7${stamp}`;
const IG = `17${stamp}`;
const IGSID = `55${stamp}`;
const PSID = `66${stamp}`;
const posts: Array<{ path: string; params: Record<string, string> }> = [];
const deletes: string[] = [];
let seq = 0;

vi.mock("../lib/meta/graph", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/meta/graph")>();
  return {
    ...actual,
    graphGetWithStatus: vi.fn(async (path: string) => {
      instagramLoginMock.lookupCalls.push(path);
      if (path === "me") {
        const error = instagramLoginMock.businessLookupError;
        if (error) throw new actual.MetaGraphError(error.message, error.status, error.code, error.subcode);
        return { data: { client_business_id: instagramLoginMock.clientBusinessId }, status: 200 };
      }
      const configured = instagramLoginMock.lookupResponses[path];
      if (configured?.error) {
        const error = configured.error;
        throw new actual.MetaGraphError(error.message, error.status, error.code, error.subcode);
      }
      return {
        data: {
          data: configured?.accounts
            ?? (path === "me/assigned_instagram_accounts" ? instagramLoginMock.assets : []),
        },
        status: configured?.status ?? 200,
      };
    }),
    graphGet: vi.fn(async (path: string, params: Record<string, string> = {}) => {
      if (path === "me") return { client_business_id: "test-business" };
      if (path === "me/assigned_instagram_accounts") return { data: instagramLoginMock.assets };
      if (path.endsWith("/content_publishing_limit")) {
        if (instagramLoginMock.limitError) {
          const e = instagramLoginMock.limitError;
          throw new actual.MetaGraphError(e.message, e.status, e.code);
        }
        return { data: [{ quota_usage: 3, config: { quota_total: 100 } }] };
      }
      if (path === IGSID) return { name: "Sami Haddad", username: "sami.h", profile_pic: "https://pic/x.jpg" };
      if (path === PSID) return { first_name: "Abu", last_name: "Kareem" };
      if (path.startsWith("ig-media-")) return { permalink: `https://instagram.com/p/${path}`, caption: "Training day" };
      if (path.startsWith("ig-container-")) return { status_code: "FINISHED" };
      if (path.startsWith("ig-published-")) return { permalink: "https://instagram.com/p/new" };
      if (path.startsWith("fb-post-")) return { permalink_url: "https://facebook.com/post/1", message: "Hi" };
      if (path.endsWith("/conversations")) return { data: [] };
      if (params.fields?.includes("permalink")) return {};
      throw new actual.MetaGraphError(`unexpected GET ${path}`, 404);
    }),
    graphPost: vi.fn(async (path: string, params: Record<string, string> = {}) => {
      posts.push({ path, params });
      if (instagramLoginMock.mutationError) {
        const error = instagramLoginMock.mutationError;
        throw new actual.MetaGraphError(error.message, error.status, error.code, error.subcode);
      }
      seq += 1;
      if (path === `${PAGE}/messages`) {
        const recipient = JSON.parse(params.recipient);
        return recipient.comment_id ? { message_id: `m-private-${seq}`, recipient_id: IGSID } : { message_id: `m-out-${seq}`, recipient_id: recipient.id };
      }
      if (path === `${IG}/media`) return { id: `ig-container-${seq}` };
      if (path === `${IG}/media_publish`) return { id: `ig-published-${seq}` };
      if (path === `${PAGE}/photos`) return { id: `photo-${seq}`, post_id: `fb-post-${seq}` };
      if (path.endsWith("/comments") || path.endsWith("/replies")) return { id: `social-comment-${seq}` };
      return { success: true };
    }),
    graphDelete: vi.fn(async (path: string) => {
      deletes.push(path);
      if (instagramLoginMock.mutationError) {
        const error = instagramLoginMock.mutationError;
        throw new actual.MetaGraphError(error.message, error.status, error.code, error.subcode);
      }
    }),
  };
});

import { encryptToken } from "../lib/meta/crypto";
import { mediaSignature } from "../lib/social/account";
import { maybeRunSocial } from "../lib/social/posts";
import { checkInstagram } from "../lib/venues/igGraph";
import { sectionForPath } from "../lib/academyPermissions";
import metaRouter from "./metaAds";
import socialRouter from "./academySocial";

let app: Express;
let ownerId: number;
let coachId: number;
let fieldId: number;
let academyId: number;
let mediaId: number;
const auth = (id: number) => ({ "x-test-user": String(id) });
const base = () => `/api/academy/console/academies/${academyId}/social`;
const JPEG = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==";

async function hook(body: unknown) {
  const raw = JSON.stringify(body);
  const signature = `sha256=${createHmac("sha256", "test-app-secret").update(raw).digest("hex")}`;
  return request(app).post("/api/meta/webhook").set("content-type", "application/json").set("x-hub-signature-256", signature).send(raw).expect(200);
}

const igDm = (mid: string, text: string, extra: Record<string, unknown> = {}) => ({
  object: "instagram",
  entry: [{ id: IG, time: Date.now(), messaging: [{ sender: { id: IGSID }, recipient: { id: IG }, timestamp: Date.now(), message: { mid, text, ...extra } }] }],
});

beforeAll(async () => {
  app = express();
  app.use("/api/meta/webhook", express.raw({ type: "*/*" }));
  app.use(express.json({ limit: "10mb" }));
  app.use("/api", metaRouter);
  app.use("/api", socialRouter);
  const users = await db.insert(usersTable).values([
    { name: `Owner ${stamp}`, email: `so-owner-${stamp}@test.local` },
    { name: `Coach ${stamp}`, email: `so-coach-${stamp}@test.local` },
  ]).returning({ id: usersTable.id });
  [ownerId, coachId] = users.map((u) => u.id);
  const [field] = await db.insert(fieldsTable).values({ name: `Social field ${stamp}`, cameraId: "camera1" }).returning({ id: fieldsTable.id });
  fieldId = field.id;
  const [academy] = await db.insert(academiesTable).values({ name: `Social Academy ${stamp}`, fieldId }).returning({ id: academiesTable.id });
  academyId = academy.id;
  await db.insert(academyMembersTable).values([
    { academyId, userId: ownerId, role: "owner" },
    { academyId, userId: coachId, role: "coach" },
  ]);
  await db.insert(academySocialAccountsTable).values({
    academyId, tokenEnc: encryptToken("sys-token"), pageId: PAGE, pageName: "Galaxy Academy", pageTokenEnc: encryptToken("page-token"),
    igUserId: IG, igUsername: "galaxy.academy", subscribed: true, status: "connected", connectedAt: new Date(),
  });
  const [m] = await db.insert(academyAdMediaTable).values({ academyId, kind: "image", name: "Team photo", imageData: JPEG, status: "ready" }).returning({ id: academyAdMediaTable.id });
  mediaId = m.id;
});

beforeEach(() => {
  posts.length = 0;
  deletes.length = 0;
  instagramLoginMock.assets = [];
  instagramLoginMock.lookupResponses = {};
  instagramLoginMock.lookupCalls.length = 0;
  instagramLoginMock.clientBusinessId = TEST_BUSINESS_ID;
  instagramLoginMock.businessLookupError = null;
  instagramLoginMock.limitError = null;
  instagramLoginMock.mutationError = null;
});

afterAll(async () => {
  if (academyId) await db.delete(academiesTable).where(eq(academiesTable.id, academyId));
  if (fieldId) await db.delete(fieldsTable).where(eq(fieldsTable.id, fieldId));
  for (const id of [ownerId, coachId]) if (id) await db.delete(usersTable).where(eq(usersTable.id, id));
});

describe("permissions", () => {
  it("puts Instagram/Messenger chats in Chats and the rest in Social", () => {
    expect(sectionForPath("/academy/console/academies/3/social/threads/9")).toEqual({ academyId: 3, section: "chats" });
    expect(sectionForPath("/academy/console/academies/3/social/threads-hidden")).toEqual({ academyId: 3, section: "chats" });
    expect(sectionForPath("/academy/console/academies/3/social/comments")).toEqual({ academyId: 3, section: "social" });
    expect(sectionForPath("/academy/console/academies/3/social")).toEqual({ academyId: 3, section: "social" });
  });
});

describe("Instagram Direct and Messenger", () => {
  it("files a DM into a thread with the person's profile, once", async () => {
    await hook(igDm(`mid-1-${stamp}`, "Do you have a U10 team?"));
    await hook(igDm(`mid-1-${stamp}`, "Do you have a U10 team?")); // Meta retries
    const [thread] = await db.select().from(academySocialThreadsTable).where(eq(academySocialThreadsTable.externalUserId, IGSID));
    expect(thread).toMatchObject({ academyId, channel: "instagram", name: "Sami Haddad", username: "sami.h", stage: "new" });
    expect(thread.lastInAt).not.toBeNull();
    const messages = await db.select().from(academySocialMessagesTable).where(eq(academySocialMessagesTable.threadId, thread.id));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ direction: "in", body: "Do you have a U10 team?", status: "received" });
  });

  it("keeps replies typed in the Instagram app (echoes) but not its own sends", async () => {
    const echo = (mid: string, appId?: string) => ({
      object: "instagram",
      entry: [{ id: IG, messaging: [{ sender: { id: IG }, recipient: { id: IGSID }, timestamp: Date.now(), message: { mid, text: "Yes, Tuesdays", is_echo: true, ...(appId ? { app_id: appId } : {}) } }] }],
    });
    await hook(echo(`mid-echo-${stamp}`));
    await hook(echo(`mid-ours-${stamp}`, "1401484938413305"));
    const rows = await db.select().from(academySocialMessagesTable).where(eq(academySocialMessagesTable.direction, "out"));
    const mine = rows.filter((r) => r.academyId === academyId);
    expect(mine.map((r) => r.externalId)).toEqual([`mid-echo-${stamp}`]);
    expect(mine[0].kind).toBe("app");
  });

  it("files Messenger messages too, and lists both with unread counts", async () => {
    await hook({ object: "page", entry: [{ id: PAGE, messaging: [{ sender: { id: PSID }, recipient: { id: PAGE }, timestamp: Date.now(), message: { mid: `mid-fb-${stamp}`, text: "Price?" } }] }] });
    const list = await request(app).get(`${base()}/threads`).set(auth(coachId)).expect(200);
    expect(list.body).toHaveLength(2);
    const fb = list.body.find((t: { channel: string }) => t.channel === "messenger");
    expect(fb).toMatchObject({ name: "Abu Kareem", unread: 1, lastBody: "Price?", replyWindow: "open" });
    const overview = await request(app).get(base()).set(auth(ownerId)).expect(200);
    expect(overview.body).toMatchObject({ unreadThreads: 2, connection: { status: "connected", igUsername: "galaxy.academy" }, canManage: true });
  });

  it("replies inside the 24-hour window and refuses after 7 days", async () => {
    const [thread] = await db.select().from(academySocialThreadsTable).where(eq(academySocialThreadsTable.externalUserId, IGSID));
    const sent = await request(app).post(`${base()}/threads/${thread.id}/messages`).set(auth(coachId)).send({ body: "Yes! Come Tuesday at 5" }).expect(201);
    expect(sent.body.status).toBe("sent");
    expect(posts[0]).toMatchObject({ path: `${PAGE}/messages` });
    expect(posts[0].params.messaging_type).toBe("RESPONSE");
    expect(JSON.parse(posts[0].params.recipient)).toEqual({ id: IGSID });
    const [after] = await db.select().from(academySocialThreadsTable).where(eq(academySocialThreadsTable.id, thread.id));
    expect(after.stage).toBe("contacted");

    await db.update(academySocialThreadsTable).set({ lastInAt: new Date(Date.now() - 3 * 86400_000) }).where(eq(academySocialThreadsTable.id, thread.id));
    posts.length = 0;
    await request(app).post(`${base()}/threads/${thread.id}/messages`).set(auth(ownerId)).send({ body: "Still interested?" }).expect(201);
    expect(posts[0].params).toMatchObject({ messaging_type: "MESSAGE_TAG", tag: "HUMAN_AGENT" });

    await db.update(academySocialThreadsTable).set({ lastInAt: new Date(Date.now() - 8 * 86400_000) }).where(eq(academySocialThreadsTable.id, thread.id));
    const late = await request(app).post(`${base()}/threads/${thread.id}/messages`).set(auth(ownerId)).send({ body: "Hello?" }).expect(409);
    expect(late.body.error).toMatch(/24 hours/);
  });

  it("archive/mute/block/personal need chats.manage; personal deletes the messages, blocked drops new ones", async () => {
    const [thread] = await db.select().from(academySocialThreadsTable).where(eq(academySocialThreadsTable.externalUserId, PSID));
    await request(app).post(`${base()}/threads/${thread.id}/state`).set(auth(coachId)).send({ archived: true }).expect(403);
    await request(app).post(`${base()}/threads/${thread.id}/state`).set(auth(ownerId)).send({ blocked: true }).expect(200);
    await hook({ object: "page", entry: [{ id: PAGE, messaging: [{ sender: { id: PSID }, recipient: { id: PAGE }, timestamp: Date.now(), message: { mid: `mid-fb2-${stamp}`, text: "hello??" } }] }] });
    expect(await db.select().from(academySocialMessagesTable).where(eq(academySocialMessagesTable.externalId, `mid-fb2-${stamp}`))).toHaveLength(0);
    await request(app).post(`${base()}/threads/${thread.id}/messages`).set(auth(ownerId)).send({ body: "x" }).expect(409);
    await request(app).post(`${base()}/threads/${thread.id}/state`).set(auth(ownerId)).send({ personal: true }).expect(200);
    expect(await db.select().from(academySocialMessagesTable).where(eq(academySocialMessagesTable.threadId, thread.id))).toHaveLength(0);
    const hidden = await request(app).get(`${base()}/threads-hidden`).set(auth(ownerId)).expect(200);
    expect(hidden.body[0]).toMatchObject({ id: thread.id, personal: true, blocked: true });
    const list = await request(app).get(`${base()}/threads`).set(auth(ownerId)).expect(200);
    expect(list.body.map((t: { id: number }) => t.id)).not.toContain(thread.id);
  });

  it("files the person into People as a lead once their phone is known", async () => {
    const [thread] = await db.select().from(academySocialThreadsTable).where(eq(academySocialThreadsTable.externalUserId, IGSID));
    await request(app).put(`${base()}/threads/${thread.id}/lead`).set(auth(coachId)).send({ phone: "0791234567" }).expect(200);
    const res = await request(app).put(`${base()}/threads/${thread.id}/lead`).set(auth(coachId)).send({ stage: "trial" }).expect(200);
    expect(res.body).toMatchObject({ stage: "trial", contact: { kind: "lead", stage: "trial", name: "Sami Haddad" } });
    const [contact] = await db.select().from(academyContactsTable).where(eq(academyContactsTable.id, res.body.contact.id));
    expect(contact).toMatchObject({ academyId, phone: "962791234567", source: "instagram" });
  });
});

describe("comments", () => {
  it("files Instagram and Facebook comments, skipping the academy's own", async () => {
    await hook({ object: "instagram", entry: [{ id: IG, changes: [
      { field: "comments", value: { id: `c-ig-${stamp}`, text: "How much per month?", from: { id: IGSID, username: "sami.h" }, media: { id: `ig-media-1` } } },
      { field: "comments", value: { id: `c-own-${stamp}`, text: "Thanks!", from: { id: IG, username: "galaxy.academy" }, media: { id: `ig-media-1` } } },
    ] }] });
    await hook({ object: "page", entry: [{ id: PAGE, changes: [{ field: "feed", value: { item: "comment", verb: "add", comment_id: `c-fb-${stamp}`, post_id: `fb-post-1`, parent_id: `fb-post-1`, message: "Location?", from: { id: PSID, name: "Abu Kareem" }, created_time: Math.floor(Date.now() / 1000) } }] }] });
    const list = await request(app).get(`${base()}/comments`).set(auth(ownerId)).expect(200);
    expect(list.body).toHaveLength(2);
    const ig = list.body.find((c: { channel: string }) => c.channel === "instagram");
    expect(ig).toMatchObject({ body: "How much per month?", fromName: "@sami.h", postPermalink: "https://instagram.com/p/ig-media-1", canPrivateReply: true });
  });

  it("replies, hides and sends one private message that opens a DM", async () => {
    const [ig] = await db.select().from(academySocialCommentsTable).where(eq(academySocialCommentsTable.commentId, `c-ig-${stamp}`));
    await request(app).post(`${base()}/comments/${ig.id}/private-reply`).set(auth(coachId)).send({ text: "Sent you the prices!" }).expect(403);
    const pr = await request(app).post(`${base()}/comments/${ig.id}/private-reply`).set(auth(ownerId)).send({ text: "Sent you the prices!" }).expect(200);
    expect(JSON.parse(posts[0].params.recipient)).toEqual({ comment_id: `c-ig-${stamp}` });
    expect(pr.body.threadId).toBeTruthy();
    await request(app).post(`${base()}/comments/${ig.id}/private-reply`).set(auth(ownerId)).send({ text: "again" }).expect(409);
    const [fb] = await db.select().from(academySocialCommentsTable).where(eq(academySocialCommentsTable.commentId, `c-fb-${stamp}`));
    await request(app).post(`${base()}/comments/${fb.id}/reply`).set(auth(ownerId)).send({ text: "Airport Road" }).expect(200);
    expect(posts.at(-1)).toMatchObject({ path: `c-fb-${stamp}/comments`, params: { message: "Airport Road" } });
    await request(app).post(`${base()}/comments/${fb.id}/hide`).set(auth(ownerId)).send({ hidden: true }).expect(200);
    expect(posts.at(-1)).toMatchObject({ path: `c-fb-${stamp}`, params: { is_hidden: "true" } });
    const open = await request(app).get(`${base()}/comments`).set(auth(ownerId)).expect(200);
    expect(open.body).toHaveLength(0);
  });

  it("creates a top-level comment on a selected published channel and records it locally", async () => {
    const post = await request(app).post(`${base()}/posts`).set(auth(ownerId))
      .send({ targets: ["facebook", "instagram"], format: "image", caption: "Match day", mediaIds: [mediaId] }).expect(201);
    const [publishedPost] = await db.select().from(academySocialPostsTable).where(eq(academySocialPostsTable.id, post.body.id));
    await request(app).post(`${base()}/posts/${post.body.id}/comments`).set(auth(coachId))
      .send({ channel: "facebook", text: "Welcome to the match!" }).expect(403);
    const created = await request(app).post(`${base()}/posts/${post.body.id}/comments`).set(auth(ownerId))
      .send({ channel: "facebook", text: "Welcome to the match!" }).expect(201);
    const [comment] = await db.select().from(academySocialCommentsTable).where(eq(academySocialCommentsTable.commentId, created.body.commentId));
    expect(posts.at(-1)).toMatchObject({ path: `${publishedPost.fbPostId}/comments`, params: { message: "Welcome to the match!" } });
    expect(comment).toMatchObject({
      academyId,
      channel: "facebook",
      postId: publishedPost.fbPostId,
      fromId: PAGE,
      body: "Welcome to the match!",
    });
  });

  it("edits Facebook-authored comments and replies, rejects Instagram edits, and deletes any comment", async () => {
    const [ownFacebook] = await db.insert(academySocialCommentsTable).values({
      academyId,
      channel: "facebook",
      commentId: `fb-own-${stamp}`,
      postId: `fb-post-${stamp}`,
      fromId: PAGE,
      body: "Old Page comment",
      replyBody: "Old Page reply",
      replyCommentId: `fb-reply-${stamp}`,
    }).returning();
    const [otherFacebook] = await db.insert(academySocialCommentsTable).values({
      academyId,
      channel: "facebook",
      commentId: `fb-other-${stamp}`,
      postId: `fb-post-${stamp}`,
      fromId: PSID,
      body: "A visitor comment",
    }).returning();
    const [instagram] = await db.insert(academySocialCommentsTable).values({
      academyId,
      channel: "instagram",
      commentId: `ig-own-${stamp}`,
      postId: `ig-post-${stamp}`,
      fromId: IG,
      body: "Instagram comment",
    }).returning();

    await request(app).patch(`${base()}/comments/${ownFacebook.id}`).set(auth(coachId))
      .send({ text: "Edited by manager" }).expect(403);
    await request(app).patch(`${base()}/comments/${ownFacebook.id}`).set(auth(ownerId))
      .send({ text: "Edited by manager" }).expect(200);
    expect(posts.at(-1)).toMatchObject({ path: ownFacebook.commentId, params: { message: "Edited by manager" } });
    await request(app).patch(`${base()}/comments/${ownFacebook.id}/reply`).set(auth(ownerId))
      .send({ text: "Edited Page reply" }).expect(200);
    expect(posts.at(-1)).toMatchObject({ path: ownFacebook.replyCommentId, params: { message: "Edited Page reply" } });
    await request(app).delete(`${base()}/comments/${ownFacebook.id}/reply`).set(auth(ownerId)).expect(200);
    expect(deletes).toContain(ownFacebook.replyCommentId);
    await request(app).patch(`${base()}/comments/${instagram.id}`).set(auth(ownerId))
      .send({ text: "Not allowed" }).expect(400);
    await request(app).delete(`${base()}/comments/${otherFacebook.id}`).set(auth(ownerId)).expect(200);
    expect(deletes).toContain(otherFacebook.commentId);
    const [deleted] = await db.select().from(academySocialCommentsTable).where(eq(academySocialCommentsTable.id, otherFacebook.id));
    expect(deleted.deletedAt).not.toBeNull();
  });

  it("returns clear permission and time-limit errors without changing local text", async () => {
    const [comment] = await db.insert(academySocialCommentsTable).values({
      academyId,
      channel: "facebook",
      commentId: `fb-limit-${stamp}`,
      postId: `fb-post-${stamp}`,
      fromId: PAGE,
      body: "Original",
    }).returning();
    instagramLoginMock.mutationError = { message: "Permission denied", status: 400, code: 200 };
    const denied = await request(app).patch(`${base()}/comments/${comment.id}`).set(auth(ownerId))
      .send({ text: "Not saved" }).expect(403);
    expect(denied.body.error).toMatch(/permission/i);
    instagramLoginMock.mutationError = { message: "The 24-hour action limit has passed", status: 400, code: 4 };
    const limited = await request(app).patch(`${base()}/comments/${comment.id}`).set(auth(ownerId))
      .send({ text: "Still not saved" }).expect(409);
    expect(limited.body.error).toMatch(/time or account limit/i);
    const [unchanged] = await db.select().from(academySocialCommentsTable).where(eq(academySocialCommentsTable.id, comment.id));
    expect(unchanged.body).toBe("Original");
  });
});

describe("posts", () => {
  it("publishes a photo to Instagram and Facebook from the media library", async () => {
    const res = await request(app).post(`${base()}/posts`).set(auth(ownerId))
      .send({ targets: ["instagram", "facebook"], format: "image", caption: "Match day 🔥", mediaIds: [mediaId] }).expect(201);
    expect(res.body.status).toBe("published");
    const igCreate = posts.find((p) => p.path === `${IG}/media`)!;
    expect(igCreate.params.image_url).toContain(`/api/social/media/${mediaId}/${mediaSignature(mediaId)}.jpg`);
    expect(posts.some((p) => p.path === `${IG}/media_publish`)).toBe(true);
    expect(posts.find((p) => p.path === `${PAGE}/photos`)!.params.caption).toBe("Match day 🔥");
    const [row] = await db.select().from(academySocialPostsTable).where(eq(academySocialPostsTable.id, res.body.id));
    expect(row.igPermalink).toBe("https://instagram.com/p/new");
    expect(row.fbPostId).toMatch(/^fb-post-/);
  });

  it("checks the format and holds scheduled posts until their time", async () => {
    await request(app).post(`${base()}/posts`).set(auth(ownerId)).send({ targets: ["instagram"], format: "reel", caption: "", mediaIds: [mediaId] }).expect(400);
    await request(app).post(`${base()}/posts`).set(auth(coachId)).send({ targets: ["instagram"], format: "image", mediaIds: [mediaId] }).expect(403);
    const soon = new Date(Date.now() + 60 * 60_000).toISOString();
    const res = await request(app).post(`${base()}/posts`).set(auth(ownerId)).send({ targets: ["instagram"], format: "image", caption: "Later", mediaIds: [mediaId], scheduledFor: soon }).expect(201);
    expect(res.body.status).toBe("scheduled");
    expect(posts).toHaveLength(0);
    await db.update(academySocialPostsTable).set({ scheduledFor: new Date(Date.now() - 1000) }).where(eq(academySocialPostsTable.id, res.body.id));
    await maybeRunSocial(Number.MAX_SAFE_INTEGER);
    const [row] = await db.select().from(academySocialPostsTable).where(eq(academySocialPostsTable.id, res.body.id));
    expect(row.status).toBe("published");
  });

  it("edits only Facebook copy and deletes each published target without erasing Replay history", async () => {
    const created = await request(app).post(`${base()}/posts`).set(auth(ownerId))
      .send({ targets: ["instagram", "facebook"], format: "image", caption: "Both captions", mediaIds: [mediaId] }).expect(201);
    const [original] = await db.select().from(academySocialPostsTable).where(eq(academySocialPostsTable.id, created.body.id));
    await request(app).patch(`${base()}/posts/${original.id}`).set(auth(coachId))
      .send({ caption: "Coach can't edit" }).expect(403);
    await request(app).patch(`${base()}/posts/${original.id}`).set(auth(ownerId))
      .send({ caption: "Facebook-only update" }).expect(200);
    expect(posts.at(-1)).toMatchObject({ path: original.fbPostId, params: { message: "Facebook-only update" } });
    const [edited] = await db.select().from(academySocialPostsTable).where(eq(academySocialPostsTable.id, original.id));
    expect(edited.caption).toBe("Both captions");
    expect(edited.facebookCaption).toBe("Facebook-only update");

    await request(app).delete(`${base()}/posts/${original.id}?channel=facebook`).set(auth(ownerId)).expect(200);
    expect(deletes).toContain(original.fbPostId);
    const [afterFacebookDelete] = await db.select().from(academySocialPostsTable).where(eq(academySocialPostsTable.id, original.id));
    expect(afterFacebookDelete.targets).toEqual(["instagram"]);
    expect(afterFacebookDelete.deletedAt).toBeNull();
    expect((await request(app).get(`${base()}/posts`).set(auth(ownerId)).expect(200)).body.some((p: { id: number }) => p.id === original.id)).toBe(true);

    await request(app).delete(`${base()}/posts/${original.id}?channel=instagram`).set(auth(ownerId)).expect(200);
    const [afterInstagramDelete] = await db.select().from(academySocialPostsTable).where(eq(academySocialPostsTable.id, original.id));
    expect(afterInstagramDelete.deletedAt).not.toBeNull();
    expect((await request(app).get(`${base()}/posts`).set(auth(ownerId)).expect(200)).body.some((p: { id: number }) => p.id === original.id)).toBe(false);
  });

  it("reports missing Meta permissions and treats already-deleted posts as successful", async () => {
    const created = await request(app).post(`${base()}/posts`).set(auth(ownerId))
      .send({ targets: ["facebook"], format: "image", caption: "Page post", mediaIds: [mediaId] }).expect(201);
    const [post] = await db.select().from(academySocialPostsTable).where(eq(academySocialPostsTable.id, created.body.id));
    instagramLoginMock.mutationError = { message: "Missing permissions to delete this post", status: 400, code: 200 };
    const denied = await request(app).delete(`${base()}/posts/${post.id}?channel=facebook`).set(auth(ownerId)).expect(403);
    expect(denied.body.error).toMatch(/permission/i);
    const [stillPublished] = await db.select().from(academySocialPostsTable).where(eq(academySocialPostsTable.id, post.id));
    expect(stillPublished.deletedAt).toBeNull();
    expect(stillPublished.targets).toEqual(["facebook"]);

    instagramLoginMock.mutationError = { message: "Object was already deleted", status: 400, code: 100 };
    const gone = await request(app).delete(`${base()}/posts/${post.id}?channel=facebook`).set(auth(ownerId)).expect(200);
    expect(gone.body.message).toMatch(/already deleted|removed from Replay/i);
    const [marked] = await db.select().from(academySocialPostsTable).where(eq(academySocialPostsTable.id, post.id));
    expect(marked.deletedAt).not.toBeNull();
  });

  it("serves media to Meta only on a signed link", async () => {
    await request(app).get(`/api/social/media/${mediaId}/deadbeefdeadbeefdeadbeef.jpg`).expect(404);
    const ok = await request(app).get(`/api/social/media/${mediaId}/${mediaSignature(mediaId)}.jpg`).expect(200);
    expect(ok.headers["content-type"]).toBe("image/jpeg");
  });
});

describe("Instagram API with Unified Login", () => {
  const instagramId1 = `8${stamp}`;
  const instagramId2 = `9${stamp}`;
  const instagramId3 = `7${stamp}`;
  const instagramId4 = `6${stamp}`;
  const previousInstagramLoginEnabled = process.env.INSTAGRAM_LOGIN_ENABLED;
  let unifiedFieldId = 0;
  let unifiedAcademyId = 0;
  beforeAll(async () => {
    process.env.INSTAGRAM_LOGIN_ENABLED = "true";
    const [field] = await db.insert(fieldsTable).values({ name: `Instagram Login ${stamp}`, cameraId: `ig-login-${stamp}` }).returning({ id: fieldsTable.id });
    unifiedFieldId = field.id;
    const [academy] = await db.insert(academiesTable).values({ name: `Instagram Login Academy ${stamp}`, fieldId: field.id }).returning({ id: academiesTable.id });
    unifiedAcademyId = academy.id;
    await db.insert(academyMembersTable).values({ academyId: unifiedAcademyId, userId: ownerId, role: "owner" });
  });
  afterAll(async () => {
    if (previousInstagramLoginEnabled === undefined) delete process.env.INSTAGRAM_LOGIN_ENABLED;
    else process.env.INSTAGRAM_LOGIN_ENABLED = previousInstagramLoginEnabled;
    if (unifiedAcademyId) await db.delete(academiesTable).where(eq(academiesTable.id, unifiedAcademyId));
    if (unifiedFieldId) await db.delete(fieldsTable).where(eq(fieldsTable.id, unifiedFieldId));
  });

  const startLogin = async (academy = unifiedAcademyId) => {
    const res = await request(app).post(`/api/academy/console/academies/${academy}/social/connect/instagram`)
      .set(auth(ownerId)).send({}).expect(200);
    return { url: new URL(res.body.url as string), state: new URL(res.body.url as string).searchParams.get("state")! };
  };
  const completeLogin = async (
    state: string,
    assets: typeof instagramLoginMock.assets,
    lookupResponses: typeof instagramLoginMock.lookupResponses = {},
  ) => {
    instagramLoginMock.assets = assets;
    instagramLoginMock.lookupResponses = lookupResponses;
    instagramLoginMock.lookupCalls.length = 0;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: "test-instagram-system-token" }), { status: 200 }),
    );
    try {
      return await request(app).post("/api/academy/console/social/instagram/callback").set(auth(ownerId))
        .send({ state, code: "test-auth-code" });
    } finally {
      fetchSpy.mockRestore();
    }
  };

  it("defaults Instagram-only login off when the environment switch is unset", async () => {
    const enabledSetting = process.env.INSTAGRAM_LOGIN_ENABLED;
    delete process.env.INSTAGRAM_LOGIN_ENABLED;
    try {
      const status = await request(app).get("/api/social/instagram-login/status").expect(200);
      expect(status.body).toEqual({ enabled: false });

      const overview = await request(app).get(`/api/academy/console/academies/${unifiedAcademyId}/social`)
        .set(auth(ownerId)).expect(200);
      expect(overview.body.app.instagramLoginEnabled).toBe(false);

      const start = await request(app).post(`/api/academy/console/academies/${unifiedAcademyId}/social/connect/instagram`)
        .set(auth(ownerId)).send({}).expect(404);
      expect(start.body.error).toBe("This sign-in option isn't available right now");

      const finish = await request(app).post("/api/academy/console/social/instagram/callback")
        .set(auth(ownerId)).send({ state: "ignored-while-disabled", code: "test-auth-code" }).expect(404);
      expect(finish.body.error).toBe("This sign-in option isn't available right now");
    } finally {
      if (enabledSetting === undefined) delete process.env.INSTAGRAM_LOGIN_ENABLED;
      else process.env.INSTAGRAM_LOGIN_ENABLED = enabledSetting;
    }
  });

  it("signs and consumes owner/academy state, exchanges one account, and saves it without a Page", async () => {
    const { url, state } = await startLogin();
    expect(url.origin + url.pathname).toBe("https://www.facebook.com/dialog/oauth");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: "1401484938413305",
      config_id: "1126113460026170",
      redirect_uri: "https://replayjo.com/connect/instagram/callback",
      response_type: "code",
      display: "popup",
      prompt: "login",
    });
    expect(state).toBeTruthy();

    const invalid = `${state.slice(0, -1)}${state.endsWith("A") ? "B" : "A"}`;
    await request(app).post("/api/academy/console/social/instagram/callback").set(auth(ownerId))
      .send({ state: invalid, code: "test-auth-code" }).expect(400);

    const connected = await completeLogin(state, [{ id: instagramId1, username: "jordangalaxy0", profile_picture_url: "https://pic/ig.jpg" }]);
    expect(connected.status).toBe(200);
    expect(connected.body).toMatchObject({ status: "connected", igUsername: "jordangalaxy0", academyId: unifiedAcademyId });
    const [saved] = await db.select().from(academySocialAccountsTable).where(eq(academySocialAccountsTable.academyId, unifiedAcademyId));
    expect(saved).toMatchObject({
      status: "connected",
      pageId: null,
      pageName: null,
      pageTokenEnc: null,
      igUserId: instagramId1,
      igUsername: "jordangalaxy0",
      igPicture: "https://pic/ig.jpg",
      connectedBy: ownerId,
    });
    expect(saved.tokenEnc).toBeTruthy();
    expect(saved.connectedAt).toBeInstanceOf(Date);

    await request(app).post("/api/academy/console/social/instagram/callback").set(auth(ownerId))
      .send({ state, code: "test-auth-code" }).expect(400);
  });

  it("lets the owner choose among multiple assigned accounts", async () => {
    const { state } = await startLogin();
    const response = await completeLogin(state, [
      { id: instagramId1, username: "first" },
      { id: instagramId2, username: "second" },
    ]);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: "pending", accounts: [{ id: instagramId1 }, { id: instagramId2 }] });
    const unifiedBase = `/api/academy/console/academies/${unifiedAcademyId}/social`;
    const choices = await request(app).get(`${unifiedBase}/instagram-accounts`).set(auth(ownerId)).expect(200);
    expect(choices.body.map((item: { id: string }) => item.id)).toEqual([instagramId1, instagramId2]);

    const selected = await request(app).post(`${unifiedBase}/instagram-account`).set(auth(ownerId))
      .send({ instagramId: instagramId2 }).expect(200);
    expect(selected.body).toMatchObject({ status: "connected", igUsername: "second" });
    const [saved] = await db.select().from(academySocialAccountsTable).where(eq(academySocialAccountsTable.academyId, unifiedAcademyId));
    expect(saved).toMatchObject({ pageId: null, pageName: null, pageTokenEnc: null, igUserId: instagramId2, igUsername: "second" });
  });

  it("falls back to owned Instagram accounts when the assigned lookup is empty", async () => {
    const { state } = await startLogin();
    const response = await completeLogin(state, [], {
      [`${TEST_BUSINESS_ID}/owned_instagram_accounts`]: {
        accounts: [{ id: instagramId3, username: "owned.account", profile_picture_url: "https://pic/owned.jpg" }],
      },
    });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: "connected", igUsername: "owned.account", academyId: unifiedAcademyId });
    expect(instagramLoginMock.lookupCalls).toEqual([
      "me",
      "me/assigned_instagram_accounts",
      `${TEST_BUSINESS_ID}/owned_instagram_accounts`,
    ]);
    const [saved] = await db.select().from(academySocialAccountsTable).where(eq(academySocialAccountsTable.academyId, unifiedAcademyId));
    expect(saved).toMatchObject({ status: "connected", igUserId: instagramId3, igUsername: "owned.account" });
  });

  it("continues to a later account lookup after an earlier lookup errors", async () => {
    const { state } = await startLogin();
    const response = await completeLogin(state, [], {
      "me/assigned_instagram_accounts": {
        error: { message: "Assigned account lookup denied", status: 403, code: 10, subcode: 123 },
      },
      [`${TEST_BUSINESS_ID}/owned_instagram_accounts`]: {
        accounts: [{ id: instagramId4, username: "later.account" }],
      },
    });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: "connected", igUsername: "later.account", academyId: unifiedAcademyId });
    expect(instagramLoginMock.lookupCalls).toEqual([
      "me",
      "me/assigned_instagram_accounts",
      `${TEST_BUSINESS_ID}/owned_instagram_accounts`,
    ]);
  });

  it("explains when Meta returned no Instagram assets", async () => {
    const { state } = await startLogin();
    const response = await completeLogin(state, []);
    expect(response.status).toBe(400);
    expect(response.body.error).toContain("Pick your Instagram account when Meta asks, then try again. (Ref: no_ig_assets)");
    expect(instagramLoginMock.lookupCalls).toEqual([
      "me",
      "me/assigned_instagram_accounts",
      `${TEST_BUSINESS_ID}/owned_instagram_accounts`,
      `${TEST_BUSINESS_ID}/instagram_accounts`,
      `${TEST_BUSINESS_ID}/client_instagram_accounts`,
    ]);
  });

  it("does not show an empty pending login as a connection", async () => {
    const [field] = await db.insert(fieldsTable).values({ name: `Empty Instagram ${stamp}`, cameraId: `empty-ig-${stamp}` })
      .returning({ id: fieldsTable.id });
    const [academy] = await db.insert(academiesTable).values({ name: `Empty Instagram Academy ${stamp}`, fieldId: field.id })
      .returning({ id: academiesTable.id });
    await db.insert(academyMembersTable).values({ academyId: academy.id, userId: ownerId, role: "owner" });
    try {
      await startLogin(academy.id);
      const overview = await request(app).get(`/api/academy/console/academies/${academy.id}/social`)
        .set(auth(ownerId)).expect(200);
      expect(overview.body.connection).toBeNull();
      const [stored] = await db.select().from(academySocialAccountsTable).where(eq(academySocialAccountsTable.academyId, academy.id));
      expect(stored).toMatchObject({ status: "pending", tokenEnc: null, pageTokenEnc: null, pageId: null, igUserId: null });
    } finally {
      await db.delete(academiesTable).where(eq(academiesTable.id, academy.id));
      await db.delete(fieldsTable).where(eq(fieldsTable.id, field.id));
    }
  });

  it("marks permission and expired-token errors for reconnect without treating account type as permission", async () => {
    const [account] = await db.select().from(academySocialAccountsTable).where(eq(academySocialAccountsTable.academyId, unifiedAcademyId));
    instagramLoginMock.limitError = { message: "Permissions error", status: 403, code: 200 };
    const permission = await checkInstagram(account);
    expect(permission).toMatchObject({
      ok: false,
      code: "reconnect",
      error: "Replay doesn't have permission for this Instagram account yet. Connect again and allow every permission.",
    });
    let [saved] = await db.select().from(academySocialAccountsTable).where(eq(academySocialAccountsTable.academyId, unifiedAcademyId));
    expect(saved.status).toBe("error");

    await db.update(academySocialAccountsTable).set({ status: "connected", error: null }).where(eq(academySocialAccountsTable.academyId, unifiedAcademyId));
    instagramLoginMock.limitError = { message: "Error validating access token", status: 400, code: 190 };
    const [active] = await db.select().from(academySocialAccountsTable).where(eq(academySocialAccountsTable.academyId, unifiedAcademyId));
    expect(await checkInstagram(active)).toMatchObject({ ok: false, code: "reconnect" });
    [saved] = await db.select().from(academySocialAccountsTable).where(eq(academySocialAccountsTable.academyId, unifiedAcademyId));
    expect(saved.status).toBe("error");

    await db.update(academySocialAccountsTable).set({ status: "connected", error: null }).where(eq(academySocialAccountsTable.academyId, unifiedAcademyId));
    instagramLoginMock.limitError = { message: "Instagram account type is not supported for publishing", status: 400, code: 100 };
    const [current] = await db.select().from(academySocialAccountsTable).where(eq(academySocialAccountsTable.academyId, unifiedAcademyId));
    expect(await checkInstagram(current)).toMatchObject({ ok: false, code: "not_business" });
    [saved] = await db.select().from(academySocialAccountsTable).where(eq(academySocialAccountsTable.academyId, unifiedAcademyId));
    expect(saved.status).toBe("connected");
    instagramLoginMock.limitError = null;
  });

  it("refuses an Instagram account already connected to another academy", async () => {
    const conflictInstagramId = `5${stamp}`;
    const [sourceField] = await db.insert(fieldsTable).values({ name: `Source Social ${stamp}`, cameraId: `source-${stamp}` })
      .returning({ id: fieldsTable.id });
    const [sourceAcademy] = await db.insert(academiesTable).values({ name: `Source Social Academy ${stamp}`, fieldId: sourceField.id })
      .returning({ id: academiesTable.id });
    await db.insert(academySocialAccountsTable).values({
      academyId: sourceAcademy.id,
      igUserId: conflictInstagramId,
      status: "connected",
    });
    const [targetField] = await db.insert(fieldsTable).values({ name: `Target Social ${stamp}`, cameraId: `target-${stamp}` })
      .returning({ id: fieldsTable.id });
    const [otherAcademy] = await db.insert(academiesTable).values({ name: `Target Social Academy ${stamp}`, fieldId: targetField.id })
      .returning({ id: academiesTable.id });
    await db.insert(academyMembersTable).values({ academyId: otherAcademy.id, userId: ownerId, role: "owner" });
    try {
      const { state } = await startLogin(otherAcademy.id);
      const response = await completeLogin(state, [{ id: conflictInstagramId, username: "already.connected" }]);
      expect(response.status).toBe(409);
      expect(response.body.error).toContain("already connected to another academy");
    } finally {
      await db.delete(academiesTable).where(eq(academiesTable.id, otherAcademy.id));
      await db.delete(academiesTable).where(eq(academiesTable.id, sourceAcademy.id));
      await db.delete(fieldsTable).where(eq(fieldsTable.id, targetField.id));
      await db.delete(fieldsTable).where(eq(fieldsTable.id, sourceField.id));
    }
  });

  it("keeps an existing Facebook Page connection intact", async () => {
    const [before] = await db.select().from(academySocialAccountsTable).where(eq(academySocialAccountsTable.academyId, academyId));
    const response = await request(app).post(`/api/academy/console/academies/${academyId}/social/connect/instagram`)
      .set(auth(ownerId)).send({});
    expect(response.status).toBe(409);
    const [after] = await db.select().from(academySocialAccountsTable).where(eq(academySocialAccountsTable.academyId, academyId));
    expect(after).toMatchObject({ pageId: before.pageId, pageTokenEnc: before.pageTokenEnc, igUserId: before.igUserId });
  });
});
