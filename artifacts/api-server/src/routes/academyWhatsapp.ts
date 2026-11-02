import { createHmac, timingSafeEqual } from "node:crypto";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import {
  academiesTable,
  academyPlayersTable,
  academySquadsTable,
  academyWhatsappBroadcastsTable,
  academyWhatsappMessagesTable,
  academyWhatsappOptOutsTable,
  academyWhatsappSettingsTable,
  db,
} from "@workspace/db";
import {
  requireAcademyConsoleUser,
  requireAcademyMembership,
  type AcademyConsoleUser,
} from "../lib/academyAccess";
import { logger } from "../lib/logger";
import { runScheduledAutomations } from "../lib/whatsapp/automations";
import { formatPhoneForDisplay, normalizePhone, phoneFromChatId } from "../lib/whatsapp/phone";
import {
  dispatchQueue,
  enqueueMessages,
  getWhatsappSettings,
  handleWahaWebhook,
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

const router: IRouter = Router();

function rawParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function intParam(value: string | string[] | undefined): number | null {
  const n = Number(rawParam(value));
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function wahaFailure(res: Response, error: unknown, fallback: string) {
  if (error instanceof WahaError) {
    const status = error.status === 503 ? 503 : error.status === 404 ? 404 : 502;
    res.status(status).json({ error: error.status === 503 ? "WhatsApp service is not set up yet" : error.message || fallback });
    return;
  }
  logger.warn({ error: (error as Error)?.message }, fallback);
  res.status(500).json({ error: fallback });
}

type Access = { user: AcademyConsoleUser; isOwner: boolean; academyId: number; academyName: string };

async function academyAccess(req: Request, res: Response, ownerOnly = false): Promise<Access | null> {
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

async function validateAudience(academyId: number, audience: z.infer<typeof AudienceBody>, res: Response): Promise<boolean> {
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
  const merged = mergeByPhone(resolved.recipients);
  const reachable = merged.filter((r) => !optOuts.has(r.phone));
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
  audience: AudienceBody,
  scheduledFor: z.string().datetime({ offset: true }).nullable().optional(),
});

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
  if (!(await validateAudience(access.academyId, body.data.audience, res))) return;
  const scheduledFor = body.data.scheduledFor ? new Date(body.data.scheduledFor) : new Date();
  if (scheduledFor.getTime() > Date.now() + 60 * 86_400_000) {
    res.status(400).json({ error: "Schedule within the next 60 days" });
    return;
  }

  const resolved = await resolveAudience(access.academyId, body.data.audience);
  const optOuts = await optedOutPhones(access.academyId);
  const merged = mergeByPhone(resolved.recipients).filter((r) => !optOuts.has(r.phone));
  if (merged.length === 0) {
    res.status(400).json({ error: "Nobody in this audience has a WhatsApp number on file" });
    return;
  }

  const [broadcast] = await db.insert(academyWhatsappBroadcastsTable).values({
    academyId: access.academyId,
    body: body.data.body,
    audience: body.data.audience,
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

router.get("/admin/whatsapp", async (req, res): Promise<void> => {
  if (!(await requireAdmin(req, res))) return;
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
});

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
  const scheduled = await runScheduledAutomations();
  const dispatched = await dispatchQueue({ budgetMs: Math.max(10_000, 50_000 - (Date.now() - started)) });
  res.json({ scheduled, dispatched, ms: Date.now() - started });
});

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

export default router;
