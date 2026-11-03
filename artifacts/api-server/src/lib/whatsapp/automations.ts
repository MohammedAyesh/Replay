import { randomBytes } from "node:crypto";
import { and, eq, gt, gte, inArray, isNotNull, isNull, like, lte } from "drizzle-orm";
import {
  academiesTable,
  academyFeesTable,
  academyPlayersTable,
  academySessionsTable,
  academySquadsTable,
  academyWhatsappMessagesTable,
  academyWhatsappSettingsTable,
  db,
} from "@workspace/db";
import { logger } from "../logger";
import { getWhatsappSettings, enqueueMessages, senderSessionFor, type OutgoingMessage } from "./queue";
import {
  dedupePerPlayer,
  joinNames,
  mergeByPhone,
  resolveAudience,
  type AudienceScope,
  type Recipient,
} from "./recipients";
import {
  allSquadsLabel,
  effectiveAutomations,
  formatCalendarDate,
  formatDate,
  formatDay,
  formatFils,
  formatTime,
  opponentFragment,
  renderTemplate,
  sessionTypeLabel,
  type AutomationKey,
  type EffectiveAutomation,
  type WhatsappLocale,
} from "./templates";
import { linkContactToPlayer, upsertContact } from "./contacts";
import { normalizePhone } from "./phone";
import { publicBaseUrl } from "./waha";

type Context = {
  academyId: number;
  academyName: string;
  locale: WhatsappLocale;
  automation: EffectiveAutomation;
};

/** The automation's config, or null when WhatsApp is off or this automation is. */
async function automationContext(
  academyId: number,
  key: AutomationKey,
  options: { ignoreEnabled?: boolean } = {},
): Promise<Context | null> {
  const settings = await getWhatsappSettings(academyId);
  if (!senderSessionFor(settings)) return null;
  const automation = effectiveAutomations(settings.automations, settings.locale)[key];
  if (!automation.enabled && !options.ignoreEnabled) return null;
  const [academy] = await db.select({ name: academiesTable.name }).from(academiesTable).where(eq(academiesTable.id, academyId));
  if (!academy) return null;
  return { academyId, academyName: academy.name, locale: settings.locale, automation };
}

function greetingName(name: string | null, locale: WhatsappLocale): string {
  return name?.trim() || (locale === "ar" ? "" : "there");
}

/** One message per phone; {player} names every child of that parent in scope. */
async function queueMerged(
  ctx: Context,
  scope: Omit<AudienceScope, "roles">,
  values: (r: { role: Recipient["role"]; playerNames: string[]; squadNames: string[] }) => Record<string, string>,
  dedupe: (phone: string) => string,
  extra: Partial<OutgoingMessage> = {},
): Promise<number> {
  if (ctx.automation.audiences.length === 0) return 0;
  const { recipients } = await resolveAudience(ctx.academyId, { ...scope, roles: ctx.automation.audiences });
  const merged = mergeByPhone(recipients);
  return enqueueMessages(merged.map((r) => ({
    academyId: ctx.academyId,
    kind: ctx.automation.key,
    phone: r.phone,
    recipientName: r.name,
    recipientRole: r.role,
    playerId: r.playerIds.length === 1 ? r.playerIds[0] : null,
    dedupeKey: dedupe(r.phone),
    body: renderTemplate(ctx.automation.template, {
      academy: ctx.academyName,
      name: greetingName(r.name, ctx.locale),
      player: joinNames(r.playerNames, ctx.locale),
      ...values(r),
    }),
    ...extra,
  })));
}

/** One message per (phone, player): absences, fees, receipts. */
async function queuePerPlayer(
  ctx: Context,
  playerIds: number[],
  values: (r: Recipient) => Record<string, string>,
  dedupe: (r: Recipient) => string,
): Promise<number> {
  if (ctx.automation.audiences.length === 0 || playerIds.length === 0) return 0;
  const { recipients } = await resolveAudience(ctx.academyId, {
    roles: ctx.automation.audiences.filter((r) => r !== "coaches"),
    squadIds: null,
    playerIds,
  });
  return enqueueMessages(dedupePerPlayer(recipients).map((r) => ({
    academyId: ctx.academyId,
    kind: ctx.automation.key,
    phone: r.phone,
    recipientName: r.name,
    recipientRole: r.role,
    playerId: r.playerId,
    dedupeKey: dedupe(r),
    body: renderTemplate(ctx.automation.template, {
      academy: ctx.academyName,
      name: greetingName(r.name, ctx.locale),
      player: r.playerName ?? "",
      squad: r.squadName ?? "",
      ...values(r),
    }),
  })));
}

