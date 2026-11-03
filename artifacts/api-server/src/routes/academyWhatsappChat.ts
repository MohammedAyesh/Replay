import { and, desc, eq, ilike, inArray, isNull, sql } from "drizzle-orm";
import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import {
  academyContactsTable,
  academyWhatsappGroupsTable,
  academyWhatsappMessagesTable,
  academyWhatsappPostsTable,
  academyWhatsappSavedRepliesTable,
  db,
} from "@workspace/db";
import { logger } from "../lib/logger";
import { parseChatOptions } from "../lib/whatsapp/chatOptions";
import { mediaUrl } from "../lib/whatsapp/media";
import { formatPhoneForDisplay, groupIdFromKey, isGroupKey, normalizePhone } from "../lib/whatsapp/phone";
import { dispatchMessageNow, getWhatsappSettings, saveWhatsappSettings, senderSessionFor } from "../lib/whatsapp/queue";
import {
  WahaError,
  createChannel,
  deleteMessage,
  deleteStatus,
  editMessage,
  getGroupInviteLink,
  getGroupMembers,
  postStatus,
  removeGroupMembers,
  sendImage,
  sendText,
  sendVideo,
  serializedMessageId,
  setGroupAdminsOnly,
  setGroupAdmins,
  setGroupDescription,
  setGroupPicture,
  setGroupSubject,
  setReaction,
  setTyping,
  wahaConfigured,
  type WahaFile,
} from "../lib/whatsapp/waha";
import {
  academyAccess,
  canManageChats,
  chatKeyParam,
  groupRow,
  intParam,
  messagesView,
  rawParam,
  wahaFailure,
  type Access,
} from "./academyWhatsapp";

const router: IRouter = Router();
const base = "/academy/console/academies/:academyId/whatsapp";

const MediaRef = z.object({
  path: z.string().regex(/^wa-media\/\d+\/[0-9a-f]{32}\.[a-z0-9]{1,5}$/),
  mimetype: z.string().min(3).max(150),
  filename: z.string().max(200).nullable().optional(),
  size: z.number().int().nonnegative().nullable().optional(),
});

function ownMedia(access: Access, media: z.infer<typeof MediaRef>): WahaFile | null {
  if (!media.path.startsWith(`wa-media/${access.academyId}/`)) return null;
  const url = mediaUrl({ path: media.path });
  return url ? { url, mimetype: media.mimetype, ...(media.filename ? { filename: media.filename } : {}) } : null;
}

/** The chat's WAHA id and the session that can act on it, or an error already sent. */
async function chatTarget(access: Access, key: string, res: Response): Promise<{ session: string; chatId: string; groupId: string | null } | null> {
  const settings = await getWhatsappSettings(access.academyId);
  const session = senderSessionFor(settings);
  if (!session || !wahaConfigured()) {
    res.status(409).json({ error: "Turn WhatsApp on first: link your number or choose Replay's number." });
    return null;
  }
  const groupId = groupIdFromKey(key);
  if (groupId) {
    const group = await groupRow(access.academyId, key);
    if (!group) {
      res.status(404).json({ error: "Group not found" });
      return null;
    }
    if (group.session !== session) {
      res.status(409).json({ error: "This group is on the academy's other WhatsApp number." });
      return null;
    }
  }
  return { session, chatId: groupId ? `${groupId}@g.us` : `${key}@c.us`, groupId };
}

async function messageRow(access: Access, key: string, idParam: string | string[] | undefined) {
  const id = intParam(idParam);
  if (!id) return null;
  const [row] = await db.select().from(academyWhatsappMessagesTable).where(and(
    eq(academyWhatsappMessagesTable.id, id),
    eq(academyWhatsappMessagesTable.academyId, access.academyId),
    eq(academyWhatsappMessagesTable.phone, key),
  ));
  return row ?? null;
}

