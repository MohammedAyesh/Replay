import { and, eq, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";
import {
  academiesTable,
  academyContactsTable,
  academyWhatsappGroupsTable,
  academyWhatsappMessagesTable,
  academyWhatsappPollVotesTable,
  academyWhatsappOptOutsTable,
  academyWhatsappSettingsTable,
  db,
  type AcademyWhatsappSettings,
} from "@workspace/db";
import { logger } from "../logger";
import { upsertContact } from "./contacts";
import { handleVenueInbound } from "../venues/agent";
import { recordAdLead } from "../meta/leads";
import { findAdReferral } from "../meta/referral";
import { groupIdFromKey, groupKey, isGroupKey, isLid, phoneFromChatId } from "./phone";
import {
  MAX_CHAT_MEDIA_BYTES,
  incomingContacts,
  incomingKind,
  incomingLocation,
  mediaUrl,
  storeChatMedia,
  summaryFor,
  type WaMedia,
  type WhatsappContent,
} from "./media";
import type { WhatsappLocale } from "./templates";
import { isClosed, parseChatOptions } from "./chatOptions";
import {
  REPLAY_SESSION,
  WahaError,
  academyIdFromSessionName,
  academySessionName,
  bareMessageId,
  checkNumber,
  downloadWahaFile,
  getSession,
  phoneForLid,
  sendFile,
  sendImage,
  sendLocation,
  sendPoll,
  sendSticker,
  sendContacts,
  sendText,
  serializedMessageId,
  type SendOptions,
  sendVideo,
  sendVoice,
  wahaConfigured,
  type WahaFile,
} from "./waha";

export type WhatsappSender = "own" | "replay" | "off";

export type WhatsappSettingsView = {
  academyId: number;
  sender: WhatsappSender;
  locale: WhatsappLocale;
  dailyLimit: number;
  automations: unknown;
  chatOptions: unknown;
  sessionStatus: string | null;
  connectedPhone: string | null;
  connectedName: string | null;
};

export function defaultSettings(academyId: number): WhatsappSettingsView {
  return {
    academyId,
    sender: "off",
    locale: "ar",
    dailyLimit: 300,
    automations: {},
    chatOptions: {},
    sessionStatus: null,
    connectedPhone: null,
    connectedName: null,
  };
}

function view(row: AcademyWhatsappSettings): WhatsappSettingsView {
  return {
    academyId: row.academyId,
    sender: (row.sender as WhatsappSender) ?? "off",
    locale: row.locale === "en" ? "en" : "ar",
    dailyLimit: row.dailyLimit,
    automations: row.automations ?? {},
    chatOptions: row.chatOptions ?? {},
    sessionStatus: row.sessionStatus,
    connectedPhone: row.connectedPhone,
    connectedName: row.connectedName,
  };
}

export async function getWhatsappSettings(academyId: number): Promise<WhatsappSettingsView> {
  const [row] = await db
    .select()
    .from(academyWhatsappSettingsTable)
    .where(eq(academyWhatsappSettingsTable.academyId, academyId));
  return row ? view(row) : defaultSettings(academyId);
}

export async function saveWhatsappSettings(
  academyId: number,
  patch: Partial<Pick<AcademyWhatsappSettings, "sender" | "locale" | "dailyLimit" | "automations" | "chatOptions" | "sessionStatus" | "connectedPhone" | "connectedName">>,
): Promise<WhatsappSettingsView> {
  const [row] = await db
    .insert(academyWhatsappSettingsTable)
    .values({ academyId, ...patch, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: academyWhatsappSettingsTable.academyId,
      set: { ...patch, updatedAt: new Date() },
    })
    .returning();
  return view(row);
}

/** WAHA session an academy's messages leave from, or null when WhatsApp is off. */
export function senderSessionFor(settings: Pick<WhatsappSettingsView, "academyId" | "sender">): string | null {
  if (settings.sender === "own") return academySessionName(settings.academyId);
  if (settings.sender === "replay") return REPLAY_SESSION;
  return null;
}

export type OutgoingMessage = {
  academyId: number;
  kind: string;
  phone: string;
  body: string;
  recipientName?: string | null;
  recipientRole?: string | null;
  playerId?: number | null;
  broadcastId?: number | null;
  dedupeKey?: string | null;
  createdBy?: number | null;
  scheduledFor?: Date;
};

/** Queue messages. Messages whose dedupe key already exists are silently dropped. Returns how many were queued. */
export async function enqueueMessages(messages: OutgoingMessage[]): Promise<number> {
  if (messages.length === 0) return 0;
  let queued = 0;
  for (let i = 0; i < messages.length; i += 200) {
    const chunk = messages.slice(i, i + 200);
    const rows = await db
      .insert(academyWhatsappMessagesTable)
      .values(chunk.map((m) => ({
        academyId: m.academyId,
        kind: m.kind,
        phone: m.phone,
        body: m.body,
        recipientName: m.recipientName ?? null,
        recipientRole: m.recipientRole ?? null,
        playerId: m.playerId ?? null,
        broadcastId: m.broadcastId ?? null,
        dedupeKey: m.dedupeKey ?? null,
        createdBy: m.createdBy ?? null,
        scheduledFor: m.scheduledFor ?? new Date(),
      })))
      .onConflictDoNothing()
      .returning({ id: academyWhatsappMessagesTable.id });
    queued += rows.length;
  }
  return queued;
}

/** Numbers the academy blocked in Chats: nothing is sent to them. */
export async function blockedPhones(academyId: number): Promise<Set<string>> {
  const rows = await db.select({ phone: academyContactsTable.phone }).from(academyContactsTable)
    .where(and(eq(academyContactsTable.academyId, academyId), isNotNull(academyContactsTable.blockedAt)));
  return new Set(rows.map((r) => r.phone));
}

export async function optedOutPhones(academyId: number): Promise<Set<string>> {
  const rows = await db
    .select({ phone: academyWhatsappOptOutsTable.phone })
    .from(academyWhatsappOptOutsTable)
    .where(eq(academyWhatsappOptOutsTable.academyId, academyId));
  return new Set(rows.map((r) => r.phone));
}

// ─── Dispatch ────────────────────────────────────────────────────────────────

const PER_SESSION_PER_TICK = Number(process.env.WHATSAPP_PER_SESSION_PER_TICK || 10);
const MIN_GAP_MS = Number(process.env.WHATSAPP_MIN_GAP_MS || 2_500);
const MAX_GAP_MS = Number(process.env.WHATSAPP_MAX_GAP_MS || 5_500);
const REPLAY_DAILY_LIMIT = Number(process.env.WHATSAPP_REPLAY_DAILY_LIMIT || 1_000);
const MAX_ATTEMPTS = 3;
const NOT_CONNECTED_EXPIRY_HOURS = 24;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const jitter = () => MIN_GAP_MS + Math.random() * Math.max(0, MAX_GAP_MS - MIN_GAP_MS);

export type DispatchSummary = {
  configured: boolean;
  sent: number;
  failed: number;
  skipped: number;
  deferred: number;
  sessions: Record<string, string>;
};

type ClaimedRow = { id: number; academy_id: number; phone: string; body: string; attempts: number; kind: string; content: WhatsappContent | null; reply_to_wa_id: string | null; mentions: string[] | null };

async function claimNext(academyIds: number[], session: string): Promise<ClaimedRow | null> {
  if (academyIds.length === 0) return null;
  const result = await db.execute(sql`
    update academy_whatsapp_messages
    set status = 'sending', attempts = attempts + 1, claimed_at = now(), sender_session = ${session}
    where id = (
      select id from academy_whatsapp_messages
      where status = 'queued' and direction = 'out' and scheduled_for <= now()
        and academy_id in (${sql.join(academyIds.map((id) => sql`${id}`), sql`, `)})
      order by scheduled_for, id
      for update skip locked
      limit 1
    )
    returning id, academy_id, phone, body, attempts, kind, content, reply_to_wa_id, mentions
  `);
  return ((result as unknown as { rows: ClaimedRow[] }).rows ?? [])[0] ?? null;
}

async function sentTodayCount(academyIds: number[] | null, session: string | null): Promise<number> {
  const result = await db.execute(sql`
    select count(*)::int as n from academy_whatsapp_messages
    where status in ('sent', 'delivered', 'read')
      and sent_at >= (date_trunc('day', now() at time zone 'Asia/Amman') at time zone 'Asia/Amman')
      ${academyIds ? sql`and academy_id in (${sql.join(academyIds.map((id) => sql`${id}`), sql`, `)})` : sql``}
      ${session ? sql`and sender_session = ${session}` : sql``}
  `);
  return ((result as unknown as { rows: Array<{ n: number }> }).rows ?? [])[0]?.n ?? 0;
}

async function finish(id: number, patch: Partial<typeof academyWhatsappMessagesTable.$inferInsert>) {
  await db.update(academyWhatsappMessagesTable).set(patch).where(eq(academyWhatsappMessagesTable.id, id));
}

async function markQueued(academyIds: number[], status: "failed" | "skipped", error: string, olderThanHours = 0) {
  if (academyIds.length === 0) return 0;
  const rows = await db
    .update(academyWhatsappMessagesTable)
    .set({ status, error })
    .where(and(
      eq(academyWhatsappMessagesTable.status, "queued"),
      inArray(academyWhatsappMessagesTable.academyId, academyIds),
      lte(academyWhatsappMessagesTable.createdAt, new Date(Date.now() - olderThanHours * 3_600_000)),
    ))
    .returning({ id: academyWhatsappMessagesTable.id });
  return rows.length;
}

class NotOnWhatsapp extends Error {}

/** The other WAHA session can't post in a group that lives on one number. */
class WrongNumberForGroup extends Error {}

/**
 * Send one claimed message: text, a file, a location or a poll, to a person or a group.
 * On Replay's shared number the academy's name goes on top (in the caption, the location's
 * title or the poll's question), so the recipient knows who is writing.
 */
async function deliver(session: string, row: ClaimedRow, academyName: string | null): Promise<string | null> {
  const brand = session === REPLAY_SESSION && academyName ? academyName : null;
  const branded = (text: string | null | undefined) => (brand ? `*${brand}*\n${text ?? ""}`.trim() : (text ?? "").trim());
  let chatId: string;
  const groupId = groupIdFromKey(row.phone);
  if (groupId) {
    const [group] = await db.select({ session: academyWhatsappGroupsTable.session }).from(academyWhatsappGroupsTable)
      .where(and(eq(academyWhatsappGroupsTable.academyId, row.academy_id), eq(academyWhatsappGroupsTable.groupId, groupId)));
    if (group && group.session !== session) throw new WrongNumberForGroup();
    chatId = `${groupId}@g.us`;
  } else {
    const found = await checkNumber(session, row.phone);
    if (!found) throw new NotOnWhatsapp();
    chatId = found;
  }
  const content = row.content;
  const opts: SendOptions = {};
  if (row.reply_to_wa_id) opts.replyTo = await serializedReplyId(row.academy_id, row.phone, row.reply_to_wa_id);
  if (row.mentions?.length) opts.mentions = row.mentions.map((p) => `${p}@c.us`);
  if (!content) return sendText(session, chatId, branded(row.body), opts);
  const file = (media: WaMedia): WahaFile => {
    const url = mediaUrl(media);
    if (!url) throw new WahaError(400, "The file is no longer available", false);
    return { url, mimetype: media.mimetype, ...(media.filename ? { filename: media.filename } : {}) };
  };
  switch (content.type) {
    case "image": return sendImage(session, chatId, file(content.media), branded(content.caption) || undefined, opts);
    case "video": return sendVideo(session, chatId, file(content.media), content.note ? undefined : branded(content.caption) || undefined, content.gif === true, { ...opts, note: content.note === true });
    case "document": return sendFile(session, chatId, file(content.media), branded(content.caption) || undefined, opts);
    case "audio": return sendVoice(session, chatId, file(content.media), opts);
    case "sticker": return sendSticker(session, chatId, file(content.media), opts);
    case "location": {
      const title = [brand, content.name].filter(Boolean).join(" · ");
      return sendLocation(session, chatId, content.latitude, content.longitude, title || undefined, opts);
    }
    case "contact": return sendContacts(session, chatId, content.contacts, opts);
    case "poll": {
      const name = brand ? `${brand}: ${content.name}` : content.name;
      return sendPoll(session, chatId, { name: name.slice(0, 255), options: content.options, multipleAnswers: content.multipleAnswers }, opts);
    }
  }
}

/** WAHA's id for a message we hold, so a reply can quote it. */
export async function serializedReplyId(academyId: number, chatKey: string, waId: string): Promise<string> {
  const [row] = await db.select({ direction: academyWhatsappMessagesTable.direction, authorPhone: academyWhatsappMessagesTable.authorPhone })
    .from(academyWhatsappMessagesTable)
    .where(and(eq(academyWhatsappMessagesTable.academyId, academyId), eq(academyWhatsappMessagesTable.phone, chatKey), eq(academyWhatsappMessagesTable.waMessageId, waId)))
    .limit(1);
  const groupId = groupIdFromKey(chatKey);
  const chatId = groupId ? `${groupId}@g.us` : `${chatKey}@c.us`;
  if (!row) return waId;
  return serializedMessageId(row.direction === "out", chatId, waId, groupId && row.direction === "in" && row.authorPhone ? `${row.authorPhone}@c.us` : null);
}

function deliveryFailure(error: unknown): string | null {
  if (error instanceof NotOnWhatsapp) return "This number is not on WhatsApp";
  if (error instanceof WrongNumberForGroup) return "This group is on the academy's other WhatsApp number";
  return null;
}

/**
 * Send what is due. Called every minute by vps1's cron through /api/whatsapp/tick
 * (the API runs on autoscale, so it cannot keep its own timer).
 *
 * Each WhatsApp number sends at most PER_SESSION_PER_TICK messages a minute, a few
 * seconds apart, so a broadcast to a whole academy trickles out like a person typing
 * rather than a burst — the pattern WhatsApp bans numbers for.
 */
export async function dispatchQueue(options: { budgetMs?: number } = {}): Promise<DispatchSummary> {
  const summary: DispatchSummary = { configured: wahaConfigured(), sent: 0, failed: 0, skipped: 0, deferred: 0, sessions: {} };
  if (!summary.configured) return summary;
  const deadline = Date.now() + (options.budgetMs ?? 45_000);

  await db.execute(sql`
    update academy_whatsapp_messages
    set status = 'failed', error = 'Interrupted while sending; not retried to avoid a duplicate'
    where status = 'sending' and claimed_at < now() - interval '10 minutes'
  `);

  const due = await db
    .selectDistinct({ academyId: academyWhatsappMessagesTable.academyId })
    .from(academyWhatsappMessagesTable)
    .where(and(
      eq(academyWhatsappMessagesTable.status, "queued"),
      eq(academyWhatsappMessagesTable.direction, "out"),
      lte(academyWhatsappMessagesTable.scheduledFor, new Date()),
    ));
  if (due.length === 0) return summary;

  const bySession = new Map<string, WhatsappSettingsView[]>();
  const off: number[] = [];
  for (const { academyId } of due) {
    const settings = await getWhatsappSettings(academyId);
    const session = senderSessionFor(settings);
    if (!session) {
      off.push(academyId);
      continue;
    }
    const list = bySession.get(session) ?? [];
    list.push(settings);
    bySession.set(session, list);
  }
  summary.skipped += await markQueued(off, "skipped", "WhatsApp is turned off for this academy");

  const academyNames = new Map(
    (await db.select({ id: academiesTable.id, name: academiesTable.name }).from(academiesTable)
      .where(inArray(academiesTable.id, due.map((d) => d.academyId))))
      .map((a) => [a.id, a.name]),
  );

  await Promise.all([...bySession.entries()].map(async ([session, academies]) => {
    const academyIds = academies.map((a) => a.academyId);
    let status: string;
    try {
      status = (await getSession(session))?.status ?? "MISSING";
    } catch (error) {
      summary.sessions[session] = `unreachable: ${(error as Error).message}`;
      return;
    }
    summary.sessions[session] = status;
    if (status !== "WORKING") {
      summary.failed += await markQueued(
        academyIds,
        "failed",
        "WhatsApp number is not connected",
        NOT_CONNECTED_EXPIRY_HOURS,
      );
      return;
    }

    const limits = new Map(academies.map((a) => [a.academyId, a.dailyLimit]));
    const sentToday = new Map<number, number>();
    for (const id of academyIds) sentToday.set(id, await sentTodayCount([id], null));
    let sessionSentToday = session === REPLAY_SESSION ? await sentTodayCount(null, REPLAY_SESSION) : 0;
    const optOuts = new Map<number, Set<string>>();
    const blocked = new Map<number, Set<string>>();
    let open = academyIds.filter((id) => (sentToday.get(id) ?? 0) < (limits.get(id) ?? 300));
    let sentThisTick = 0;

    while (open.length > 0 && sentThisTick < PER_SESSION_PER_TICK && Date.now() < deadline - 8_000) {
      if (session === REPLAY_SESSION && sessionSentToday >= REPLAY_DAILY_LIMIT) break;
      const row = await claimNext(open, session);
      if (!row) break;
      const academyId = row.academy_id;
      if (!optOuts.has(academyId)) optOuts.set(academyId, await optedOutPhones(academyId));
      if (!blocked.has(academyId)) blocked.set(academyId, await blockedPhones(academyId));
      if (blocked.get(academyId)!.has(row.phone)) {
        await finish(row.id, { status: "skipped", error: "Blocked" });
        summary.skipped += 1;
        continue;
      }
      if (!isGroupKey(row.phone) && row.kind !== "reply" && row.kind !== "chat" && row.kind !== "auto_reply" && optOuts.get(academyId)!.has(row.phone)) {
        await finish(row.id, { status: "skipped", error: "Recipient replied STOP" });
        summary.skipped += 1;
        continue;
      }
      try {
        const waId = await deliver(session, row, academyNames.get(academyId) ?? null);
        await finish(row.id, { status: "sent", sentAt: new Date(), waMessageId: bareMessageId(waId), error: null });
        summary.sent += 1;
        sentThisTick += 1;
        sessionSentToday += 1;
        const count = (sentToday.get(academyId) ?? 0) + 1;
        sentToday.set(academyId, count);
        if (count >= (limits.get(academyId) ?? 300)) open = open.filter((id) => id !== academyId);
        await sleep(jitter());
      } catch (error) {
        const final = deliveryFailure(error);
        if (final) {
          await finish(row.id, { status: "failed", error: final });
          summary.failed += 1;
          continue;
        }
        const transient = error instanceof WahaError ? error.transient : true;
        const message = (error as Error).message?.slice(0, 500) ?? "Send failed";
        if (transient && row.attempts < MAX_ATTEMPTS) {
          await finish(row.id, { status: "queued", error: message, scheduledFor: new Date(Date.now() + 2 * 60_000) });
          summary.deferred += 1;
        } else {
          await finish(row.id, { status: "failed", error: message });
          summary.failed += 1;
        }
        logger.warn({ session, messageId: row.id, error: message }, "WhatsApp send failed");
        if (transient) break;
      }
    }
  }));

  return summary;
}

// ─── Webhook handling ────────────────────────────────────────────────────────

type WebhookEvent = {
  event?: string;
  session?: string;
  me?: { id?: string; pushName?: string } | null;
  payload?: Record<string, unknown>;
};

const ACK_STATUS: Record<number, "sent" | "delivered" | "read" | "failed"> = { [-1]: "failed", 1: "sent", 2: "delivered", 3: "read", 4: "read" };
const STATUS_RANK: Record<string, number> = { queued: 0, sending: 1, sent: 2, delivered: 3, read: 4 };

const STOP_WORDS = new Set(["stop", "unsubscribe", "ايقاف", "إيقاف", "الغاء", "إلغاء", "توقف", "وقف"]);
const START_WORDS = new Set(["start", "subscribe", "تفعيل", "اشتراك"]);

/**
 * The other side's phone number. WhatsApp often names the sender by a linked id ("…@lid")
 * instead of the number; the engine's raw message usually carries the number as well
 * (SenderAlt / RecipientAlt), and otherwise WAHA's lid map knows it.
 */
export async function phoneForChat(session: string, chatId: string, payload: Record<string, unknown>, fromMe: boolean): Promise<string | null> {
  const direct = phoneFromChatId(chatId);
  if (direct) return direct;
  if (!isLid(chatId)) return null;
  const data = (payload._data ?? {}) as Record<string, unknown>;
  const info = (data.Info ?? data.info ?? {}) as Record<string, unknown>;
  const alternatives = fromMe
    ? [info.RecipientAlt, info.ChatAlt, data.to, (data.key as { remoteJidAlt?: unknown } | undefined)?.remoteJidAlt]
    : [info.SenderAlt, info.ChatAlt, (data.key as { remoteJidAlt?: unknown; participantAlt?: unknown } | undefined)?.remoteJidAlt, data.from];
  for (const alt of alternatives) {
    const phone = typeof alt === "string" ? phoneFromChatId(alt) : null;
    if (phone) return phone;
  }
  try {
    return await phoneForLid(session, chatId);
  } catch (error) {
    logger.warn({ session, error: (error as Error).message }, "Looking up a WhatsApp linked id failed");
    return null;
  }
}

/** Which academy a webhook belongs to, from its session name. Replay's shared number has none. */
function academyForSession(session: string | undefined): number | null {
  return academyIdFromSessionName(session);
}

export async function handleWahaWebhook(event: WebhookEvent): Promise<void> {
  const session = event.session ?? "";
  const payload = event.payload ?? {};

  if (event.event === "session.status") {
    const academyId = academyForSession(session);
    if (academyId === null) return;
    const status = String(payload.status ?? "");
    const mePhone = phoneFromChatId(event.me?.id ?? null);
    await saveWhatsappSettings(academyId, {
      sessionStatus: status || null,
      ...(status === "WORKING" ? { connectedPhone: mePhone, connectedName: event.me?.pushName ?? null } : {}),
    });
    return;
  }

  if (event.event === "message.ack") {
    const ack = Number(payload.ack);
    const next = ACK_STATUS[ack];
    const id = bareMessageId(typeof payload.id === "string" ? payload.id : null);
    if (!next || !id) return;
    const [message] = await db
      .select({ id: academyWhatsappMessagesTable.id, status: academyWhatsappMessagesTable.status })
      .from(academyWhatsappMessagesTable)
      .where(eq(academyWhatsappMessagesTable.waMessageId, id))
      .limit(1);
    if (!message) return;
    if (next === "failed") {
      await finish(message.id, { status: "failed", error: "WhatsApp reported a delivery error" });
      return;
    }
    if ((STATUS_RANK[next] ?? 0) <= (STATUS_RANK[message.status] ?? 0)) return;
    await finish(message.id, {
      status: next,
      ...(next === "delivered" ? { deliveredAt: new Date() } : {}),
      ...(next === "read" ? { readAt: new Date() } : {}),
    });
    return;
  }

  if (event.event === "poll.vote") {
    await handlePollVote(session, payload);
    return;
  }
  if (event.event === "message.reaction") {
    await handleReaction(session, payload);
    return;
  }
  if (event.event === "message.revoked") {
    await handleRevoked(payload);
    return;
  }
  if (event.event === "message.edited") {
    await handleEdited(payload);
    return;
  }
  if (event.event === "presence.update") {
    await handlePresence(session, payload);
    return;
  }
  if (event.event === "call.received") {
    await handleMissedCall(session, payload);
    return;
  }

  if (event.event === "message" || event.event === "message.any") {
    const from = typeof payload.from === "string" ? payload.from : "";
    const to = typeof payload.to === "string" ? payload.to : "";
    const fromMe = payload.fromMe === true;
    const other = fromMe ? to : from;
    if (other.includes("status@broadcast") || other.endsWith("@newsletter")) return;
    const body = typeof payload.body === "string" ? payload.body : "";
    const waMessageId = bareMessageId(typeof payload.id === "string" ? payload.id : null);
    if (waMessageId) {
      const [seen] = await db
        .select({ id: academyWhatsappMessagesTable.id })
        .from(academyWhatsappMessagesTable)
        .where(eq(academyWhatsappMessagesTable.waMessageId, waMessageId))
        .limit(1);
      if (seen) return;
    }
    const pushName = typeof (payload._data as { pushName?: unknown } | undefined)?.pushName === "string"
      ? String((payload._data as { pushName: string }).pushName)
      : typeof (payload as { notifyName?: unknown }).notifyName === "string" ? String((payload as { notifyName: string }).notifyName) : null;

    let academyId: number | null;
    let chatKey: string;
    let authorPhone: string | null = null;
    const isGroup = other.endsWith("@g.us");

    if (isGroup) {
      // Only groups the academy follows in Chats are kept; any other group on the phone stays private.
      const groupId = other.slice(0, -"@g.us".length);
      const group = await followedGroup(session, groupId);
      if (!group) return;
      academyId = group.academyId;
      chatKey = groupKey(groupId);
      if (!fromMe) {
        const data = (payload._data ?? {}) as Record<string, unknown>;
        const info = (data.Info ?? data.info ?? {}) as Record<string, unknown>;
        const participant = [payload.participant, payload.author, info.Sender].find((v): v is string => typeof v === "string" && v.length > 0) ?? "";
        authorPhone = participant ? await phoneForChat(session, participant, payload, false) : null;
      }
    } else {
      const phone = await phoneForChat(session, other, payload, fromMe);
      if (!phone) {
        if (!fromMe) logger.warn({ session, chat: other }, "WhatsApp message from a number we couldn't resolve; dropped");
        return;
      }
      chatKey = phone;
      // Which academy is this for? Own number → that academy. Replay's number →
      // the academy whose ad they tapped, else the academy that last messaged
      // this phone from it, else the one academy that has this number in People.
      academyId = academyForSession(session);
      const referral = fromMe ? null : findAdReferral(payload);
      if (referral) {
        const lead = await recordAdLead({
          source: "whatsapp",
          externalId: `wa:${waMessageId ?? referral.ctwaClid ?? `${phone}:${Date.now()}`}`,
          academyId,
          adId: referral.adId,
          ctwaClid: referral.ctwaClid,
          headline: referral.headline,
          phone,
          name: pushName,
          answers: { message: body.slice(0, 500), adBody: referral.body, sourceUrl: referral.sourceUrl },
        }).catch((error) => {
          logger.warn({ error: (error as Error).message }, "Recording a click-to-WhatsApp lead failed");
          return null;
        });
        academyId ??= lead?.academyId ?? null;
      }
      if (academyId === null && session === REPLAY_SESSION) {
        if (fromMe) return;
        academyId = await academyForReplayNumber(phone);
      }
      if (academyId === null) return;
      // A blocked number, or a chat the academy marked personal, is never stored.
      const [hidden] = await db.select({ blockedAt: academyContactsTable.blockedAt, personalAt: academyContactsTable.personalAt })
        .from(academyContactsTable)
        .where(and(eq(academyContactsTable.academyId, academyId), eq(academyContactsTable.phone, phone)))
        .limit(1);
      if (hidden?.blockedAt || hidden?.personalAt) return;
    }
    if (fromMe && payload.source === "api") return; // Sent by Replay: stored already.

    const settings = await getWhatsappSettings(academyId);
    const kind = incomingKind(payload);
    let content: WhatsappContent | null = null;
    if (kind.type === "location") {
      const location = incomingLocation(payload);
      if (location) content = { type: "location", ...location };
    } else if (kind.type === "contact") {
      const contacts = incomingContacts(payload);
      if (contacts.length) content = { type: "contact", contacts };
    } else if (kind.type === "poll" && kind.poll) {
      content = { type: "poll", ...kind.poll };
    } else if (kind.type !== "text" && kind.type !== "poll") {
      const media = (payload.media ?? {}) as { url?: unknown; mimetype?: unknown; filename?: unknown };
      const placeholder: WaMedia = {
        path: "",
        mimetype: typeof media.mimetype === "string" ? media.mimetype : "application/octet-stream",
        filename: typeof media.filename === "string" ? media.filename : null,
        unavailable: true,
        pending: typeof media.url === "string",
      };
      const caption = body.trim() || null;
      content = kind.type === "image" ? { type: "image", media: placeholder, caption }
        : kind.type === "video" ? { type: "video", media: placeholder, caption, gif: kind.gif === true }
        : kind.type === "audio" ? { type: "audio", media: placeholder, voice: kind.voice === true }
        : kind.type === "sticker" ? { type: "sticker", media: placeholder }
        : { type: "document", media: placeholder, caption };
    }
    const text = (content ? summaryFor(content, settings.locale) : body).slice(0, 4000) || (payload.hasMedia ? "[media]" : "");
    if (!text) return;

    const [stored] = await db.insert(academyWhatsappMessagesTable).values({
      academyId,
      direction: fromMe ? "out" : "in",
      kind: fromMe ? "phone" : "reply",
      phone: chatKey,
      body: text,
      status: fromMe ? "sent" : "received",
      ...(fromMe ? { sentAt: new Date() } : {}),
      senderSession: session,
      waMessageId,
      content,
      authorPhone,
      authorName: isGroup && !fromMe ? pushName : null,
      replyToWaId: bareMessageId(typeof (payload.replyTo as { id?: unknown } | undefined)?.id === "string" ? String((payload.replyTo as { id: string }).id) : null),
    }).returning({ id: academyWhatsappMessagesTable.id });

    if (content && "media" in content && content.media.pending) {
      // WAHA keeps a received file for a few minutes only: copy it now.
      const kept = await keepIncomingMedia(academyId, String((payload.media as { url: string }).url), content.media);
      await db.update(academyWhatsappMessagesTable)
        .set({ content: { ...content, media: kept } as WhatsappContent })
        .where(eq(academyWhatsappMessagesTable.id, stored.id));
      content = { ...content, media: kept } as WhatsappContent;
    }

    if (fromMe || isGroup) return;
    const contact = await upsertContact(academyId, chatKey, { kind: "unknown", source: "whatsapp", name: pushName });

    const word = body.trim().toLowerCase().replace(/[.!؟?]+$/, "");
    if (!STOP_WORDS.has(word) && !START_WORDS.has(word)) {
      // A field's booking agent answers instead of the greeting and away replies.
      const agentAnswered = contact.kind === "staff" || contact.kind === "coach"
        ? false
        : await handleVenueInbound({ academyId, phone: chatKey, body, content, pushName }).catch((error) => {
          logger.warn({ academyId, error: (error as Error).message }, "Booking agent failed");
          return false;
        });
      if (!agentAnswered) {
        await autoReply(academyId, chatKey, stored.id, settings).catch((error) => logger.warn({ academyId, error: (error as Error).message }, "Auto-reply failed"));
      }
    }
    if (STOP_WORDS.has(word)) {
      await db.insert(academyWhatsappOptOutsTable).values({ academyId, phone: chatKey }).onConflictDoNothing();
      await enqueueMessages([{
        academyId,
        kind: "reply",
        phone: chatKey,
        body: settings.locale === "en"
          ? "You won't receive more messages from us. Reply START to subscribe again."
          : "تمام، ما رح توصلك رسائل منّا بعد هيك. ابعت تفعيل إذا بدك ترجع تستقبلها.",
      }]);
    } else if (START_WORDS.has(word)) {
      await db.delete(academyWhatsappOptOutsTable).where(and(
        eq(academyWhatsappOptOutsTable.academyId, academyId),
        eq(academyWhatsappOptOutsTable.phone, chatKey),
      ));
    }
  }
}

/** Greeting for a number's first message, and the "we're closed" reply, once per half-day. */
async function autoReply(academyId: number, phone: string, messageId: number, settings: WhatsappSettingsView): Promise<void> {
  if (!senderSessionFor(settings)) return;
  const options = parseChatOptions(settings.chatOptions, settings.locale);
  if (!options.greeting.enabled && !options.away.enabled) return;
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(academyWhatsappMessagesTable)
    .where(and(eq(academyWhatsappMessagesTable.academyId, academyId), eq(academyWhatsappMessagesTable.phone, phone), sql`${academyWhatsappMessagesTable.id} <> ${messageId}`));
  const now = new Date();
  const queue = (key: string, text: string) => enqueueMessages([{ academyId, kind: "auto_reply", phone, body: text, dedupeKey: key }]);
  if (options.greeting.enabled && n === 0) {
    await queue(`auto-greeting:${academyId}:${phone}`, options.greeting.text);
    return;
  }
  if (options.away.enabled && isClosed(options.away, now)) {
    await queue(`auto-away:${academyId}:${phone}:${Math.floor(now.getTime() / (12 * 3_600_000))}`, options.away.text);
  }
}

/** The bare id inside WAHA's "true_<chat>_<id>[_<participant>]". */
function targetId(value: unknown): string | null {
  return typeof value === "string" ? bareMessageId(value) : null;
}

async function handleReaction(session: string, payload: Record<string, unknown>): Promise<void> {
  const reaction = (payload.reaction ?? {}) as { text?: unknown; messageId?: unknown };
  const target = targetId(reaction.messageId);
  if (!target) return;
  const [message] = await db.select({ id: academyWhatsappMessagesTable.id, reactions: academyWhatsappMessagesTable.reactions, phone: academyWhatsappMessagesTable.phone })
    .from(academyWhatsappMessagesTable).where(eq(academyWhatsappMessagesTable.waMessageId, target)).limit(1);
  if (!message) return;
  let who = "me";
  let name: string | null = null;
  if (payload.fromMe !== true) {
    const from = [payload.participant, payload.from].find((v): v is string => typeof v === "string" && !v.endsWith("@g.us")) ?? "";
    who = (from ? await phoneForChat(session, from, payload, false) : null) ?? from.split("@")[0];
    name = typeof (payload._data as { pushName?: unknown } | undefined)?.pushName === "string" ? String((payload._data as { pushName: string }).pushName) : null;
  }
  if (!who) return;
  const next = { ...((message.reactions ?? {}) as Record<string, { emoji: string; name: string | null }>) };
  const emoji = typeof reaction.text === "string" ? reaction.text : "";
  if (emoji) next[who] = { emoji, name };
  else delete next[who];
  await db.update(academyWhatsappMessagesTable).set({ reactions: Object.keys(next).length ? next : null }).where(eq(academyWhatsappMessagesTable.id, message.id));
}

async function handleRevoked(payload: Record<string, unknown>): Promise<void> {
  const target = targetId(payload.revokedMessageId) ?? targetId((payload.before as { id?: unknown } | undefined)?.id);
  if (!target) return;
  await db.update(academyWhatsappMessagesTable)
    .set({ deletedAt: new Date(), body: "", content: null, reactions: null })
    .where(and(eq(academyWhatsappMessagesTable.waMessageId, target), isNull(academyWhatsappMessagesTable.deletedAt)));
}

async function handleEdited(payload: Record<string, unknown>): Promise<void> {
  const target = targetId(payload.editedMessageId);
  const body = typeof payload.body === "string" ? payload.body.slice(0, 4000) : "";
  if (!target || !body) return;
  await db.update(academyWhatsappMessagesTable)
    .set({ body, editedAt: new Date() })
    .where(and(eq(academyWhatsappMessagesTable.waMessageId, target), isNull(academyWhatsappMessagesTable.deletedAt)));
}

/** "typing…" for 8 seconds after WhatsApp says so; academies' own numbers only. */
async function handlePresence(session: string, payload: Record<string, unknown>): Promise<void> {
  const academyId = academyForSession(session);
  if (academyId === null) return;
  const chat = typeof payload.id === "string" ? payload.id : "";
  const presences = Array.isArray(payload.presences) ? (payload.presences as Array<{ lastKnownPresence?: unknown }>) : [];
  const active = presences.some((p) => p.lastKnownPresence === "typing" || p.lastKnownPresence === "recording");
  const until = active ? new Date(Date.now() + 8_000) : null;
  if (chat.endsWith("@g.us")) {
    await db.update(academyWhatsappGroupsTable).set({ typingUntil: until })
      .where(and(eq(academyWhatsappGroupsTable.academyId, academyId), eq(academyWhatsappGroupsTable.groupId, chat.slice(0, -5))));
    return;
  }
  const phone = await phoneForChat(session, chat, payload, false);
  if (!phone) return;
  await db.update(academyContactsTable).set({ typingUntil: until })
    .where(and(eq(academyContactsTable.academyId, academyId), eq(academyContactsTable.phone, phone)));
}

/** A call WhatsApp can't answer: note it in the chat and, if the academy wants, reply once an hour. */
async function handleMissedCall(session: string, payload: Record<string, unknown>): Promise<void> {
  if (payload.isGroup === true) return;
  const from = typeof payload.from === "string" ? payload.from : "";
  if (!from || from.endsWith("@g.us")) return;
  const phone = await phoneForChat(session, from, payload, false);
  if (!phone) return;
  let academyId = academyForSession(session);
  if (academyId === null && session === REPLAY_SESSION) academyId = await academyForReplayNumber(phone);
  if (academyId === null) return;
  const [hidden] = await db.select({ blockedAt: academyContactsTable.blockedAt, personalAt: academyContactsTable.personalAt }).from(academyContactsTable)
    .where(and(eq(academyContactsTable.academyId, academyId), eq(academyContactsTable.phone, phone))).limit(1);
  if (hidden?.blockedAt || hidden?.personalAt) return;
  const callId = typeof payload.id === "string" ? payload.id : `${phone}:${Date.now()}`;
  const settings = await getWhatsappSettings(academyId);
  const video = payload.isVideo === true;
  const [stored] = await db.insert(academyWhatsappMessagesTable).values({
    academyId, direction: "in", kind: "call", phone, status: "received", senderSession: session,
    body: settings.locale === "en" ? (video ? "📹 Missed video call" : "📞 Missed call") : (video ? "📹 مكالمة فيديو فائتة" : "📞 مكالمة فائتة"),
    waMessageId: `call-${callId}`,
  }).returning({ id: academyWhatsappMessagesTable.id }).catch(() => []);
  if (!stored) return;
  await upsertContact(academyId, phone, { kind: "unknown", source: "whatsapp", name: null });
  const options = parseChatOptions(settings.chatOptions, settings.locale);
  if (options.missedCall.enabled && senderSessionFor(settings)) {
    await enqueueMessages([{ academyId, kind: "auto_reply", phone, body: options.missedCall.text, dedupeKey: `auto-call:${academyId}:${phone}:${Math.floor(Date.now() / 3_600_000)}` }]);
  }
}

async function keepIncomingMedia(academyId: number, url: string, placeholder: WaMedia): Promise<WaMedia> {
  try {
    const file = await downloadWahaFile(url, MAX_CHAT_MEDIA_BYTES);
    if (!file) return { ...placeholder, pending: false };
    const mimetype = placeholder.mimetype !== "application/octet-stream" ? placeholder.mimetype : file.mimetype;
    return await storeChatMedia(academyId, file.buffer, mimetype, placeholder.filename);
  } catch (error) {
    logger.warn({ academyId, error: (error as Error).message }, "Keeping a WhatsApp file failed");
    return { ...placeholder, pending: false };
  }
}

/** The academy that follows this group on this WhatsApp number, if any. */
async function followedGroup(session: string, groupId: string): Promise<{ academyId: number } | null> {
  const own = academyForSession(session);
  const rows = await db.select({ academyId: academyWhatsappGroupsTable.academyId }).from(academyWhatsappGroupsTable)
    .where(and(eq(academyWhatsappGroupsTable.groupId, groupId), eq(academyWhatsappGroupsTable.session, session)))
    .limit(2);
  if (own !== null) return rows.find((r) => r.academyId === own) ?? null;
  return rows[0] ?? null;
}

/**
 * Who a message to Replay's shared number is for, when it didn't come from an ad: the academy
 * that last wrote to this phone from Replay's number, else the one academy that has the number
 * in People as someone it knows (a parent, player, coach, staff or lead). Anyone else stays
 * out, so personal chats on that phone never reach an academy.
 */
export async function academyForReplayNumber(phone: string): Promise<number | null> {
  const [last] = await db
    .select({ academyId: academyWhatsappMessagesTable.academyId })
    .from(academyWhatsappMessagesTable)
    .where(and(
      eq(academyWhatsappMessagesTable.phone, phone),
      eq(academyWhatsappMessagesTable.direction, "out"),
      eq(academyWhatsappMessagesTable.senderSession, REPLAY_SESSION),
    ))
    .orderBy(sql`${academyWhatsappMessagesTable.createdAt} desc`)
    .limit(1);
  if (last) return last.academyId;
  const known = await db.selectDistinct({ academyId: academyContactsTable.academyId }).from(academyContactsTable)
    .innerJoin(academyWhatsappSettingsTable, eq(academyWhatsappSettingsTable.academyId, academyContactsTable.academyId))
    .where(and(
      eq(academyContactsTable.phone, phone),
      inArray(academyContactsTable.kind, ["parent", "player", "coach", "staff", "lead"]),
      eq(academyWhatsappSettingsTable.sender, "replay"),
    ))
    .limit(2);
  return known.length === 1 ? known[0].academyId : null;
}

/** A vote on a poll an academy sent. A changed vote replaces the old one; an empty one removes it. */
async function handlePollVote(session: string, payload: Record<string, unknown>): Promise<void> {
  const vote = (payload.vote ?? {}) as { from?: unknown; participant?: unknown; fromMe?: unknown; selectedOptions?: unknown; timestamp?: unknown };
  const poll = (payload.poll ?? {}) as { id?: unknown };
  const pollId = bareMessageId(typeof poll.id === "string" ? poll.id : null);
  if (!pollId) return;
  const [message] = await db.select({ id: academyWhatsappMessagesTable.id, academyId: academyWhatsappMessagesTable.academyId })
    .from(academyWhatsappMessagesTable)
    .where(eq(academyWhatsappMessagesTable.waMessageId, pollId))
    .limit(1);
  if (!message) return;
  let voterPhone: string | null;
  if (vote.fromMe === true) {
    voterPhone = "me";
  } else {
    const who = [vote.participant, vote.from].find((v): v is string => typeof v === "string" && !v.endsWith("@g.us")) ?? "";
    voterPhone = who ? await phoneForChat(session, who, payload, false) : null;
    voterPhone ??= who ? who.split("@")[0] : null;
  }
  if (!voterPhone) return;
  const options = Array.isArray(vote.selectedOptions) ? vote.selectedOptions.map(String).filter(Boolean).slice(0, 12) : [];
  if (options.length === 0) {
    await db.delete(academyWhatsappPollVotesTable).where(and(
      eq(academyWhatsappPollVotesTable.messageId, message.id),
      eq(academyWhatsappPollVotesTable.voterPhone, voterPhone),
    ));
    return;
  }
  const [contact] = voterPhone === "me" ? [] : await db.select({ name: academyContactsTable.name }).from(academyContactsTable)
    .where(and(eq(academyContactsTable.academyId, message.academyId), eq(academyContactsTable.phone, voterPhone))).limit(1);
  const seconds = Number(vote.timestamp);
  const votedAt = Number.isFinite(seconds) && seconds > 0 ? new Date(seconds < 1e12 ? seconds * 1000 : seconds) : new Date();
  await db.insert(academyWhatsappPollVotesTable)
    .values({ messageId: message.id, voterPhone, voterName: contact?.name ?? null, options, votedAt })
    .onConflictDoUpdate({
      target: [academyWhatsappPollVotesTable.messageId, academyWhatsappPollVotesTable.voterPhone],
      set: { options, votedAt, voterName: contact?.name ?? null },
    });
}

/**
 * Send one queued message right away (a chat reply should not wait for the next
 * minute's tick). Leaves it queued for the tick when the number isn't connected.
 */
export async function dispatchMessageNow(messageId: number): Promise<"sent" | "queued" | "failed"> {
  if (!wahaConfigured()) return "queued";
  const [message] = await db
    .select({ academyId: academyWhatsappMessagesTable.academyId })
    .from(academyWhatsappMessagesTable)
    .where(eq(academyWhatsappMessagesTable.id, messageId));
  if (!message) return "failed";
  const settings = await getWhatsappSettings(message.academyId);
  const session = senderSessionFor(settings);
  if (!session) return "queued";
  try {
    if ((await getSession(session))?.status !== "WORKING") return "queued";
  } catch {
    return "queued";
  }
  const result = await db.execute(sql`
    update academy_whatsapp_messages
    set status = 'sending', attempts = attempts + 1, claimed_at = now(), sender_session = ${session}
    where id = ${messageId} and status = 'queued'
    returning id, academy_id, phone, body, attempts, kind, content, reply_to_wa_id, mentions
  `);
  const row = ((result as unknown as { rows: ClaimedRow[] }).rows ?? [])[0];
  if (!row) return "queued";
  const [academy] = await db.select({ name: academiesTable.name }).from(academiesTable).where(eq(academiesTable.id, row.academy_id));
  try {
    const waId = await deliver(session, row, academy?.name ?? null);
    await finish(row.id, { status: "sent", sentAt: new Date(), waMessageId: bareMessageId(waId), error: null });
    return "sent";
  } catch (error) {
    const final = deliveryFailure(error);
    if (final) {
      await finish(row.id, { status: "failed", error: final });
      return "failed";
    }
    const transient = error instanceof WahaError ? error.transient : true;
    const message = (error as Error).message?.slice(0, 500) ?? "Send failed";
    if (transient && row.attempts < MAX_ATTEMPTS) {
      await finish(row.id, { status: "queued", error: message });
      return "queued";
    }
    await finish(row.id, { status: "failed", error: message });
    return "failed";
  }
}
