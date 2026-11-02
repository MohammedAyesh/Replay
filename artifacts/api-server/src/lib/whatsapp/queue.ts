import { and, eq, inArray, lte, sql } from "drizzle-orm";
import {
  academiesTable,
  academyWhatsappMessagesTable,
  academyWhatsappOptOutsTable,
  academyWhatsappSettingsTable,
  db,
  type AcademyWhatsappSettings,
} from "@workspace/db";
import { logger } from "../logger";
import { upsertContact } from "./contacts";
import { phoneFromChatId } from "./phone";
import type { WhatsappLocale } from "./templates";
import {
  REPLAY_SESSION,
  WahaError,
  academyIdFromSessionName,
  academySessionName,
  bareMessageId,
  checkNumber,
  getSession,
  sendText,
  wahaConfigured,
} from "./waha";

export type WhatsappSender = "own" | "replay" | "off";

export type WhatsappSettingsView = {
  academyId: number;
  sender: WhatsappSender;
  locale: WhatsappLocale;
  dailyLimit: number;
  automations: unknown;
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
  patch: Partial<Pick<AcademyWhatsappSettings, "sender" | "locale" | "dailyLimit" | "automations" | "sessionStatus" | "connectedPhone" | "connectedName">>,
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

type ClaimedRow = { id: number; academy_id: number; phone: string; body: string; attempts: number; kind: string };

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
    returning id, academy_id, phone, body, attempts, kind
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
    let open = academyIds.filter((id) => (sentToday.get(id) ?? 0) < (limits.get(id) ?? 300));
    let sentThisTick = 0;

    while (open.length > 0 && sentThisTick < PER_SESSION_PER_TICK && Date.now() < deadline - 8_000) {
      if (session === REPLAY_SESSION && sessionSentToday >= REPLAY_DAILY_LIMIT) break;
      const row = await claimNext(open, session);
      if (!row) break;
      const academyId = row.academy_id;
      if (!optOuts.has(academyId)) optOuts.set(academyId, await optedOutPhones(academyId));
      if (row.kind !== "reply" && row.kind !== "chat" && optOuts.get(academyId)!.has(row.phone)) {
        await finish(row.id, { status: "skipped", error: "Recipient replied STOP" });
        summary.skipped += 1;
        continue;
      }
      const text = session === REPLAY_SESSION
        ? `*${academyNames.get(academyId) ?? ""}*\n${row.body}`.trim()
        : row.body;
      try {
        const chatId = await checkNumber(session, row.phone);
        if (!chatId) {
          await finish(row.id, { status: "failed", error: "This number is not on WhatsApp" });
          summary.failed += 1;
          continue;
        }
        const waId = await sendText(session, chatId, text);
        await finish(row.id, { status: "sent", sentAt: new Date(), waMessageId: bareMessageId(waId), error: null });
        summary.sent += 1;
        sentThisTick += 1;
        sessionSentToday += 1;
        const count = (sentToday.get(academyId) ?? 0) + 1;
        sentToday.set(academyId, count);
        if (count >= (limits.get(academyId) ?? 300)) open = open.filter((id) => id !== academyId);
        await sleep(jitter());
      } catch (error) {
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

  if (event.event === "message" || event.event === "message.any") {
    const from = typeof payload.from === "string" ? payload.from : "";
    const to = typeof payload.to === "string" ? payload.to : "";
    const fromMe = payload.fromMe === true;
    const other = fromMe ? to : from;
    if (other.endsWith("@g.us") || other.includes("status@broadcast") || other.endsWith("@newsletter")) return;
    const phone = phoneFromChatId(other);
    if (!phone) return;
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

    // Which academy is this for? Own number → that academy. Replay's number →
    // the academy that last messaged this phone from it.
    let academyId = academyForSession(session);
    if (academyId === null && session === REPLAY_SESSION) {
      if (fromMe) return;
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
      academyId = last?.academyId ?? null;
    }
    if (academyId === null) return;
    const text = body.slice(0, 4000) || (payload.hasMedia ? "[media]" : "");

    if (fromMe) {
      // Typed on the academy's phone itself; messages the app sent are stored already.
      if (payload.source === "api") return;
      await db.insert(academyWhatsappMessagesTable).values({
        academyId,
        direction: "out",
        kind: "phone",
        phone,
        body: text,
        status: "sent",
        sentAt: new Date(),
        senderSession: session,
        waMessageId,
      });
      return;
    }

    await db.insert(academyWhatsappMessagesTable).values({
      academyId,
      direction: "in",
      kind: "reply",
      phone,
      body: text,
      status: "received",
      senderSession: session,
      waMessageId,
    });
    const pushName = typeof (payload._data as { pushName?: unknown } | undefined)?.pushName === "string"
      ? String((payload._data as { pushName: string }).pushName)
      : typeof (payload as { notifyName?: unknown }).notifyName === "string" ? String((payload as { notifyName: string }).notifyName) : null;
    await upsertContact(academyId, phone, { kind: "unknown", source: "whatsapp", name: pushName });

    const word = body.trim().toLowerCase().replace(/[.!؟?]+$/, "");
    const settings = await getWhatsappSettings(academyId);
    if (STOP_WORDS.has(word)) {
      await db.insert(academyWhatsappOptOutsTable).values({ academyId, phone }).onConflictDoNothing();
      await enqueueMessages([{
        academyId,
        kind: "reply",
        phone,
        body: settings.locale === "en"
          ? "You won't receive more messages from us. Reply START to subscribe again."
          : "تمام، ما رح توصلك رسائل منّا بعد هيك. ابعت تفعيل إذا بدك ترجع تستقبلها.",
      }]);
    } else if (START_WORDS.has(word)) {
      await db.delete(academyWhatsappOptOutsTable).where(and(
        eq(academyWhatsappOptOutsTable.academyId, academyId),
        eq(academyWhatsappOptOutsTable.phone, phone),
      ));
    }
  }
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
    returning id, academy_id, phone, body, attempts, kind
  `);
  const row = ((result as unknown as { rows: ClaimedRow[] }).rows ?? [])[0];
  if (!row) return "queued";
  let text = row.body;
  if (session === REPLAY_SESSION) {
    const [academy] = await db.select({ name: academiesTable.name }).from(academiesTable).where(eq(academiesTable.id, row.academy_id));
    text = `*${academy?.name ?? ""}*\n${row.body}`.trim();
  }
  try {
    const chatId = await checkNumber(session, row.phone);
    if (!chatId) {
      await finish(row.id, { status: "failed", error: "This number is not on WhatsApp" });
      return "failed";
    }
    const waId = await sendText(session, chatId, text);
    await finish(row.id, { status: "sent", sentAt: new Date(), waMessageId: bareMessageId(waId), error: null });
    return "sent";
  } catch (error) {
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