function serializedFor(row: typeof academyWhatsappMessagesTable.$inferSelect, chatId: string): string | null {
  if (!row.waMessageId) return null;
  const participant = chatId.endsWith("@g.us") && row.direction === "in" && row.authorPhone ? `${row.authorPhone}@c.us` : null;
  return serializedMessageId(row.direction === "out", chatId, row.waMessageId, participant);
}

// ─── Reactions, delete, edit, forward, typing ────────────────────────────────

router.post(`${base}/chats/:phone/messages/:messageId/reaction`, async (req, res): Promise<void> => {
  const access = await academyAccess(req, res);
  if (!access) return;
  const key = chatKeyParam(req, res);
  if (!key) return;
  const emoji = typeof req.body?.emoji === "string" ? req.body.emoji.trim() : "";
  if ([...emoji].length > 4) {
    res.status(400).json({ error: "Pick one emoji" });
    return;
  }
  const row = await messageRow(access, key, req.params.messageId);
  if (!row || row.deletedAt) {
    res.status(404).json({ error: "Message not found" });
    return;
  }
  const serialized = row.waMessageId ? serializedFor(row, `${groupIdFromKey(key) ?? key}${groupIdFromKey(key) ? "@g.us" : "@c.us"}`) : null;
  if (!serialized) {
    res.status(400).json({ error: "This message can't be reacted to yet" });
    return;
  }
  const target = await chatTarget(access, key, res);
  if (!target) return;
  try {
    await setReaction(target.session, serialized, emoji);
    const next = { ...((row.reactions ?? {}) as Record<string, { emoji: string; name: string | null }>) };
    if (emoji) next.me = { emoji, name: null };
    else delete next.me;
    await db.update(academyWhatsappMessagesTable).set({ reactions: Object.keys(next).length ? next : null }).where(eq(academyWhatsappMessagesTable.id, row.id));
    res.json({ ok: true });
  } catch (error) {
    wahaFailure(res, error, "Reacting failed");
  }
});

router.delete(`${base}/chats/:phone/messages/:messageId`, async (req, res): Promise<void> => {
  const access = await academyAccess(req, res);
  if (!access) return;
  const key = chatKeyParam(req, res);
  if (!key) return;
  const row = await messageRow(access, key, req.params.messageId);
  if (!row || row.direction !== "out" || row.deletedAt) {
    res.status(404).json({ error: "Message not found" });
    return;
  }
  if (!access.isOwner && row.createdBy !== access.user.id && !(await canManageChats(access))) {
    res.status(403).json({ error: "You can delete messages you sent" });
    return;
  }
  // Not sent yet (a scheduled or waiting message): cancel it.
  if (row.status === "queued") {
    await db.delete(academyWhatsappMessagesTable).where(and(eq(academyWhatsappMessagesTable.id, row.id), eq(academyWhatsappMessagesTable.status, "queued")));
    res.json({ ok: true, cancelled: true });
    return;
  }
  const target = await chatTarget(access, key, res);
  if (!target) return;
  const serialized = serializedFor(row, target.chatId);
  if (!serialized) {
    res.status(400).json({ error: "This message can't be deleted" });
    return;
  }
  try {
    await deleteMessage(target.session, target.chatId, serialized);
  } catch (error) {
    if (!(error instanceof WahaError) || error.status !== 404) {
      wahaFailure(res, error, "Deleting failed");
      return;
    }
  }
  await db.update(academyWhatsappMessagesTable).set({ deletedAt: new Date(), body: "", content: null, reactions: null }).where(eq(academyWhatsappMessagesTable.id, row.id));
  res.json({ ok: true });
});

