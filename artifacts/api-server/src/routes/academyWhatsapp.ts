import { createHmac, timingSafeEqual } from "node:crypto";
import { and, desc, eq, gte, inArray, isNotNull, or, sql } from "drizzle-orm";
import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import {
  academiesTable,
  academyContactPlayersTable,
  academyContactsTable,
  academyMembersTable,
  academyPlayersTable,
  academySquadsTable,
  academyWhatsappBroadcastsTable,
  academyWhatsappGroupsTable,
  academyWhatsappMessagesTable,
  academyWhatsappPollVotesTable,
  academyWhatsappOptOutsTable,
  academyWhatsappSettingsTable,
  db,
  usersTable,
} from "@workspace/db";
import {
  requireAcademyConsoleUser,
  requireAcademyMembership,
  type AcademyConsoleUser,
} from "../lib/academyAccess";
import { logger } from "../lib/logger";
import { staffAccessFor } from "../lib/academyPermissions";
import { runScheduledAutomations } from "../lib/whatsapp/automations";
import { maybePrepareRecentClips } from "../lib/featured/sweep";
import { maybeSyncMetaAds } from "../lib/meta/sync";
import { maybeRunSocial } from "../lib/social/posts";
import {
  linkContactToPlayer,
  linksForContacts,
  listContacts,
  syncAcademyContacts,
  upsertContact,
  type ContactKind,
  type LeadStage,
  type Relationship,
} from "../lib/whatsapp/contacts";
import { chatKeyFromParam, formatPhoneForDisplay, groupIdFromKey, groupKey, isGroupKey, normalizePhone, phoneFromChatId } from "../lib/whatsapp/phone";
import { MAX_CHAT_MEDIA_BYTES, gifToMp4, mentionedPhones, mediaUrl, storeChatMedia, summaryFor, type WaMedia, type WhatsappContent } from "../lib/whatsapp/media";
import { parseChatOptions } from "../lib/whatsapp/chatOptions";
import {
  dispatchMessageNow,
  dispatchQueue,
  enqueueMessages,
  getWhatsappSettings,
  handleWahaWebhook,
  blockedPhones,
  optedOutPhones,
  saveWhatsappSettings,
  senderSessionFor,
} from "../lib/whatsapp/queue";
import { joinNames, mergeByPhone, resolveAudience } from "../lib/whatsapp/recipients";
import {
  AUTOMATIONS,
  automationDefinition,
  effectiveAutomations,
  renderTemplate,
  type StoredAutomation,
} from "../lib/whatsapp/templates";
import {
  REPLAY_SESSION,
  WahaError,
  academySessionName,
  addGroupParticipants,
  checkNumber,
  createGroup,
  listGroups,
  refreshWebhookEvents,
  fetchImageBytes,
  getPictureUrl,
  sendSeen,
  serializedMessageId,
  subscribePresence,
  ensureSessionStarted,
  getQrDataUrl,
  getSession,
  listSessions,
  logoutSession,
  requestPairingCode,
  wahaConfigured,
  wahaVersion,
  wahaWebhookSecret,
  whatsappTickKey,
  type WahaSession,
} from "../lib/whatsapp/waha";

import { runVenueTick } from "../lib/venues/store";
const router: IRouter = Router();

export function rawParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

export function intParam(value: string | string[] | undefined): number | null {
  const n = Number(rawParam(value));
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export function wahaFailure(res: Response, error: unknown, fallback: string) {
  if (error instanceof WahaError) {
    const status = error.status === 503 ? 503 : error.status === 404 ? 404 : 502;
    res.status(status).json({ error: error.status === 503 ? "WhatsApp service is not set up yet" : error.message || fallback });
    return;
  }
  logger.warn({ error: (error as Error)?.message }, fallback);
  res.status(500).json({ error: fallback });
}

export type Access = { user: AcademyConsoleUser; isOwner: boolean; academyId: number; academyName: string };

export async function academyAccess(req: Request, res: Response, ownerOnly = false): Promise<Access | null> {
  const user = await requireAcademyConsoleUser(req, res);
  if (!user) return null;
  const academyId = intParam(req.params.academyId);
  if (!academyId) {
    res.status(400).json({ error: "Invalid academy id" });
    return null;
  }
  const roles = await requireAcademyMembership(user.id, academyId, res);
  if (!roles) return null;
  const isOwner = roles.includes("owner");
  if (ownerOnly && !isOwner) {
    res.status(403).json({ error: "Academy owner role required" });
    return null;
  }
  const [academy] = await db.select({ name: academiesTable.name }).from(academiesTable).where(eq(academiesTable.id, academyId));
  if (!academy) {
    res.status(404).json({ error: "Academy not found" });
    return null;
  }
  return { user, isOwner, academyId, academyName: academy.name };
}

async function sessionOrNull(name: string): Promise<{ session: WahaSession | null; reachable: boolean }> {
  if (!wahaConfigured()) return { session: null, reachable: false };
  try {
    return { session: await getSession(name), reachable: true };
  } catch {
    return { session: null, reachable: false };
  }
}

function sessionView(session: WahaSession | null) {
  const phone = phoneFromChatId(session?.me?.id ?? null);
  return {
    status: session?.status ?? "NOT_CREATED",
    phone: phone ? formatPhoneForDisplay(phone) : null,
    name: session?.me?.pushName ?? null,
  };
}

const WAIT_FOR_QR_MS = 15_000;

/** Start (or refresh) a WAHA session and, for a pairing code, wait until WhatsApp accepts one. */
async function connectSession(
  name: string,
  metadata: Record<string, string>,
  method: "qr" | "code",
  phone: string | null,
): Promise<{ status: string; code: string | null }> {
  let session = await ensureSessionStarted(name, metadata);
  if (session.status === "WORKING") return { status: session.status, code: null };
  if (method === "qr") return { status: session.status, code: null };
  const deadline = Date.now() + WAIT_FOR_QR_MS;
  while (session.status !== "SCAN_QR_CODE" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    session = (await getSession(name)) ?? session;
    if (session.status === "WORKING") return { status: session.status, code: null };
  }
  if (session.status !== "SCAN_QR_CODE") throw new WahaError(504, "WhatsApp took too long to start. Try again.", true);
  const code = await requestPairingCode(name, phone!);
  return { status: session.status, code };
}

const ConnectBody = z.object({
  method: z.enum(["qr", "code"]).default("qr"),
  phone: z.string().max(40).optional().nullable(),
});

function parseConnect(req: Request, res: Response): { method: "qr" | "code"; phone: string | null } | null {
  const body = ConnectBody.safeParse(req.body ?? {});
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return null;
  }
  const phone = body.data.method === "code" ? normalizePhone(body.data.phone) : null;
  if (body.data.method === "code" && !phone) {
    res.status(400).json({ error: "Enter the WhatsApp number you want to link, e.g. 0791234567" });
    return null;
  }
  return { method: body.data.method, phone };
}

// ─── Academy console ─────────────────────────────────────────────────────────

async function academyStats(academyId: number) {
  const result = await db.execute(sql`
    select
      count(*) filter (where status in ('sent','delivered','read')
        and sent_at >= (date_trunc('day', now() at time zone 'Asia/Amman') at time zone 'Asia/Amman'))::int as "sentToday",
      count(*) filter (where status in ('queued','sending'))::int as "queued",
      count(*) filter (where status = 'failed' and created_at >= now() - interval '7 days')::int as "failed7d",
      count(*) filter (where status in ('sent','delivered','read') and sent_at >= now() - interval '7 days')::int as "sent7d",
      count(*) filter (where status in ('delivered','read') and sent_at >= now() - interval '7 days')::int as "delivered7d",
      count(*) filter (where status = 'read' and sent_at >= now() - interval '7 days')::int as "read7d",
      count(*) filter (where direction = 'in' and created_at >= now() - interval '7 days')::int as "replies7d"
    from academy_whatsapp_messages where academy_id = ${academyId}
  `);
  const row = ((result as unknown as { rows: Array<Record<string, number>> }).rows ?? [])[0] ?? {};
  const [{ optOuts }] = await db
    .select({ optOuts: sql<number>`count(*)::int` })
    .from(academyWhatsappOptOutsTable)
    .where(eq(academyWhatsappOptOutsTable.academyId, academyId));
  return {
    sentToday: row.sentToday ?? 0,
    queued: row.queued ?? 0,
    failed7d: row.failed7d ?? 0,
    sent7d: row.sent7d ?? 0,
    delivered7d: row.delivered7d ?? 0,
    read7d: row.read7d ?? 0,
    replies7d: row.replies7d ?? 0,
    optOuts,
  };
}

function automationsView(stored: unknown, locale: "ar" | "en") {
  const effective = effectiveAutomations(stored, locale);
  return AUTOMATIONS.map((def) => ({
    ...effective[def.key],
    allowedAudiences: def.allowedAudiences,
    timingRule: def.timing,
    placeholders: def.placeholders,
    defaultTemplate: def.template[locale],
  }));
}

router.get("/academy/console/academies/:academyId/whatsapp", async (req, res): Promise<void> => {
  const access = await academyAccess(req, res);
  if (!access) return;
  const settings = await getWhatsappSettings(access.academyId);
  const own = await sessionOrNull(academySessionName(access.academyId));
  const replay = await sessionOrNull(REPLAY_SESSION);

  // Keep the stored status honest when the webhook was missed.
  if (own.reachable) {
    const live = own.session?.status ?? null;
    const phone = phoneFromChatId(own.session?.me?.id ?? null);
    if (live !== settings.sessionStatus || (live === "WORKING" && phone !== settings.connectedPhone)) {
      await saveWhatsappSettings(access.academyId, {
        sessionStatus: live,
        ...(live === "WORKING" ? { connectedPhone: phone, connectedName: own.session?.me?.pushName ?? null } : {}),
      });
    }
  }

  const [squads, players] = await Promise.all([
    db.select({ id: academySquadsTable.id, name: academySquadsTable.name })
      .from(academySquadsTable)
      .where(eq(academySquadsTable.academyId, access.academyId))
      .orderBy(academySquadsTable.name),
    db.select({ id: academyPlayersTable.id, name: academyPlayersTable.name, squadId: academyPlayersTable.squadId })
      .from(academyPlayersTable)
      .where(and(eq(academyPlayersTable.academyId, access.academyId), eq(academyPlayersTable.isActive, true)))
      .orderBy(academyPlayersTable.name),
  ]);

  res.json({
    academyId: access.academyId,
    academyName: access.academyName,
    role: access.isOwner ? "owner" : "coach",
    configured: wahaConfigured(),
    serviceReachable: own.reachable,
    sender: settings.sender,
    locale: settings.locale,
    dailyLimit: settings.dailyLimit,
    own: own.reachable
      ? sessionView(own.session)
      : {
        status: settings.sessionStatus ?? "NOT_CREATED",
        phone: settings.connectedPhone ? formatPhoneForDisplay(settings.connectedPhone) : null,
        name: settings.connectedName,
      },
    replay: { available: replay.session?.status === "WORKING", ...sessionView(replay.session) },
    automations: automationsView(settings.automations, settings.locale),
    stats: await academyStats(access.academyId),
    squads,
    players,
  });
});

const SettingsBody = z.object({
  sender: z.enum(["own", "replay", "off"]).optional(),
  locale: z.enum(["ar", "en"]).optional(),
  dailyLimit: z.number().int().min(1).max(5000).optional(),
});

