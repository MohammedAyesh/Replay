import { and, eq, sql } from "drizzle-orm";
import { notifyChatMessage } from "../push/webPush";
import {
  academySocialCommentsTable,
  academySocialMessagesTable,
  academySocialThreadsTable,
  db,
  type AcademySocialAccount,
  type AcademySocialThread,
} from "@workspace/db";
import { logger } from "../logger";
import { metaConfig } from "../meta/config";
import { graphDelete, graphGet, graphPost, MetaGraphError } from "../meta/graph";
import { accountByInstagram, accountByPage, markSocialReconnect, pageToken } from "./account";

/**
 * Instagram Direct and Messenger conversations, and comments on the academy's posts.
 * Meta delivers both through the app webhook (object "page" and object "instagram").
 */

export type Channel = "instagram" | "messenger";
export const REPLY_WINDOW_MS = 24 * 60 * 60 * 1000;
export const HUMAN_AGENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

type Attachment = { type?: string; payload?: { url?: string; title?: string } };
type MessagingEvent = {
  sender?: { id?: string };
  recipient?: { id?: string };
  timestamp?: number;
  message?: {
    mid?: string;
    text?: string;
    attachments?: Attachment[];
    is_echo?: boolean;
    is_deleted?: boolean;
    app_id?: number | string;
    reply_to?: { story?: { url?: string; id?: string } };
    referral?: { source?: string; ad_id?: string };
  };
  postback?: { mid?: string; title?: string; payload?: string };
  referral?: { source?: string; ad_id?: string };
};
type Change = { field?: string; value?: Record<string, unknown> };
export type WebhookEntry = { id?: string; time?: number; messaging?: MessagingEvent[]; changes?: Change[] };

// ─── Threads ────────────────────────────────────────────────────────────────

/** Name, @username and picture of the person, as far as Meta lets us read them. */
async function profileOf(channel: Channel, userId: string, token: string, academyId: number): Promise<{ name: string | null; username: string | null; picture: string | null }> {
  try {
    if (channel === "instagram") {
      const p = await graphGet<{ name?: string; username?: string; profile_pic?: string }>(userId, { fields: "name,username,profile_pic" }, { token });
      return { name: p.name ?? null, username: p.username ?? null, picture: p.profile_pic ?? null };
    }
    const p = await graphGet<{ first_name?: string; last_name?: string; name?: string; profile_pic?: string }>(userId, { fields: "first_name,last_name,profile_pic" }, { token });
    const name = [p.first_name, p.last_name].filter(Boolean).join(" ") || p.name || null;
    return { name, username: null, picture: p.profile_pic ?? null };
  } catch (error) {
    await markSocialReconnect(academyId, error).catch(() => false);
    logger.info({ channel, error: (error as Error).message }, "Reading a social profile failed");
    return { name: null, username: null, picture: null };
  }
}

export async function ensureThread(account: AcademySocialAccount, channel: Channel, userId: string): Promise<AcademySocialThread> {
  const where = and(
    eq(academySocialThreadsTable.academyId, account.academyId),
    eq(academySocialThreadsTable.channel, channel),
    eq(academySocialThreadsTable.externalUserId, userId),
  );
  const [existing] = await db.select().from(academySocialThreadsTable).where(where);
  if (existing) {
    if (!existing.name && !existing.username && (account.pageTokenEnc || (!account.pageId && account.tokenEnc))) {
      const profile = await profileOf(channel, userId, pageToken(account), account.academyId);
      if (profile.name || profile.username) {
        const [updated] = await db.update(academySocialThreadsTable).set({ ...profile, updatedAt: new Date() })
          .where(eq(academySocialThreadsTable.id, existing.id)).returning();
        return updated;
      }
    }
    return existing;
  }
  const profile = account.pageTokenEnc || (!account.pageId && account.tokenEnc)
    ? await profileOf(channel, userId, pageToken(account), account.academyId)
    : { name: null, username: null, picture: null };
  const [created] = await db.insert(academySocialThreadsTable)
    .values({ academyId: account.academyId, channel, externalUserId: userId, ...profile, stage: "new" })
    .onConflictDoNothing()
    .returning();
  if (created) return created;
  const [row] = await db.select().from(academySocialThreadsTable).where(where);
  return row;
}

