import { spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import { and, desc, eq, getTableColumns, inArray, isNull, sql } from "drizzle-orm";
import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import {
  academyMembersTable,
  academyAdMediaTable,
  academyContactsTable,
  academySocialCommentsTable,
  academySocialMessagesTable,
  academySocialPostsTable,
  academySocialThreadsTable,
  db,
  type AcademySocialThread,
} from "@workspace/db";
import { requireAcademyConsoleUser, requireAcademyMembership, type AcademyConsoleUser } from "../lib/academyAccess";
import { staffAccessFor } from "../lib/academyPermissions";
import { fetchExportObject } from "../lib/backupExport";
import { logger } from "../lib/logger";
import { metaConfig } from "../lib/meta/config";
import { intParam, sendFailure } from "../lib/meta/routeAccess";
import {
  connectWithCode,
  disconnectSocial,
  getSocialAccount,
  listPages,
  markSocialReconnect,
  mediaSignature,
  selectPage,
  socialLoginConfigId,
} from "../lib/social/account";
import {
  createInstagramLoginUrl,
  finishInstagramLogin,
  instagramLoginAcademyHint,
  listPendingInstagramAssets,
  selectInstagramAsset,
} from "../lib/social/instagramLogin";
import { backfillConversations, hideComment, privateReply, replyToComment, replyWindow, sendThreadMessage } from "../lib/social/inbox";
import { libraryMedia, publishPost, syncSocial, type Format, type Target } from "../lib/social/posts";
import { upsertContact } from "../lib/whatsapp/contacts";
import { formatPhoneForDisplay, normalizePhone } from "../lib/whatsapp/phone";

/**
 * Academy console → Social (connect Instagram + Facebook, comments, posts, numbers) and the
 * Instagram/Messenger conversations shown in Chats.
 * Paths under /social/threads belong to the Chats section; everything else to Social.
 */
const router: IRouter = Router();
const base = "/academy/console/academies/:academyId/social";
const instagramLoginUnavailableMessage = "This sign-in option isn't available right now";

type Access = { user: AcademyConsoleUser; academyId: number; manages: boolean };

async function access(req: Request, res: Response, needManage = false): Promise<Access | null> {
  const user = await requireAcademyConsoleUser(req, res);
  if (!user) return null;
  const academyId = intParam(req.params.academyId);
  if (!academyId) {
    res.status(400).json({ error: "Invalid academy id" });
    return null;
  }
  const roles = await requireAcademyMembership(user.id, academyId, res);
  if (!roles) return null;
  // "owner" here includes a manager (or a coach the owner opened Social to): see academyAccessGate.
  const manages = roles.includes("owner");
  if (needManage && !manages) {
    res.status(403).json({ error: "Only the academy owner can do this, unless he opens Social to your role." });
    return null;
  }
  return { user, academyId, manages };
}

async function instagramCallbackAccess(req: Request, res: Response, state: string): Promise<Access | null> {
  const academyId = instagramLoginAcademyHint(state);
  if (!academyId) {
    res.status(400).json({ error: "Instagram sign-in state is invalid. Start again." });
    return null;
  }
  const user = await requireAcademyConsoleUser(req, res);
  if (!user) return null;
  const roles = await requireAcademyMembership(user.id, academyId, res);
  if (!roles) return null;
  const manages = roles.includes("owner");
  if (!manages) {
    res.status(403).json({ error: "Only the academy owner can connect Instagram." });
    return null;
  }
  return { user, academyId, manages };
}

function fail(res: Response, error: unknown, what: string) {
  const cause = (error as { cause?: { code?: string } })?.cause;
  if (cause?.code === "42P01") {
    res.status(500).json({ error: "The social tables are missing from this database. Publish again so they're created." });
    return;
  }
  sendFailure(res, error, what);
}

// ─── Connection ─────────────────────────────────────────────────────────────

router.get("/social/instagram-login/status", (_req, res): void => {
  res.json({ enabled: metaConfig().instagramLoginEnabled });
});

router.get(base, async (req, res): Promise<void> => {
  const a = await access(req, res);
  if (!a) return;
  try {
    const account = await getSocialAccount(a.academyId);
    const emptyPendingLogin = account?.status === "pending"
      && !account.tokenEnc
      && !account.pageTokenEnc
      && !account.pageId
      && !account.igUserId;
    const visibleAccount = account && !emptyPendingLogin ? account : null;
    const storedInsights = visibleAccount?.insights && typeof visibleAccount.insights === "object"
      ? visibleAccount.insights as Record<string, unknown>
      : null;
    const publicInsights = storedInsights
      ? Object.fromEntries(Object.entries(storedInsights).filter(([key]) => key !== "__replayInstagramLogin"))
      : null;
    const config = metaConfig();
    const [counts] = (await db.execute(sql`
      select
        (select count(*)::int from academy_social_threads t where t.academy_id = ${a.academyId} and t.personal_at is null and t.blocked_at is null and not t.muted
          and exists (select 1 from academy_social_messages m where m.thread_id = t.id and m.direction = 'in' and m.created_at > coalesce(t.last_read_at, 'epoch'::timestamptz))) as "unreadThreads",
        (select count(*)::int from academy_social_comments c where c.academy_id = ${a.academyId} and c.read_at is null and c.deleted_at is null and c.replied_at is null and c.private_replied_at is null and not c.hidden) as "openComments"
    `) as unknown as { rows: Array<{ unreadThreads: number; openComments: number }> }).rows;
    res.json({
      connection: visibleAccount ? {
        status: visibleAccount.status,
        pageId: visibleAccount.pageId,
        pageName: visibleAccount.pageName,
        igUserId: visibleAccount.igUserId,
        igUsername: visibleAccount.igUsername,
        igPicture: visibleAccount.igPicture,
        subscribed: visibleAccount.subscribed,
        error: visibleAccount.error,
        connectedAt: visibleAccount.connectedAt,
        insights: publicInsights,
        insightsAt: visibleAccount.insightsAt,
        postsSyncedAt: visibleAccount.postsSyncedAt,
      } : null,
      app: {
        appId: config.appId,
        graphVersion: config.graphVersion,
        loginConfigId: socialLoginConfigId(),
        configured: Boolean(config.appSecret),
        instagramLoginEnabled: config.instagramLoginEnabled,
      },
      canManage: a.manages,
      unreadThreads: counts?.unreadThreads ?? 0,
      openComments: counts?.openComments ?? 0,
    });
  } catch (error) {
    fail(res, error, "Reading the social connection failed");
  }
});

router.post(`${base}/connect/instagram`, async (req, res): Promise<void> => {
  if (!metaConfig().instagramLoginEnabled) {
    res.status(404).json({ error: instagramLoginUnavailableMessage });
    return;
  }
  const a = await access(req, res, true);
  if (!a) return;
  try {
    res.json({ url: await createInstagramLoginUrl(a.academyId, a.user.id) });
  } catch (error) {
    fail(res, error, "Starting Instagram sign-in failed");
  }
});

router.post("/academy/console/social/instagram/callback", async (req, res): Promise<void> => {
  if (!metaConfig().instagramLoginEnabled) {
    res.status(404).json({ error: instagramLoginUnavailableMessage });
    return;
  }
  const state = typeof req.body?.state === "string" ? req.body.state : "";
  if (!state) {
    res.status(400).json({ error: "Instagram sign-in state is missing. Start again." });
    return;
  }
  const a = await instagramCallbackAccess(req, res, state);
  if (!a) return;
  try {
    const result = await finishInstagramLogin({
      academyId: a.academyId,
      userId: a.user.id,
      state,
      code: typeof req.body?.code === "string" ? req.body.code : undefined,
      oauthError: typeof req.body?.error === "string" ? req.body.error : undefined,
      errorDescription: typeof req.body?.errorDescription === "string" ? req.body.errorDescription : undefined,
    });
    if (result.status === "connected") {
      const account = await getSocialAccount(a.academyId);
      if (account) void backfillConversations(account).catch(() => undefined);
    }
    res.json(result);
  } catch (error) {
    fail(res, error, "Connecting Instagram failed");
  }
});

router.get(`${base}/instagram-accounts`, async (req, res): Promise<void> => {
  const a = await access(req, res, true);
  if (!a) return;
  try {
    res.json(await listPendingInstagramAssets(a.academyId));
  } catch (error) {
    fail(res, error, "Listing Instagram accounts failed");
  }
});

router.post(`${base}/instagram-account`, async (req, res): Promise<void> => {
  const a = await access(req, res, true);
  if (!a) return;
  const instagramId = typeof req.body?.instagramId === "string" ? req.body.instagramId : "";
  try {
    const account = await selectInstagramAsset(a.academyId, a.user.id, instagramId);
    res.json({ status: account.status, igUsername: account.igUsername });
  } catch (error) {
    fail(res, error, "Choosing an Instagram account failed");
  }
});

router.post(`${base}/connect`, async (req, res): Promise<void> => {
  const a = await access(req, res, true);
  if (!a) return;
  const code = typeof req.body?.code === "string" ? req.body.code.trim() : "";
  if (!code) {
    res.status(400).json({ error: "Sign in with Facebook first" });
    return;
  }
  try {
    const result = await connectWithCode(a.academyId, code, a.user.id);
    if (result.account.status === "connected") void backfillConversations(result.account).catch(() => undefined);
    res.json({ status: result.account.status, pages: result.pages });
  } catch (error) {
    fail(res, error, "Connecting Instagram and Facebook failed");
  }
});

router.get(`${base}/pages`, async (req, res): Promise<void> => {
  const a = await access(req, res, true);
  if (!a) return;
  try {
    res.json(await listPages(a.academyId));
  } catch (error) {
    fail(res, error, "Listing Pages failed");
  }
});

router.put(`${base}/page`, async (req, res): Promise<void> => {
  const a = await access(req, res, true);
  if (!a) return;
  const pageId = typeof req.body?.pageId === "string" ? req.body.pageId : "";
  if (!/^\d{5,30}$/.test(pageId)) {
    res.status(400).json({ error: "Pick a Page" });
    return;
  }
  try {
    const account = await selectPage(a.academyId, pageId);
    void backfillConversations(account).catch(() => undefined);
    res.json({ status: account.status, pageName: account.pageName, igUsername: account.igUsername });
  } catch (error) {
    fail(res, error, "Choosing a Page failed");
  }
});

router.delete(base, async (req, res): Promise<void> => {
  const a = await access(req, res, true);
  if (!a) return;
  try {
    await disconnectSocial(a.academyId);
    res.status(204).end();
  } catch (error) {
    fail(res, error, "Disconnecting failed");
  }
});

router.post(`${base}/sync`, async (req, res): Promise<void> => {
  const a = await access(req, res, true);
  if (!a) return;
  try {
    res.json(await syncSocial(a.academyId));
  } catch (error) {
    await markSocialReconnect(a.academyId, error).catch(() => false);
    fail(res, error, "Syncing posts failed");
  }
});

// ─── Conversations (Chats section) ──────────────────────────────────────────

async function canManageChats(userId: number, academyId: number): Promise<boolean> {
  const staff = await staffAccessFor(userId, academyId);
  return Boolean(staff?.permissions.includes("chats.manage"));
}

async function threadFor(academyId: number, id: number | null): Promise<AcademySocialThread | null> {
  if (!id) return null;
  const [row] = await db.select().from(academySocialThreadsTable)
    .where(and(eq(academySocialThreadsTable.id, id), eq(academySocialThreadsTable.academyId, academyId)));
  return row ?? null;
}

async function contactsById(ids: number[]) {
  if (ids.length === 0) return new Map<number, typeof academyContactsTable.$inferSelect>();
  const rows = await db.select().from(academyContactsTable).where(inArray(academyContactsTable.id, ids));
  return new Map(rows.map((r) => [r.id, r]));
}

function threadView(t: AcademySocialThread, contact: typeof academyContactsTable.$inferSelect | undefined, extra: Record<string, unknown> = {}) {
  return {
    id: t.id,
    channel: t.channel,
    name: contact?.name ?? t.name,
    username: t.username,
    picture: t.picture,
    stage: contact?.stage ?? t.stage,
    contact: contact ? { id: contact.id, name: contact.name, phone: contact.phone, display: formatPhoneForDisplay(contact.phone), kind: contact.kind, stage: contact.stage } : null,
    archived: Boolean(t.archivedAt),
    muted: t.muted,
    blocked: Boolean(t.blockedAt),
    replyWindow: replyWindow(t),
    lastInAt: t.lastInAt,
    lastAt: t.lastAt,
    assignedUserId: t.assignedUserId,
    ...extra,
  };
}

router.get(`${base}/threads`, async (req, res): Promise<void> => {
  const a = await access(req, res);
  if (!a) return;
  try {
    const threads = await db.select().from(academySocialThreadsTable)
      .where(and(eq(academySocialThreadsTable.academyId, a.academyId), isNull(academySocialThreadsTable.personalAt)))
      .orderBy(desc(academySocialThreadsTable.lastAt)).limit(300);
    if (threads.length === 0) {
      res.json([]);
      return;
    }
    const ids = threads.map((t) => t.id);
    const last = (await db.execute(sql`
      select distinct on (m.thread_id) m.thread_id as "threadId", m.body, m.direction, m.status, m.kind
      from academy_social_messages m where m.thread_id in ${sql.raw(`(${ids.join(",")})`)}
      order by m.thread_id, m.created_at desc, m.id desc
    `) as unknown as { rows: Array<{ threadId: number; body: string; direction: string; status: string; kind: string }> }).rows;
    const unread = (await db.execute(sql`
      select m.thread_id as "threadId", count(*)::int as n from academy_social_messages m
      join academy_social_threads t on t.id = m.thread_id
      where m.thread_id in ${sql.raw(`(${ids.join(",")})`)} and m.direction = 'in' and m.created_at > coalesce(t.last_read_at, 'epoch'::timestamptz)
      group by m.thread_id
    `) as unknown as { rows: Array<{ threadId: number; n: number }> }).rows;
    const lastBy = new Map(last.map((r) => [r.threadId, r]));
    const unreadBy = new Map(unread.map((r) => [r.threadId, r.n]));
    const contacts = await contactsById(threads.map((t) => t.contactId).filter((x): x is number => Boolean(x)));
    res.json(threads.filter((t) => lastBy.has(t.id)).map((t) => {
      const l = lastBy.get(t.id)!;
      return threadView(t, t.contactId ? contacts.get(t.contactId) : undefined, {
        lastBody: l.body, lastDirection: l.direction, lastStatus: l.status === "failed" ? "failed" : l.direction === "out" ? "sent" : "received",
        unread: unreadBy.get(t.id) ?? 0,
      });
    }));
  } catch (error) {
    fail(res, error, "Listing social chats failed");
  }
});

router.get(`${base}/threads/:threadId`, async (req, res): Promise<void> => {
  const a = await access(req, res);
  if (!a) return;
  try {
    const thread = await threadFor(a.academyId, intParam(req.params.threadId));
    if (!thread) {
      res.status(404).json({ error: "Chat not found" });
      return;
    }
    const messages = thread.personalAt ? [] : await db.select().from(academySocialMessagesTable)
      .where(eq(academySocialMessagesTable.threadId, thread.id))
      .orderBy(desc(academySocialMessagesTable.createdAt), desc(academySocialMessagesTable.id)).limit(300);
    if (req.query.markRead !== "0") {
      await db.update(academySocialThreadsTable).set({ lastReadAt: new Date() }).where(eq(academySocialThreadsTable.id, thread.id));
    }
    const contacts = await contactsById(thread.contactId ? [thread.contactId] : []);
    res.json(threadView(thread, thread.contactId ? contacts.get(thread.contactId) : undefined, {
      canManage: await canManageChats(a.user.id, a.academyId),
      messages: messages.reverse().map((m) => ({
        id: m.id, direction: m.direction, kind: m.kind, body: m.body, attachments: m.attachments,
        status: m.status, error: m.error, createdAt: m.createdAt,
      })),
    }));
  } catch (error) {
    fail(res, error, "Reading a social chat failed");
  }
});

router.post(`${base}/threads/:threadId/messages`, async (req, res): Promise<void> => {
  const a = await access(req, res);
  if (!a) return;
  const text = typeof req.body?.body === "string" ? req.body.body.trim() : "";
  if (!text || text.length > 1000) {
    res.status(400).json({ error: text ? "Instagram and Messenger messages can be at most 1,000 characters" : "Write a message first" });
    return;
  }
  try {
    const thread = await threadFor(a.academyId, intParam(req.params.threadId));
    if (!thread) {
      res.status(404).json({ error: "Chat not found" });
      return;
    }
    if (thread.blockedAt) {
      res.status(409).json({ error: "This person is blocked. Unblock them to reply." });
      return;
    }
    const account = await getSocialAccount(a.academyId);
    if (!account || account.status !== "connected") {
      res.status(409).json({ error: "Connect Instagram and Facebook first (Academy console → Social)." });
      return;
    }
    const result = await sendThreadMessage(account, thread, text, a.user.id);
    res.status(result.status === "sent" ? 201 : 502).json(result.status === "sent" ? result : { ...result, error: `Meta: ${result.error}` });
  } catch (error) {
    fail(res, error, "Sending a social message failed");
  }
});

const ThreadState = z.object({ archived: z.boolean().optional(), muted: z.boolean().optional(), blocked: z.boolean().optional(), personal: z.boolean().optional() });

router.post(`${base}/threads/:threadId/state`, async (req, res): Promise<void> => {
  const a = await access(req, res);
  if (!a) return;
  const body = ThreadState.safeParse(req.body ?? {});
  if (!body.success || Object.keys(body.data).length === 0) {
    res.status(400).json({ error: "Nothing to change" });
    return;
  }
  if (!(await canManageChats(a.user.id, a.academyId))) {
    res.status(403).json({ error: "Only the academy owner can archive, mute, block or hide chats, unless he gives your role that permission.", code: "chats_manage" });
    return;
  }
  const thread = await threadFor(a.academyId, intParam(req.params.threadId));
  if (!thread) {
    res.status(404).json({ error: "Chat not found" });
    return;
  }
  const now = new Date();
  const patch: Partial<AcademySocialThread> = { updatedAt: now };
  if (body.data.archived !== undefined) patch.archivedAt = body.data.archived ? now : null;
  if (body.data.muted !== undefined) patch.muted = body.data.muted;
  if (body.data.blocked !== undefined) patch.blockedAt = body.data.blocked ? now : null;
  if (body.data.personal !== undefined) patch.personalAt = body.data.personal ? now : null;
  const [row] = await db.update(academySocialThreadsTable).set(patch).where(eq(academySocialThreadsTable.id, thread.id)).returning();
  if (body.data.personal) await db.delete(academySocialMessagesTable).where(eq(academySocialMessagesTable.threadId, thread.id));
  res.json({ id: row.id, archived: Boolean(row.archivedAt), muted: row.muted, blocked: Boolean(row.blockedAt), personal: Boolean(row.personalAt) });
});

/** Hand an Instagram / Messenger chat to someone on the team (or nobody). */
router.post(`${base}/threads/:threadId/assign`, async (req, res): Promise<void> => {
  const a = await access(req, res);
  if (!a) return;
  const thread = await threadFor(a.academyId, intParam(req.params.threadId));
  if (!thread) {
    res.status(404).json({ error: "Chat not found" });
    return;
  }
  const raw = req.body?.userId;
  const userId = raw === null ? null : Number(raw);
  if (userId !== null && !(Number.isSafeInteger(userId) && userId > 0)) {
    res.status(400).json({ error: "Pick someone on the team" });
    return;
  }
  if (userId !== null) {
    const [member] = await db.select({ id: academyMembersTable.userId }).from(academyMembersTable)
      .where(and(eq(academyMembersTable.academyId, a.academyId), eq(academyMembersTable.userId, userId))).limit(1);
    if (!member) {
      res.status(404).json({ error: "That person isn't on this academy's team" });
      return;
    }
  }
  await db.update(academySocialThreadsTable).set({ assignedUserId: userId, updatedAt: new Date() }).where(eq(academySocialThreadsTable.id, thread.id));
  res.json({ id: thread.id, assignedUserId: userId });
});

router.get(`${base}/threads-hidden`, async (req, res): Promise<void> => {
  const a = await access(req, res);
  if (!a) return;
  if (!(await canManageChats(a.user.id, a.academyId))) {
    res.status(403).json({ error: "Only the academy owner can see hidden chats", code: "chats_manage" });
    return;
  }
  const rows = await db.select().from(academySocialThreadsTable).where(and(
    eq(academySocialThreadsTable.academyId, a.academyId),
    sql`(${academySocialThreadsTable.personalAt} is not null or ${academySocialThreadsTable.blockedAt} is not null)`,
  ));
  res.json(rows.map((t) => ({ id: t.id, channel: t.channel, name: t.name, username: t.username, personal: Boolean(t.personalAt), blocked: Boolean(t.blockedAt) })));
});

const LeadBody = z.object({
  stage: z.enum(["new", "contacted", "trial", "joined", "lost"]).nullable().optional(),
  phone: z.string().trim().max(30).optional(),
  name: z.string().trim().max(120).optional(),
});

/** Track the person as a lead, and file them into People once their phone number is known. */
router.put(`${base}/threads/:threadId/lead`, async (req, res): Promise<void> => {
  const a = await access(req, res);
  if (!a) return;
  const body = LeadBody.safeParse(req.body ?? {});
  if (!body.success) {
    res.status(400).json({ error: body.error.issues[0]?.message ?? "Invalid" });
    return;
  }
  try {
    const thread = await threadFor(a.academyId, intParam(req.params.threadId));
    if (!thread) {
      res.status(404).json({ error: "Chat not found" });
      return;
    }
    let contactId = thread.contactId;
    if (body.data.phone) {
      const phone = normalizePhone(body.data.phone);
      if (!phone) {
        res.status(400).json({ error: "That phone number doesn't look right" });
        return;
      }
      const contact = await upsertContact(a.academyId, phone, {
        name: body.data.name || thread.name || (thread.username ? `@${thread.username}` : null),
        kind: "lead",
        stage: (body.data.stage ?? thread.stage ?? "new") as "new",
        source: thread.channel,
      });
      contactId = contact.id;
    }
    const patch: Partial<AcademySocialThread> = { contactId, updatedAt: new Date() };
    if (body.data.stage !== undefined) patch.stage = body.data.stage;
    if (body.data.name) patch.name = body.data.name;
    await db.update(academySocialThreadsTable).set(patch).where(eq(academySocialThreadsTable.id, thread.id));
    if (contactId && body.data.stage) {
      await db.update(academyContactsTable).set({ stage: body.data.stage, updatedAt: new Date() })
        .where(and(eq(academyContactsTable.id, contactId), eq(academyContactsTable.academyId, a.academyId)));
    }
    const fresh = (await threadFor(a.academyId, thread.id))!;
    const contacts = await contactsById(fresh.contactId ? [fresh.contactId] : []);
    res.json(threadView(fresh, fresh.contactId ? contacts.get(fresh.contactId) : undefined));
  } catch (error) {
    fail(res, error, "Saving a social lead failed");
  }
});

// ─── Comments ───────────────────────────────────────────────────────────────

router.get(`${base}/comments`, async (req, res): Promise<void> => {
  const a = await access(req, res);
  if (!a) return;
  try {
    const open = req.query.filter !== "all";
    const rows = await db.select().from(academySocialCommentsTable).where(and(
      eq(academySocialCommentsTable.academyId, a.academyId),
      isNull(academySocialCommentsTable.deletedAt),
      ...(open ? [isNull(academySocialCommentsTable.repliedAt), isNull(academySocialCommentsTable.privateRepliedAt), eq(academySocialCommentsTable.hidden, false)] : []),
    )).orderBy(desc(academySocialCommentsTable.createdAt)).limit(200);
    const week = 7 * 24 * 60 * 60 * 1000;
    res.json(rows.map((c) => ({
      id: c.id, channel: c.channel, body: c.body, fromName: c.fromName, postPermalink: c.postPermalink, postCaption: c.postCaption,
      hidden: c.hidden, replyBody: c.replyBody, repliedAt: c.repliedAt, privateRepliedAt: c.privateRepliedAt, threadId: c.threadId,
      read: Boolean(c.readAt), createdAt: c.createdAt,
      canPrivateReply: !c.privateRepliedAt && Date.now() - c.createdAt.getTime() < week,
    })));
  } catch (error) {
    fail(res, error, "Listing comments failed");
  }
});

async function commentFor(academyId: number, id: number | null) {
  if (!id) return null;
  const [row] = await db.select().from(academySocialCommentsTable)
    .where(and(eq(academySocialCommentsTable.id, id), eq(academySocialCommentsTable.academyId, academyId)));
  return row ?? null;
}

const TextBody = z.object({ text: z.string().trim().min(1).max(1000) });

router.post(`${base}/comments/:commentId/reply`, async (req, res): Promise<void> => {
  const a = await access(req, res, true);
  if (!a) return;
  const body = TextBody.safeParse(req.body ?? {});
  if (!body.success) {
    res.status(400).json({ error: "Write a reply first" });
    return;
  }
  try {
    const comment = await commentFor(a.academyId, intParam(req.params.commentId));
    const account = await getSocialAccount(a.academyId);
    if (!comment || !account) {
      res.status(404).json({ error: "Comment not found" });
      return;
    }
    await replyToComment(account, comment.channel as "instagram" | "facebook", comment.commentId, body.data.text);
    await db.update(academySocialCommentsTable).set({ replyBody: body.data.text, repliedAt: new Date(), repliedBy: a.user.id, readAt: new Date() })
      .where(eq(academySocialCommentsTable.id, comment.id));
    res.json({ ok: true });
  } catch (error) {
    fail(res, error, "Replying to a comment failed");
  }
});

router.post(`${base}/comments/:commentId/private-reply`, async (req, res): Promise<void> => {
  const a = await access(req, res, true);
  if (!a) return;
  const body = TextBody.safeParse(req.body ?? {});
  if (!body.success) {
    res.status(400).json({ error: "Write a message first" });
    return;
  }
  try {
    const comment = await commentFor(a.academyId, intParam(req.params.commentId));
    const account = await getSocialAccount(a.academyId);
    if (!comment || !account) {
      res.status(404).json({ error: "Comment not found" });
      return;
    }
    if (comment.privateRepliedAt) {
      res.status(409).json({ error: "Meta allows one private message per comment, and it was already sent." });
      return;
    }
    if (Date.now() - comment.createdAt.getTime() > 7 * 24 * 60 * 60 * 1000) {
      res.status(409).json({ error: "Meta allows a private message only within 7 days of the comment." });
      return;
    }
    const threadId = await privateReply(account, comment.channel as "instagram" | "facebook", comment.commentId, comment.fromId, body.data.text, a.user.id);
    await db.update(academySocialCommentsTable).set({ privateRepliedAt: new Date(), threadId, readAt: new Date() })
      .where(eq(academySocialCommentsTable.id, comment.id));
    res.json({ ok: true, threadId });
  } catch (error) {
    fail(res, error, "Sending a private reply failed");
  }
});

router.post(`${base}/comments/:commentId/hide`, async (req, res): Promise<void> => {
  const a = await access(req, res, true);
  if (!a) return;
  const hidden = req.body?.hidden !== false;
  try {
    const comment = await commentFor(a.academyId, intParam(req.params.commentId));
    const account = await getSocialAccount(a.academyId);
    if (!comment || !account) {
      res.status(404).json({ error: "Comment not found" });
      return;
    }
    await hideComment(account, comment.channel as "instagram" | "facebook", comment.commentId, hidden);
    await db.update(academySocialCommentsTable).set({ hidden, readAt: new Date() }).where(eq(academySocialCommentsTable.id, comment.id));
    res.json({ ok: true, hidden });
  } catch (error) {
    fail(res, error, "Hiding a comment failed");
  }
});

router.post(`${base}/comments/:commentId/read`, async (req, res): Promise<void> => {
  const a = await access(req, res);
  if (!a) return;
  const comment = await commentFor(a.academyId, intParam(req.params.commentId));
  if (!comment) {
    res.status(404).json({ error: "Comment not found" });
    return;
  }
  await db.update(academySocialCommentsTable).set({ readAt: new Date() }).where(eq(academySocialCommentsTable.id, comment.id));
  res.json({ ok: true });
});

// ─── Posts ──────────────────────────────────────────────────────────────────

const thumbPath = (academyId: number, mediaId: number) => `/api/academy/console/academies/${academyId}/social/media/${mediaId}/thumb`;

router.get(`${base}/posts`, async (req, res): Promise<void> => {
  const a = await access(req, res);
  if (!a) return;
  try {
    const rows = await db.select().from(academySocialPostsTable).where(eq(academySocialPostsTable.academyId, a.academyId))
      .orderBy(sql`coalesce(${academySocialPostsTable.publishedAt}, ${academySocialPostsTable.scheduledFor}, ${academySocialPostsTable.createdAt}) desc`).limit(100);
    res.json(rows.map((p) => {
      const media = (p.media as Array<{ mediaId: number; type: string }>) ?? [];
      return {
        id: p.id, source: p.source, targets: p.targets, format: p.format, caption: p.caption, status: p.status,
        scheduledFor: p.scheduledFor, publishedAt: p.publishedAt, igPermalink: p.igPermalink, fbPermalink: p.fbPermalink,
        thumbnail: p.thumbnail ?? (media[0] ? thumbPath(a.academyId, media[0].mediaId) : null),
        error: p.error, insights: p.insights ?? {}, insightsAt: p.insightsAt, mediaCount: media.length,
      };
    }));
  } catch (error) {
    fail(res, error, "Listing posts failed");
  }
});

const PostBody = z.object({
  targets: z.array(z.enum(["instagram", "facebook"])).min(1),
  format: z.enum(["image", "carousel", "video", "reel", "story"]),
  caption: z.string().max(2200).default(""),
  mediaIds: z.array(z.number().int().positive()).min(1).max(10),
  scheduledFor: z.string().datetime({ offset: true }).nullable().optional(),
});

router.post(`${base}/posts`, async (req, res): Promise<void> => {
  const a = await access(req, res, true);
  if (!a) return;
  const body = PostBody.safeParse(req.body ?? {});
  if (!body.success) {
    res.status(400).json({ error: body.error.issues[0]?.message ?? "Invalid post" });
    return;
  }
  const { targets, format, caption, mediaIds, scheduledFor } = body.data;
  if (format === "carousel" && mediaIds.length < 2) {
    res.status(400).json({ error: "A carousel needs 2 to 10 photos or videos" });
    return;
  }
  if (format !== "carousel" && mediaIds.length !== 1) {
    res.status(400).json({ error: "Pick one photo or video (or choose Carousel)" });
    return;
  }
  try {
    const account = await getSocialAccount(a.academyId);
    if (!account || account.status !== "connected") {
      res.status(409).json({ error: "Connect Instagram and Facebook first" });
      return;
    }
    if (targets.includes("instagram") && !account.igUserId) {
      res.status(409).json({ error: account.pageId
        ? "No Instagram account is linked to your Facebook Page. Link it in Instagram settings, then connect again."
        : "Connect an Instagram account first." });
      return;
    }
    if (targets.includes("facebook") && !account.pageId) {
      res.status(409).json({ error: "Connect a Facebook Page before posting to Facebook." });
      return;
    }
    const media = await libraryMedia(a.academyId, mediaIds);
    if ((format === "reel" || format === "video") && media[0].type !== "video") {
      res.status(400).json({ error: "Reels and videos need a video" });
      return;
    }
    const when = scheduledFor ? new Date(scheduledFor) : null;
    if (when && when.getTime() < Date.now() - 60_000) {
      res.status(400).json({ error: "Pick a time in the future" });
      return;
    }
    const [post] = await db.insert(academySocialPostsTable).values({
      academyId: a.academyId, source: "replay", targets: targets as Target[], format: format as Format, caption, media,
      status: when ? "scheduled" : "draft", scheduledFor: when, createdBy: a.user.id,
    }).returning();
    const result = when ? post : await publishPost(post.id);
    res.status(201).json({ id: result.id, status: result.status, error: result.error, igPermalink: result.igPermalink, fbPermalink: result.fbPermalink });
  } catch (error) {
    fail(res, error, "Publishing a post failed");
  }
});

router.post(`${base}/posts/:postId/publish`, async (req, res): Promise<void> => {
  const a = await access(req, res, true);
  if (!a) return;
  const id = intParam(req.params.postId);
  const [post] = id ? await db.select().from(academySocialPostsTable).where(and(eq(academySocialPostsTable.id, id), eq(academySocialPostsTable.academyId, a.academyId))) : [];
  if (!post || post.source !== "replay") {
    res.status(404).json({ error: "Post not found" });
    return;
  }
  try {
    const result = await publishPost(post.id);
    res.json({ id: result.id, status: result.status, error: result.error });
  } catch (error) {
    fail(res, error, "Publishing a post failed");
  }
});

router.delete(`${base}/posts/:postId`, async (req, res): Promise<void> => {
  const a = await access(req, res, true);
  if (!a) return;
  const id = intParam(req.params.postId);
  const deleted = id ? await db.delete(academySocialPostsTable).where(and(
    eq(academySocialPostsTable.id, id),
    eq(academySocialPostsTable.academyId, a.academyId),
    inArray(academySocialPostsTable.status, ["draft", "scheduled", "failed"]),
  )).returning({ id: academySocialPostsTable.id }) : [];
  if (deleted.length === 0) {
    res.status(409).json({ error: "Only drafts, scheduled and failed posts can be removed here. Delete published posts in Instagram or Facebook." });
    return;
  }
  res.status(204).end();
});

// ─── Media library (shared with Ads) ────────────────────────────────────────

router.get(`${base}/media`, async (req, res): Promise<void> => {
  const a = await access(req, res, true);
  if (!a) return;
  try {
    const { imageData: _bytes, ...columns } = getTableColumns(academyAdMediaTable);
    const rows = await db.select({ ...columns, hasImage: sql<boolean>`${academyAdMediaTable.imageData} is not null` })
      .from(academyAdMediaTable).where(eq(academyAdMediaTable.academyId, a.academyId))
      .orderBy(desc(academyAdMediaTable.createdAt)).limit(200);
    res.json(rows.map((m) => ({
      id: m.id, kind: m.kind, name: m.name, status: m.status, width: m.width, height: m.height, durationSec: m.durationSec,
      thumbUrl: m.hasImage ? thumbPath(a.academyId, m.id) : null,
    })));
  } catch (error) {
    fail(res, error, "Listing media failed");
  }
});

router.post(`${base}/media`, async (req, res): Promise<void> => {
  const a = await access(req, res, true);
  if (!a) return;
  const body = z.object({
    dataUrl: z.string().max(6_000_000).regex(/^data:image\/(png|jpe?g|webp);base64,/),
    name: z.string().trim().max(120).default(""),
  }).safeParse(req.body ?? {});
  if (!body.success) {
    res.status(400).json({ error: "Send a JPEG, PNG or WebP photo" });
    return;
  }
  try {
    const [row] = await db.insert(academyAdMediaTable).values({
      academyId: a.academyId, kind: "image", name: body.data.name || "Photo", source: "social",
      imageData: body.data.dataUrl, bytes: Math.round((body.data.dataUrl.length * 3) / 4), status: "ready", createdBy: a.user.id,
    }).returning({ id: academyAdMediaTable.id });
    res.status(201).json({ id: row.id, kind: "image", thumbUrl: thumbPath(a.academyId, row.id) });
  } catch (error) {
    fail(res, error, "Saving a photo failed");
  }
});

router.get(`${base}/media/:mediaId/thumb`, async (req, res): Promise<void> => {
  const a = await access(req, res);
  if (!a) return;
  const id = intParam(req.params.mediaId);
  const [m] = id ? await db.select({ imageData: academyAdMediaTable.imageData }).from(academyAdMediaTable)
    .where(and(eq(academyAdMediaTable.id, id), eq(academyAdMediaTable.academyId, a.academyId))) : [];
  const match = m?.imageData?.match(/^data:(image\/[a-z+]+);base64,(.+)$/);
  if (!match) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.setHeader("Content-Type", match[1]);
  res.setHeader("Cache-Control", "private, max-age=3600");
  res.send(Buffer.from(match[2], "base64"));
});

// ─── Public, signed media links (Meta downloads these when publishing) ──────

function toJpeg(input: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-f", "mjpeg", "-q:v", "3", "pipe:1"]);
    const out: Buffer[] = [];
    ff.stdout.on("data", (d: Buffer) => out.push(d));
    ff.on("error", reject);
    ff.on("close", (code) => (code === 0 && out.length ? resolve(Buffer.concat(out)) : reject(new Error(`ffmpeg exited ${code}`))));
    ff.stdin.on("error", () => undefined);
    ff.stdin.end(input);
  });
}

