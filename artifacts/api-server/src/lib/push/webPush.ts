/**
 * Notifications on console users' phones and computers (Web Push), for new chat messages
 * (Mohammed, 2026-11-05: "enable notifications for field owners and academy owners for chats").
 *
 * A device subscribes from the console's Chats ("Notify me on this device"); the service
 * worker (public/video-cache-sw.js) shows the notification and opens the chat when tapped.
 * Who is told about a message:
 *   - a chat handed to someone (assigned): that person only;
 *   - otherwise everyone who can see the academy's or field's Chats (owners, and the managers
 *     and coaches the owner shows Chats to);
 *   - never for a muted chat, a group, or a message the academy sent.
 * One push per chat per COALESCE_MS: a burst of messages is one buzz, and the notification
 * (tagged by chat) shows the latest.
 *
 * Keys: VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY when set, else a pair made once and kept in
 * web_push_keys. iPhones get pushes only from the app added to the Home Screen (iOS 16.4+).
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import webpush from "web-push";
import { academiesTable, academyMembersTable, db, pushSubscriptionsTable, webPushKeysTable } from "@workspace/db";
import { logger } from "../logger";
import { loadAccess, primaryRole, staffAccess } from "../academyPermissions";

export const COALESCE_MS = 45_000;
const FAILURES_BEFORE_DROP = 5;
const SUBJECT = "mailto:hello@replayjo.com";

let keysPromise: Promise<{ publicKey: string; privateKey: string }> | null = null;

/** The VAPID pair: the environment's, else the stored one, else a new one stored now. */
export function vapidKeys(): Promise<{ publicKey: string; privateKey: string }> {
  if (!keysPromise) {
    keysPromise = (async () => {
      const envPublic = process.env.VAPID_PUBLIC_KEY?.trim();
      const envPrivate = process.env.VAPID_PRIVATE_KEY?.trim();
      if (envPublic && envPrivate) return { publicKey: envPublic, privateKey: envPrivate };
      const [stored] = await db.select().from(webPushKeysTable).where(eq(webPushKeysTable.id, 1));
      if (stored) return { publicKey: stored.publicKey, privateKey: stored.privateKey };
      const made = webpush.generateVAPIDKeys();
      await db.insert(webPushKeysTable).values({ id: 1, publicKey: made.publicKey, privateKey: made.privateKey }).onConflictDoNothing();
      // Two servers starting together: the first pair stored wins.
      const [kept] = await db.select().from(webPushKeysTable).where(eq(webPushKeysTable.id, 1));
      return { publicKey: kept.publicKey, privateKey: kept.privateKey };
    })().catch((error) => { keysPromise = null; throw error; });
  }
  return keysPromise;
}

/** For tests. */
export function forgetVapidKeys(): void {
  keysPromise = null;
}

export type PushPayload = {
  title: string;
  body: string;
  /** Opened when the notification is tapped (a path on this site). */
  url: string;
  /** Notifications with the same tag replace each other (one per chat). */
  tag: string;
};

type Sender = (sub: { endpoint: string; keys: { p256dh: string; auth: string } }, payload: string, options: webpush.RequestOptions) => Promise<{ statusCode: number }>;
let send: Sender = (sub, payload, options) => webpush.sendNotification(sub, payload, options);
/** For tests: capture pushes instead of sending them. */
export function setPushSender(next: Sender | null): void {
  send = next ?? ((sub, payload, options) => webpush.sendNotification(sub, payload, options));
}

/** Push to every device of these people. Gone subscriptions are deleted. Returns pushes delivered. */
export async function pushToUsers(userIds: number[], payload: PushPayload): Promise<number> {
  if (!userIds.length) return 0;
  const subs = await db.select().from(pushSubscriptionsTable).where(inArray(pushSubscriptionsTable.userId, [...new Set(userIds)]));
  if (!subs.length) return 0;
  const keys = await vapidKeys();
  const body = JSON.stringify(payload);
  let delivered = 0;
  await Promise.all(subs.map(async (s) => {
    try {
      await send({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body, {
        vapidDetails: { subject: SUBJECT, publicKey: keys.publicKey, privateKey: keys.privateKey },
        TTL: 60 * 60,
        urgency: "high",
        topic: payload.tag.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || undefined,
        timeout: 10_000,
      });
      delivered += 1;
      await db.update(pushSubscriptionsTable).set({ failures: 0, lastSentAt: new Date() }).where(eq(pushSubscriptionsTable.id, s.id));
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) {
        await db.delete(pushSubscriptionsTable).where(eq(pushSubscriptionsTable.id, s.id));
        return;
      }
      const [row] = await db.update(pushSubscriptionsTable).set({ failures: sql`${pushSubscriptionsTable.failures} + 1` })
        .where(eq(pushSubscriptionsTable.id, s.id)).returning({ failures: pushSubscriptionsTable.failures });
      if (row && row.failures >= FAILURES_BEFORE_DROP) await db.delete(pushSubscriptionsTable).where(eq(pushSubscriptionsTable.id, s.id));
      logger.warn({ subscriptionId: s.id, status, error: (error as Error).message }, "Push failed");
    }
  }));
  return delivered;
}