router.put("/academy/console/academies/:academyId/whatsapp/settings", async (req, res): Promise<void> => {
  const access = await academyAccess(req, res, true);
  if (!access) return;
  const body = SettingsBody.safeParse(req.body ?? {});
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const saved = await saveWhatsappSettings(access.academyId, body.data);
  res.json({ sender: saved.sender, locale: saved.locale, dailyLimit: saved.dailyLimit });
});

const AutomationBody = z.object({
  key: z.string(),
  enabled: z.boolean().optional(),
  audiences: z.array(z.enum(["parents", "players", "coaches"])).optional(),
  template: z.string().max(3000).nullable().optional(),
  timing: z.number().int().min(0).max(720).nullable().optional(),
});

router.put("/academy/console/academies/:academyId/whatsapp/automations", async (req, res): Promise<void> => {
  const access = await academyAccess(req, res, true);
  if (!access) return;
  const body = AutomationBody.safeParse(req.body ?? {});
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const def = automationDefinition(body.data.key);
  if (!def) {
    res.status(404).json({ error: "Unknown automation" });
    return;
  }
  const settings = await getWhatsappSettings(access.academyId);
  const all = { ...((settings.automations ?? {}) as Record<string, StoredAutomation>) };
  const current = { ...(all[def.key] ?? {}) };
  if (body.data.enabled !== undefined) current.enabled = body.data.enabled;
  if (body.data.audiences !== undefined) current.audiences = body.data.audiences.filter((r) => def.allowedAudiences.includes(r));
  if (body.data.template !== undefined) {
    const template = body.data.template?.trim() ?? "";
    current.template = template && template !== def.template[settings.locale] ? template : null;
  }
  if (body.data.timing !== undefined) current.timing = body.data.timing;
  all[def.key] = current;
  const saved = await saveWhatsappSettings(access.academyId, { automations: all });
  res.json({ automations: automationsView(saved.automations, saved.locale) });
});

router.post("/academy/console/academies/:academyId/whatsapp/connect", async (req, res): Promise<void> => {
  const access = await academyAccess(req, res, true);
  if (!access) return;
  const input = parseConnect(req, res);
  if (!input) return;
  try {
    const result = await connectSession(
      academySessionName(access.academyId),
      { academyId: String(access.academyId) },
      input.method,
      input.phone,
    );
    await saveWhatsappSettings(access.academyId, { sessionStatus: result.status });
    res.json(result);
  } catch (error) {
    wahaFailure(res, error, "Could not start WhatsApp linking");
  }
});

router.get("/academy/console/academies/:academyId/whatsapp/qr", async (req, res): Promise<void> => {
  const access = await academyAccess(req, res, true);
  if (!access) return;
  const name = academySessionName(access.academyId);
  try {
    const session = await getSession(name);
    const status = session?.status ?? "NOT_CREATED";
    const qr = status === "SCAN_QR_CODE" ? await getQrDataUrl(name) : null;
    const phone = phoneFromChatId(session?.me?.id ?? null);
    const settings = await getWhatsappSettings(access.academyId);
    if (status === "WORKING") {
      await saveWhatsappSettings(access.academyId, {
        sessionStatus: status,
        connectedPhone: phone,
        connectedName: session?.me?.pushName ?? null,
        // The first time an academy links its own number, switch it on.
        ...(settings.sender === "off" ? { sender: "own" } : {}),
      });
    } else if (status !== settings.sessionStatus) {
      await saveWhatsappSettings(access.academyId, { sessionStatus: status });
    }
    res.json({ ...sessionView(session), qr });
  } catch (error) {
    wahaFailure(res, error, "Could not read the WhatsApp link status");
  }
});

router.post("/academy/console/academies/:academyId/whatsapp/disconnect", async (req, res): Promise<void> => {
  const access = await academyAccess(req, res, true);
  if (!access) return;
  try {
    await logoutSession(academySessionName(access.academyId));
    const settings = await getWhatsappSettings(access.academyId);
    await saveWhatsappSettings(access.academyId, {
      sessionStatus: "STOPPED",
      connectedPhone: null,
      connectedName: null,
      ...(settings.sender === "own" ? { sender: "off" } : {}),
    });
    res.json({ ok: true });
  } catch (error) {
    wahaFailure(res, error, "Could not unlink WhatsApp");
  }
});

const AudienceBody = z.object({
  roles: z.array(z.enum(["parents", "players", "coaches"])).min(1),
  squadIds: z.array(z.number().int().positive()).nullable().default(null),
  playerIds: z.array(z.number().int().positive()).nullable().default(null),
});

export async function validateAudience(academyId: number, audience: z.infer<typeof AudienceBody>, res: Response): Promise<boolean> {
  if (audience.squadIds && audience.squadIds.length > 0) {
    const rows = await db.select({ id: academySquadsTable.id }).from(academySquadsTable)
      .where(and(eq(academySquadsTable.academyId, academyId), inArray(academySquadsTable.id, audience.squadIds)));
    if (rows.length !== new Set(audience.squadIds).size) {
      res.status(404).json({ error: "Squad not found in this academy" });
      return false;
    }
  }
  if (audience.playerIds && audience.playerIds.length > 0) {
    const rows = await db.select({ id: academyPlayersTable.id }).from(academyPlayersTable)
      .where(and(eq(academyPlayersTable.academyId, academyId), inArray(academyPlayersTable.id, audience.playerIds)));
    if (rows.length !== new Set(audience.playerIds).size) {
      res.status(404).json({ error: "Player not found in this academy" });
      return false;
    }
  }
  return true;
}

router.post("/academy/console/academies/:academyId/whatsapp/preview", async (req, res): Promise<void> => {
  const access = await academyAccess(req, res);
  if (!access) return;
  const body = AudienceBody.safeParse(req.body?.audience ?? req.body ?? {});
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  if (!(await validateAudience(access.academyId, body.data, res))) return;
  const resolved = await resolveAudience(access.academyId, body.data);
  const optOuts = await optedOutPhones(access.academyId);
  const blocked = await blockedPhones(access.academyId);
  const merged = mergeByPhone(resolved.recipients);
  // Blocked numbers are skipped at dispatch; count them with the opted-out so the preview matches what sends.
  const reachable = merged.filter((r) => !optOuts.has(r.phone) && !blocked.has(r.phone));
  res.json({
    count: reachable.length,
    optedOut: merged.length - reachable.length,
    playerCount: resolved.playerCount,
    recipients: reachable.slice(0, 300).map((r) => ({
      phone: formatPhoneForDisplay(r.phone),
      name: r.name,
      role: r.role,
      players: r.playerNames,
    })),
    missing: resolved.missing,
  });
});

const BroadcastBody = z.object({
  body: z.string().trim().min(1).max(4000),
  audience: AudienceBody.optional(),
  /** People picked in the People list; replaces the audience when present. */
  contactIds: z.array(z.number().int().positive()).min(1).max(2000).optional(),
  scheduledFor: z.string().datetime({ offset: true }).nullable().optional(),
}).refine((b) => b.audience || b.contactIds, { message: "Pick an audience or people" });

/** Picked people as merged recipients, with the players they are linked to. */
export async function contactRecipients(academyId: number, contactIds: number[]) {
  const contacts = await db.select().from(academyContactsTable)
    .where(and(eq(academyContactsTable.academyId, academyId), inArray(academyContactsTable.id, contactIds)));
  const links = await linksForContacts(contacts.map((c) => c.id));
  return contacts.map((c) => {
    const players = (links.get(c.id) ?? []).filter((l) => l.isActive);
    const role: "parent" | "player" | "coach" = c.kind === "coach" ? "coach" : c.kind === "player" ? "player" : "parent";
    return {
      phone: c.phone,
      name: c.name,
      role,
      playerIds: players.map((p) => p.playerId),
      playerNames: players.map((p) => p.playerName),
      squadNames: [...new Set(players.map((p) => p.squadName).filter((n): n is string => Boolean(n)))],
    };
  });
}

router.post("/academy/console/academies/:academyId/whatsapp/broadcasts", async (req, res): Promise<void> => {
  const access = await academyAccess(req, res);
  if (!access) return;
  const body = BroadcastBody.safeParse(req.body ?? {});
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const settings = await getWhatsappSettings(access.academyId);
  if (!senderSessionFor(settings)) {
    res.status(409).json({ error: "Turn WhatsApp on first: link your number or choose Replay's number." });
    return;
  }
  if (body.data.audience && !body.data.contactIds && !(await validateAudience(access.academyId, body.data.audience, res))) return;
  const scheduledFor = body.data.scheduledFor ? new Date(body.data.scheduledFor) : new Date();
  if (scheduledFor.getTime() > Date.now() + 60 * 86_400_000) {
    res.status(400).json({ error: "Schedule within the next 60 days" });
    return;
  }

  const optOuts = await optedOutPhones(access.academyId);
  const candidates = body.data.contactIds
    ? await contactRecipients(access.academyId, body.data.contactIds)
    : mergeByPhone((await resolveAudience(access.academyId, body.data.audience!)).recipients);
  const merged = candidates.filter((r) => !optOuts.has(r.phone));
  if (merged.length === 0) {
    res.status(400).json({ error: "Nobody in this audience has a WhatsApp number on file" });
    return;
  }

  const [broadcast] = await db.insert(academyWhatsappBroadcastsTable).values({
    academyId: access.academyId,
    body: body.data.body,
    audience: body.data.contactIds ? { contactIds: body.data.contactIds } : body.data.audience!,
    recipientCount: merged.length,
    createdBy: access.user.id,
    scheduledFor,
  }).returning({ id: academyWhatsappBroadcastsTable.id });

  const queued = await enqueueMessages(merged.map((r) => ({
    academyId: access.academyId,
    kind: "broadcast",
    broadcastId: broadcast.id,
    phone: r.phone,
    recipientName: r.name,
    recipientRole: r.role,
    playerId: r.playerIds.length === 1 ? r.playerIds[0] : null,
    createdBy: access.user.id,
    scheduledFor,
    dedupeKey: `a${access.academyId}:b${broadcast.id}:${r.phone}`,
    body: renderTemplate(body.data.body, {
      academy: access.academyName,
      name: r.name ?? "",
      player: joinNames(r.playerNames, settings.locale),
      squad: r.squadNames.join(settings.locale === "ar" ? "، " : ", "),
    }),
  })));
  res.status(201).json({ broadcastId: broadcast.id, queued, scheduledFor: scheduledFor.toISOString() });
});