router.put(`${base}/chats/:phone/messages/:messageId`, async (req, res): Promise<void> => {
  const access = await academyAccess(req, res);
  if (!access) return;
  const key = chatKeyParam(req, res);
  if (!key) return;
  const text = z.string().trim().min(1).max(4000).safeParse(req.body?.text);
  if (!text.success) {
    res.status(400).json({ error: "Write the new text" });
    return;
  }
  const row = await messageRow(access, key, req.params.messageId);
  const editable = row && row.direction === "out" && row.kind === "chat" && !row.content && !row.deletedAt && row.sentAt
    && ["sent", "delivered", "read"].includes(row.status) && Date.now() - row.sentAt.getTime() < 14 * 60_000;
  if (!row || !editable) {
    res.status(409).json({ error: "WhatsApp only lets you edit a text message for 15 minutes after sending it" });
    return;
  }
  if (!access.isOwner && row.createdBy !== access.user.id) {
    res.status(403).json({ error: "You can edit messages you sent" });
    return;
  }
  const target = await chatTarget(access, key, res);
  if (!target) return;
  const serialized = serializedFor(row, target.chatId);
  if (!serialized) {
    res.status(400).json({ error: "This message can't be edited" });
    return;
  }
  try {
    await editMessage(target.session, target.chatId, serialized, text.data, (row.mentions as string[] | null)?.map((p) => `${p}@c.us`));
    await db.update(academyWhatsappMessagesTable).set({ body: text.data, editedAt: new Date() }).where(eq(academyWhatsappMessagesTable.id, row.id));
    res.json({ ok: true });
  } catch (error) {
    wahaFailure(res, error, "Editing failed");
  }
});

/** Send a copy of a message to other chats (people by number, or groups). */
router.post(`${base}/chats/:phone/messages/:messageId/forward`, async (req, res): Promise<void> => {
  const access = await academyAccess(req, res);
  if (!access) return;
  const key = chatKeyParam(req, res);
  if (!key) return;
  const targets = z.array(z.string().max(60)).min(1).max(10).safeParse(req.body?.targets);
  if (!targets.success) {
    res.status(400).json({ error: "Pick up to 10 chats" });
    return;
  }
  const row = await messageRow(access, key, req.params.messageId);
  if (!row || row.deletedAt || row.kind === "call") {
    res.status(404).json({ error: "Message not found" });
    return;
  }
  const settings = await getWhatsappSettings(access.academyId);
  const session = senderSessionFor(settings);
  if (!session) {
    res.status(409).json({ error: "Turn WhatsApp on first: link your number or choose Replay's number." });
    return;
  }
  const blocked = new Set((await db.select({ phone: academyContactsTable.phone }).from(academyContactsTable)
    .where(and(eq(academyContactsTable.academyId, access.academyId), sql`${academyContactsTable.blockedAt} is not null`))).map((c) => c.phone));
  let sent = 0;
  const skipped: string[] = [];
  for (const raw of new Set(targets.data)) {
    const dest = isGroupKey(raw) ? raw : normalizePhone(raw);
    if (!dest || dest === key || (!isGroupKey(dest) && blocked.has(dest))) {
      skipped.push(raw);
      continue;
    }
    if (isGroupKey(dest)) {
      const group = await groupRow(access.academyId, dest);
      if (!group || group.session !== session) {
        skipped.push(raw);
        continue;
      }
    }
    const [copy] = await db.insert(academyWhatsappMessagesTable).values({
      academyId: access.academyId, kind: "chat", phone: dest, body: row.body, content: row.content, createdBy: access.user.id,
    }).returning({ id: academyWhatsappMessagesTable.id });
    if ((await dispatchMessageNow(copy.id)) !== "failed") sent += 1;
    else skipped.push(raw);
  }
  res.json({ sent, skipped });
});

/** "typing…" shown to the other person while a coach writes. */
router.post(`${base}/chats/:phone/typing`, async (req, res): Promise<void> => {
  const access = await academyAccess(req, res);
  if (!access) return;
  const key = chatKeyParam(req, res);
  if (!key) return;
  const settings = await getWhatsappSettings(access.academyId);
  const session = senderSessionFor(settings);
  if (session && wahaConfigured()) {
    const chatId = isGroupKey(key) ? `${groupIdFromKey(key)}@g.us` : `${key}@c.us`;
    await setTyping(session, chatId, req.body?.typing !== false).catch(() => undefined);
  }
  res.json({ ok: true });
});

// ─── Search and the media tab ────────────────────────────────────────────────