function attachmentsOf(list: Attachment[] | undefined) {
  return (list ?? []).filter((a) => a?.type).map((a) => ({ type: a.type!, url: a.payload?.url ?? null, title: a.payload?.title ?? null }));
}

function describe(attachments: Array<{ type: string }>, storyReply: boolean): string {
  if (storyReply) return "↩︎ Replied to your story";
  if (attachments.length === 0) return "";
  const kinds: Record<string, string> = { image: "📷 Photo", video: "🎥 Video", audio: "🎤 Voice message", file: "📎 File", story_mention: "📣 Mentioned you in their story", share: "🔗 Shared a post", ig_reel: "🎬 Shared a reel", reel: "🎬 Shared a reel" };
  return kinds[attachments[0].type] ?? "📎 Attachment";
}

/** One DM, echo or button tap from the webhook. */
async function handleMessaging(account: AcademySocialAccount, channel: Channel, ownId: string, event: MessagingEvent): Promise<void> {
  const message = event.message;
  const echo = Boolean(message?.is_echo);
  const userId = echo ? event.recipient?.id : event.sender?.id;
  if (!userId || userId === ownId) return;
  const at = new Date(event.timestamp ?? Date.now());
  const mid = message?.mid ?? event.postback?.mid ?? null;

  if (message?.is_deleted && mid) {
    await db.delete(academySocialMessagesTable).where(eq(academySocialMessagesTable.externalId, mid));
    return;
  }
  // Our own sends come back as echoes from our app id: already stored when sent.
  if (echo && message?.app_id && String(message.app_id) === metaConfig().appId) return;

  const thread = await ensureThread(account, channel, userId);
  if (thread.blockedAt || thread.personalAt) return;

  const attachments = attachmentsOf(message?.attachments);
  const storyReply = Boolean(message?.reply_to?.story);
  const kind = echo ? "app"
    : event.postback ? "dm"
      : attachments.some((a) => a.type === "story_mention") ? "story_mention"
        : storyReply ? "story_reply"
          : (message?.referral ?? event.referral)?.source === "ADS" ? "ad" : "dm";
  const body = message?.text ?? event.postback?.title ?? describe(attachments, storyReply);
  const inserted = await db.insert(academySocialMessagesTable).values({
    threadId: thread.id,
    academyId: account.academyId,
    direction: echo ? "out" : "in",
    kind,
    body,
    attachments: storyReply && message?.reply_to?.story?.url ? [...attachments, { type: "story", url: message.reply_to.story.url, title: null }] : attachments,
    externalId: mid,
    status: echo ? "sent" : "received",
    createdAt: at,
  }).onConflictDoNothing().returning({ id: academySocialMessagesTable.id });
  if (inserted.length === 0) return;
  await db.update(academySocialThreadsTable).set({
    lastAt: sql`greatest(coalesce(${academySocialThreadsTable.lastAt}, 'epoch'::timestamptz), ${at.toISOString()}::timestamptz)`,
    ...(echo ? {} : { lastInAt: at }),
    // A new message from them brings an archived chat back.
    ...(echo ? {} : { archivedAt: null }),
    updatedAt: new Date(),
  }).where(eq(academySocialThreadsTable.id, thread.id));
  // The people who answer this chat get a notification on their phones (lib/push/webPush.ts).
  if (!echo) {
    void notifyChatMessage({
      academyId: account.academyId, channel, chatKey: String(thread.id),
      from: thread.name || (thread.username ? `@${thread.username}` : channel === "instagram" ? "Instagram" : "Messenger"),
      preview: body, muted: thread.muted, assignedUserId: thread.assignedUserId,
    });
  }
}

// ─── Comments ───────────────────────────────────────────────────────────────

const postCache = new Map<string, { permalink: string | null; caption: string | null }>();