router.get("/academy/console/academies/:academyId/whatsapp/messages", async (req, res): Promise<void> => {
  const access = await academyAccess(req, res);
  if (!access) return;
  const messages = await db
    .select({
      id: academyWhatsappMessagesTable.id,
      direction: academyWhatsappMessagesTable.direction,
      kind: academyWhatsappMessagesTable.kind,
      broadcastId: academyWhatsappMessagesTable.broadcastId,
      phone: academyWhatsappMessagesTable.phone,
      recipientName: academyWhatsappMessagesTable.recipientName,
      recipientRole: academyWhatsappMessagesTable.recipientRole,
      playerName: academyPlayersTable.name,
      body: academyWhatsappMessagesTable.body,
      status: academyWhatsappMessagesTable.status,
      error: academyWhatsappMessagesTable.error,
      scheduledFor: academyWhatsappMessagesTable.scheduledFor,
      sentAt: academyWhatsappMessagesTable.sentAt,
      deliveredAt: academyWhatsappMessagesTable.deliveredAt,
      readAt: academyWhatsappMessagesTable.readAt,
      createdAt: academyWhatsappMessagesTable.createdAt,
    })
    .from(academyWhatsappMessagesTable)
    .leftJoin(academyPlayersTable, eq(academyPlayersTable.id, academyWhatsappMessagesTable.playerId))
    .where(eq(academyWhatsappMessagesTable.academyId, access.academyId))
    .orderBy(desc(academyWhatsappMessagesTable.createdAt), desc(academyWhatsappMessagesTable.id))
    .limit(300);

  const broadcastRows = await db
    .select({
      id: academyWhatsappBroadcastsTable.id,
      body: academyWhatsappBroadcastsTable.body,
      recipientCount: academyWhatsappBroadcastsTable.recipientCount,
      scheduledFor: academyWhatsappBroadcastsTable.scheduledFor,
      createdAt: academyWhatsappBroadcastsTable.createdAt,
    })
    .from(academyWhatsappBroadcastsTable)
    .where(eq(academyWhatsappBroadcastsTable.academyId, access.academyId))
    .orderBy(desc(academyWhatsappBroadcastsTable.createdAt))
    .limit(30);
  const counts = broadcastRows.length === 0 ? [] : await db
    .select({
      broadcastId: academyWhatsappMessagesTable.broadcastId,
      status: academyWhatsappMessagesTable.status,
      n: sql<number>`count(*)::int`,
    })
    .from(academyWhatsappMessagesTable)
    .where(inArray(academyWhatsappMessagesTable.broadcastId, broadcastRows.map((b) => b.id)))
    .groupBy(academyWhatsappMessagesTable.broadcastId, academyWhatsappMessagesTable.status);

  res.json({
    messages: messages.map((m) => ({ ...m, phone: formatPhoneForDisplay(m.phone) })),
    broadcasts: broadcastRows.map((b) => ({
      ...b,
      statusCounts: Object.fromEntries(counts.filter((c) => c.broadcastId === b.id).map((c) => [c.status, c.n])),
    })),
  });
});

router.post("/academy/console/academies/:academyId/whatsapp/messages/:messageId/retry", async (req, res): Promise<void> => {
  const access = await academyAccess(req, res);
  if (!access) return;
  const messageId = intParam(req.params.messageId);
  if (!messageId) {
    res.status(400).json({ error: "Invalid message id" });
    return;
  }
  const [updated] = await db
    .update(academyWhatsappMessagesTable)
    .set({ status: "queued", error: null, attempts: 0, scheduledFor: new Date(), claimedAt: null })
    .where(and(
      eq(academyWhatsappMessagesTable.id, messageId),
      eq(academyWhatsappMessagesTable.academyId, access.academyId),
      eq(academyWhatsappMessagesTable.direction, "out"),
      inArray(academyWhatsappMessagesTable.status, ["failed", "skipped"]),
    ))
    .returning({ id: academyWhatsappMessagesTable.id });
  if (!updated) {
    res.status(404).json({ error: "Only failed messages can be retried" });
    return;
  }
  res.json({ ok: true });
});

const TestBody = z.object({ phone: z.string().max(40).optional().nullable() });

router.post("/academy/console/academies/:academyId/whatsapp/test", async (req, res): Promise<void> => {
  const access = await academyAccess(req, res, true);
  if (!access) return;
  const body = TestBody.safeParse(req.body ?? {});
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const phone = normalizePhone(body.data.phone || access.user.phone);
  if (!phone) {
    res.status(400).json({ error: "Enter a phone number to send the test to" });
    return;
  }
  const settings = await getWhatsappSettings(access.academyId);
  if (!senderSessionFor(settings)) {
    res.status(409).json({ error: "Turn WhatsApp on first: link your number or choose Replay's number." });
    return;
  }
  await db.delete(academyWhatsappOptOutsTable).where(and(
    eq(academyWhatsappOptOutsTable.academyId, access.academyId),
    eq(academyWhatsappOptOutsTable.phone, phone),
  ));
  await enqueueMessages([{
    academyId: access.academyId,
    kind: "test",
    phone,
    recipientName: access.user.name,
    recipientRole: "owner",
    createdBy: access.user.id,
    body: settings.locale === "en"
      ? `✅ ${access.academyName}: WhatsApp messages from Replay are working.`
      : `✅ ${access.academyName}: رسائل الواتساب من Replay شغّالة.`,
  }]);
  res.status(201).json({ ok: true, phone: formatPhoneForDisplay(phone) });
});

router.get("/academy/console/academies/:academyId/whatsapp/opt-outs", async (req, res): Promise<void> => {
  const access = await academyAccess(req, res, true);
  if (!access) return;
  const rows = await db
    .select({ phone: academyWhatsappOptOutsTable.phone, createdAt: academyWhatsappOptOutsTable.createdAt })
    .from(academyWhatsappOptOutsTable)
    .where(eq(academyWhatsappOptOutsTable.academyId, access.academyId))
    .orderBy(desc(academyWhatsappOptOutsTable.createdAt));
  res.json(rows.map((r) => ({ phone: r.phone, display: formatPhoneForDisplay(r.phone), createdAt: r.createdAt })));
});

router.delete("/academy/console/academies/:academyId/whatsapp/opt-outs/:phone", async (req, res): Promise<void> => {
  const access = await academyAccess(req, res, true);
  if (!access) return;
  const phone = normalizePhone(rawParam(req.params.phone));
  if (!phone) {
    res.status(400).json({ error: "Invalid phone" });
    return;
  }
  await db.delete(academyWhatsappOptOutsTable).where(and(
    eq(academyWhatsappOptOutsTable.academyId, access.academyId),
    eq(academyWhatsappOptOutsTable.phone, phone),
  ));
  res.status(204).send();
});

// ─── Admin: the WhatsApp service and Replay's shared number ──────────────────

async function requireAdmin(req: Request, res: Response): Promise<AcademyConsoleUser | null> {
  const user = await requireAcademyConsoleUser(req, res);
  if (!user) return null;
  if (!user.isAdmin) {
    res.status(403).json({ error: "Admin access required" });
    return null;
  }
  return user;
}

router.get("/admin/whatsapp", async (req, res, next): Promise<void> => {
  if (!(await requireAdmin(req, res))) return;
  try {
    await adminOverview(res);
  } catch (error) {
    logger.error({ error: (error as Error)?.message }, "Admin WhatsApp overview failed");
    if (!res.headersSent) res.status(500).json({ error: describeDbError(error) });
    else next(error);
  }
});

/** "relation ... does not exist" means the publish skipped the database review. */
function describeDbError(error: unknown): string {
  const message = (error as Error)?.message ?? String(error);
  const cause = (error as { cause?: { message?: string; code?: string } })?.cause;
  const text = `${message} ${cause?.message ?? ""}`;
  if (/does not exist/i.test(text) || cause?.code === "42P01") {
    return "The WhatsApp tables are missing from this database. Run the schema push and publish with the database review.";
  }
  return message.slice(0, 300);
}

async function adminOverview(res: Response): Promise<void> {
  let version: Record<string, unknown> | null = null;
  let sessions: WahaSession[] = [];
  let error: string | null = null;
  if (wahaConfigured()) {
    try {
      version = await wahaVersion();
      sessions = await listSessions();
    } catch (e) {
      error = (e as Error).message;
    }
  } else {
    error = "Not configured";
  }
  const replay = sessions.find((s) => s.name === REPLAY_SESSION) ?? null;
  const academies = await db
    .select({
      academyId: academyWhatsappSettingsTable.academyId,
      name: academiesTable.name,
      sender: academyWhatsappSettingsTable.sender,
      sessionStatus: academyWhatsappSettingsTable.sessionStatus,
      connectedPhone: academyWhatsappSettingsTable.connectedPhone,
    })
    .from(academyWhatsappSettingsTable)
    .innerJoin(academiesTable, eq(academiesTable.id, academyWhatsappSettingsTable.academyId));
  const volume = await db
    .select({
      academyId: academyWhatsappMessagesTable.academyId,
      sent7d: sql<number>`count(*) filter (where ${academyWhatsappMessagesTable.status} in ('sent','delivered','read'))::int`,
      failed7d: sql<number>`count(*) filter (where ${academyWhatsappMessagesTable.status} = 'failed')::int`,
      queued: sql<number>`count(*) filter (where ${academyWhatsappMessagesTable.status} in ('queued','sending'))::int`,
    })
    .from(academyWhatsappMessagesTable)
    .where(gte(academyWhatsappMessagesTable.createdAt, new Date(Date.now() - 7 * 86_400_000)))
    .groupBy(academyWhatsappMessagesTable.academyId);
  res.json({
    configured: wahaConfigured(),
    reachable: version !== null,
    version,
    error,
    replay: sessionView(replay),
    sessions: sessions.map((s) => ({ session: s.name, ...sessionView(s) })),
    academies: academies.map((a) => ({
      ...a,
      connectedPhone: a.connectedPhone ? formatPhoneForDisplay(a.connectedPhone) : null,
      ...(volume.find((v) => v.academyId === a.academyId) ?? { sent7d: 0, failed7d: 0, queued: 0 }),
    })),
  });
}

router.post("/admin/whatsapp/replay/connect", async (req, res): Promise<void> => {
  if (!(await requireAdmin(req, res))) return;
  const input = parseConnect(req, res);
  if (!input) return;
  try {
    res.json(await connectSession(REPLAY_SESSION, { scope: "replay" }, input.method, input.phone));
  } catch (error) {
    wahaFailure(res, error, "Could not start WhatsApp linking");
  }
});

router.get("/admin/whatsapp/replay/qr", async (req, res): Promise<void> => {
  if (!(await requireAdmin(req, res))) return;
  try {
    const session = await getSession(REPLAY_SESSION);
    const qr = session?.status === "SCAN_QR_CODE" ? await getQrDataUrl(REPLAY_SESSION) : null;
    res.json({ ...sessionView(session), qr });
  } catch (error) {
    wahaFailure(res, error, "Could not read the WhatsApp link status");
  }
});

router.post("/admin/whatsapp/replay/disconnect", async (req, res): Promise<void> => {
  if (!(await requireAdmin(req, res))) return;
  try {
    await logoutSession(REPLAY_SESSION);
    res.json({ ok: true });
  } catch (error) {
    wahaFailure(res, error, "Could not unlink WhatsApp");
  }
});

// ─── vps1 → app ──────────────────────────────────────────────────────────────

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Called every minute by cron on vps1 (the API is on autoscale and has no timer of
 * its own). Queues due reminders, then sends what is due.
 */