router.get(`${base}/chats/:phone/search`, async (req, res): Promise<void> => {
  const access = await academyAccess(req, res);
  if (!access) return;
  const key = chatKeyParam(req, res);
  if (!key) return;
  const q = String(req.query.q ?? "").trim().slice(0, 100);
  if (q.length < 2) {
    res.json([]);
    return;
  }
  const rows = await db.select().from(academyWhatsappMessagesTable).where(and(
    eq(academyWhatsappMessagesTable.academyId, access.academyId),
    eq(academyWhatsappMessagesTable.phone, key),
    isNull(academyWhatsappMessagesTable.deletedAt),
    ilike(academyWhatsappMessagesTable.body, `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`),
  )).orderBy(desc(academyWhatsappMessagesTable.createdAt)).limit(50);
  res.json(rows.map((m) => ({ id: m.id, direction: m.direction, body: m.body, createdAt: m.createdAt, author: m.authorName })));
});

router.get(`${base}/chats/:phone/media`, async (req, res): Promise<void> => {
  const access = await academyAccess(req, res);
  if (!access) return;
  const key = chatKeyParam(req, res);
  if (!key) return;
  const rows = await db.select().from(academyWhatsappMessagesTable).where(and(
    eq(academyWhatsappMessagesTable.academyId, access.academyId),
    eq(academyWhatsappMessagesTable.phone, key),
    isNull(academyWhatsappMessagesTable.deletedAt),
    sql`${academyWhatsappMessagesTable.content}->>'type' in ('image', 'video', 'document', 'audio', 'sticker', 'location')`,
  )).orderBy(desc(academyWhatsappMessagesTable.createdAt)).limit(200);
  res.json(await messagesView(rows, access.academyId));
});

// ─── Saved replies ───────────────────────────────────────────────────────────

const SavedReplyBody = z.object({
  shortcut: z.string().trim().toLowerCase().regex(/^[\p{L}\p{N}_-]{1,30}$/u, "Use one word for the shortcut"),
  title: z.string().trim().min(1).max(80),
  body: z.string().trim().min(1).max(1500),
});

router.get(`${base}/saved-replies`, async (req, res): Promise<void> => {
  const access = await academyAccess(req, res);
  if (!access) return;
  const rows = await db.select().from(academyWhatsappSavedRepliesTable)
    .where(eq(academyWhatsappSavedRepliesTable.academyId, access.academyId)).orderBy(academyWhatsappSavedRepliesTable.shortcut);
  res.json({ canEdit: await canManageChats(access), replies: rows.map((r) => ({ id: r.id, shortcut: r.shortcut, title: r.title, body: r.body })) });
});

router.post(`${base}/saved-replies`, async (req, res): Promise<void> => {
  const access = await academyAccess(req, res);
  if (!access) return;
  if (!(await canManageChats(access))) {
    res.status(403).json({ error: "Only the academy owner can edit saved replies, unless he gives your role that permission.", code: "chats_manage" });
    return;
  }
  const body = SavedReplyBody.safeParse(req.body ?? {});
  if (!body.success) {
    res.status(400).json({ error: body.error.issues[0]?.message ?? "Invalid reply" });
    return;
  }
  const [row] = await db.insert(academyWhatsappSavedRepliesTable).values({ academyId: access.academyId, ...body.data, createdBy: access.user.id })
    .onConflictDoUpdate({
      target: [academyWhatsappSavedRepliesTable.academyId, academyWhatsappSavedRepliesTable.shortcut],
      set: { title: body.data.title, body: body.data.body, updatedAt: new Date() },
    }).returning();
  res.status(201).json({ id: row.id, shortcut: row.shortcut, title: row.title, body: row.body });
});