async function postInfo(channel: "instagram" | "facebook", postId: string, token: string, academyId: number) {
  const hit = postCache.get(postId);
  if (hit) return hit;
  let info = { permalink: null as string | null, caption: null as string | null };
  try {
    if (channel === "instagram") {
      const m = await graphGet<{ permalink?: string; caption?: string }>(postId, { fields: "permalink,caption" }, { token });
      info = { permalink: m.permalink ?? null, caption: m.caption ?? null };
    } else {
      const p = await graphGet<{ permalink_url?: string; message?: string }>(postId, { fields: "permalink_url,message" }, { token });
      info = { permalink: p.permalink_url ?? null, caption: p.message ?? null };
    }
  } catch (error) {
    await markSocialReconnect(academyId, error).catch(() => false);
    logger.info({ postId, error: (error as Error).message }, "Reading a post for a comment failed");
  }
  postCache.set(postId, info);
  if (postCache.size > 500) postCache.delete(postCache.keys().next().value!);
  return info;
}

export async function recordComment(account: AcademySocialAccount, channel: "instagram" | "facebook", c: {
  commentId: string; parentId?: string | null; postId?: string | null; fromId?: string | null; fromName?: string | null; body?: string | null; createdAt?: Date;
}): Promise<boolean> {
  // The academy's own replies aren't comments to answer.
  if (c.fromId && (c.fromId === account.pageId || c.fromId === account.igUserId)) return false;
  const canReadSocialPosts = Boolean(account.pageTokenEnc || (!account.pageId && account.tokenEnc));
  const post = c.postId && canReadSocialPosts ? await postInfo(channel, c.postId, pageToken(account), account.academyId) : { permalink: null, caption: null };
  const rows = await db.insert(academySocialCommentsTable).values({
    academyId: account.academyId,
    channel,
    commentId: c.commentId,
    parentId: c.parentId ?? null,
    postId: c.postId ?? null,
    postPermalink: post.permalink,
    postCaption: post.caption?.slice(0, 500) ?? null,
    fromId: c.fromId ?? null,
    fromName: c.fromName ?? null,
    body: c.body ?? "",
    createdAt: c.createdAt ?? new Date(),
  }).onConflictDoNothing().returning({ id: academySocialCommentsTable.id });
  return rows.length > 0;
}

async function handleChange(account: AcademySocialAccount, object: "page" | "instagram", change: Change): Promise<void> {
  const v = change.value ?? {};
  if (object === "instagram" && change.field === "comments") {
    const from = v.from as { id?: string; username?: string } | undefined;
    const media = v.media as { id?: string } | undefined;
    if (!v.id) return;
    await recordComment(account, "instagram", {
      commentId: String(v.id), parentId: (v.parent_id as string) ?? null, postId: media?.id ?? null,
      fromId: from?.id ?? null, fromName: from?.username ? `@${from.username}` : null, body: (v.text as string) ?? "",
    });
    return;
  }
  if (object === "page" && change.field === "feed" && v.item === "comment") {
    const commentId = v.comment_id as string | undefined;
    if (!commentId) return;
    if (v.verb === "remove") {
      await db.update(academySocialCommentsTable).set({ deletedAt: new Date() })
        .where(and(eq(academySocialCommentsTable.channel, "facebook"), eq(academySocialCommentsTable.commentId, commentId)));
      return;
    }
    if (v.verb !== "add") return;
    const from = v.from as { id?: string; name?: string } | undefined;
    const created = typeof v.created_time === "number" ? new Date(v.created_time * 1000) : new Date();
    await recordComment(account, "facebook", {
      commentId, parentId: (v.parent_id as string) !== v.post_id ? (v.parent_id as string) ?? null : null, postId: (v.post_id as string) ?? null,
      fromId: from?.id ?? null, fromName: from?.name ?? null, body: (v.message as string) ?? "", createdAt: created,
    });
  }
}