/** Run a hook without ever failing the request that triggered it. */
async function safely(label: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    logger.warn({ error: (error as Error)?.message ?? error, hook: label }, "WhatsApp automation failed");
  }
}

// ─── Sessions ────────────────────────────────────────────────────────────────

export type SessionSnapshot = {
  id: number;
  academyId: number;
  squadId: number | null;
  type: string;
  startsAt: Date;
  location: string;
  opponent: string | null;
};

export async function loadSessionSnapshot(academyId: number, sessionId: number): Promise<SessionSnapshot | null> {
  const [row] = await db
    .select({
      id: academySessionsTable.id,
      academyId: academySessionsTable.academyId,
      squadId: academySessionsTable.squadId,
      type: academySessionsTable.type,
      startsAt: academySessionsTable.startsAt,
      location: academySessionsTable.location,
      opponent: academySessionsTable.opponent,
    })
    .from(academySessionsTable)
    .where(and(eq(academySessionsTable.id, sessionId), eq(academySessionsTable.academyId, academyId)));
  return row ?? null;
}

async function squadName(squadId: number | null, locale: WhatsappLocale): Promise<string> {
  if (squadId === null) return allSquadsLabel(locale);
  const [row] = await db.select({ name: academySquadsTable.name }).from(academySquadsTable).where(eq(academySquadsTable.id, squadId));
  return row?.name ?? allSquadsLabel(locale);
}

async function sessionValues(session: SessionSnapshot, locale: WhatsappLocale): Promise<Record<string, string>> {
  return {
    squad: await squadName(session.squadId, locale),
    type: sessionTypeLabel(session.type, locale),
    day: formatDay(session.startsAt, locale),
    date: formatDate(session.startsAt, locale),
    time: formatTime(session.startsAt, locale),
    location: session.location,
    opponent: opponentFragment(session.opponent, locale),
  };
}

function sessionScope(session: SessionSnapshot): Omit<AudienceScope, "roles"> {
  return { squadIds: session.squadId === null ? null : [session.squadId], playerIds: null };
}

/** Drop reminders still waiting for a session that moved or was cancelled. */
async function dropQueuedSessionReminders(academyId: number, sessionId: number): Promise<void> {
  await db.delete(academyWhatsappMessagesTable).where(and(
    eq(academyWhatsappMessagesTable.academyId, academyId),
    eq(academyWhatsappMessagesTable.status, "queued"),
    like(academyWhatsappMessagesTable.dedupeKey, `a${academyId}:s${sessionId}:reminder:%`),
  ));
}

export async function onSessionCreated(academyId: number, sessionId: number): Promise<void> {
  await safely("session_created", async () => {
    const session = await loadSessionSnapshot(academyId, sessionId);
    if (!session || session.startsAt.getTime() <= Date.now()) return;
    const ctx = await automationContext(academyId, "session_created");
    if (!ctx) return;
    const values = await sessionValues(session, ctx.locale);
    await queueMerged(ctx, sessionScope(session), () => values, (phone) => `a${academyId}:s${sessionId}:created:${phone}`);
  });
}

export async function onSessionChanged(academyId: number, before: SessionSnapshot | null, sessionId: number): Promise<void> {
  await safely("session_changed", async () => {
    const after = await loadSessionSnapshot(academyId, sessionId);
    if (!after || !before) return;
    const moved = before.startsAt.getTime() !== after.startsAt.getTime() || before.location !== after.location;
    if (!moved) return;
    await dropQueuedSessionReminders(academyId, sessionId);
    if (after.startsAt.getTime() <= Date.now()) return;
    const ctx = await automationContext(academyId, "session_changed");
    if (!ctx) return;
    const values = await sessionValues(after, ctx.locale);
    const stamp = `${after.startsAt.getTime()}:${Buffer.from(after.location).toString("base64url").slice(0, 24)}`;
    await queueMerged(ctx, sessionScope(after), () => values, (phone) => `a${academyId}:s${sessionId}:changed:${stamp}:${phone}`);
  });
}