router.put(`${base}/saved-replies/:replyId`, async (req, res): Promise<void> => {
  const access = await academyAccess(req, res);
  if (!access) return;
  if (!(await canManageChats(access))) {
    res.status(403).json({ error: "Only the academy owner can edit saved replies, unless he gives your role that permission.", code: "chats_manage" });
    return;
  }
  const id = intParam(req.params.replyId);
  const body = SavedReplyBody.safeParse(req.body ?? {});
  if (!id || !body.success) {
    res.status(400).json({ error: body.success ? "Invalid reply" : body.error.issues[0]?.message ?? "Invalid reply" });
    return;
  }
  try {
    const [row] = await db.update(academyWhatsappSavedRepliesTable).set({ ...body.data, updatedAt: new Date() })
      .where(and(eq(academyWhatsappSavedRepliesTable.id, id), eq(academyWhatsappSavedRepliesTable.academyId, access.academyId))).returning();
    if (!row) {
      res.status(404).json({ error: "Reply not found" });
      return;
    }
    res.json({ id: row.id, shortcut: row.shortcut, title: row.title, body: row.body });
  } catch {
    res.status(409).json({ error: "Another reply already uses that shortcut" });
  }
});

router.delete(`${base}/saved-replies/:replyId`, async (req, res): Promise<void> => {
  const access = await academyAccess(req, res);
  if (!access) return;
  if (!(await canManageChats(access))) {
    res.status(403).json({ error: "Only the academy owner can edit saved replies, unless he gives your role that permission.", code: "chats_manage" });
    return;
  }
  const id = intParam(req.params.replyId);
  if (id) await db.delete(academyWhatsappSavedRepliesTable).where(and(eq(academyWhatsappSavedRepliesTable.id, id), eq(academyWhatsappSavedRepliesTable.academyId, access.academyId)));
  res.status(204).end();
});

// ─── Chat options: read receipts, greeting, away, missed calls ───────────────

const AutoReplyBody = z.object({ enabled: z.boolean(), text: z.string().trim().min(1).max(1000) });
const OptionsBody = z.object({
  readReceipts: z.boolean().optional(),
  greeting: AutoReplyBody.optional(),
  away: AutoReplyBody.extend({
    days: z.array(z.number().int().min(0).max(6)).max(7),
    start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  }).optional(),
  missedCall: AutoReplyBody.optional(),
});

router.get(`${base}/options`, async (req, res): Promise<void> => {
  const access = await academyAccess(req, res);
  if (!access) return;
  const settings = await getWhatsappSettings(access.academyId);
  res.json({ ...parseChatOptions(settings.chatOptions, settings.locale), canEdit: access.isOwner });
});

router.put(`${base}/options`, async (req, res): Promise<void> => {
  const access = await academyAccess(req, res, true);
  if (!access) return;
  const body = OptionsBody.safeParse(req.body ?? {});
  if (!body.success) {
    res.status(400).json({ error: body.error.issues[0]?.message ?? "Invalid options" });
    return;
  }
  const settings = await getWhatsappSettings(access.academyId);
  const current = parseChatOptions(settings.chatOptions, settings.locale);
  const next = { ...current, ...body.data };
  const saved = await saveWhatsappSettings(access.academyId, { chatOptions: next });
  res.json({ ...parseChatOptions(saved.chatOptions, saved.locale), canEdit: true });
});

// ─── WhatsApp Status and the academy's Channel ───────────────────────────────

/** Status and Channel belong to the academy's own number, never Replay's shared one. */
async function ownSession(access: Access, res: Response): Promise<string | null> {
  const settings = await getWhatsappSettings(access.academyId);
  if (settings.sender !== "own" || !wahaConfigured()) {
    res.status(409).json({ error: "Status and Channel need the academy's own WhatsApp number to be linked." });
    return null;
  }
  return senderSessionFor(settings);
}

const postView = (p: typeof academyWhatsappPostsTable.$inferSelect) => ({
  id: p.id,
  target: p.target,
  kind: p.kind,
  text: p.text,
  mediaUrl: p.media ? mediaUrl(p.media as { path: string }) : null,
  error: p.error,
  canDelete: p.target === "status" && Boolean(p.waMessageId) && !p.deletedAt,
  createdAt: p.createdAt,
});