/** Every social event in one webhook delivery. Returns how many entries matched a connected academy. */
export async function handleSocialWebhook(body: { object?: string; entry?: WebhookEntry[] }): Promise<number> {
  const object = body.object === "instagram" ? "instagram" : body.object === "page" ? "page" : null;
  if (!object) return 0;
  let matched = 0;
  for (const entry of body.entry ?? []) {
    if (!entry.id) continue;
    const hasSocial = (entry.messaging?.length ?? 0) > 0 || (entry.changes ?? []).some((c) => c.field === "feed" || c.field === "comments");
    if (!hasSocial) continue;
    const account = object === "instagram" ? await accountByInstagram(entry.id) : await accountByPage(entry.id);
    if (!account || account.status !== "connected") continue;
    matched += 1;
    const channel: Channel = object === "instagram" ? "instagram" : "messenger";
    for (const event of entry.messaging ?? []) await handleMessaging(account, channel, entry.id, event);
    for (const change of entry.changes ?? []) await handleChange(account, object, change);
  }
  return matched;
}

// ─── Sending ────────────────────────────────────────────────────────────────

export type ReplyWindow = "open" | "human_agent" | "closed";

export function replyWindow(thread: Pick<AcademySocialThread, "lastInAt">, now = Date.now()): ReplyWindow {
  if (!thread.lastInAt) return "closed";
  const age = now - thread.lastInAt.getTime();
  if (age <= REPLY_WINDOW_MS) return "open";
  if (age <= HUMAN_AGENT_WINDOW_MS && process.env.META_HUMAN_AGENT !== "0") return "human_agent";
  return "closed";
}

export async function sendThreadMessage(account: AcademySocialAccount, thread: AcademySocialThread, text: string, userId: number): Promise<{ id: number; status: "sent" | "failed"; error: string | null }> {
  const senderId = account.pageId ?? (thread.channel === "instagram" ? account.igUserId : null);
  if (!senderId) throw new MetaGraphError(thread.channel === "instagram" ? "Connect Instagram first" : "Connect your Facebook Page first", 409);
  const window = replyWindow(thread);
  if (window === "closed") {
    throw new MetaGraphError("Meta only lets businesses reply within 24 hours of the person's last message (7 days for a person answering by hand). Wait for them to write again.", 409);
  }
  const params: Record<string, string> = {
    recipient: JSON.stringify({ id: thread.externalUserId }),
    message: JSON.stringify({ text }),
    messaging_type: window === "open" ? "RESPONSE" : "MESSAGE_TAG",
  };
  if (window === "human_agent") params.tag = "HUMAN_AGENT";
  let externalId: string | null = null;
  let error: string | null = null;
  try {
    const res = await graphPost<{ message_id?: string }>(`${senderId}/messages`, params, { token: pageToken(account) });
    externalId = res.message_id ?? null;
  } catch (e) {
    await markSocialReconnect(account.academyId, e).catch(() => false);
    error = (e as Error).message;
  }
  const now = new Date();
  const [row] = await db.insert(academySocialMessagesTable).values({
    threadId: thread.id, academyId: account.academyId, direction: "out", kind: "dm", body: text,
    externalId, status: error ? "failed" : "sent", error, sentBy: userId, createdAt: now,
  }).onConflictDoNothing().returning({ id: academySocialMessagesTable.id });
  if (!error) {
    await db.update(academySocialThreadsTable).set({
      lastAt: now, lastReadAt: now, updatedAt: now,
      // Answering moves a new lead along.
      ...(thread.stage === "new" ? { stage: "contacted" } : {}),
    }).where(eq(academySocialThreadsTable.id, thread.id));
  }
  return { id: row?.id ?? 0, status: error ? "failed" : "sent", error };
}

/** Reply under the comment, publicly. */
export async function replyToComment(account: AcademySocialAccount, channel: "instagram" | "facebook", commentId: string, text: string): Promise<string | null> {
  const token = pageToken(account);
  try {
    const result = channel === "instagram"
      ? await graphPost<{ id?: string }>(`${commentId}/replies`, { message: text }, { token })
      : await graphPost<{ id?: string }>(`${commentId}/comments`, { message: text }, { token });
    return result.id ?? null;
  } catch (error) {
    await markSocialReconnect(account.academyId, error).catch(() => false);
    throw error;
  }
}