router.get("/social/media/:mediaId/:file", async (req, res): Promise<void> => {
  const id = intParam(req.params.mediaId);
  const [sig, ext] = String(req.params.file ?? "").split(".");
  const expected = id ? mediaSignature(id) : "";
  if (!id || !sig || sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    res.status(404).end();
    return;
  }
  const [m] = await db.select().from(academyAdMediaTable).where(eq(academyAdMediaTable.id, id));
  if (!m) {
    res.status(404).end();
    return;
  }
  try {
    if (ext === "mp4" && m.kind === "video" && m.storageUrl) {
      const range = typeof req.headers.range === "string" ? req.headers.range : undefined;
      const upstream = await fetchExportObject(m.storageUrl, { range });
      if (!upstream.ok || !upstream.body) {
        res.status(upstream.status === 404 ? 404 : 502).end();
        return;
      }
      res.status(upstream.status);
      for (const header of ["content-length", "content-range", "accept-ranges"]) {
        const value = upstream.headers.get(header);
        if (value) res.setHeader(header, value);
      }
      res.setHeader("Content-Type", "video/mp4");
      const stream = Readable.fromWeb(upstream.body as never);
      req.on("close", () => stream.destroy());
      stream.on("error", () => res.destroy());
      stream.pipe(res);
      return;
    }
    const match = m.imageData?.match(/^data:(image\/[a-z+]+);base64,(.+)$/);
    if (!match) {
      res.status(404).end();
      return;
    }
    let bytes: Buffer = Buffer.from(match[2], "base64");
    if (!/jpe?g/.test(match[1])) bytes = await toJpeg(bytes);
    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.send(bytes);
  } catch (error) {
    logger.warn({ mediaId: id, error: (error as Error).message }, "Serving social media failed");
    if (!res.headersSent) res.status(500).end();
  }
});

export default router;