router.get(`${base}/posts`, async (req, res): Promise<void> => {
  const access = await academyAccess(req, res, true);
  if (!access) return;
  const settings = await getWhatsappSettings(access.academyId);
  const rows = await db.select().from(academyWhatsappPostsTable)
    .where(and(eq(academyWhatsappPostsTable.academyId, access.academyId), isNull(academyWhatsappPostsTable.deletedAt)))
    .orderBy(desc(academyWhatsappPostsTable.createdAt)).limit(40);
  res.json({ channel: parseChatOptions(settings.chatOptions, settings.locale).channel, ownNumber: settings.sender === "own", posts: rows.map(postView) });
});

router.post(`${base}/channel`, async (req, res): Promise<void> => {
  const access = await academyAccess(req, res, true);
  if (!access) return;
  const body = z.object({ name: z.string().trim().min(2).max(100), description: z.string().trim().max(500).default("") }).safeParse(req.body ?? {});
  if (!body.success) {
    res.status(400).json({ error: "Name the channel" });
    return;
  }
  const session = await ownSession(access, res);
  if (!session) return;
  const settings = await getWhatsappSettings(access.academyId);
  const current = parseChatOptions(settings.chatOptions, settings.locale);
  if (current.channel) {
    res.status(409).json({ error: "This academy already has a channel" });
    return;
  }
  try {
    const channel = await createChannel(session, body.data.name, body.data.description);
    await saveWhatsappSettings(access.academyId, { chatOptions: { ...current, channel } });
    res.status(201).json(channel);
  } catch (error) {
    wahaFailure(res, error, "Creating the channel failed");
  }
});

const PostBody = z.object({
  target: z.enum(["status", "channel"]),
  kind: z.enum(["text", "image", "video"]),
  text: z.string().trim().max(1000).optional(),
  caption: z.string().trim().max(1000).optional(),
  media: MediaRef.optional(),
  backgroundColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#38b42f"),
});

router.post(`${base}/posts`, async (req, res): Promise<void> => {
  const access = await academyAccess(req, res, true);
  if (!access) return;
  const body = PostBody.safeParse(req.body ?? {});
  if (!body.success || (body.data.kind === "text" ? !body.data.text : !body.data.media)) {
    res.status(400).json({ error: body.success && body.data.kind !== "text" ? "Choose a photo or video" : "Write something to post" });
    return;
  }
  const session = await ownSession(access, res);
  if (!session) return;
  const file = body.data.media ? ownMedia(access, body.data.media) : null;
  if (body.data.kind !== "text" && !file) {
    res.status(400).json({ error: "Upload the file again" });
    return;
  }
  const settings = await getWhatsappSettings(access.academyId);
  const channel = parseChatOptions(settings.chatOptions, settings.locale).channel;
  if (body.data.target === "channel" && !channel) {
    res.status(409).json({ error: "Create the academy's channel first" });
    return;
  }
  let waId: string | null = null;
  let failure: string | null = null;
  try {
    if (body.data.target === "status") {
      waId = await postStatus(session, body.data.kind === "text"
        ? { kind: "text", text: body.data.text!, backgroundColor: body.data.backgroundColor }
        : { kind: body.data.kind, file: file!, caption: body.data.caption });
    } else if (body.data.kind === "text") {
      waId = await sendText(session, channel!.id, body.data.text!);
    } else if (body.data.kind === "image") {
      waId = await sendImage(session, channel!.id, file!, body.data.caption);
    } else {
      waId = await sendVideo(session, channel!.id, file!, body.data.caption);
    }
  } catch (error) {
    failure = (error as Error).message?.slice(0, 300) ?? "Posting failed";
    logger.warn({ target: body.data.target, error: failure }, "Posting to WhatsApp failed");
  }
  const [row] = await db.insert(academyWhatsappPostsTable).values({
    academyId: access.academyId, target: body.data.target, kind: body.data.kind,
    text: body.data.kind === "text" ? body.data.text! : body.data.caption ?? null,
    media: body.data.media ?? null, backgroundColor: body.data.kind === "text" ? body.data.backgroundColor : null,
    waMessageId: waId, error: failure, createdBy: access.user.id,
  }).returning();
  if (failure) {
    res.status(502).json({ error: body.data.target === "channel" ? "WhatsApp wouldn't take the channel post. Channel posting depends on the WhatsApp engine." : "WhatsApp wouldn't take the post. Try again.", post: postView(row) });
    return;
  }
  res.status(201).json(postView(row));
});