export async function createPostComment(
  account: AcademySocialAccount,
  _channel: "instagram" | "facebook",
  postId: string,
  text: string,
): Promise<string> {
  const result = await graphPost<{ id?: string }>(`${postId}/comments`, { message: text }, { token: pageToken(account) });
  if (!result.id) throw new MetaGraphError("Meta did not return the new comment ID", 502);
  return result.id;
}

export async function editFacebookComment(account: AcademySocialAccount, commentId: string, text: string): Promise<void> {
  await graphPost(commentId, { message: text }, { token: pageToken(account) });
}

export async function deleteSocialComment(account: AcademySocialAccount, commentId: string): Promise<void> {
  await graphDelete(commentId, { token: pageToken(account) });
}

async function resolveOwnReplyId(
  account: AcademySocialAccount,
  channel: "instagram" | "facebook",
  parentCommentId: string,
  existingBody: string,
): Promise<string | null> {
  const ownId = channel === "facebook" ? account.pageId : account.igUserId;
  if (!ownId) return null;
  const edge = channel === "instagram" ? `${parentCommentId}/replies` : `${parentCommentId}/comments`;
  const fields = channel === "instagram" ? "id,text,from" : "id,message,from";
  const result = await graphGet<{
    data?: Array<{ id: string; message?: string; text?: string; from?: { id?: string } }>;
  }>(edge, { fields, limit: "100" }, { token: pageToken(account) });
  return result.data?.find((reply) =>
    reply.from?.id === ownId && (reply.message ?? reply.text ?? "") === existingBody,
  )?.id ?? null;
}

export async function editFacebookReply(
  account: AcademySocialAccount,
  parentCommentId: string,
  replyCommentId: string | null,
  existingBody: string,
  text: string,
): Promise<string> {
  const id = replyCommentId ?? await resolveOwnReplyId(account, "facebook", parentCommentId, existingBody);
  if (!id) throw new MetaGraphError("The Facebook reply could not be found; it may already be deleted", 404, 100);
  await graphPost(id, { message: text }, { token: pageToken(account) });
  return id;
}

export async function deleteSocialReply(
  account: AcademySocialAccount,
  channel: "instagram" | "facebook",
  parentCommentId: string,
  replyCommentId: string | null,
  existingBody: string,
): Promise<string> {
  const id = replyCommentId ?? await resolveOwnReplyId(account, channel, parentCommentId, existingBody);
  if (!id) throw new MetaGraphError("The reply could not be found; it may already be deleted", 404, 100);
  await graphDelete(id, { token: pageToken(account) });
  return id;
}

export async function hideComment(account: AcademySocialAccount, channel: "instagram" | "facebook", commentId: string, hidden: boolean): Promise<void> {
  const token = pageToken(account);
  try {
    if (channel === "instagram") await graphPost(commentId, { hide: hidden ? "true" : "false" }, { token });
    else await graphPost(commentId, { is_hidden: hidden ? "true" : "false" }, { token });
  } catch (error) {
    await markSocialReconnect(account.academyId, error).catch(() => false);
    throw error;
  }
}