router.post("/whatsapp/tick", async (req, res): Promise<void> => {
  const expected = whatsappTickKey();
  const presented = String(req.headers["x-api-key"] ?? "");
  if (!expected || !presented || !safeEqual(presented, expected)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const started = Date.now();
  try {
    const scheduled = await runScheduledAutomations();
    // Field bookings: lapse unpaid holds, send reminders and recording links (queued for this dispatch).
    const venues = await runVenueTick().catch((error) => {
      logger.warn({ error: (error as Error)?.message }, "Venue tick failed");
      return "failed" as const;
    });
    const dispatched = await dispatchQueue({ budgetMs: Math.max(10_000, 50_000 - (Date.now() - started)) });
    // The same tick keeps Replay's Meta ad numbers fresh (at most hourly; never fails the tick).
    const meta = await maybeSyncMetaAds();
    // Scheduled Instagram/Facebook posts go out; post and account numbers refresh hourly.
    const social = await maybeRunSocial().catch((error) => {
      logger.warn({ error: (error as Error)?.message }, "Social tick failed");
      return "failed" as const;
    });
    const webhooks = await maybeRefreshWebhooks();
    // Children's private clips get prepared once a match is analysed (the owner sends them).
    const playerClips = await maybePrepareRecentClips().catch((error) => {
      logger.warn({ error: (error as Error)?.message }, "Private clip sweep failed");
      return "failed" as const;
    });
    res.json({ scheduled, venues, dispatched, meta: typeof meta === "string" ? meta : "synced", social, webhooks, playerClips, ms: Date.now() - started });
  } catch (error) {
    // vps1 logs this body: say what broke (e.g. a table missing after a publish).
    logger.error({ error: (error as Error)?.message }, "WhatsApp tick failed");
    res.status(500).json({ error: describeDbError(error) });
  }
});

let webhooksCheckedAt = 0;

/**
 * Sessions linked before an event was added (poll votes) don't send it. Every 6 hours the tick
 * checks each working session and updates the ones missing an event (WAHA restarts them).
 */
async function maybeRefreshWebhooks(): Promise<string[]> {
  if (Date.now() - webhooksCheckedAt < 6 * 3_600_000) return [];
  webhooksCheckedAt = Date.now();
  const updated: string[] = [];
  try {
    for (const session of await listSessions()) {
      if (session.status !== "WORKING") continue;
      if (session.name !== REPLAY_SESSION && !/^academy-\d+$/.test(session.name)) continue;
      if (await refreshWebhookEvents(session.name).catch(() => false)) updated.push(session.name);
    }
  } catch (error) {
    logger.warn({ error: (error as Error)?.message }, "Checking WhatsApp webhooks failed");
  }
  return updated;
}

/** Express gives this route the raw body (see app.ts) so the HMAC is checked over exact bytes. */
router.post("/whatsapp/webhook", async (req, res): Promise<void> => {
  const raw: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body ?? {}));
  const secret = wahaWebhookSecret();
  if (!secret) {
    res.status(503).json({ error: "Not configured" });
    return;
  }
  const signature = String(req.headers["x-webhook-hmac"] ?? "").trim();
  const digest = createHmac("sha512", secret).update(raw);
  const hex = digest.digest("hex");
  const base64 = Buffer.from(hex, "hex").toString("base64");
  if (!signature || !(safeEqual(signature.toLowerCase(), hex) || safeEqual(signature, base64))) {
    res.status(401).json({ error: "Bad signature" });
    return;
  }
  let event: Parameters<typeof handleWahaWebhook>[0];
  try {
    event = JSON.parse(raw.toString("utf8"));
  } catch {
    res.status(400).json({ error: "Bad JSON" });
    return;
  }
  try {
    await handleWahaWebhook(event);
  } catch (error) {
    logger.warn({ error: (error as Error)?.message, event: event?.event }, "WhatsApp webhook handling failed");
  }
  res.json({ ok: true });
});


// ─── Chats ───────────────────────────────────────────────────────────────────

function phoneParam(req: Request, res: Response): string | null {
  const phone = normalizePhone(rawParam(req.params.phone));
  if (!phone || isGroupKey(rawParam(req.params.phone))) res.status(400).json({ error: "Invalid phone number" });
  return phone && !isGroupKey(rawParam(req.params.phone)) ? phone : null;
}

/** A person's phone or a group's "g:<id>". */
export function chatKeyParam(req: Request, res: Response): string | null {
  const key = chatKeyFromParam(rawParam(req.params.phone));
  if (!key) res.status(400).json({ error: "Invalid chat" });
  return key;
}

export async function groupRow(academyId: number, key: string) {
  const groupId = groupIdFromKey(key);
  if (!groupId) return null;
  const [row] = await db.select().from(academyWhatsappGroupsTable)
    .where(and(eq(academyWhatsappGroupsTable.academyId, academyId), eq(academyWhatsappGroupsTable.groupId, groupId)));
  return row ?? null;
}

export function groupView(g: typeof academyWhatsappGroupsTable.$inferSelect) {
  return { id: g.id, groupId: g.groupId, subject: g.subject, origin: g.origin, squadId: g.squadId };
}

function contactView(
  c: typeof academyContactsTable.$inferSelect,
  players: Awaited<ReturnType<typeof linksForContacts>> extends Map<number, infer V> ? V : never,
) {
  return {
    id: c.id,
    phone: c.phone,
    display: formatPhoneForDisplay(c.phone),
    name: c.name,
    kind: c.kind,
    stage: c.stage,
    source: c.source,
    tags: Array.isArray(c.tags) ? (c.tags as string[]) : [],
    notes: c.notes,
    players,
    createdAt: c.createdAt,
  };
}

router.get("/academy/console/academies/:academyId/whatsapp/chats", async (req, res): Promise<void> => {
  const access = await academyAccess(req, res);
  if (!access) return;
  const result = await db.execute(sql`
    select m.phone,
      max(m.created_at) as "lastAt",
      (array_agg(m.body order by m.created_at desc, m.id desc))[1] as "lastBody",
      (array_agg(m.direction order by m.created_at desc, m.id desc))[1] as "lastDirection",
      (array_agg(m.status order by m.created_at desc, m.id desc))[1] as "lastStatus",
      (array_agg(m.author_name order by m.created_at desc, m.id desc))[1] as "lastAuthor",
      count(*) filter (where m.direction = 'in' and m.created_at > coalesce(c.last_read_at, g.last_read_at, 'epoch'::timestamptz))::int as "unread"
    from academy_whatsapp_messages m
    left join academy_contacts c on c.academy_id = m.academy_id and c.phone = m.phone
    left join academy_whatsapp_groups g on g.academy_id = m.academy_id and m.phone = 'g:' || g.group_id
    where m.academy_id = ${access.academyId} and c.personal_at is null
      and (m.phone not like 'g:%' or g.id is not null)
    group by m.phone, c.last_read_at, g.last_read_at
    order by max(m.created_at) desc
    limit 300
  `);
  const rows = (result as unknown as { rows: Array<{ phone: string; lastAt: string; lastBody: string; lastDirection: string; lastStatus: string; lastAuthor: string | null; unread: number }> }).rows ?? [];
  const phones = rows.map((r) => r.phone).filter((p) => !isGroupKey(p));
  const contacts = phones.length === 0 ? [] : await db.select().from(academyContactsTable)
    .where(and(eq(academyContactsTable.academyId, access.academyId), inArray(academyContactsTable.phone, phones)));
  const links = await linksForContacts(contacts.map((c) => c.id));
  const byPhone = new Map(contacts.map((c) => [c.phone, c]));
  const groups = await db.select().from(academyWhatsappGroupsTable).where(eq(academyWhatsappGroupsTable.academyId, access.academyId));
  const groupByKey = new Map(groups.map((g) => [groupKey(g.groupId), g]));
  const chats = rows.map((r) => {
    const group = groupByKey.get(r.phone);
    if (group) {
      return {
        phone: r.phone,
        display: group.subject,
        lastAt: r.lastAt,
        lastBody: r.lastAuthor && r.lastDirection === "in" ? `${r.lastAuthor}: ${r.lastBody}` : r.lastBody,
        lastDirection: r.lastDirection,
        lastStatus: r.lastStatus,
        unread: r.unread,
        archived: Boolean(group.archivedAt),
        muted: group.muted,
        blocked: false,
        linkLater: true,
        assignedUserId: group.assignedUserId,
        avatarUrl: avatarUrl(group.avatarPath),
        typing: Boolean(group.typingUntil && group.typingUntil.getTime() > Date.now()),
        group: groupView(group),
        contact: null,
      };
    }
    const contact = byPhone.get(r.phone);
    return {
      phone: r.phone,
      display: formatPhoneForDisplay(r.phone),
      lastAt: r.lastAt,
      lastBody: r.lastBody,
      lastDirection: r.lastDirection,
      lastStatus: r.lastStatus,
      unread: r.unread,
      archived: Boolean(contact?.archivedAt),
      muted: contact?.muted ?? false,
      blocked: Boolean(contact?.blockedAt),
      linkLater: Boolean(contact?.linkDismissedAt),
      assignedUserId: contact?.assignedUserId ?? null,
      avatarUrl: avatarUrl(contact?.avatarPath),
      typing: Boolean(contact?.typingUntil && contact.typingUntil.getTime() > Date.now()),
      group: null,
      contact: contact ? contactView(contact, links.get(contact.id) ?? []) : null,
    };
  });
  void refreshAvatars(access.academyId, contacts, groups);
  // A group just created has no messages yet; it still belongs in the list.
  const listed = new Set(rows.map((r) => r.phone));
  for (const g of groups) {
    const key = groupKey(g.groupId);
    if (listed.has(key)) continue;
    chats.push({
      phone: key, display: g.subject, lastAt: g.createdAt.toISOString(), lastBody: "", lastDirection: "out", lastStatus: "sent",
      unread: 0, archived: Boolean(g.archivedAt), muted: g.muted, blocked: false, linkLater: true,
      assignedUserId: g.assignedUserId, avatarUrl: avatarUrl(g.avatarPath), typing: false, group: groupView(g), contact: null,
    });
  }
  chats.sort((a, b) => new Date(b.lastAt).getTime() - new Date(a.lastAt).getTime());
  res.json(chats);
});

// ─── Chat controls: archive, mute, block, personal, "who is this" ────────────

/** Archive, mute, block and personal are the owner's, unless he gave "chats.manage" to the role. */
export async function canManageChats(access: Access): Promise<boolean> {
  const staff = await staffAccessFor(access.user.id, access.academyId);
  return Boolean(staff?.permissions.includes("chats.manage"));
}

const ChatStateBody = z.object({
  archived: z.boolean().optional(),
  muted: z.boolean().optional(),
  blocked: z.boolean().optional(),
  personal: z.boolean().optional(),
});