export async function onSessionCancelled(snapshot: SessionSnapshot | null): Promise<void> {
  if (!snapshot) return;
  await safely("session_cancelled", async () => {
    await dropQueuedSessionReminders(snapshot.academyId, snapshot.id);
    if (snapshot.startsAt.getTime() <= Date.now()) return;
    const ctx = await automationContext(snapshot.academyId, "session_cancelled");
    if (!ctx) return;
    const values = await sessionValues(snapshot, ctx.locale);
    await queueMerged(ctx, sessionScope(snapshot), () => values, (phone) => `a${snapshot.academyId}:s${snapshot.id}:cancelled:${phone}`);
  });
}

// ─── Attendance ──────────────────────────────────────────────────────────────

export async function onAttendanceMarked(
  academyId: number,
  sessionId: number,
  entries: Array<{ playerId: number; status: string | null }>,
): Promise<void> {
  const absent = entries.filter((e) => e.status === "absent").map((e) => e.playerId);
  if (absent.length === 0) return;
  await safely("absence_notice", async () => {
    const session = await loadSessionSnapshot(academyId, sessionId);
    if (!session) return;
    // A roll call fixed days later is a correction, not news for parents.
    if (Date.now() - session.startsAt.getTime() > 36 * 3_600_000) return;
    const ctx = await automationContext(academyId, "absence_notice");
    if (!ctx) return;
    const values = await sessionValues(session, ctx.locale);
    await queuePerPlayer(
      ctx,
      absent,
      () => ({ type: values.type, day: values.day, date: values.date, time: values.time }),
      (r) => `a${academyId}:att${sessionId}:p${r.playerId}:absent:${r.phone}`,
    );
  });
}

// ─── Money ───────────────────────────────────────────────────────────────────

export async function onRenewalRecorded(
  academyId: number,
  renewal: { id: number; playerId: number; monthsPurchased: number; amountFils: number; newExpiresOn: string },
): Promise<void> {
  await safely("payment_receipt", async () => {
    const ctx = await automationContext(academyId, "payment_receipt");
    if (!ctx) return;
    const months = renewal.monthsPurchased;
    const expires = formatCalendarDate(renewal.newExpiresOn);
    const details = ctx.locale === "ar"
      ? `تجديد ${months} ${months === 1 ? "شهر" : months === 2 ? "شهرين" : months <= 10 ? "أشهر" : "شهر"} — الاشتراك ساري لغاية ${expires}`
      : `Renewal for ${months} month${months === 1 ? "" : "s"} — subscription valid until ${expires}`;
    await queuePerPlayer(
      ctx,
      [renewal.playerId],
      () => ({ amount: formatFils(renewal.amountFils, ctx.locale), details, expires, months: String(months) }),
      (r) => `a${academyId}:ren${renewal.id}:${r.phone}`,
    );
  });
}

export async function onFeePaid(academyId: number, fee: { id: number; playerId: number; label: string; amountFils: number }): Promise<void> {
  await safely("payment_receipt", async () => {
    const ctx = await automationContext(academyId, "payment_receipt");
    if (!ctx) return;
    await queuePerPlayer(
      ctx,
      [fee.playerId],
      () => ({ amount: formatFils(fee.amountFils, ctx.locale), details: fee.label, label: fee.label }),
      (r) => `a${academyId}:feepaid${fee.id}:${r.phone}`,
    );
  });
}

// ─── Footage ─────────────────────────────────────────────────────────────────

