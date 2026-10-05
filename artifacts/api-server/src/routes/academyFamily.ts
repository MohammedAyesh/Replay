import { and, asc, desc, eq, gte, isNull, lt, or } from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
  academyAnnouncementsTable,
  academyAttendanceTable,
  academyPlayersTable,
  academySessionsTable,
  academySquadsTable,
  academiesTable,
  db,
} from "@workspace/db";
import {
  GetPublicAcademyFamilyQueryParams,
  GetPublicAcademyFamilyResponse,
} from "@workspace/api-zod";
import { financePlayersForSquad } from "./academyFinance";
import { allowAcademyFamilyRead } from "./academyJoin";

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

router.get("/academy/family", async (req, res): Promise<void> => {
  setNoStore(res);
  if (!allowAcademyFamilyRead(req)) {
    res.status(429).json({ error: "Too many requests. Try again in a few minutes." });
    return;
  }

  const token = GetPublicAcademyFamilyQueryParams.pick({ token: true }).safeParse({
    token: rawDate(req.query.token),
  });
  if (!token.success) {
    res.status(404).json({ error: "Family link not found" });
    return;
  }
  const parsedWindow = GetPublicAcademyFamilyQueryParams.pick({ from: true, to: true }).safeParse({
    from: rawDate(req.query.from),
    to: rawDate(req.query.to),
  });
  if (!parsedWindow.success) {
    res.status(400).json({ error: "Date window must use YYYY-MM-DD dates" });
    return;
  }

  const today = ammanToday();
  const from = parsedWindow.data.from ?? shiftDate(today, -30);
  const to = parsedWindow.data.to ?? shiftDate(today, 60);
  if (
    !isCalendarDate(from)
    || !isCalendarDate(to)
    || from > to
    || (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS > MAX_WINDOW_DAYS
  ) {
    res.status(400).json({ error: "Date window must be valid and no longer than 120 days" });
    return;
  }
  if ((parsedWindow.data.from === undefined) !== (parsedWindow.data.to === undefined)) {
    res.status(400).json({ error: "Both from and to dates are required together" });
    return;
  }

  const startsAtOrAfter = new Date(`${from}T00:00:00.000Z`);
  const startsBefore = new Date(`${shiftDate(to, 1)}T00:00:00.000Z`);
  const [player] = await db
    .select({
      id: academyPlayersTable.id,
      academyId: academyPlayersTable.academyId,
      squadId: academyPlayersTable.squadId,
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
    )
    .where(and(
      eq(academyPlayersTable.familyToken, token.data.token),
      eq(academyPlayersTable.isActive, true),
    ));

  if (!player) {
    res.status(404).json({ error: "Family link not found" });
    return;
  }

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
    : or(
      isNull(academySessionsTable.squadId),
      eq(academySessionsTable.squadId, player.squadId),
    );
  const announcementScope = player.squadId === null
    ? isNull(academyAnnouncementsTable.squadId)
    : or(
      isNull(academyAnnouncementsTable.squadId),
      eq(academyAnnouncementsTable.squadId, player.squadId),
    );

  const [sessions, attendance, announcements] = await Promise.all([
    db.select({
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
        gte(academySessionsTable.startsAt, startsAtOrAfter),
        lt(academySessionsTable.startsAt, startsBefore),
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
        gte(academySessionsTable.startsAt, startsAtOrAfter),
        lt(academySessionsTable.startsAt, startsBefore),
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
        gte(academyAnnouncementsTable.createdAt, startsAtOrAfter),
        lt(academyAnnouncementsTable.createdAt, startsBefore),
      ))
      .orderBy(desc(academyAnnouncementsTable.createdAt), desc(academyAnnouncementsTable.id)),
  ]);

  res.json(GetPublicAcademyFamilyResponse.parse({
    academy: {
      name: player.academyName,
      logoUrl: player.logoUrl,
      contactPhone: player.contactPhone,
    },
    player: {
      name: player.name,
      squadName: player.squadName,
      jerseyNumber: player.jerseyNumber,
      position: player.position,
    },
    finance,
    sessions,
    attendance,
    announcements,
  }));
});

export default router;