router.post("/academy/console/academies/:academyId/whatsapp/chats/:phone/state", async (req, res): Promise<void> => {
  const access = await academyAccess(req, res);
  if (!access) return;
  const phone = chatKeyParam(req, res);
  if (!phone) return;
  const body = ChatStateBody.safeParse(req.body ?? {});
  if (!body.success || Object.keys(body.data).length === 0) {
    res.status(400).json({ error: "Nothing to change" });
    return;
  }
  if (!(await canManageChats(access))) {
    res.status(403).json({ error: "Only the academy owner can archive, mute, block or hide chats, unless he gives your role that permission.", code: "chats_manage" });
    return;
  }
  if (isGroupKey(phone)) {
    const group = await groupRow(access.academyId, phone);
    if (!group) {
      res.status(404).json({ error: "Group not found" });
      return;
    }
    if (body.data.blocked) {
      res.status(400).json({ error: "A group can't be blocked. Stop following it instead." });
      return;
    }
    if (body.data.personal) {
      // "Stop following": the group leaves Replay and what was stored from it goes.
      await db.delete(academyWhatsappMessagesTable).where(and(
        eq(academyWhatsappMessagesTable.academyId, access.academyId),
        eq(academyWhatsappMessagesTable.phone, phone),
      ));
      await db.delete(academyWhatsappGroupsTable).where(eq(academyWhatsappGroupsTable.id, group.id));
      res.json({ phone, archived: false, muted: false, blocked: false, personal: true });
      return;
    }
    const now = new Date();
    const [row] = await db.update(academyWhatsappGroupsTable).set({
      updatedAt: now,
      ...(body.data.archived !== undefined ? { archivedAt: body.data.archived ? now : null } : {}),
      ...(body.data.muted !== undefined ? { muted: body.data.muted } : {}),
    }).where(eq(academyWhatsappGroupsTable.id, group.id)).returning();
    res.json({ phone, archived: Boolean(row.archivedAt), muted: row.muted, blocked: false, personal: false });
    return;
  }
  const contact = await upsertContact(access.academyId, phone, { source: "chat" });
  const now = new Date();
  const patch: Partial<typeof academyContactsTable.$inferInsert> = { updatedAt: now };
  if (body.data.archived !== undefined) patch.archivedAt = body.data.archived ? now : null;
  if (body.data.muted !== undefined) patch.muted = body.data.muted;
  if (body.data.blocked !== undefined) patch.blockedAt = body.data.blocked ? now : null;
  if (body.data.personal !== undefined) patch.personalAt = body.data.personal ? now : null;
  const [row] = await db.update(academyContactsTable).set(patch).where(eq(academyContactsTable.id, contact.id)).returning();
  if (body.data.personal) {
    // A personal chat leaves Replay: what was stored goes, nothing new is kept.
    await db.delete(academyWhatsappMessagesTable).where(and(
      eq(academyWhatsappMessagesTable.academyId, access.academyId),
      eq(academyWhatsappMessagesTable.phone, phone),
      inArray(academyWhatsappMessagesTable.status, ["sent", "delivered", "read", "received", "failed", "skipped"]),
    ));
  }
  if (body.data.blocked) {
    // Nothing waiting goes out to a blocked number.
    await db.update(academyWhatsappMessagesTable).set({ status: "skipped", error: "Blocked" }).where(and(
      eq(academyWhatsappMessagesTable.academyId, access.academyId),
      eq(academyWhatsappMessagesTable.phone, phone),
      eq(academyWhatsappMessagesTable.status, "queued"),
    ));
  }
  res.json({ phone, archived: Boolean(row.archivedAt), muted: row.muted, blocked: Boolean(row.blockedAt), personal: Boolean(row.personalAt) });
});

/** Numbers hidden as personal or blocked, so they can be brought back. */
router.get("/academy/console/academies/:academyId/whatsapp/hidden", async (req, res): Promise<void> => {
  const access = await academyAccess(req, res);
  if (!access) return;
  if (!(await canManageChats(access))) {
    res.status(403).json({ error: "Only the academy owner can see hidden chats", code: "chats_manage" });
    return;
  }
  const rows = await db.select().from(academyContactsTable).where(and(
    eq(academyContactsTable.academyId, access.academyId),
    or(isNotNull(academyContactsTable.personalAt), isNotNull(academyContactsTable.blockedAt)),
  ));
  res.json(rows.map((c) => ({ phone: c.phone, display: formatPhoneForDisplay(c.phone), name: c.name, personal: Boolean(c.personalAt), blocked: Boolean(c.blockedAt) })));
});

/** "Who is this?": not linked to any player, or not now. Anyone who can chat may answer it. */
router.post("/academy/console/academies/:academyId/whatsapp/chats/:phone/who", async (req, res): Promise<void> => {
  const access = await academyAccess(req, res);
  if (!access) return;
  const phone = phoneParam(req, res);
  if (!phone) return;
  const action = req.body?.action;
  if (action !== "none" && action !== "later" && action !== "ask") {
    res.status(400).json({ error: "action must be none, later or ask" });
    return;
  }
  const contact = await upsertContact(access.academyId, phone, { source: "chat" });
  const patch: Partial<typeof academyContactsTable.$inferInsert> = { updatedAt: new Date() };
  if (action === "later") patch.linkDismissedAt = new Date();
  if (action === "ask") {
    patch.linkDismissedAt = null;
    if (contact.kind === "other") patch.kind = "unknown";
  }
  // Not anyone's parent or player: someone else (a supplier, a friend of the academy…).
  if (action === "none") {
    patch.linkDismissedAt = new Date();
    if (contact.kind === "unknown") patch.kind = "other";
  }
  const [row] = await db.update(academyContactsTable).set(patch).where(eq(academyContactsTable.id, contact.id)).returning();
  res.json({ phone, kind: row.kind, linkLater: Boolean(row.linkDismissedAt) });
});

// ─── One chat: messages with their files, locations, polls and votes ─────────

type MessageRow = typeof academyWhatsappMessagesTable.$inferSelect;

export function avatarUrl(path: string | null | undefined): string | null {
  return path ? mediaUrl({ path }) : null;
}

/**
 * Blue ticks: tell WhatsApp the incoming messages since the chat was last read were seen.
 * Never blocks or fails the page; off when the academy turned read receipts off.
 */
async function markChatRead(academyId: number, chatKey: string, settings: Awaited<ReturnType<typeof getWhatsappSettings>>, since: Date | null): Promise<void> {
  try {
    const session = senderSessionFor(settings);
    if (!session || !wahaConfigured() || !parseChatOptions(settings.chatOptions, settings.locale).readReceipts) return;
    const unseen = await db.select({ waMessageId: academyWhatsappMessagesTable.waMessageId, authorPhone: academyWhatsappMessagesTable.authorPhone })
      .from(academyWhatsappMessagesTable)
      .where(and(
        eq(academyWhatsappMessagesTable.academyId, academyId),
        eq(academyWhatsappMessagesTable.phone, chatKey),
        eq(academyWhatsappMessagesTable.direction, "in"),
        isNotNull(academyWhatsappMessagesTable.waMessageId),
        sql`${academyWhatsappMessagesTable.createdAt} > ${since ?? new Date(0)}`,
        sql`${academyWhatsappMessagesTable.kind} <> 'call'`,
      ))
      .limit(50);
    if (unseen.length === 0) return;
    const groupId = groupIdFromKey(chatKey);
    const chatId = groupId ? `${groupId}@g.us` : `${chatKey}@c.us`;
    void sendSeen(session, chatId, unseen.map((m) => serializedMessageId(false, chatId, m.waMessageId!, groupId && m.authorPhone ? `${m.authorPhone}@c.us` : null)))
      .catch((error) => logger.warn({ error: (error as Error).message }, "Sending read receipts failed"));
  } catch (error) {
    logger.warn({ error: (error as Error).message }, "Read receipts skipped");
  }
}

const AVATAR_TTL_MS = 7 * 24 * 3_600_000;
const avatarsRunning = new Set<number>();

/** Copy up to a few stale profile photos from WhatsApp to Bunny, in the background. */
async function refreshAvatars(
  academyId: number,
  contacts: Array<typeof academyContactsTable.$inferSelect>,
  groups: Array<typeof academyWhatsappGroupsTable.$inferSelect>,
): Promise<void> {
  if (avatarsRunning.has(academyId) || !wahaConfigured()) return;
  const stale = (checked: Date | null) => !checked || Date.now() - checked.getTime() > AVATAR_TTL_MS;
  const contactJobs = contacts.filter((c) => stale(c.avatarCheckedAt) && !c.blockedAt).slice(0, 4).map((c) => ({ kind: "contact" as const, id: c.id, chatId: `${c.phone}@c.us` }));
  const groupJobs = groups.filter((g) => stale(g.avatarCheckedAt)).slice(0, 2).map((g) => ({ kind: "group" as const, id: g.id, chatId: `${g.groupId}@g.us` }));
  const jobs = [...contactJobs, ...groupJobs];
  if (jobs.length === 0) return;
  avatarsRunning.add(academyId);
  try {
    const settings = await getWhatsappSettings(academyId);
    const session = senderSessionFor(settings);
    if (!session) return;
    for (const job of jobs) {
      let path: string | null = null;
      try {
        const url = await getPictureUrl(session, job.chatId);
        const image = url ? await fetchImageBytes(url) : null;
        if (image) path = (await storeChatMedia(academyId, image.buffer, image.mimetype, "avatar.jpg")).path;
      } catch (error) {
        logger.warn({ academyId, error: (error as Error).message }, "Copying a WhatsApp profile photo failed");
      }
      const patch = { avatarCheckedAt: new Date(), ...(path ? { avatarPath: path } : {}) };
      if (job.kind === "contact") await db.update(academyContactsTable).set(patch).where(eq(academyContactsTable.id, job.id));
      else await db.update(academyWhatsappGroupsTable).set(patch).where(eq(academyWhatsappGroupsTable.id, job.id));
    }
  } finally {
    avatarsRunning.delete(academyId);
  }
}

const presenceWatched = new Map<string, number>();

/** Ask WhatsApp to tell us when this chat is typing (once every 10 minutes per chat). */
async function watchPresence(settings: Awaited<ReturnType<typeof getWhatsappSettings>>, chatId: string): Promise<void> {
  if (settings.sender !== "own" || !wahaConfigured()) return;
  const key = `${settings.academyId}|${chatId}`;
  if (Date.now() - (presenceWatched.get(key) ?? 0) < 10 * 60_000) return;
  presenceWatched.set(key, Date.now());
  if (presenceWatched.size > 2000) presenceWatched.clear();
  await subscribePresence(academySessionName(settings.academyId), chatId).catch(() => undefined);
}