export async function onFootageReady(academyId: number, sessionId: number, recordingId: number): Promise<void> {
  await safely("review_request", async () => {
    const session = await loadSessionSnapshot(academyId, sessionId);
    if (!session || Date.now() - session.startsAt.getTime() > 7 * 86_400_000) return;
    await queueReviewRequests(academyId, session);
  });
  await safely("footage_ready", async () => {
    const session = await loadSessionSnapshot(academyId, sessionId);
    if (!session) return;
    if (Date.now() - session.startsAt.getTime() > 7 * 86_400_000) return;
    const ctx = await automationContext(academyId, "footage_ready");
    if (!ctx) return;
    const values = await sessionValues(session, ctx.locale);
    const base = publicBaseUrl();
    await queueMerged(
      ctx,
      sessionScope(session),
      (r) => ({ ...values, link: r.role === "coach" ? `${base}/academy/recordings` : `${base}/academy/me` }),
      (phone) => `a${academyId}:foot${recordingId}:s${sessionId}:${phone}`,
    );
  });
}

// ─── Review requests ─────────────────────────────────────────────────────────

/** Academic terms in Jordan as the academies run them: Sep–Dec, Jan–Apr, May–Aug. */
export function reviewTerm(at: Date): string {
  const [y, m] = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Amman", year: "numeric", month: "2-digit" }).format(at).split("-").map(Number);
  return m >= 9 ? `${y}-sep` : m >= 5 ? `${y}-may` : `${y}-jan`;
}

/** 7 pm in Amman on the day after `at` (Jordan is UTC+3 all year). */
export function nextDaySevenPm(at: Date): Date {
  const [y, m, d] = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Amman", year: "numeric", month: "2-digit", day: "2-digit" }).format(at).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1, 19 - 3, 0, 0));
}

/**
 * The Google review request, after a match video is ready: to the families of
 * the squad, the next day at 7 pm, once per family per term. Off by default.
 */
export async function queueReviewRequests(academyId: number, session: SessionSnapshot, now = new Date()): Promise<number> {
  const ctx = await automationContext(academyId, "review_request");
  if (!ctx) return 0;
  const [academy] = await db.select({ url: academiesTable.googleReviewUrl }).from(academiesTable).where(eq(academiesTable.id, academyId));
  if (!academy?.url) return 0;
  const term = reviewTerm(now);
  return queueMerged(
    ctx,
    sessionScope(session),
    () => ({ link: academy.url! }),
    (phone) => `a${academyId}:review:${term}:${phone}`,
    { scheduledFor: nextDaySevenPm(now) },
  );
}

// ─── Registrations ───────────────────────────────────────────────────────────

export async function onRegistrationReceived(
  academyId: number,
  registration: { id: number; playerName: string; guardianName: string | null; guardianPhone: string; locale: string },
): Promise<void> {
  await safely("registration_contact", async () => {
    const phone = normalizePhone(registration.guardianPhone);
    if (phone) {
      await upsertContact(academyId, phone, {
        kind: "lead",
        name: registration.guardianName,
        source: "registration",
        notes: `Registration: ${registration.playerName}`,
      });
    }
  });
  await safely("registration_received", async () => {
    const ctx = await automationContext(academyId, "registration_received");
    if (!ctx) return;
    const phone = normalizePhone(registration.guardianPhone);
    if (!phone) return;
    await enqueueMessages([{
      academyId,
      kind: ctx.automation.key,
      phone,
      recipientName: registration.guardianName,
      recipientRole: "parent",
      dedupeKey: `a${academyId}:reg${registration.id}:received`,
      body: renderTemplate(ctx.automation.template, {
        academy: ctx.academyName,
        name: greetingName(registration.guardianName, ctx.locale),
        player: registration.playerName,
      }),
    }]);
  });
}