router.delete(`${base}/posts/:postId`, async (req, res): Promise<void> => {
  const access = await academyAccess(req, res, true);
  if (!access) return;
  const id = intParam(req.params.postId);
  const [row] = id ? await db.select().from(academyWhatsappPostsTable).where(and(eq(academyWhatsappPostsTable.id, id), eq(academyWhatsappPostsTable.academyId, access.academyId))) : [];
  if (!row) {
    res.status(404).json({ error: "Post not found" });
    return;
  }
  if (row.target === "status" && row.waMessageId && !row.error) {
    const session = await ownSession(access, res);
    if (!session) return;
    try {
      await deleteStatus(session, row.waMessageId);
    } catch (error) {
      wahaFailure(res, error, "Deleting the status failed");
      return;
    }
  }
  await db.update(academyWhatsappPostsTable).set({ deletedAt: new Date() }).where(eq(academyWhatsappPostsTable.id, row.id));
  res.status(204).end();
});

// ─── Group management ────────────────────────────────────────────────────────

async function groupContext(access: Access, req: Request, res: Response, manage: boolean) {
  const key = `g:${rawParam(req.params.groupId).replace(/^g:/, "")}`;
  const group = await groupRow(access.academyId, key);
  if (!group) {
    res.status(404).json({ error: "Group not found" });
    return null;
  }
  if (manage && !(await canManageChats(access))) {
    res.status(403).json({ error: "Only the academy owner can manage groups, unless he gives your role that permission.", code: "chats_manage" });
    return null;
  }
  if (!wahaConfigured()) {
    res.status(503).json({ error: "WhatsApp service is not set up yet" });
    return null;
  }
  return group;
}

router.get(`${base}/groups/:groupId/members`, async (req, res): Promise<void> => {
  const access = await academyAccess(req, res);
  if (!access) return;
  const group = await groupContext(access, req, res, false);
  if (!group) return;
  try {
    const members = await getGroupMembers(group.session, group.groupId);
    const phones = members.map((m) => m.phone).filter((p): p is string => Boolean(p));
    const contacts = phones.length === 0 ? [] : await db.select({ phone: academyContactsTable.phone, name: academyContactsTable.name }).from(academyContactsTable)
      .where(and(eq(academyContactsTable.academyId, access.academyId), inArray(academyContactsTable.phone, phones)));
    const names = new Map(contacts.map((c) => [c.phone, c.name]));
    res.json(members.map((m) => ({
      phone: m.phone, display: m.phone ? formatPhoneForDisplay(m.phone) : null, name: m.phone ? names.get(m.phone) ?? null : null, admin: m.admin,
    })).sort((a, b) => Number(b.admin) - Number(a.admin) || String(a.name ?? a.display).localeCompare(String(b.name ?? b.display))));
  } catch (error) {
    wahaFailure(res, error, "Listing the group's members failed");
  }
});

const GroupUpdateBody = z.object({
  subject: z.string().trim().min(1).max(100).optional(),
  description: z.string().trim().max(2048).optional(),
  adminsOnlyMessages: z.boolean().optional(),
  adminsOnlyInfo: z.boolean().optional(),
  /** A stored photo, or null to remove the group's photo. */
  picture: MediaRef.nullable().optional(),
});