/** Media gets its URL; a poll gets its tally. */
export async function messagesView(rows: MessageRow[], academyId?: number) {
  const pollIds = rows.filter((m) => (m.content as WhatsappContent | null)?.type === "poll").map((m) => m.id);
  const votes = pollIds.length === 0 ? [] : await db.select().from(academyWhatsappPollVotesTable)
    .where(inArray(academyWhatsappPollVotesTable.messageId, pollIds));
  const senderIds = [...new Set(rows.map((m) => m.createdBy).filter((id): id is number => id !== null))];
  const senders = senderIds.length === 0 ? [] : await db.select({ id: usersTable.id, name: usersTable.name }).from(usersTable)
    .where(inArray(usersTable.id, senderIds));
  const senderName = new Map(senders.map((u) => [u.id, u.name]));
  // The message each reply quotes (it may be older than the page, so look it up).
  const quotedIds = [...new Set(rows.map((m) => m.replyToWaId).filter((id): id is string => Boolean(id)))];
  const quotedRows = quotedIds.length === 0 ? [] : await db.select().from(academyWhatsappMessagesTable)
    .where(and(eq(academyWhatsappMessagesTable.academyId, academyId ?? rows[0]?.academyId ?? 0), inArray(academyWhatsappMessagesTable.waMessageId, quotedIds)));
  const quoted = new Map(quotedRows.map((q) => [q.waMessageId, q]));
  const now = Date.now();
  return rows.map((m) => {
    const content = m.content as WhatsappContent | null;
    let view: Record<string, unknown> | null = null;
    if (content) {
      if ("media" in content) {
        view = { ...content, media: { mimetype: content.media.mimetype, filename: content.media.filename ?? null, size: content.media.size ?? null, url: mediaUrl(content.media), pending: content.media.pending === true } };
      } else if (content.type === "poll") {
        const mine = votes.filter((v) => v.messageId === m.id);
        view = {
          ...content,
          voters: mine.length,
          tally: content.options.map((option) => {
            const who = mine.filter((v) => Array.isArray(v.options) && (v.options as string[]).includes(option));
            return { option, count: who.length, voters: who.map((v) => v.voterName || (v.voterPhone === "me" ? "You" : formatPhoneForDisplay(v.voterPhone))) };
          }),
        };
      } else if (content.type === "contact") {
        view = { ...content, contacts: content.contacts.map((c) => ({ ...c, display: formatPhoneForDisplay(c.phone) })) };
      } else {
        view = { ...content };
      }
    }
    const q = m.replyToWaId ? quoted.get(m.replyToWaId) : null;
    const reactions = Object.entries((m.reactions ?? {}) as Record<string, { emoji: string; name: string | null }>)
      .map(([who, r]) => ({ who: who === "me" ? "me" : formatPhoneForDisplay(who), name: r.name, emoji: r.emoji }));
    const editable = m.direction === "out" && m.kind === "chat" && !m.content && !m.deletedAt && Boolean(m.waMessageId)
      && ["sent", "delivered", "read"].includes(m.status) && m.sentAt !== null && now - m.sentAt.getTime() < 14 * 60_000;
    return {
      id: m.id,
      direction: m.direction,
      kind: m.kind,
      body: m.body,
      status: m.status,
      error: m.error,
      createdAt: m.createdAt,
      scheduledFor: m.status === "queued" && m.scheduledFor.getTime() > now + 30_000 ? m.scheduledFor : null,
      sentAt: m.sentAt,
      content: view,
      author: m.authorPhone || m.authorName ? { phone: m.authorPhone ? formatPhoneForDisplay(m.authorPhone) : null, name: m.authorName } : null,
      sentBy: m.createdBy ? senderName.get(m.createdBy) ?? null : null,
      replyTo: m.replyToWaId ? (q
        ? { id: q.id, direction: q.direction, body: q.deletedAt ? "" : q.body, deleted: Boolean(q.deletedAt), type: (q.content as WhatsappContent | null)?.type ?? "text", author: q.direction === "in" ? (q.authorName ?? null) : "me" }
        : { id: null, direction: "in", body: "", deleted: false, type: "text", author: null }) : null,
      reactions,
      mentions: Array.isArray(m.mentions) ? (m.mentions as string[]) : [],
      editedAt: m.editedAt,
      deleted: Boolean(m.deletedAt),
      canEdit: editable,
      canDelete: !m.deletedAt && m.direction === "out" && (m.status === "queued" || (Boolean(m.waMessageId) && ["sent", "delivered", "read"].includes(m.status))),
    };
  });
}

router.get("/academy/console/academies/:academyId/whatsapp/chats/:phone", async (req, res): Promise<void> => {
  const access = await academyAccess(req, res);
  if (!access) return;
  const phone = chatKeyParam(req, res);
  if (!phone) return;
  const group = isGroupKey(phone) ? await groupRow(access.academyId, phone) : null;
  if (isGroupKey(phone) && !group) {
    res.status(404).json({ error: "Group not found" });
    return;
  }
  const rows = await db
    .select()
    .from(academyWhatsappMessagesTable)
    .where(and(eq(academyWhatsappMessagesTable.academyId, access.academyId), eq(academyWhatsappMessagesTable.phone, phone)))
    .orderBy(desc(academyWhatsappMessagesTable.createdAt), desc(academyWhatsappMessagesTable.id))
    .limit(300);
  const messages = await messagesView(rows.reverse(), access.academyId);
  const canManage = await canManageChats(access);
  if (group) {
    const settings = await getWhatsappSettings(access.academyId);
    if (req.query.markRead !== "0") {
      await markChatRead(access.academyId, phone, settings, group.lastReadAt);
      await db.update(academyWhatsappGroupsTable).set({ lastReadAt: new Date() }).where(eq(academyWhatsappGroupsTable.id, group.id));
    }
    void watchPresence(settings, `${group.groupId}@g.us`);
    res.json({
      phone,
      display: group.subject,
      avatarUrl: avatarUrl(group.avatarPath),
      typing: Boolean(group.typingUntil && group.typingUntil.getTime() > Date.now()),
      group: groupView(group),
      wrongNumber: senderSessionFor(settings) !== group.session,
      contact: null,
      optedOut: false,
      archived: Boolean(group.archivedAt),
      muted: group.muted,
      blocked: false,
      linkLater: true,
      assignedUserId: group.assignedUserId,
      canManage,
      messages,
    });
    return;
  }
  const [contact] = await db.select().from(academyContactsTable)
    .where(and(eq(academyContactsTable.academyId, access.academyId), eq(academyContactsTable.phone, phone)));
  const settings = await getWhatsappSettings(access.academyId);
  if (req.query.markRead !== "0") {
    await markChatRead(access.academyId, phone, settings, contact?.lastReadAt ?? null);
    if (contact) await db.update(academyContactsTable).set({ lastReadAt: new Date() }).where(eq(academyContactsTable.id, contact.id));
  }
  void watchPresence(settings, `${phone}@c.us`);
  const links = contact ? await linksForContacts([contact.id]) : new Map();
  const optOuts = await optedOutPhones(access.academyId);
  res.json({
    phone,
    display: formatPhoneForDisplay(phone),
    avatarUrl: avatarUrl(contact?.avatarPath),
    typing: Boolean(contact?.typingUntil && contact.typingUntil.getTime() > Date.now()),
    group: null,
    wrongNumber: false,
    contact: contact ? contactView(contact, links.get(contact.id) ?? []) : null,
    optedOut: optOuts.has(phone),
    archived: Boolean(contact?.archivedAt),
    muted: contact?.muted ?? false,
    blocked: Boolean(contact?.blockedAt),
    linkLater: Boolean(contact?.linkDismissedAt),
    assignedUserId: contact?.assignedUserId ?? null,
    canManage,
    messages: contact?.personalAt ? [] : messages,
  });
});

const MediaRef = z.object({
  path: z.string().regex(/^wa-media\/\d+\/[0-9a-f]{32}\.[a-z0-9]{1,5}$/),
  mimetype: z.string().min(3).max(150),
  filename: z.string().max(200).nullable().optional(),
  size: z.number().int().nonnegative().nullable().optional(),
});
const Caption = z.string().trim().max(1024).nullable().optional();
const ContentBody = z.discriminatedUnion("type", [
  z.object({ type: z.literal("image"), media: MediaRef, caption: Caption }),
  z.object({ type: z.literal("video"), media: MediaRef, caption: Caption, gif: z.boolean().optional(), note: z.boolean().optional() }),
  z.object({ type: z.literal("document"), media: MediaRef, caption: Caption }),
  z.object({ type: z.literal("audio"), media: MediaRef, voice: z.boolean().optional() }),
  z.object({ type: z.literal("sticker"), media: MediaRef }),
  z.object({
    type: z.literal("location"),
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    name: z.string().trim().max(200).nullable().optional(),
    address: z.string().trim().max(300).nullable().optional(),
  }),
  z.object({
    type: z.literal("contact"),
    contacts: z.array(z.object({ name: z.string().trim().min(1).max(100), phone: z.string().regex(/^\d{6,15}$/) })).min(1).max(10),
  }),
  z.object({
    type: z.literal("poll"),
    name: z.string().trim().min(1).max(255),
    options: z.array(z.string().trim().min(1).max(100)).min(2).max(12)
      .refine((o) => new Set(o.map((x) => x.toLowerCase())).size === o.length, { message: "Each option must be different" }),
    multipleAnswers: z.boolean().default(false),
  }),
]);
const ChatSendBody = z.object({
  body: z.string().trim().max(4000).optional(),
  content: ContentBody.optional(),
  /** Id of the message in this chat being answered. */
  replyToId: z.number().int().positive().optional(),
  /** Send later instead of now. */
  scheduledFor: z.string().datetime({ offset: true }).optional(),
}).refine((b) => Boolean(b.body) || Boolean(b.content), { message: "Write a message first" });

router.post("/academy/console/academies/:academyId/whatsapp/chats/:phone/messages", async (req, res): Promise<void> => {
  const access = await academyAccess(req, res);
  if (!access) return;
  const phone = chatKeyParam(req, res);
  if (!phone) return;
  const body = ChatSendBody.safeParse(req.body ?? {});
  if (!body.success) {
    res.status(400).json({ error: body.error.issues[0]?.message === "Write a message first" ? "Write a message first" : body.error.issues[0]?.message ?? "Invalid message" });
    return;
  }
  const content = (body.data.content ?? null) as WhatsappContent | null;
  if (content && "media" in content && !content.media.path.startsWith(`wa-media/${access.academyId}/`)) {
    res.status(400).json({ error: "Upload the file again" });
    return;
  }
  const scheduledFor = body.data.scheduledFor ? new Date(body.data.scheduledFor) : null;
  if (scheduledFor && (scheduledFor.getTime() < Date.now() - 60_000 || scheduledFor.getTime() > Date.now() + 60 * 24 * 3_600_000)) {
    res.status(400).json({ error: "Pick a time within the next 60 days" });
    return;
  }
  const settings = await getWhatsappSettings(access.academyId);
  const session = senderSessionFor(settings);
  if (!session) {
    res.status(409).json({ error: "Turn WhatsApp on first: link your number or choose Replay's number." });
    return;
  }
  let replyToWaId: string | null = null;
  if (body.data.replyToId) {
    const [quoted] = await db.select({ waMessageId: academyWhatsappMessagesTable.waMessageId }).from(academyWhatsappMessagesTable)
      .where(and(eq(academyWhatsappMessagesTable.id, body.data.replyToId), eq(academyWhatsappMessagesTable.academyId, access.academyId), eq(academyWhatsappMessagesTable.phone, phone)));
    if (!quoted?.waMessageId) {
      res.status(400).json({ error: "That message can't be quoted" });
      return;
    }
    replyToWaId = quoted.waMessageId;
  }
  let recipientName: string | null = null;
  let mentions: string[] | null = null;
  if (isGroupKey(phone)) {
    const group = await groupRow(access.academyId, phone);
    if (!group) {
      res.status(404).json({ error: "Group not found" });
      return;
    }
    if (group.session !== session) {
      res.status(409).json({ error: "This group is on the academy's other WhatsApp number. Switch back to that number to post in it." });
      return;
    }
    recipientName = group.subject;
    if (body.data.body && !content) mentions = mentionedPhones(body.data.body);
  } else {
    const contact = await upsertContact(access.academyId, phone, { source: "chat" });
    if (contact.blockedAt) {
      res.status(409).json({ error: "This number is blocked. Unblock it to message it." });
      return;
    }
    recipientName = contact.name;
  }
  const [message] = await db.insert(academyWhatsappMessagesTable).values({
    academyId: access.academyId,
    kind: "chat",
    phone,
    body: content ? (!("caption" in content) || !content.caption ? summaryFor(content, settings.locale) : content.caption) : body.data.body!,
    content,
    replyToWaId,
    mentions: mentions?.length ? mentions : null,
    recipientName,
    createdBy: access.user.id,
    ...(scheduledFor && scheduledFor.getTime() > Date.now() + 30_000 ? { scheduledFor } : {}),
  }).returning({ id: academyWhatsappMessagesTable.id });
  const later = Boolean(scheduledFor && scheduledFor.getTime() > Date.now() + 30_000);
  const outcome = later ? "queued" : await dispatchMessageNow(message.id);
  res.status(201).json({ id: message.id, outcome, scheduled: later });
});