export async function onRegistrationApproved(
  academyId: number,
  registration: { id: number; guardianName: string | null; guardianPhone: string; playerName: string; createdPlayerId: number | null },
): Promise<void> {
  await safely("registration_contact", async () => {
    const phone = normalizePhone(registration.guardianPhone);
    if (!phone) return;
    const contact = await upsertContact(academyId, phone, { kind: "parent", name: registration.guardianName, source: "registration" });
    if (registration.createdPlayerId) await linkContactToPlayer(contact.id, registration.createdPlayerId, "guardian");
  });
  await safely("registration_approved", async () => {
    const ctx = await automationContext(academyId, "registration_approved");
    if (!ctx) return;
    const phone = normalizePhone(registration.guardianPhone);
    if (!phone) return;
    let link = `${publicBaseUrl()}/academy/me`;
    let squad = "";
    if (registration.createdPlayerId) {
      const [player] = await db
        .select({ token: academyPlayersTable.familyToken, squadName: academySquadsTable.name })
        .from(academyPlayersTable)
        .leftJoin(academySquadsTable, eq(academySquadsTable.id, academyPlayersTable.squadId))
        .where(eq(academyPlayersTable.id, registration.createdPlayerId));
      let token = player?.token ?? null;
      if (player && !token) {
        // The parent's invite link: the same token the owner's "family link" button creates.
        const fresh = randomBytes(16).toString("hex");
        const [updated] = await db.update(academyPlayersTable)
          .set({ familyToken: fresh })
          .where(and(eq(academyPlayersTable.id, registration.createdPlayerId), isNull(academyPlayersTable.familyToken)))
          .returning({ token: academyPlayersTable.familyToken });
        token = updated?.token ?? null;
      }
      if (token) link = `${publicBaseUrl()}/p/${token}`;
      squad = player?.squadName ?? "";
    }
    await enqueueMessages([{
      academyId,
      kind: ctx.automation.key,
      phone,
      recipientName: registration.guardianName,
      recipientRole: "parent",
      playerId: registration.createdPlayerId,
      dedupeKey: `a${academyId}:reg${registration.id}:approved`,
      body: renderTemplate(ctx.automation.template, {
        academy: ctx.academyName,
        name: greetingName(registration.guardianName, ctx.locale),
        player: registration.playerName,
        squad,
        link,
      }),
    }]);
  });
}

// ─── Announcements ───────────────────────────────────────────────────────────

/** Sent only when the author ticks "also send on WhatsApp"; the automation sets audience and wording. */
export async function onAnnouncementPosted(
  academyId: number,
  announcement: { id: number; squadId: number | null; title: string; body: string; createdBy: number },
): Promise<number> {
  let queued = 0;
  await safely("announcement", async () => {
    const ctx = await automationContext(academyId, "announcement", { ignoreEnabled: true });
    if (!ctx) return;
    const squad = await squadName(announcement.squadId, ctx.locale);
    queued = await queueMerged(
      ctx,
      { squadIds: announcement.squadId === null ? null : [announcement.squadId], playerIds: null },
      () => ({ squad, title: announcement.title, message: announcement.body }),
      (phone) => `a${academyId}:ann${announcement.id}:${phone}`,
      { createdBy: announcement.createdBy },
    );
  });
  return queued;
}

// ─── Time-based (run from the tick) ──────────────────────────────────────────

function ammanToday(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Amman", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

function ammanHour(now = new Date()): number {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Amman", hour: "numeric", hour12: false }).format(now));
}

function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return t.toISOString().slice(0, 10);
}

/** Academies with WhatsApp on (own or Replay). */
async function activeAcademyIds(): Promise<number[]> {
  const rows = await db
    .select({ academyId: academyWhatsappSettingsTable.academyId })
    .from(academyWhatsappSettingsTable)
    .where(inArray(academyWhatsappSettingsTable.sender, ["own", "replay"]));
  return rows.map((r) => r.academyId);
}

export type SchedulerSummary = { reminders: number; fees: number; subscriptions: number };