/** One private message to the commenter (once per comment, within 7 days). It opens a DM thread. */
export async function privateReply(account: AcademySocialAccount, channel: "instagram" | "facebook", commentId: string, fromId: string | null, text: string, userId: number): Promise<number | null> {
  const senderId = account.pageId ?? (channel === "instagram" ? account.igUserId : null);
  if (!senderId) throw new MetaGraphError(channel === "instagram" ? "Connect Instagram first" : "Connect your Facebook Page first", 409);
  let res: { message_id?: string; recipient_id?: string };
  try {
    res = await graphPost<{ message_id?: string; recipient_id?: string }>(`${senderId}/messages`, {
      recipient: JSON.stringify({ comment_id: commentId }),
      message: JSON.stringify({ text }),
    }, { token: pageToken(account) });
  } catch (error) {
    await markSocialReconnect(account.academyId, error).catch(() => false);
    throw error;
  }
  const recipient = res.recipient_id ?? fromId;
  if (!recipient) return null;
  const thread = await ensureThread(account, channel === "instagram" ? "instagram" : "messenger", recipient);
  const now = new Date();
  await db.insert(academySocialMessagesTable).values({
    threadId: thread.id, academyId: account.academyId, direction: "out", kind: "private_reply", body: text,
    externalId: res.message_id ?? null, status: "sent", sentBy: userId, createdAt: now,
  }).onConflictDoNothing();
  await db.update(academySocialThreadsTable).set({ lastAt: now, updatedAt: now }).where(eq(academySocialThreadsTable.id, thread.id));
  return thread.id;
}

// ─── Backfill after connecting ──────────────────────────────────────────────

type ConversationRow = {
  id: string;
  updated_time?: string;
  participants?: { data?: Array<{ id: string; name?: string; username?: string }> };
  messages?: { data?: Array<{ id: string; message?: string; created_time?: string; from?: { id?: string } }> };
};

/** Recent conversations from before Replay was connected, so the inbox isn't empty on day one. */
export async function backfillConversations(account: AcademySocialAccount): Promise<number> {
  if (!account.pageId && !account.igUserId) return 0;
  const token = pageToken(account);
  let stored = 0;
  const platforms: Array<{ baseId: string; platform: string; channel: Channel; ownId: string | null }> = [
    ...(account.pageId ? [{ baseId: account.pageId, platform: "messenger", channel: "messenger" as Channel, ownId: account.pageId }] : []),
    ...(account.igUserId ? [{ baseId: account.pageId ?? account.igUserId, platform: "instagram", channel: "instagram" as Channel, ownId: account.igUserId }] : []),
  ];
  for (const { baseId, platform, channel, ownId } of platforms) {
    let rows: ConversationRow[] = [];
    try {
      rows = (await graphGet<{ data: ConversationRow[] }>(`${baseId}/conversations`, {
        platform,
        fields: "id,updated_time,participants,messages.limit(15){id,message,created_time,from}",
        limit: "25",
      }, { token })).data ?? [];
    } catch (error) {
      await markSocialReconnect(account.academyId, error).catch(() => false);
      logger.info({ platform, error: (error as Error).message }, "Backfilling conversations failed");
      continue;
    }
    for (const conv of rows) {
      const other = conv.participants?.data?.find((p) => p.id !== ownId && p.id !== account.pageId);
      if (!other) continue;
      const thread = await ensureThread(account, channel, other.id);
      if (thread.blockedAt || thread.personalAt) continue;
      let lastIn: Date | null = null;
      let last: Date | null = null;
      for (const m of conv.messages?.data ?? []) {
        const at = m.created_time ? new Date(m.created_time) : new Date();
        const mine = m.from?.id === ownId || m.from?.id === account.pageId;
        const res = await db.insert(academySocialMessagesTable).values({
          threadId: thread.id, academyId: account.academyId, direction: mine ? "out" : "in", kind: mine ? "app" : "dm",
          body: m.message ?? "", externalId: m.id, status: mine ? "sent" : "received", createdAt: at,
        }).onConflictDoNothing().returning({ id: academySocialMessagesTable.id });
        stored += res.length;
        if (!last || at > last) last = at;
        if (!mine && (!lastIn || at > lastIn)) lastIn = at;
      }
      if (last) {
        await db.update(academySocialThreadsTable).set({
          lastAt: last,
          ...(lastIn && (!thread.lastInAt || lastIn > thread.lastInAt) ? { lastInAt: lastIn } : {}),
          // Old conversations count as read; only new messages light up.
          lastReadAt: thread.lastReadAt ?? last,
          updatedAt: new Date(),
        }).where(eq(academySocialThreadsTable.id, thread.id));
      }
    }
  }
  return stored;
}