router.put(`${base}/groups/:groupId`, async (req, res): Promise<void> => {
  const access = await academyAccess(req, res);
  if (!access) return;
  const group = await groupContext(access, req, res, true);
  if (!group) return;
  const body = GroupUpdateBody.safeParse(req.body ?? {});
  if (!body.success || Object.keys(body.data).length === 0) {
    res.status(400).json({ error: "Nothing to change" });
    return;
  }
  try {
    if (body.data.subject !== undefined && body.data.subject !== group.subject) {
      await setGroupSubject(group.session, group.groupId, body.data.subject);
      await db.update(academyWhatsappGroupsTable).set({ subject: body.data.subject, updatedAt: new Date() }).where(eq(academyWhatsappGroupsTable.id, group.id));
    }
    if (body.data.description !== undefined) await setGroupDescription(group.session, group.groupId, body.data.description);
    if (body.data.adminsOnlyMessages !== undefined) await setGroupAdminsOnly(group.session, group.groupId, "messages", body.data.adminsOnlyMessages);
    if (body.data.adminsOnlyInfo !== undefined) await setGroupAdminsOnly(group.session, group.groupId, "info", body.data.adminsOnlyInfo);
    if (body.data.picture !== undefined) {
      const file = body.data.picture ? ownMedia(access, body.data.picture) : null;
      if (body.data.picture && !file) {
        res.status(400).json({ error: "Upload the photo again" });
        return;
      }
      await setGroupPicture(group.session, group.groupId, file ? { url: file.url, mimetype: file.mimetype } : null);
      await db.update(academyWhatsappGroupsTable).set({ avatarCheckedAt: null, ...(body.data.picture ? { avatarPath: body.data.picture.path } : { avatarPath: null }) }).where(eq(academyWhatsappGroupsTable.id, group.id));
    }
    res.json({ ok: true });
  } catch (error) {
    wahaFailure(res, error, "Updating the group failed");
  }
});

router.post(`${base}/groups/:groupId/members/remove`, async (req, res): Promise<void> => {
  const access = await academyAccess(req, res);
  if (!access) return;
  const group = await groupContext(access, req, res, true);
  if (!group) return;
  const phones = (Array.isArray(req.body?.phones) ? req.body.phones as unknown[] : []).map((p) => normalizePhone(String(p))).filter((p): p is string => Boolean(p)).slice(0, 100);
  if (phones.length === 0) {
    res.status(400).json({ error: "Pick who to remove" });
    return;
  }
  try {
    await removeGroupMembers(group.session, group.groupId, phones.map((p) => `${p}@c.us`));
    res.json({ removed: phones.length });
  } catch (error) {
    wahaFailure(res, error, "Removing people failed");
  }
});

router.post(`${base}/groups/:groupId/admins`, async (req, res): Promise<void> => {
  const access = await academyAccess(req, res);
  if (!access) return;
  const group = await groupContext(access, req, res, true);
  if (!group) return;
  const phones = (Array.isArray(req.body?.phones) ? req.body.phones as unknown[] : []).map((p) => normalizePhone(String(p))).filter((p): p is string => Boolean(p)).slice(0, 50);
  if (phones.length === 0) {
    res.status(400).json({ error: "Pick who to change" });
    return;
  }
  try {
    await setGroupAdmins(group.session, group.groupId, phones.map((p) => `${p}@c.us`), req.body?.admin !== false);
    res.json({ changed: phones.length });
  } catch (error) {
    wahaFailure(res, error, "Changing admins failed");
  }
});

router.get(`${base}/groups/:groupId/invite`, async (req, res): Promise<void> => {
  const access = await academyAccess(req, res);
  if (!access) return;
  const group = await groupContext(access, req, res, false);
  if (!group) return;
  try {
    res.json({ link: await getGroupInviteLink(group.session, group.groupId) });
  } catch (error) {
    wahaFailure(res, error, "Getting the invite link failed");
  }
});

router.post(`${base}/groups/:groupId/invite/revoke`, async (req, res): Promise<void> => {
  const access = await academyAccess(req, res);
  if (!access) return;
  const group = await groupContext(access, req, res, true);
  if (!group) return;
  try {
    res.json({ link: await getGroupInviteLink(group.session, group.groupId, true) });
  } catch (error) {
    wahaFailure(res, error, "Resetting the invite link failed");
  }
});

export default router;