export async function runScheduledAutomations(now = new Date()): Promise<SchedulerSummary> {
  const summary: SchedulerSummary = { reminders: 0, fees: 0, subscriptions: 0 };
  const academyIds = await activeAcademyIds();
  if (academyIds.length === 0) return summary;
  const today = ammanToday(now);
  // Money reminders only go out in the daytime.
  const daytime = ammanHour(now) >= 10 && ammanHour(now) < 21;

  for (const academyId of academyIds) {
    await safely("scheduler", async () => {
      // Session reminders: up to 48 h ahead, once per start time.
      const reminder = await automationContext(academyId, "session_reminder");
      if (reminder && reminder.automation.timing) {
        const hours = reminder.automation.timing;
        const sessions = await db
          .select({
            id: academySessionsTable.id,
            academyId: academySessionsTable.academyId,
            squadId: academySessionsTable.squadId,
            type: academySessionsTable.type,
            startsAt: academySessionsTable.startsAt,
            location: academySessionsTable.location,
            opponent: academySessionsTable.opponent,
            createdAt: academySessionsTable.createdAt,
          })
          .from(academySessionsTable)
          .where(and(
            eq(academySessionsTable.academyId, academyId),
            gt(academySessionsTable.startsAt, new Date(now.getTime() + 10 * 60_000)),
            lte(academySessionsTable.startsAt, new Date(now.getTime() + hours * 3_600_000)),
          ));
        for (const session of sessions) {
          const remindAt = session.startsAt.getTime() - hours * 3_600_000;
          // A session booked inside its own reminder window already got "new session".
          if (session.createdAt.getTime() > remindAt) continue;
          const values = await sessionValues(session, reminder.locale);
          summary.reminders += await queueMerged(
            reminder,
            sessionScope(session),
            () => values,
            (phone) => `a${academyId}:s${session.id}:reminder:${session.startsAt.getTime()}:${phone}`,
          );
        }
      }

      if (!daytime) return;

      const feeReminder = await automationContext(academyId, "fee_reminder");
      const feeOverdue = await automationContext(academyId, "fee_overdue");
      if (feeReminder || feeOverdue) {
        const fees = await db
          .select({
            id: academyFeesTable.id,
            playerId: academyFeesTable.playerId,
            label: academyFeesTable.label,
            amountFils: academyFeesTable.amountFils,
            dueDate: academyFeesTable.dueDate,
          })
          .from(academyFeesTable)
          .innerJoin(academyPlayersTable, eq(academyPlayersTable.id, academyFeesTable.playerId))
          .where(and(
            eq(academyFeesTable.academyId, academyId),
            eq(academyFeesTable.status, "due"),
            eq(academyPlayersTable.isActive, true),
            gt(academyFeesTable.amountFils, 0),
            gte(academyFeesTable.dueDate, addDays(today, -60)),
            lte(academyFeesTable.dueDate, addDays(today, 30)),
          ));
        for (const fee of fees) {
          const values = () => ({
            label: fee.label,
            amount: formatFils(fee.amountFils, (feeReminder ?? feeOverdue)!.locale),
            due_date: formatCalendarDate(fee.dueDate),
          });
          if (feeReminder?.automation.timing != null
            && today >= addDays(fee.dueDate, -feeReminder.automation.timing) && today <= fee.dueDate) {
            summary.fees += await queuePerPlayer(feeReminder, [fee.playerId], values,
              (r) => `a${academyId}:fee${fee.id}:reminder:${fee.dueDate}:${r.phone}`);
          }
          if (feeOverdue?.automation.timing != null && today >= addDays(fee.dueDate, feeOverdue.automation.timing)) {
            summary.fees += await queuePerPlayer(feeOverdue, [fee.playerId], values,
              (r) => `a${academyId}:fee${fee.id}:overdue:${fee.dueDate}:${r.phone}`);
          }
        }
      }

      const expiring = await automationContext(academyId, "subscription_expiring");
      if (expiring?.automation.timing != null) {
        const players = await db
          .select({ id: academyPlayersTable.id, expiresOn: academyPlayersTable.subscriptionExpiresOn })
          .from(academyPlayersTable)
          .where(and(
            eq(academyPlayersTable.academyId, academyId),
            eq(academyPlayersTable.isActive, true),
            isNotNull(academyPlayersTable.subscriptionExpiresOn),
            gte(academyPlayersTable.subscriptionExpiresOn, today),
            lte(academyPlayersTable.subscriptionExpiresOn, addDays(today, expiring.automation.timing)),
          ));
        for (const player of players) {
          const expiresOn = player.expiresOn!;
          summary.subscriptions += await queuePerPlayer(expiring, [player.id],
            () => ({ expires: formatCalendarDate(expiresOn) }),
            (r) => `a${academyId}:sub${player.id}:${expiresOn}:${r.phone}`);
        }
      }
    });
  }
  return summary;
}

/** For tests and the console preview. */
export const __test = { ammanToday, addDays, ammanHour };
