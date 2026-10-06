import { and, asc, desc, eq, gte, inArray, isNull, lt, or } from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
  academyFeesTable,
  academyAnnouncementsTable,
  academyAttendanceTable,
  academyPlayerGuardiansTable,
  academyPlayerRenewalsTable,
  academyPlayersTable,
  academyRecordingsTable,
  academySessionsTable,
  academySquadsTable,
  academiesTable,
  db,
  recordingsTable,
} from "@workspace/db";
import {
  ClaimAcademyFamilyBody,
  ClaimAcademyFamilyResponse,
  GetAcademyFamilyMeQueryParams,
  GetAcademyFamilyMeResponse,
} from "@workspace/api-zod";
import { getLocalUserRecord, unauthenticatedResponse } from "../lib/clerkUserBridge";
import { financePlayersForSquad } from "./academyFinance";
import { allowAcademyFamilyClaim } from "./academyJoin";

const router: IRouter = Router();
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_WINDOW_DAYS = 120;

function setNoStore(res: { setHeader(name: string, value: string): unknown }): void {
  res.setHeader("Cache-Control", "no-store");
}

function rawDate(value: unknown): unknown {
  return typeof value === "string" ? value : value === undefined ? undefined : "";
}

function ammanToday(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Amman",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function shiftDate(value: string, days: number): string {
  const [year, month, day] = value.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}-${String(shifted.getUTCDate()).padStart(2, "0")}`;
}

function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function parseFamilyWindow(fromValue: unknown, toValue: unknown):
  | { ok: true; startsAtOrAfter: Date; startsBefore: Date }
  | { ok: false; error: string } {
  const parsed = GetAcademyFamilyMeQueryParams.pick({ from: true, to: true }).safeParse({
    from: rawDate(fromValue),
    to: rawDate(toValue),
  });
  if (!parsed.success) return { ok: false, error: "Date window must use YYYY-MM-DD dates" };
  if ((parsed.data.from === undefined) !== (parsed.data.to === undefined)) {
    return { ok: false, error: "Both from and to dates are required together" };
  }

  const today = ammanToday();
  const from = parsed.data.from ?? shiftDate(today, -30);
  const to = parsed.data.to ?? shiftDate(today, 60);
  if (
    !isCalendarDate(from)
    || !isCalendarDate(to)
    || from > to
    || (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS > MAX_WINDOW_DAYS
  ) {
    return { ok: false, error: "Date window must be valid and no longer than 120 days" };
  }
  return {
    ok: true,
    startsAtOrAfter: new Date(`${from}T00:00:00.000Z`),
    startsBefore: new Date(`${shiftDate(to, 1)}T00:00:00.000Z`),
  };
}

const familyPlayerSelection = () => db
  .select({
    id: academyPlayersTable.id,
    academyId: academyPlayersTable.academyId,
    squadId: academyPlayersTable.squadId,
    userId: academyPlayersTable.userId,
    name: academyPlayersTable.name,
    jerseyNumber: academyPlayersTable.jerseyNumber,
    position: academyPlayersTable.position,
    academyName: academiesTable.name,
    logoUrl: academiesTable.logoUrl,
    contactPhone: academiesTable.contactPhone,
    squadName: academySquadsTable.name,
  })
  .from(academyPlayersTable)
  .innerJoin(academiesTable, eq(academiesTable.id, academyPlayersTable.academyId))
  .leftJoin(
    academySquadsTable,
    and(
      eq(academySquadsTable.id, academyPlayersTable.squadId),
      eq(academySquadsTable.academyId, academyPlayersTable.academyId),
    ),
  );

async function findFamilyPlayersForUser(userId: number) {
  const guardianLinks = await db
    .select({ playerId: academyPlayerGuardiansTable.playerId })
    .from(academyPlayerGuardiansTable)
    .where(eq(academyPlayerGuardiansTable.userId, userId));
  const playerIds = guardianLinks.map(({ playerId }) => playerId);
  const accessiblePlayer = playerIds.length > 0
    ? or(
        eq(academyPlayersTable.userId, userId),
        inArray(academyPlayersTable.id, playerIds),
      )
    : eq(academyPlayersTable.userId, userId);
  return familyPlayerSelection()
    .where(and(
      accessiblePlayer,
      eq(academyPlayersTable.isActive, true),
    ))
    .orderBy(asc(academyPlayersTable.name), asc(academyPlayersTable.id));
}

type FamilyPlayer = Awaited<ReturnType<typeof findFamilyPlayersForUser>>[number];
type FamilyWindow = Extract<ReturnType<typeof parseFamilyWindow>, { ok: true }>;

async function readFamilyView(
  player: FamilyPlayer,
  linkedPlayers: FamilyPlayer[],
  window: FamilyWindow,
) {
  let finance: {
    effectiveMonthlyFeeFils: number;
    subscriptionExpiresOn: string | null;
    subscriptionStatus: "no_subscription" | "paid" | "expiring" | "expired";
    monthsOwed: number;
    outstandingFils: number;
  } | null = null;
  if (player.squadId !== null) {
    const [squad] = await db
      .select()
      .from(academySquadsTable)
      .where(and(
        eq(academySquadsTable.id, player.squadId),
        eq(academySquadsTable.academyId, player.academyId),
      ));
    if (squad) {
      const summary = (await financePlayersForSquad(player.academyId, squad))
        .find((entry) => entry.id === player.id);
      if (summary) {
        finance = {
          effectiveMonthlyFeeFils: summary.effectiveMonthlyFeeFils,
          subscriptionExpiresOn: summary.subscriptionExpiresOn,
          subscriptionStatus: summary.subscriptionStatus,
          monthsOwed: summary.monthsOwed,
          outstandingFils: summary.outstandingFils,
        };
      }
    }
  }

  const sessionScope = player.squadId === null
    ? isNull(academySessionsTable.squadId)
    : or(isNull(academySessionsTable.squadId), eq(academySessionsTable.squadId, player.squadId));
  const announcementScope = player.squadId === null
    ? isNull(academyAnnouncementsTable.squadId)
    : or(isNull(academyAnnouncementsTable.squadId), eq(academyAnnouncementsTable.squadId, player.squadId));
  const paymentCutoff = new Date();
  paymentCutoff.setUTCFullYear(paymentCutoff.getUTCFullYear() - 1);

  const [sessions, attendance, announcements, renewals, fees] = await Promise.all([
    db.select({
      id: academySessionsTable.id,
      type: academySessionsTable.type,
      startsAt: academySessionsTable.startsAt,
      endsAt: academySessionsTable.endsAt,
      location: academySessionsTable.location,
      opponent: academySessionsTable.opponent,
      ownScore: academySessionsTable.ownScore,
      opponentScore: academySessionsTable.opponentScore,
    })
      .from(academySessionsTable)
      .where(and(
        eq(academySessionsTable.academyId, player.academyId),
        sessionScope,
        gte(academySessionsTable.startsAt, window.startsAtOrAfter),
        lt(academySessionsTable.startsAt, window.startsBefore),
      ))
      .orderBy(asc(academySessionsTable.startsAt), asc(academySessionsTable.id)),
    db.select({
      status: academyAttendanceTable.status,
      startsAt: academySessionsTable.startsAt,
      type: academySessionsTable.type,
      location: academySessionsTable.location,
    })
      .from(academyAttendanceTable)
      .innerJoin(academySessionsTable, eq(academySessionsTable.id, academyAttendanceTable.sessionId))
      .where(and(
        eq(academyAttendanceTable.playerId, player.id),
        eq(academySessionsTable.academyId, player.academyId),
        sessionScope,
        gte(academySessionsTable.startsAt, window.startsAtOrAfter),
        lt(academySessionsTable.startsAt, window.startsBefore),
      ))
      .orderBy(desc(academySessionsTable.startsAt), desc(academySessionsTable.id)),
    db.select({
      title: academyAnnouncementsTable.title,
      body: academyAnnouncementsTable.body,
      createdAt: academyAnnouncementsTable.createdAt,
    })
      .from(academyAnnouncementsTable)
      .where(and(
        eq(academyAnnouncementsTable.academyId, player.academyId),
        announcementScope,
        gte(academyAnnouncementsTable.createdAt, window.startsAtOrAfter),
        lt(academyAnnouncementsTable.createdAt, window.startsBefore),
      ))
      .orderBy(desc(academyAnnouncementsTable.createdAt), desc(academyAnnouncementsTable.id)),
    db.select({
      id: academyPlayerRenewalsTable.id,
      paidAt: academyPlayerRenewalsTable.paidAt,
      amountFils: academyPlayerRenewalsTable.amountFils,
      monthsPurchased: academyPlayerRenewalsTable.monthsPurchased,
      newExpiresOn: academyPlayerRenewalsTable.newExpiresOn,
    })
      .from(academyPlayerRenewalsTable)
      .where(and(
        eq(academyPlayerRenewalsTable.academyId, player.academyId),
        eq(academyPlayerRenewalsTable.playerId, player.id),
        gte(academyPlayerRenewalsTable.paidAt, paymentCutoff),
      )),
    db.select({
      id: academyFeesTable.id,
      label: academyFeesTable.label,
      amountFils: academyFeesTable.amountFils,
      dueDate: academyFeesTable.dueDate,
      status: academyFeesTable.status,
      paidAt: academyFeesTable.paidAt,
      createdAt: academyFeesTable.createdAt,
    })
      .from(academyFeesTable)
      .where(and(
        eq(academyFeesTable.academyId, player.academyId),
        eq(academyFeesTable.playerId, player.id),
        or(
          gte(academyFeesTable.createdAt, paymentCutoff),
          gte(academyFeesTable.paidAt, paymentCutoff),
        ),
      )),
  ]);

  const present = attendance.filter((item) => item.status === "present").length;
  const late = attendance.filter((item) => item.status === "late").length;
  const markedTotal = attendance.length;
  const payments = [
    ...renewals.map((renewal) => ({
      id: `renewal:${renewal.id}`,
      kind: "renewal" as const,
      date: renewal.paidAt.toISOString(),
      amountFils: renewal.amountFils,
      label: null,
      monthsPurchased: renewal.monthsPurchased,
      newExpiresOn: renewal.newExpiresOn,
      dueDate: null,
      status: "paid" as const,
    })),
    ...fees.map((fee) => ({
      id: `fee:${fee.id}`,
      kind: "fee" as const,
      date: (fee.paidAt ?? fee.createdAt).toISOString(),
      amountFils: fee.amountFils,
      label: fee.label,
      monthsPurchased: null,
      newExpiresOn: null,
      dueDate: fee.dueDate,
      status: fee.status,
    })),
  ].sort((a, b) => Date.parse(b.date) - Date.parse(a.date) || b.id.localeCompare(a.id));

  const pinnedRecordings = sessions.length === 0
    ? []
    : await db
      .select({
        sessionId: academyRecordingsTable.sessionId,
        id: recordingsTable.id,
        fieldId: recordingsTable.fieldId,
        court: recordingsTable.court,
        date: recordingsTable.date,
        timeSlot: recordingsTable.timeSlot,
        duration: recordingsTable.duration,
        score: recordingsTable.score,
        videoUrl: recordingsTable.videoUrl,
      })
      .from(academyRecordingsTable)
      .innerJoin(recordingsTable, eq(recordingsTable.id, academyRecordingsTable.recordingId))
      .where(and(
        eq(academyRecordingsTable.academyId, player.academyId),
        inArray(academyRecordingsTable.sessionId, sessions.map(({ id }) => id)),
      ))
      .orderBy(asc(recordingsTable.date), asc(recordingsTable.timeSlot), asc(recordingsTable.id));
  const recordingsBySession = new Map<number, typeof pinnedRecordings>();
  for (const recording of pinnedRecordings) {
    if (recording.sessionId === null) continue;
    const existing = recordingsBySession.get(recording.sessionId) ?? [];
    existing.push(recording);
    recordingsBySession.set(recording.sessionId, existing);
  }

  const players = linkedPlayers.map((other) => ({
    id: other.id,
    name: other.name,
    academyName: other.academyName,
  }));

  return GetAcademyFamilyMeResponse.parse({
    academy: {
      name: player.academyName,
      logoUrl: player.logoUrl,
      contactPhone: player.contactPhone,
    },
    player: {
      id: player.id,
      name: player.name,
      squadName: player.squadName,
      jerseyNumber: player.jerseyNumber,
      position: player.position,
    },
    finance,
    sessions: sessions.map(({ id, ...session }) => ({
      ...session,
      recordings: recordingsBySession.get(id)?.map(({
        sessionId: _sessionId,
        ...recording
      }) => recording) ?? [],
    })),
    attendance,
    attendanceSummary: {
      present,
      late,
      absent: attendance.filter((item) => item.status === "absent").length,
      excused: attendance.filter((item) => item.status === "excused").length,
      markedTotal,
      percentPresent: markedTotal === 0 ? null : Math.round(((present + late) / markedTotal) * 100),
    },
    payments,
    announcements,
    players,
    ...(players.length > 1
      ? { otherLinkedPlayers: players.filter((other) => other.id !== player.id) }
      : {}),
  });
}

router.post("/academy/family/claim", async (req, res): Promise<void> => {
  setNoStore(res);
  const user = await getLocalUserRecord(req);
  if (!user || user.isGuest || user.isDisabled) {
    unauthenticatedResponse(res, req);
    return;
  }

  const body = ClaimAcademyFamilyBody.safeParse(req.body ?? {});
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  if (!allowAcademyFamilyClaim(req)) {
    res.status(429).json({ error: "Too many requests. Try again in a few minutes." });
    return;
  }

  const [player] = await familyPlayerSelection().where(and(
    eq(academyPlayersTable.familyToken, body.data.token),
    eq(academyPlayersTable.isActive, true),
  ));
  if (!player) {
    res.status(404).json({ error: "Family link not found" });
    return;
  }

  await db.insert(academyPlayerGuardiansTable)
    .values({ playerId: player.id, userId: user.id, addedBy: "link" })
    .onConflictDoNothing();

  res.json(ClaimAcademyFamilyResponse.parse({
    playerId: player.id,
    playerName: player.name,
    academyName: player.academyName,
  }));
});

router.get("/academy/family/me", async (req, res): Promise<void> => {
  setNoStore(res);
  const user = await getLocalUserRecord(req);
  if (!user || user.isGuest || user.isDisabled) {
    unauthenticatedResponse(res, req);
    return;
  }

  const query = GetAcademyFamilyMeQueryParams.safeParse({
    from: rawDate(req.query.from),
    to: rawDate(req.query.to),
    playerId: rawDate(req.query.playerId),
  });
  if (!query.success) {
    res.status(400).json({ error: "Invalid date window or player selection" });
    return;
  }
  const window = parseFamilyWindow(query.data.from, query.data.to);
  if (!window.ok) {
    res.status(400).json({ error: window.error });
    return;
  }
  const linkedPlayers = await findFamilyPlayersForUser(user.id);
  if (linkedPlayers.length === 0) {
    res.status(404).json({ error: "No active academy player is linked to this account" });
    return;
  }
  const player = query.data.playerId === undefined
    ? linkedPlayers[0]
    : linkedPlayers.find(({ id }) => id === query.data.playerId);
  if (!player) {
    res.status(404).json({ error: "Selected player is not linked to this account" });
    return;
  }

  res.json(await readFamilyView(player, linkedPlayers, window));
});

export default router;