// ─── Files and GIFs ──────────────────────────────────────────────────────────

/** The browser sends the file's bytes as the body (see app.ts), its type as Content-Type. */
router.post("/academy/console/academies/:academyId/whatsapp/media", async (req, res): Promise<void> => {
  const access = await academyAccess(req, res);
  if (!access) return;
  const bytes = Buffer.isBuffer(req.body) ? req.body : null;
  if (!bytes || bytes.length === 0) {
    res.status(400).json({ error: "Choose a file" });
    return;
  }
  if (bytes.length > MAX_CHAT_MEDIA_BYTES) {
    res.status(413).json({ error: "Files up to 30 MB can be sent" });
    return;
  }
  const mimetype = String(req.headers["content-type"] ?? "application/octet-stream").split(";")[0].trim().toLowerCase();
  const filename = String(req.query.filename ?? "").replace(/[\\/\r\n]/g, "").slice(0, 200) || null;
  try {
    if (mimetype === "image/gif") {
      const mp4 = await gifToMp4(bytes);
      const media = await storeChatMedia(access.academyId, mp4, "video/mp4", filename ? filename.replace(/\.gif$/i, ".mp4") : null);
      res.status(201).json({ media, gif: true });
      return;
    }
    const media = await storeChatMedia(access.academyId, bytes, mimetype, filename);
    res.status(201).json({ media, gif: false, url: mediaUrl(media) });
  } catch (error) {
    logger.warn({ error: (error as Error).message }, "Storing a chat file failed");
    res.status(502).json({ error: "The file couldn't be uploaded. Try again." });
  }
});

function giphyKey(): string {
  return (process.env.GIPHY_API_KEY ?? "").trim();
}

type GiphyItem = { id?: string; title?: string; images?: Record<string, { url?: string; mp4?: string; width?: string; height?: string }> };

function giphyView(g: GiphyItem) {
  const preview = g.images?.fixed_width_small?.mp4 ?? g.images?.fixed_width?.mp4 ?? g.images?.preview?.mp4 ?? null;
  const still = g.images?.fixed_width_small_still?.url ?? g.images?.fixed_width_still?.url ?? null;
  return { id: String(g.id ?? ""), title: g.title ?? "", preview, still };
}

/** GIF search (GIPHY), when a GIPHY key is set; otherwise the console offers uploading a GIF. */
router.get("/academy/console/academies/:academyId/whatsapp/gifs", async (req, res): Promise<void> => {
  const access = await academyAccess(req, res);
  if (!access) return;
  const key = giphyKey();
  if (!key) {
    res.json({ enabled: false, results: [] });
    return;
  }
  const q = String(req.query.q ?? "").trim().slice(0, 50);
  const url = q
    ? `https://api.giphy.com/v1/gifs/search?api_key=${encodeURIComponent(key)}&q=${encodeURIComponent(q)}&limit=24&rating=g`
    : `https://api.giphy.com/v1/gifs/trending?api_key=${encodeURIComponent(key)}&limit=24&rating=g`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    const data = (await response.json()) as { data?: GiphyItem[] };
    res.json({ enabled: true, results: (data.data ?? []).map(giphyView).filter((g) => g.id && g.preview) });
  } catch {
    res.status(502).json({ error: "GIF search isn't answering. Try again." });
  }
});