/** Everyone who sees this academy's or field's Chats. */
export async function chatWatchers(academyId: number): Promise<number[]> {
  const members = await db.select({ userId: academyMembersTable.userId, role: academyMembersTable.role })
    .from(academyMembersTable).where(eq(academyMembersTable.academyId, academyId));
  if (!members.length) return [];
  const access = await loadAccess(academyId);
  const byUser = new Map<number, Array<"owner" | "manager" | "coach">>();
  for (const m of members) byUser.set(m.userId, [...(byUser.get(m.userId) ?? []), m.role]);
  const out: number[] = [];
  for (const [userId, roles] of byUser) {
    const role = primaryRole(roles);
    if (role && staffAccess(role, access).sections.includes("chats")) out.push(userId);
  }
  return out;
}

const lastPush = new Map<string, number>();

/** For tests. */
export function forgetChatPushes(): void {
  lastPush.clear();
}

export type ChatPush = {
  academyId: number;
  channel: "whatsapp" | "instagram" | "messenger";
  /** The chat: a phone for WhatsApp, a thread id for Instagram and Messenger. */
  chatKey: string;
  /** Who wrote: their name, else their number or username. */
  from: string;
  preview: string;
  muted?: boolean;
  assignedUserId?: number | null;
};

/** A new message in one of the academy's chats: tell the people who answer it. Never throws. */
export async function notifyChatMessage(m: ChatPush, now = Date.now()): Promise<number> {
  try {
    if (m.muted) return 0;
    const key = `${m.academyId}:${m.channel}:${m.chatKey}`;
    const last = lastPush.get(key);
    if (last !== undefined && now - last < COALESCE_MS) return 0;
    lastPush.set(key, now);
    if (lastPush.size > 5000) lastPush.delete(lastPush.keys().next().value!);
    const watchers = await chatWatchers(m.academyId);
    const to = m.assignedUserId && watchers.includes(m.assignedUserId) ? [m.assignedUserId] : watchers;
    if (!to.length) return 0;
    const [academy] = await db.select({ name: academiesTable.name, kind: academiesTable.kind }).from(academiesTable).where(eq(academiesTable.id, m.academyId));
    const area = academy?.kind === "venue" ? "field" : "academy";
    const chat = m.channel === "whatsapp" ? `phone=${encodeURIComponent(m.chatKey)}` : `thread=${encodeURIComponent(m.chatKey)}`;
    const icon = m.channel === "instagram" ? "📷 " : m.channel === "messenger" ? "💬 " : "";
    return await pushToUsers(to, {
      title: `${icon}${m.from}${academy?.name ? ` · ${academy.name}` : ""}`,
      body: m.preview.replace(/\s+/g, " ").trim().slice(0, 180) || "New message",
      url: `/${area}/chats?a=${m.academyId}&${chat}`,
      tag: `chat-${m.academyId}-${m.channel}-${m.chatKey}`,
    });
  } catch (error) {
    logger.warn({ academyId: m.academyId, error: (error as Error).message }, "Chat notification failed");
    return 0;
  }
}

/** This device's subscription, kept for this person (a device moves to whoever subscribed last). */
export async function saveSubscription(userId: number, sub: { endpoint: string; p256dh: string; auth: string }, userAgent: string | null): Promise<void> {
  await db.insert(pushSubscriptionsTable).values({ userId, endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth, userAgent })
    .onConflictDoUpdate({ target: pushSubscriptionsTable.endpoint, set: { userId, p256dh: sub.p256dh, auth: sub.auth, userAgent, failures: 0 } });
}

export async function deleteSubscription(userId: number, endpoint: string): Promise<boolean> {
  const rows = await db.delete(pushSubscriptionsTable)
    .where(and(eq(pushSubscriptionsTable.userId, userId), eq(pushSubscriptionsTable.endpoint, endpoint))).returning({ id: pushSubscriptionsTable.id });
  return rows.length > 0;
}

export async function hasSubscription(userId: number, endpoint: string): Promise<boolean> {
  const [row] = await db.select({ id: pushSubscriptionsTable.id }).from(pushSubscriptionsTable)
    .where(and(eq(pushSubscriptionsTable.userId, userId), eq(pushSubscriptionsTable.endpoint, endpoint)));
  return !!row;
}