router.post("/academy/console/academies/:academyId/whatsapp/gifs", async (req, res): Promise<void> => {
  const access = await academyAccess(req, res);
  if (!access) return;
  const key = giphyKey();
  const id = String(req.body?.id ?? "");
  if (!key || !/^[A-Za-z0-9]{4,40}$/.test(id)) {
    res.status(400).json({ error: "Pick a GIF" });
    return;
  }
  try {
    const info = (await (await fetch(`https://api.giphy.com/v1/gifs/${id}?api_key=${encodeURIComponent(key)}`, { signal: AbortSignal.timeout(10_000) })).json()) as { data?: GiphyItem };
    const mp4 = info.data?.images?.downsized_small?.mp4 ?? info.data?.images?.original?.mp4 ?? info.data?.images?.fixed_width?.mp4;
    if (!mp4 || !/^https:\/\/[a-z0-9.-]*giphy\.com\//.test(mp4)) throw new Error("No MP4 for this GIF");
    const file = await fetch(mp4, { signal: AbortSignal.timeout(20_000) });
    const bytes = Buffer.from(await file.arrayBuffer());
    if (!file.ok || bytes.length === 0 || bytes.length > MAX_CHAT_MEDIA_BYTES) throw new Error("GIF download failed");
    const media = await storeChatMedia(access.academyId, bytes, "video/mp4", "gif.mp4");
    res.status(201).json({ media, gif: true });
  } catch (error) {
    logger.warn({ error: (error as Error).message }, "Picking a GIF failed");
    res.status(502).json({ error: "That GIF couldn't be added. Try another." });
  }
});

// ─── Starting a chat, and who a chat is handed to ────────────────────────────

/** Is this number on WhatsApp? Used before opening a new chat. */
router.post("/academy/console/academies/:academyId/whatsapp/check", async (req, res): Promise<void> => {
  const access = await academyAccess(req, res);
  if (!access) return;
  const phone = normalizePhone(String(req.body?.phone ?? ""));
  if (!phone) {
    res.status(400).json({ error: "Enter a number, e.g. 0791234567" });
    return;
  }
  const settings = await getWhatsappSettings(access.academyId);
  const session = senderSessionFor(settings);
  let onWhatsapp: boolean | null = null;
  if (session && wahaConfigured()) {
    try {
      onWhatsapp = Boolean(await checkNumber(session, phone));
    } catch {
      onWhatsapp = null;
    }
  }
  const [contact] = await db.select({ name: academyContactsTable.name }).from(academyContactsTable)
    .where(and(eq(academyContactsTable.academyId, access.academyId), eq(academyContactsTable.phone, phone)));
  res.json({ phone, display: formatPhoneForDisplay(phone), onWhatsapp, name: contact?.name ?? null });
});

/** The academy's team, for "hand this chat to…". */
router.get("/academy/console/academies/:academyId/whatsapp/assignees", async (req, res): Promise<void> => {
  const access = await academyAccess(req, res);
  if (!access) return;
  res.json((await academyTeam(access.academyId)).map((m) => ({ ...m, me: m.id === access.user.id })));
});

async function academyTeam(academyId: number) {
  const rows = await db.select({ id: usersTable.id, name: usersTable.name, role: academyMembersTable.role })
    .from(academyMembersTable).innerJoin(usersTable, eq(usersTable.id, academyMembersTable.userId))
    .where(eq(academyMembersTable.academyId, academyId));
  const rank: Record<string, number> = { owner: 0, manager: 1, coach: 2 };
  const byUser = new Map<number, { id: number; name: string; role: string }>();
  for (const r of rows) {
    const seen = byUser.get(r.id);
    if (!seen || rank[r.role] < rank[seen.role]) byUser.set(r.id, { id: r.id, name: r.name, role: r.role });
  }
  return [...byUser.values()].sort((a, b) => rank[a.role] - rank[b.role] || a.name.localeCompare(b.name));
}

router.post("/academy/console/academies/:academyId/whatsapp/chats/:phone/assign", async (req, res): Promise<void> => {
  const access = await academyAccess(req, res);
  if (!access) return;
  const phone = chatKeyParam(req, res);
  if (!phone) return;
  const raw = req.body?.userId;
  const userId = raw === null ? null : Number(raw);
  if (userId !== null && !(Number.isSafeInteger(userId) && userId > 0)) {
    res.status(400).json({ error: "Pick someone on the team" });
    return;
  }
  if (userId !== null && !(await academyTeam(access.academyId)).some((m) => m.id === userId)) {
    res.status(404).json({ error: "That person isn't on this academy's team" });
    return;
  }
  if (isGroupKey(phone)) {
    const group = await groupRow(access.academyId, phone);
    if (!group) {
      res.status(404).json({ error: "Group not found" });
      return;
    }
    await db.update(academyWhatsappGroupsTable).set({ assignedUserId: userId, updatedAt: new Date() }).where(eq(academyWhatsappGroupsTable.id, group.id));
  } else {
    const contact = await upsertContact(access.academyId, phone, { source: "chat" });
    await db.update(academyContactsTable).set({ assignedUserId: userId, updatedAt: new Date() }).where(eq(academyContactsTable.id, contact.id));
  }
  res.json({ phone, assignedUserId: userId });
});

// ─── Groups ──────────────────────────────────────────────────────────────────

const GroupCreateBody = z.object({
  subject: z.string().trim().min(1).max(100),
  contactIds: z.array(z.number().int().positive()).max(1000).optional(),
  audience: AudienceBody.optional(),
  phones: z.array(z.string().max(40)).max(1000).optional(),
});

/** Create a WhatsApp group from the academy's number with picked people, a squad's families, or numbers. */
router.post("/academy/console/academies/:academyId/whatsapp/groups", async (req, res): Promise<void> => {
  const access = await academyAccess(req, res);
  if (!access) return;
  const body = GroupCreateBody.safeParse(req.body ?? {});
  if (!body.success) {
    res.status(400).json({ error: "Name the group and pick who is in it" });
    return;
  }
  const settings = await getWhatsappSettings(access.academyId);
  const session = senderSessionFor(settings);
  if (!session) {
    res.status(409).json({ error: "Turn WhatsApp on first: link your number or choose Replay's number." });
    return;
  }
  const phones = new Set<string>();
  for (const raw of body.data.phones ?? []) {
    const phone = normalizePhone(raw);
    if (phone) phones.add(phone);
  }
  if (body.data.contactIds?.length) {
    for (const r of await contactRecipients(access.academyId, body.data.contactIds)) phones.add(r.phone);
  }
  let squadId: number | null = null;
  if (body.data.audience) {
    if (!(await validateAudience(access.academyId, body.data.audience, res))) return;
    for (const r of (await resolveAudience(access.academyId, body.data.audience)).recipients) phones.add(r.phone);
    if (body.data.audience.squadIds?.length === 1) squadId = body.data.audience.squadIds[0];
  }
  const blocked = await blockedPhones(access.academyId);
  const members = [...phones].filter((p) => !blocked.has(p));
  if (members.length === 0) {
    res.status(400).json({ error: "Pick at least one person with a WhatsApp number" });
    return;
  }
  if (members.length > 1000) {
    res.status(400).json({ error: "A WhatsApp group holds up to 1,000 people" });
    return;
  }
  try {
    const created = await createGroup(session, body.data.subject, members.map((p) => `${p}@c.us`));
    const [row] = await db.insert(academyWhatsappGroupsTable).values({
      academyId: access.academyId,
      groupId: created.id,
      session,
      subject: body.data.subject,
      origin: "replay",
      squadId,
      createdBy: access.user.id,
    }).onConflictDoNothing().returning();
    res.status(201).json({ phone: groupKey(created.id), group: row ? groupView(row) : null, members: members.length });
  } catch (error) {
    wahaFailure(res, error, "Creating the group failed");
  }
});

/** Groups the academy's own number is already in, to follow one in Chats. */
router.get("/academy/console/academies/:academyId/whatsapp/groups/available", async (req, res): Promise<void> => {
  const access = await academyAccess(req, res);
  if (!access) return;
  if (!(await canManageChats(access))) {
    res.status(403).json({ error: "Only the academy owner can add the phone's groups, unless he gives your role that permission.", code: "chats_manage" });
    return;
  }
  const settings = await getWhatsappSettings(access.academyId);
  if (settings.sender !== "own") {
    res.status(409).json({ error: "Adding existing groups works with the academy's own linked number." });
    return;
  }
  try {
    const groups = await listGroups(academySessionName(access.academyId));
    const followed = new Set((await db.select({ groupId: academyWhatsappGroupsTable.groupId }).from(academyWhatsappGroupsTable)
      .where(eq(academyWhatsappGroupsTable.academyId, access.academyId))).map((g) => g.groupId));
    res.json(groups.map((g) => ({ ...g, followed: followed.has(g.id) })).sort((a, b) => a.subject.localeCompare(b.subject)));
  } catch (error) {
    wahaFailure(res, error, "Listing the phone's groups failed");
  }
});

router.post("/academy/console/academies/:academyId/whatsapp/groups/follow", async (req, res): Promise<void> => {
  const access = await academyAccess(req, res);
  if (!access) return;
  if (!(await canManageChats(access))) {
    res.status(403).json({ error: "Only the academy owner can add the phone's groups, unless he gives your role that permission.", code: "chats_manage" });
    return;
  }
  const groupId = String(req.body?.groupId ?? "").replace(/@g\.us$/, "");
  const subject = String(req.body?.subject ?? "").trim().slice(0, 100) || "Group";
  if (!isGroupKey(groupKey(groupId))) {
    res.status(400).json({ error: "Pick a group" });
    return;
  }
  const settings = await getWhatsappSettings(access.academyId);
  if (settings.sender !== "own") {
    res.status(409).json({ error: "Adding existing groups works with the academy's own linked number." });
    return;
  }
  const [row] = await db.insert(academyWhatsappGroupsTable).values({
    academyId: access.academyId,
    groupId,
    session: academySessionName(access.academyId),
    subject,
    origin: "existing",
    createdBy: access.user.id,
  }).onConflictDoNothing().returning();
  res.status(201).json({ phone: groupKey(groupId), group: row ? groupView(row) : null });
});

router.post("/academy/console/academies/:academyId/whatsapp/groups/:groupId/participants", async (req, res): Promise<void> => {
  const access = await academyAccess(req, res);
  if (!access) return;
  const group = await groupRow(access.academyId, groupKey(rawParam(req.params.groupId)));
  if (!group) {
    res.status(404).json({ error: "Group not found" });
    return;
  }
  const phones = (Array.isArray(req.body?.phones) ? req.body.phones as unknown[] : [])
    .map((p) => normalizePhone(String(p))).filter((p): p is string => Boolean(p)).slice(0, 200);
  const contactIds = Array.isArray(req.body?.contactIds) ? (req.body.contactIds as unknown[]).map(Number).filter((n) => Number.isSafeInteger(n) && n > 0) : [];
  if (contactIds.length) for (const r of await contactRecipients(access.academyId, contactIds)) phones.push(r.phone);
  if (phones.length === 0) {
    res.status(400).json({ error: "Pick who to add" });
    return;
  }
  try {
    await addGroupParticipants(group.session, group.groupId, [...new Set(phones)].map((p) => `${p}@c.us`));
    res.json({ added: new Set(phones).size });
  } catch (error) {
    wahaFailure(res, error, "Adding people to the group failed");
  }
});

// ─── People (CRM) ────────────────────────────────────────────────────────────

const KINDS = ["unknown", "lead", "parent", "player", "coach", "staff", "other"] as const;
const STAGES = ["new", "contacted", "trial", "joined", "lost"] as const;
const RELATIONSHIPS = ["father", "mother", "guardian", "sibling", "relative", "self", "other"] as const;
const Tags = z.array(z.string().trim().min(1).max(40)).max(20);

router.get("/academy/console/academies/:academyId/contacts", async (req, res): Promise<void> => {
  const access = await academyAccess(req, res);
  if (!access) return;
  await syncAcademyContacts(access.academyId);
  const contacts = (await listContacts(access.academyId)).filter((c) => !c.personalAt);
  const optOuts = await optedOutPhones(access.academyId);
  res.json(contacts.map((c) => ({
    id: c.id,
    phone: c.phone,
    display: formatPhoneForDisplay(c.phone),
    name: c.name,
    kind: c.kind,
    stage: c.stage,
    source: c.source,
    tags: c.tags,
    notes: c.notes,
    players: c.players,
    lastMessageAt: c.lastMessageAt,
    optedOut: optOuts.has(c.phone),
    blocked: Boolean(c.blockedAt),
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  })));
});

const ContactBody = z.object({
  phone: z.string().max(40).optional(),
  name: z.string().trim().max(120).nullable().optional(),
  kind: z.enum(KINDS).optional(),
  stage: z.enum(STAGES).nullable().optional(),
  tags: Tags.optional(),
  notes: z.string().max(4000).nullable().optional(),
  links: z.array(z.object({ playerId: z.number().int().positive(), relationship: z.enum(RELATIONSHIPS) })).max(20).optional(),
});

async function playerInAcademy(academyId: number, playerId: number): Promise<boolean> {
  const [row] = await db.select({ id: academyPlayersTable.id }).from(academyPlayersTable)
    .where(and(eq(academyPlayersTable.id, playerId), eq(academyPlayersTable.academyId, academyId)));
  return Boolean(row);
}

async function contactInAcademy(academyId: number, contactId: number) {
  const [row] = await db.select().from(academyContactsTable)
    .where(and(eq(academyContactsTable.id, contactId), eq(academyContactsTable.academyId, academyId)));
  return row ?? null;
}

async function respondContact(res: Response, academyId: number, contactId: number, status = 200) {
  const contact = await contactInAcademy(academyId, contactId);
  if (!contact) {
    res.status(404).json({ error: "Person not found" });
    return;
  }
  const links = await linksForContacts([contact.id]);
  res.status(status).json(contactView(contact, links.get(contact.id) ?? []));
}

router.post("/academy/console/academies/:academyId/contacts", async (req, res): Promise<void> => {
  const access = await academyAccess(req, res);
  if (!access) return;
  const body = ContactBody.safeParse(req.body ?? {});
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const phone = normalizePhone(body.data.phone);
  if (!phone) {
    res.status(400).json({ error: "Enter a valid phone number, e.g. 0791234567" });
    return;
  }
  for (const link of body.data.links ?? []) {
    if (!(await playerInAcademy(access.academyId, link.playerId))) {
      res.status(404).json({ error: "Player not found in this academy" });
      return;
    }
  }
  const contact = await upsertContact(access.academyId, phone, { source: "manual" });
  const kind = body.data.kind ?? (body.data.links?.length ? (body.data.links.some((l) => l.relationship === "self") ? "player" : "parent") : contact.kind);
  await db.update(academyContactsTable).set({
    ...(body.data.name !== undefined ? { name: body.data.name || null } : {}),
    kind,
    stage: body.data.stage !== undefined ? body.data.stage : kind === "lead" ? (contact.stage ?? "new") : contact.stage,
    ...(body.data.tags ? { tags: body.data.tags } : {}),
    ...(body.data.notes !== undefined ? { notes: body.data.notes } : {}),
    updatedAt: new Date(),
  }).where(eq(academyContactsTable.id, contact.id));
  for (const link of body.data.links ?? []) await linkContactToPlayer(contact.id, link.playerId, link.relationship, true);
  await respondContact(res, access.academyId, contact.id, 201);
});

router.patch("/academy/console/academies/:academyId/contacts/:contactId", async (req, res): Promise<void> => {
  const access = await academyAccess(req, res);
  if (!access) return;
  const contactId = intParam(req.params.contactId);
  const contact = contactId ? await contactInAcademy(access.academyId, contactId) : null;
  if (!contact) {
    res.status(404).json({ error: "Person not found" });
    return;
  }
  const body = ContactBody.omit({ phone: true, links: true }).safeParse(req.body ?? {});
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const nextKind = body.data.kind ?? contact.kind;
  await db.update(academyContactsTable).set({
    ...(body.data.name !== undefined ? { name: body.data.name || null } : {}),
    ...(body.data.kind ? { kind: body.data.kind } : {}),
    ...(body.data.stage !== undefined
      ? { stage: body.data.stage }
      : nextKind === "lead" && !contact.stage ? { stage: "new" } : {}),
    ...(body.data.tags ? { tags: body.data.tags } : {}),
    ...(body.data.notes !== undefined ? { notes: body.data.notes } : {}),
    updatedAt: new Date(),
  }).where(eq(academyContactsTable.id, contact.id));
  await respondContact(res, access.academyId, contact.id);
});

router.delete("/academy/console/academies/:academyId/contacts/:contactId", async (req, res): Promise<void> => {
  const access = await academyAccess(req, res, true);
  if (!access) return;
  const contactId = intParam(req.params.contactId);
  if (!contactId) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  await db.delete(academyContactsTable)
    .where(and(eq(academyContactsTable.id, contactId), eq(academyContactsTable.academyId, access.academyId)));
  res.status(204).send();
});

const LinkBody = z.object({ relationship: z.enum(RELATIONSHIPS) });

router.put("/academy/console/academies/:academyId/contacts/:contactId/players/:playerId", async (req, res): Promise<void> => {
  const access = await academyAccess(req, res);
  if (!access) return;
  const contactId = intParam(req.params.contactId);
  const playerId = intParam(req.params.playerId);
  const contact = contactId ? await contactInAcademy(access.academyId, contactId) : null;
  if (!contact || !playerId || !(await playerInAcademy(access.academyId, playerId))) {
    res.status(404).json({ error: "Person or player not found" });
    return;
  }
  const body = LinkBody.safeParse(req.body ?? {});
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  await linkContactToPlayer(contact.id, playerId, body.data.relationship as Relationship, true);
  // Linking sorts the person: a parent or relative, or the player themself.
  if (contact.kind === "unknown" || contact.kind === "lead" || contact.kind === "other") {
    await db.update(academyContactsTable).set({
      kind: (body.data.relationship === "self" ? "player" : "parent") as ContactKind,
      stage: contact.kind === "lead" ? ("joined" as LeadStage) : contact.stage,
      updatedAt: new Date(),
    }).where(eq(academyContactsTable.id, contact.id));
  }
  await respondContact(res, access.academyId, contact.id);
});

router.delete("/academy/console/academies/:academyId/contacts/:contactId/players/:playerId", async (req, res): Promise<void> => {
  const access = await academyAccess(req, res);
  if (!access) return;
  const contactId = intParam(req.params.contactId);
  const playerId = intParam(req.params.playerId);
  const contact = contactId ? await contactInAcademy(access.academyId, contactId) : null;
  if (!contact || !playerId) {
    res.status(404).json({ error: "Person not found" });
    return;
  }
  await db.delete(academyContactPlayersTable).where(and(
    eq(academyContactPlayersTable.contactId, contact.id),
    eq(academyContactPlayersTable.playerId, playerId),
  ));
  await respondContact(res, access.academyId, contact.id);
});

export default router;
