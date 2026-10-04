import crypto from "node:crypto";
import { and, asc, count, desc, eq, gte, lt, sql } from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
  AddAcademyMemberBody,
  AddAcademyMemberParams,
  AddAcademyMemberResponse,
  CreateAcademyConsoleSessionBody,
  CreateAcademyConsoleSessionParams,
  CreateAcademyConsoleSessionResponse,
  CreateAcademyConsolePlayerBody,
  CreateAcademyConsolePlayerParams,
  CreateAcademyConsolePlayerResponse,
  CreateAcademyConsoleSquadBody,
  CreateAcademyConsoleSquadParams,
  CreateAcademyConsoleSquadResponse,
  DeleteAcademyConsoleSessionParams,
  DeleteAcademyConsoleSquadParams,
  GetAcademyConsoleDashboardParams,
  GetAcademyConsoleDashboardResponse,
  GetAcademyConsoleJoinLinkParams,
  GetAcademyConsoleJoinLinkResponse,
  GetAcademyConsoleMembershipsResponse,
  ListAcademyConsoleSessionsParams,
  ListAcademyConsoleSessionsResponse,
  ListAcademyConsolePlayersParams,
  ListAcademyConsolePlayersResponse,
  ListAcademyConsoleRegistrationsParams,
  ListAcademyConsoleRegistrationsQueryParams,
  ListAcademyConsoleRegistrationsResponse,
  ListAcademyConsoleSquadsParams,
  ListAcademyConsoleSquadsResponse,
  ListAcademyMembersParams,
  ListAcademyMembersResponse,
  RemoveAcademyMemberRoleParams,
  UpdateAcademyConsolePlayerBody,
  UpdateAcademyConsolePlayerParams,
  UpdateAcademyConsolePlayerResponse,
  UpdateAcademyConsoleSessionBody,
  UpdateAcademyConsoleSessionParams,
  UpdateAcademyConsoleSessionResponse,
  UpdateAcademyConsoleSquadBody,
  UpdateAcademyConsoleSquadParams,
  UpdateAcademyConsoleSquadResponse,
  RegenerateAcademyConsoleJoinLinkParams,
  RegenerateAcademyConsoleJoinLinkResponse,
  ApproveAcademyConsoleRegistrationParams,
  ApproveAcademyConsoleRegistrationBody,
  ApproveAcademyConsoleRegistrationResponse,
  RejectAcademyConsoleRegistrationParams,
} from "@workspace/api-zod";
import {
  academyAttendanceTable,
  academyMembersTable,
  academyPlayersTable,
  academyRegistrationsTable,
  academySessionsTable,
  academySquadsTable,
  academiesTable,
  db,
  usersTable,
} from "@workspace/db";
import { financePlayersForSquad, getAcademyCollectThisWeek } from "./academyFinance";
import {
  academyRolesForUser,
  requireAcademyConsoleAdmin,
  requireAcademyConsoleUser,
  requireAcademyMembership,
} from "../lib/academyAccess";
import { publicBaseUrl } from "./share";

const router: IRouter = Router();
const ROLE_ORDER = ["owner", "coach"] as const;
const JOIN_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function rawParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function sortedRoles(roles: string[]): Array<"owner" | "coach"> {
  return [...new Set(roles)].sort(
    (a, b) => ROLE_ORDER.indexOf(a as (typeof ROLE_ORDER)[number])
      - ROLE_ORDER.indexOf(b as (typeof ROLE_ORDER)[number]),
  ) as Array<"owner" | "coach">;
}

async function academySquadSummaries(academyId: number, squadId?: number) {
  const rows = await db
    .select({
      id: academySquadsTable.id,
      academyId: academySquadsTable.academyId,
      name: academySquadsTable.name,
      ageGroup: academySquadsTable.ageGroup,
      description: academySquadsTable.description,
      activePlayerCount: count(academyPlayersTable.id),
    })
    .from(academySquadsTable)
    .leftJoin(
      academyPlayersTable,
      and(
        eq(academyPlayersTable.squadId, academySquadsTable.id),
        eq(academyPlayersTable.academyId, academyId),
        eq(academyPlayersTable.isActive, true),
      ),
    )
    .where(and(
      eq(academySquadsTable.academyId, academyId),
      ...(squadId === undefined ? [] : [eq(academySquadsTable.id, squadId)]),
    ))
    .groupBy(
      academySquadsTable.id,
      academySquadsTable.academyId,
      academySquadsTable.name,
      academySquadsTable.ageGroup,
      academySquadsTable.description,
    )
    .orderBy(asc(academySquadsTable.name), asc(academySquadsTable.id));

  return rows.map((row) => ({
    ...row,
    activePlayerCount: Number(row.activePlayerCount),
  }));
}

async function academyPlayerSummaries(academyId: number, playerId?: number) {
  const rows = await db
    .select({
      id: academyPlayersTable.id,
      academyId: academyPlayersTable.academyId,
      squadId: academyPlayersTable.squadId,
      squadName: academySquadsTable.name,
      name: academyPlayersTable.name,
      jerseyNumber: academyPlayersTable.jerseyNumber,
      position: academyPlayersTable.position,
      dateOfBirth: academyPlayersTable.dateOfBirth,
      guardianPhone: academyPlayersTable.guardianPhone,
      userId: academyPlayersTable.userId,
      linkedUserEmail: usersTable.email,
      isActive: academyPlayersTable.isActive,
    })
    .from(academyPlayersTable)
    .leftJoin(
      academySquadsTable,
      and(
        eq(academySquadsTable.id, academyPlayersTable.squadId),
        eq(academySquadsTable.academyId, academyId),
      ),
    )
    .leftJoin(usersTable, eq(usersTable.id, academyPlayersTable.userId))
    .where(and(
      eq(academyPlayersTable.academyId, academyId),
      ...(playerId === undefined ? [] : [eq(academyPlayersTable.id, playerId)]),
    ))
    .orderBy(asc(academyPlayersTable.name), asc(academyPlayersTable.id));

  return rows;
}

async function academySessionSummaries(academyId: number, sessionId?: number) {
  const sessions = await db
    .select({
      id: academySessionsTable.id,
      academyId: academySessionsTable.academyId,
      squadId: academySessionsTable.squadId,
      squadName: academySquadsTable.name,
      type: academySessionsTable.type,
      startsAt: academySessionsTable.startsAt,
      endsAt: academySessionsTable.endsAt,
      location: academySessionsTable.location,
      opponent: academySessionsTable.opponent,
      ownScore: academySessionsTable.ownScore,
      opponentScore: academySessionsTable.opponentScore,
      notes: academySessionsTable.notes,
      createdAt: academySessionsTable.createdAt,
    })
    .from(academySessionsTable)
    .leftJoin(
      academySquadsTable,
      and(
        eq(academySquadsTable.id, academySessionsTable.squadId),
        eq(academySquadsTable.academyId, academyId),
      ),
    )
    .where(and(
      eq(academySessionsTable.academyId, academyId),
      ...(sessionId === undefined ? [] : [eq(academySessionsTable.id, sessionId)]),
    ))
    .orderBy(asc(academySessionsTable.startsAt), asc(academySessionsTable.id));

  if (sessions.length === 0) return [];

  const statusRows = await db
    .select({
      sessionId: academyAttendanceTable.sessionId,
      status: academyAttendanceTable.status,
      value: count(),
    })
    .from(academyAttendanceTable)
    .innerJoin(academySessionsTable, eq(academySessionsTable.id, academyAttendanceTable.sessionId))
    .where(and(
      eq(academySessionsTable.academyId, academyId),
      ...(sessionId === undefined ? [] : [eq(academySessionsTable.id, sessionId)]),
    ))
    .groupBy(academyAttendanceTable.sessionId, academyAttendanceTable.status);

  const countsBySession = new Map<number, {
    present: number;
    absent: number;
    late: number;
    excused: number;
  }>();
  for (const row of statusRows) {
    const counts = countsBySession.get(row.sessionId) ?? {
      present: 0,
      absent: 0,
      late: 0,
      excused: 0,
    };
    counts[row.status] = Number(row.value);
    countsBySession.set(row.sessionId, counts);
  }

  return sessions.map((session) => ({
    ...session,
    attendanceCounts: countsBySession.get(session.id) ?? {
      present: 0,
      absent: 0,
      late: 0,
      excused: 0,
    },
  }));
}

function normalizeOptionalText(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

async function academySquadBelongsToAcademy(squadId: number, academyId: number): Promise<boolean> {
  const [squad] = await db
    .select({ id: academySquadsTable.id })
    .from(academySquadsTable)
    .where(and(
      eq(academySquadsTable.id, squadId),
      eq(academySquadsTable.academyId, academyId),
    ));
  return Boolean(squad);
}

async function academyExists(academyId: number): Promise<boolean> {
  const [academy] = await db
    .select({ id: academiesTable.id })
    .from(academiesTable)
    .where(eq(academiesTable.id, academyId));
  return Boolean(academy);
}

function generateAcademyJoinCode(): string {
  const bytes = crypto.randomBytes(8);
  return [...bytes].map((byte) => JOIN_CODE_ALPHABET[byte & 31]).join("");
}

function joinLinkPayload(req: Request, joinCode: string | null) {
  return GetAcademyConsoleJoinLinkResponse.parse({
    joinCode,
    joinUrl: joinCode ? `${publicBaseUrl(req)}/join/${joinCode}` : null,
  });
}

function isJoinCodeUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; constraint?: unknown };
  return candidate.code === "23505"
    && (candidate.constraint === undefined || candidate.constraint === "academies_join_code_unique");
}

async function listAcademyMemberSummaries(academyId: number) {
  const rows = await db
    .select({
      userId: usersTable.id,
      name: usersTable.name,
      email: usersTable.email,
      role: academyMembersTable.role,
    })
    .from(academyMembersTable)
    .innerJoin(usersTable, eq(academyMembersTable.userId, usersTable.id))
    .where(eq(academyMembersTable.academyId, academyId))
    .orderBy(asc(usersTable.name), asc(academyMembersTable.role));

  const byUser = new Map<number, {
    userId: number;
    name: string;
    email: string;
    roles: Array<"owner" | "coach">;
  }>();

  for (const row of rows) {
    const member = byUser.get(row.userId) ?? {
      userId: row.userId,
      name: row.name,
      email: row.email,
      roles: [],
    };
    member.roles.push(row.role);
    byUser.set(row.userId, member);
  }

  return [...byUser.values()].map((member) => ({
    ...member,
    roles: sortedRoles(member.roles),
  }));
}

router.get("/academy/console/memberships", async (req, res): Promise<void> => {
  const user = await requireAcademyConsoleUser(req, res);
  if (!user) return;

  const rows = await db
    .select({
      academyId: academiesTable.id,
      academyName: academiesTable.name,
      role: academyMembersTable.role,
    })
    .from(academyMembersTable)
    .innerJoin(academiesTable, eq(academyMembersTable.academyId, academiesTable.id))
    .where(eq(academyMembersTable.userId, user.id))
    .orderBy(asc(academiesTable.name), asc(academyMembersTable.role));

  if (rows.length === 0) {
    res.status(403).json({ error: "Academy membership required" });
    return;
  }

  const memberships = new Map<number, { academyId: number; academyName: string; roles: string[] }>();
  for (const row of rows) {
    const membership = memberships.get(row.academyId) ?? {
      academyId: row.academyId,
      academyName: row.academyName,
      roles: [],
    };
    membership.roles.push(row.role);
    memberships.set(row.academyId, membership);
  }

  res.json(GetAcademyConsoleMembershipsResponse.parse(
    [...memberships.values()].map((membership) => ({
      ...membership,
      roles: sortedRoles(membership.roles),
    })),
  ));
});

router.get("/academy/console/academies/:academyId/join-link", async (req, res): Promise<void> => {
  const user = await requireAcademyConsoleUser(req, res);
  if (!user) return;
  const parsedParams = GetAcademyConsoleJoinLinkParams.safeParse({
    academyId: rawParam(req.params.academyId),
  });
  if (!parsedParams.success) {
    res.status(400).json({ error: parsedParams.error.message });
    return;
  }
  const { academyId } = parsedParams.data;
  const roles = await requireAcademyMembership(user.id, academyId, res);
  if (!roles) return;
  if (!roles.includes("owner")) {
    res.status(403).json({ error: "Academy owner role required" });
    return;
  }
  const [academy] = await db
    .select({ joinCode: academiesTable.joinCode })
    .from(academiesTable)
    .where(eq(academiesTable.id, academyId));
  if (!academy) {
    res.status(404).json({ error: "Academy not found" });
    return;
  }
  res.json(joinLinkPayload(req, academy.joinCode));
});

router.post("/academy/console/academies/:academyId/join-link", async (req, res): Promise<void> => {
  const user = await requireAcademyConsoleUser(req, res);
  if (!user) return;
  const parsedParams = RegenerateAcademyConsoleJoinLinkParams.safeParse({
    academyId: rawParam(req.params.academyId),
  });
  if (!parsedParams.success) {
    res.status(400).json({ error: parsedParams.error.message });
    return;
  }
  const { academyId } = parsedParams.data;
  const roles = await requireAcademyMembership(user.id, academyId, res);
  if (!roles) return;
  if (!roles.includes("owner")) {
    res.status(403).json({ error: "Academy owner role required" });
    return;
  }
  if (!(await academyExists(academyId))) {
    res.status(404).json({ error: "Academy not found" });
    return;
  }

  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      const [academy] = await db
        .update(academiesTable)
        .set({ joinCode: generateAcademyJoinCode() })
        .where(eq(academiesTable.id, academyId))
        .returning({ joinCode: academiesTable.joinCode });
      if (!academy) {
        res.status(404).json({ error: "Academy not found" });
        return;
      }
      res.json(joinLinkPayload(req, academy.joinCode));
      return;
    } catch (error) {
      if (!isJoinCodeUniqueViolation(error)) throw error;
    }
  }
  throw new Error("Unable to allocate a unique academy registration code");
});

router.get("/academy/console/academies/:academyId/registrations", async (req, res): Promise<void> => {
  const user = await requireAcademyConsoleUser(req, res);
  if (!user) return;
  const path = ListAcademyConsoleRegistrationsParams.safeParse({
    academyId: rawParam(req.params.academyId),
  });
  const query = ListAcademyConsoleRegistrationsQueryParams.safeParse({
    status: req.query.status,
  });
  if (!path.success || !query.success) {
    res.status(400).json({ error: !path.success ? path.error.message : query.error.message });
    return;
  }
  const { academyId } = path.data;
  const roles = await requireAcademyMembership(user.id, academyId, res);
  if (!roles) return;
  if (!(await academyExists(academyId))) {
    res.status(404).json({ error: "Academy not found" });
    return;
  }

  const rows = await db
    .select({
      id: academyRegistrationsTable.id,
      playerName: academyRegistrationsTable.playerName,
      dateOfBirth: academyRegistrationsTable.dateOfBirth,
      guardianName: academyRegistrationsTable.guardianName,
      guardianPhone: academyRegistrationsTable.guardianPhone,
      preferredSquadId: academyRegistrationsTable.preferredSquadId,
      preferredSquadName: academySquadsTable.name,
      notes: academyRegistrationsTable.notes,
      locale: academyRegistrationsTable.locale,
      status: academyRegistrationsTable.status,
      createdAt: academyRegistrationsTable.createdAt,
      createdPlayerId: academyRegistrationsTable.createdPlayerId,
    })
    .from(academyRegistrationsTable)
    .leftJoin(
      academySquadsTable,
      and(
        eq(academyRegistrationsTable.preferredSquadId, academySquadsTable.id),
        eq(academySquadsTable.academyId, academyId),
      ),
    )
    .where(and(
      eq(academyRegistrationsTable.academyId, academyId),
      eq(academyRegistrationsTable.status, query.data.status),
    ))
    .orderBy(desc(academyRegistrationsTable.createdAt), desc(academyRegistrationsTable.id));

  res.json(ListAcademyConsoleRegistrationsResponse.parse(rows));
});

router.post(
  "/academy/console/academies/:academyId/registrations/:registrationId/approve",
  async (req, res): Promise<void> => {
    const user = await requireAcademyConsoleUser(req, res);
    if (!user) return;
    const parsedParams = ApproveAcademyConsoleRegistrationParams.safeParse({
      academyId: rawParam(req.params.academyId),
      registrationId: rawParam(req.params.registrationId),
    });
    if (!parsedParams.success) {
      res.status(400).json({ error: parsedParams.error.message });
      return;
    }
    const { academyId, registrationId } = parsedParams.data;
    const roles = await requireAcademyMembership(user.id, academyId, res);
    if (!roles) return;
    if (!(await academyExists(academyId))) {
      res.status(404).json({ error: "Academy not found" });
      return;
    }
    const body = ApproveAcademyConsoleRegistrationBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: body.error.message });
      return;
    }
    if (body.data.squadId != null && !(await academySquadBelongsToAcademy(body.data.squadId, academyId))) {
      res.status(404).json({ error: "Squad not found in this academy" });
      return;
    }

    const result = await db.transaction(async (tx) => {
      const [registration] = await tx
        .select()
        .from(academyRegistrationsTable)
        .where(and(
          eq(academyRegistrationsTable.id, registrationId),
          eq(academyRegistrationsTable.academyId, academyId),
        ))
        .for("update");
      if (!registration) return { kind: "missing" as const };
      if (registration.status !== "pending") return { kind: "not-pending" as const };

      const [player] = await tx
        .insert(academyPlayersTable)
        .values({
          academyId,
          name: registration.playerName,
          squadId: body.data.squadId ?? null,
          jerseyNumber: body.data.jerseyNumber ?? null,
          position: normalizeOptionalText(body.data.position),
          dateOfBirth: registration.dateOfBirth,
          guardianPhone: registration.guardianPhone,
        })
        .returning({ id: academyPlayersTable.id });
      await tx
        .update(academyRegistrationsTable)
        .set({
          status: "approved",
          createdPlayerId: player.id,
          reviewedAt: new Date(),
          reviewedBy: user.id,
        })
        .where(eq(academyRegistrationsTable.id, registrationId));
      return { kind: "approved" as const, playerId: player.id };
    });

    if (result.kind === "missing") {
      res.status(404).json({ error: "Registration not found" });
      return;
    }
    if (result.kind === "not-pending") {
      res.status(409).json({ error: "Registration is no longer pending" });
      return;
    }
    const [summary] = await academyPlayerSummaries(academyId, result.playerId);
    res.json(ApproveAcademyConsoleRegistrationResponse.parse(summary));
  },
);

router.post(
  "/academy/console/academies/:academyId/registrations/:registrationId/reject",
  async (req, res): Promise<void> => {
    const user = await requireAcademyConsoleUser(req, res);
    if (!user) return;
    const parsedParams = RejectAcademyConsoleRegistrationParams.safeParse({
      academyId: rawParam(req.params.academyId),
      registrationId: rawParam(req.params.registrationId),
    });
    if (!parsedParams.success) {
      res.status(400).json({ error: parsedParams.error.message });
      return;
    }
    const { academyId, registrationId } = parsedParams.data;
    const roles = await requireAcademyMembership(user.id, academyId, res);
    if (!roles) return;
    if (!(await academyExists(academyId))) {
      res.status(404).json({ error: "Academy not found" });
      return;
    }

    const result = await db.transaction(async (tx) => {
      const [registration] = await tx
        .select({ id: academyRegistrationsTable.id, status: academyRegistrationsTable.status })
        .from(academyRegistrationsTable)
        .where(and(
          eq(academyRegistrationsTable.id, registrationId),
          eq(academyRegistrationsTable.academyId, academyId),
        ))
        .for("update");
      if (!registration) return "missing" as const;
      if (registration.status !== "pending") return "not-pending" as const;
      await tx
        .update(academyRegistrationsTable)
        .set({ status: "rejected", reviewedAt: new Date(), reviewedBy: user.id })
        .where(eq(academyRegistrationsTable.id, registrationId));
      return "rejected" as const;
    });
    if (result === "missing") {
      res.status(404).json({ error: "Registration not found" });
      return;
    }
    if (result === "not-pending") {
      res.status(409).json({ error: "Registration is no longer pending" });
      return;
    }
    res.status(204).end();
  },
);

router.get("/academy/console/academies/:academyId/dashboard", async (req, res): Promise<void> => {
  const user = await requireAcademyConsoleUser(req, res);
  if (!user) return;

  const parsedParams = GetAcademyConsoleDashboardParams.safeParse({
    academyId: rawParam(req.params.academyId),
  });
  if (!parsedParams.success || !Number.isSafeInteger(parsedParams.data?.academyId)) {
    res.status(400).json({ error: parsedParams.success ? "Invalid academy id" : parsedParams.error.message });
    return;
  }
  const academyId = parsedParams.data.academyId;

  const roles = await requireAcademyMembership(user.id, academyId, res);
  if (!roles) return;

  const [academy] = await db
    .select({ id: academiesTable.id, name: academiesTable.name })
    .from(academiesTable)
    .where(eq(academiesTable.id, academyId));
  if (!academy) {
    res.status(404).json({ error: "Academy not found" });
    return;
  }

  const now = new Date();
  const nextSevenDays = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const [squadCount, activePlayerCount, upcomingSessionCount, pendingRegistrationCount, collectThisWeek] = await Promise.all([
    db.select({ value: count() })
      .from(academySquadsTable)
      .where(eq(academySquadsTable.academyId, academyId)),
    db.select({ value: count() })
      .from(academyPlayersTable)
      .where(and(
        eq(academyPlayersTable.academyId, academyId),
        eq(academyPlayersTable.isActive, true),
      )),
    db.select({ value: count() })
      .from(academySessionsTable)
      .where(and(
        eq(academySessionsTable.academyId, academyId),
        gte(academySessionsTable.startsAt, now),
        lt(academySessionsTable.startsAt, nextSevenDays),
      )),
    db.select({ value: count() })
      .from(academyRegistrationsTable)
      .where(and(
        eq(academyRegistrationsTable.academyId, academyId),
        eq(academyRegistrationsTable.status, "pending"),
      )),
    roles.includes("owner")
      ? getAcademyCollectThisWeek(academyId)
      : Promise.resolve(null),
  ]);

  res.json(GetAcademyConsoleDashboardResponse.parse({
    academyId: academy.id,
    academyName: academy.name,
    roles,
    squadCount: Number(squadCount[0]?.value ?? 0),
    activePlayerCount: Number(activePlayerCount[0]?.value ?? 0),
    upcomingSessionCount: Number(upcomingSessionCount[0]?.value ?? 0),
    pendingRegistrationCount: Number(pendingRegistrationCount[0]?.value ?? 0),
    collectThisWeek,
  }));
});

router.get("/academy/console/academies/:academyId/squads", async (req, res): Promise<void> => {
  const user = await requireAcademyConsoleUser(req, res);
  if (!user) return;

  const parsedParams = ListAcademyConsoleSquadsParams.safeParse({
    academyId: rawParam(req.params.academyId),
  });
  if (!parsedParams.success) {
    res.status(400).json({ error: parsedParams.error.message });
    return;
  }
  const academyId = parsedParams.data.academyId;

  const roles = await requireAcademyMembership(user.id, academyId, res);
  if (!roles) return;
  if (!(await academyExists(academyId))) {
    res.status(404).json({ error: "Academy not found" });
    return;
  }

  res.json(ListAcademyConsoleSquadsResponse.parse(await academySquadSummaries(academyId)));
});

router.post("/academy/console/academies/:academyId/squads", async (req, res): Promise<void> => {
  const user = await requireAcademyConsoleUser(req, res);
  if (!user) return;

  const parsedParams = CreateAcademyConsoleSquadParams.safeParse({
    academyId: rawParam(req.params.academyId),
  });
  if (!parsedParams.success) {
    res.status(400).json({ error: parsedParams.error.message });
    return;
  }
  const academyId = parsedParams.data.academyId;
  const roles = await requireAcademyMembership(user.id, academyId, res);
  if (!roles) return;
  if (!(await academyExists(academyId))) {
    res.status(404).json({ error: "Academy not found" });
    return;
  }

  const body = CreateAcademyConsoleSquadBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const name = body.data.name.trim();
  if (!name) {
    res.status(400).json({ error: "Squad name cannot be empty" });
    return;
  }

  const [created] = await db
    .insert(academySquadsTable)
    .values({
      academyId,
      name,
      ageGroup: normalizeOptionalText(body.data.ageGroup),
      description: normalizeOptionalText(body.data.description),
    })
    .returning({ id: academySquadsTable.id });
  const [summary] = await academySquadSummaries(academyId, created.id);
  res.status(201).json(CreateAcademyConsoleSquadResponse.parse(summary));
});

router.patch("/academy/console/academies/:academyId/squads/:squadId", async (req, res): Promise<void> => {
  const user = await requireAcademyConsoleUser(req, res);
  if (!user) return;

  const parsedParams = UpdateAcademyConsoleSquadParams.safeParse({
    academyId: rawParam(req.params.academyId),
    squadId: rawParam(req.params.squadId),
  });
  if (!parsedParams.success) {
    res.status(400).json({ error: parsedParams.error.message });
    return;
  }
  const { academyId, squadId } = parsedParams.data;
  const roles = await requireAcademyMembership(user.id, academyId, res);
  if (!roles) return;
  if (!(await academyExists(academyId))) {
    res.status(404).json({ error: "Academy not found" });
    return;
  }

  const body = UpdateAcademyConsoleSquadBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  if (Object.keys(body.data).length === 0) {
    res.status(400).json({ error: "At least one squad field is required" });
    return;
  }

  const updates: Partial<typeof academySquadsTable.$inferInsert> = {};
  if (body.data.name !== undefined) {
    const name = body.data.name.trim();
    if (!name) {
      res.status(400).json({ error: "Squad name cannot be empty" });
      return;
    }
    updates.name = name;
  }
  if ("ageGroup" in body.data) {
    updates.ageGroup = normalizeOptionalText(body.data.ageGroup);
  }
  if ("description" in body.data) {
    updates.description = normalizeOptionalText(body.data.description);
  }

  const [updated] = await db
    .update(academySquadsTable)
    .set(updates)
    .where(and(
      eq(academySquadsTable.id, squadId),
      eq(academySquadsTable.academyId, academyId),
    ))
    .returning({ id: academySquadsTable.id });
  if (!updated) {
    res.status(404).json({ error: "Squad not found in this academy" });
    return;
  }

  const [summary] = await academySquadSummaries(academyId, squadId);
  res.json(UpdateAcademyConsoleSquadResponse.parse(summary));
});

router.delete("/academy/console/academies/:academyId/squads/:squadId", async (req, res): Promise<void> => {
  const user = await requireAcademyConsoleUser(req, res);
  if (!user) return;

  const parsedParams = DeleteAcademyConsoleSquadParams.safeParse({
    academyId: rawParam(req.params.academyId),
    squadId: rawParam(req.params.squadId),
  });
  if (!parsedParams.success) {
    res.status(400).json({ error: parsedParams.error.message });
    return;
  }
  const { academyId, squadId } = parsedParams.data;
  if (!(await requireAcademyMembership(user.id, academyId, res))) return;
  if (!(await academyExists(academyId))) {
    res.status(404).json({ error: "Academy not found" });
    return;
  }

  const [squad] = await db
    .select()
    .from(academySquadsTable)
    .where(and(
      eq(academySquadsTable.id, squadId),
      eq(academySquadsTable.academyId, academyId),
    ));
  if (!squad) {
    res.status(404).json({ error: "Squad not found in this academy" });
    return;
  }
  const players = await financePlayersForSquad(academyId, squad);
  if (players.some((player) => player.outstandingFils > 0)) {
    res.status(409).json({ error: "Players with outstanding balances cannot be unassigned by deleting this squad" });
    return;
  }

  const [deleted] = await db
    .delete(academySquadsTable)
    .where(and(
      eq(academySquadsTable.id, squadId),
      eq(academySquadsTable.academyId, academyId),
    ))
    .returning({ id: academySquadsTable.id });
  if (!deleted) {
    res.status(404).json({ error: "Squad not found in this academy" });
    return;
  }

  res.status(204).send();
});

router.get("/academy/console/academies/:academyId/players", async (req, res): Promise<void> => {
  const user = await requireAcademyConsoleUser(req, res);
  if (!user) return;

  const parsedParams = ListAcademyConsolePlayersParams.safeParse({
    academyId: rawParam(req.params.academyId),
  });
  if (!parsedParams.success) {
    res.status(400).json({ error: parsedParams.error.message });
    return;
  }
  const academyId = parsedParams.data.academyId;
  const roles = await requireAcademyMembership(user.id, academyId, res);
  if (!roles) return;
  if (!(await academyExists(academyId))) {
    res.status(404).json({ error: "Academy not found" });
    return;
  }

  res.json(ListAcademyConsolePlayersResponse.parse(await academyPlayerSummaries(academyId)));
});

router.post("/academy/console/academies/:academyId/players", async (req, res): Promise<void> => {
  const user = await requireAcademyConsoleUser(req, res);
  if (!user) return;

  const parsedParams = CreateAcademyConsolePlayerParams.safeParse({
    academyId: rawParam(req.params.academyId),
  });
  if (!parsedParams.success) {
    res.status(400).json({ error: parsedParams.error.message });
    return;
  }
  const academyId = parsedParams.data.academyId;
  const roles = await requireAcademyMembership(user.id, academyId, res);
  if (!roles) return;
  if (!(await academyExists(academyId))) {
    res.status(404).json({ error: "Academy not found" });
    return;
  }

  const body = CreateAcademyConsolePlayerBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const name = body.data.name.trim();
  if (!name) {
    res.status(400).json({ error: "Player name cannot be empty" });
    return;
  }
  if (body.data.squadId != null && !(await academySquadBelongsToAcademy(body.data.squadId, academyId))) {
    res.status(404).json({ error: "Squad not found in this academy" });
    return;
  }

  const [created] = await db
    .insert(academyPlayersTable)
    .values({
      academyId,
      name,
      squadId: body.data.squadId ?? null,
      jerseyNumber: body.data.jerseyNumber ?? null,
      position: normalizeOptionalText(body.data.position),
      dateOfBirth: body.data.dateOfBirth ?? null,
      guardianPhone: normalizeOptionalText(body.data.guardianPhone),
    })
    .returning({ id: academyPlayersTable.id });
  const [summary] = await academyPlayerSummaries(academyId, created.id);
  res.status(201).json(CreateAcademyConsolePlayerResponse.parse(summary));
});

router.patch("/academy/console/academies/:academyId/players/:playerId", async (req, res): Promise<void> => {
  const user = await requireAcademyConsoleUser(req, res);
  if (!user) return;

  const parsedParams = UpdateAcademyConsolePlayerParams.safeParse({
    academyId: rawParam(req.params.academyId),
    playerId: rawParam(req.params.playerId),
  });
  if (!parsedParams.success) {
    res.status(400).json({ error: parsedParams.error.message });
    return;
  }
  const { academyId, playerId } = parsedParams.data;
  const roles = await requireAcademyMembership(user.id, academyId, res);
  if (!roles) return;
  if (!(await academyExists(academyId))) {
    res.status(404).json({ error: "Academy not found" });
    return;
  }

  const body = UpdateAcademyConsolePlayerBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  if (Object.keys(body.data).length === 0) {
    res.status(400).json({ error: "At least one player field is required" });
    return;
  }
  if (body.data.name !== undefined && !body.data.name.trim()) {
    res.status(400).json({ error: "Player name cannot be empty" });
    return;
  }
  if (body.data.squadId != null && !(await academySquadBelongsToAcademy(body.data.squadId, academyId))) {
    res.status(404).json({ error: "Squad not found in this academy" });
    return;
  }

  const updates: Partial<typeof academyPlayersTable.$inferInsert> = {};
  if (body.data.name !== undefined) updates.name = body.data.name.trim();
  if ("squadId" in body.data) updates.squadId = body.data.squadId ?? null;
  if ("jerseyNumber" in body.data) updates.jerseyNumber = body.data.jerseyNumber ?? null;
  if ("position" in body.data) updates.position = normalizeOptionalText(body.data.position);
  if ("dateOfBirth" in body.data) updates.dateOfBirth = body.data.dateOfBirth ?? null;
  if ("guardianPhone" in body.data) updates.guardianPhone = normalizeOptionalText(body.data.guardianPhone);
  if (body.data.isActive !== undefined) updates.isActive = body.data.isActive;
  if ("linkedUserEmail" in body.data) {
    const linkedUserEmail = body.data.linkedUserEmail;
    if (linkedUserEmail == null) {
      updates.userId = null;
    } else {
      const normalizedEmail = linkedUserEmail.trim().toLowerCase();
      const [linkedUser] = await db
        .select({ id: usersTable.id })
        .from(usersTable)
        .where(and(
          sql`lower(${usersTable.email}) = ${normalizedEmail}`,
          eq(usersTable.isGuest, false),
          eq(usersTable.isDisabled, false),
        ));
      if (!linkedUser) {
        res.status(404).json({ error: "Existing Replay user not found" });
        return;
      }
      updates.userId = linkedUser.id;
    }
  }

  const [updated] = await db
    .update(academyPlayersTable)
    .set(updates)
    .where(and(
      eq(academyPlayersTable.id, playerId),
      eq(academyPlayersTable.academyId, academyId),
    ))
    .returning({ id: academyPlayersTable.id });
  if (!updated) {
    res.status(404).json({ error: "Player not found in this academy" });
    return;
  }

  const [summary] = await academyPlayerSummaries(academyId, playerId);
  res.json(UpdateAcademyConsolePlayerResponse.parse(summary));
});

router.get("/academy/console/academies/:academyId/sessions", async (req, res): Promise<void> => {
  const user = await requireAcademyConsoleUser(req, res);
  if (!user) return;

  const parsedParams = ListAcademyConsoleSessionsParams.safeParse({
    academyId: rawParam(req.params.academyId),
  });
  if (!parsedParams.success || !Number.isSafeInteger(parsedParams.data?.academyId)) {
    res.status(400).json({ error: parsedParams.success ? "Invalid academy id" : parsedParams.error.message });
    return;
  }
  const academyId = parsedParams.data.academyId;
  const roles = await requireAcademyMembership(user.id, academyId, res);
  if (!roles) return;
  if (!(await academyExists(academyId))) {
    res.status(404).json({ error: "Academy not found" });
    return;
  }

  res.json(ListAcademyConsoleSessionsResponse.parse(await academySessionSummaries(academyId)));
});

router.post("/academy/console/academies/:academyId/sessions", async (req, res): Promise<void> => {
  const user = await requireAcademyConsoleUser(req, res);
  if (!user) return;

  const parsedParams = CreateAcademyConsoleSessionParams.safeParse({
    academyId: rawParam(req.params.academyId),
  });
  if (!parsedParams.success || !Number.isSafeInteger(parsedParams.data?.academyId)) {
    res.status(400).json({ error: parsedParams.success ? "Invalid academy id" : parsedParams.error.message });
    return;
  }
  const academyId = parsedParams.data.academyId;
  const roles = await requireAcademyMembership(user.id, academyId, res);
  if (!roles) return;
  if (!(await academyExists(academyId))) {
    res.status(404).json({ error: "Academy not found" });
    return;
  }

  const body = CreateAcademyConsoleSessionBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const startsAt = body.data.startsAt;
  const endsAt = body.data.endsAt ?? null;
  if (endsAt && endsAt.getTime() <= startsAt.getTime()) {
    res.status(400).json({ error: "Session end must be after its start" });
    return;
  }
  const location = body.data.location.trim();
  if (!location) {
    res.status(400).json({ error: "Session location cannot be empty" });
    return;
  }
  const opponent = normalizeOptionalText(body.data.opponent);
  if (body.data.type === "training" && opponent) {
    res.status(400).json({ error: "Opponent is only supported for match sessions" });
    return;
  }
  if (body.data.squadId != null && !(await academySquadBelongsToAcademy(body.data.squadId, academyId))) {
    res.status(404).json({ error: "Squad not found in this academy" });
    return;
  }

  const [created] = await db
    .insert(academySessionsTable)
    .values({
      academyId,
      squadId: body.data.squadId ?? null,
      type: body.data.type,
      startsAt,
      endsAt,
      location,
      opponent: body.data.type === "match" ? opponent : null,
      notes: normalizeOptionalText(body.data.notes),
    })
    .returning({ id: academySessionsTable.id });
  const [summary] = await academySessionSummaries(academyId, created.id);
  res.status(201).json(CreateAcademyConsoleSessionResponse.parse(summary));
});

router.patch(
  "/academy/console/academies/:academyId/sessions/:sessionId",
  async (req, res): Promise<void> => {
    const user = await requireAcademyConsoleUser(req, res);
    if (!user) return;

    const parsedParams = UpdateAcademyConsoleSessionParams.safeParse({
      academyId: rawParam(req.params.academyId),
      sessionId: rawParam(req.params.sessionId),
    });
    if (!parsedParams.success
      || !Number.isSafeInteger(parsedParams.data?.academyId)
      || !Number.isSafeInteger(parsedParams.data?.sessionId)) {
      res.status(400).json({ error: parsedParams.success ? "Invalid session parameters" : parsedParams.error.message });
      return;
    }
    const { academyId, sessionId } = parsedParams.data;
    const roles = await requireAcademyMembership(user.id, academyId, res);
    if (!roles) return;
    if (!(await academyExists(academyId))) {
      res.status(404).json({ error: "Academy not found" });
      return;
    }

    const body = UpdateAcademyConsoleSessionBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: body.error.message });
      return;
    }
    if (Object.keys(body.data).length === 0) {
      res.status(400).json({ error: "At least one session field is required" });
      return;
    }
    const [existing] = await db
      .select()
      .from(academySessionsTable)
      .where(and(
        eq(academySessionsTable.id, sessionId),
        eq(academySessionsTable.academyId, academyId),
      ));
    if (!existing) {
      res.status(404).json({ error: "Session not found in this academy" });
      return;
    }
    if (body.data.squadId != null && !(await academySquadBelongsToAcademy(body.data.squadId, academyId))) {
      res.status(404).json({ error: "Squad not found in this academy" });
      return;
    }

    const nextType = body.data.type ?? existing.type;
    const nextStartsAt = body.data.startsAt ?? existing.startsAt;
    const nextEndsAt = "endsAt" in body.data ? body.data.endsAt ?? null : existing.endsAt;
    if (nextEndsAt && nextEndsAt.getTime() <= nextStartsAt.getTime()) {
      res.status(400).json({ error: "Session end must be after its start" });
      return;
    }

    const updates: Partial<typeof academySessionsTable.$inferInsert> = {};
    if (body.data.type !== undefined) updates.type = body.data.type;
    if (body.data.startsAt !== undefined) updates.startsAt = body.data.startsAt;
    if ("endsAt" in body.data) updates.endsAt = body.data.endsAt ?? null;
    if (body.data.squadId !== undefined) updates.squadId = body.data.squadId ?? null;
    if (body.data.location !== undefined) {
      const location = body.data.location.trim();
      if (!location) {
        res.status(400).json({ error: "Session location cannot be empty" });
        return;
      }
      updates.location = location;
    }
    if ("opponent" in body.data) {
      const opponent = normalizeOptionalText(body.data.opponent);
      if (nextType === "training" && opponent) {
        res.status(400).json({ error: "Opponent is only supported for match sessions" });
        return;
      }
      updates.opponent = nextType === "match" ? opponent : null;
    } else if (nextType === "training") {
      updates.opponent = null;
    }
    if ("notes" in body.data) updates.notes = normalizeOptionalText(body.data.notes);

    const clearingResultForTraining = nextType === "training" && existing.type !== "training";
    const ownScore = "ownScore" in body.data
      ? body.data.ownScore ?? null
      : clearingResultForTraining ? null : existing.ownScore;
    const opponentScore = "opponentScore" in body.data
      ? body.data.opponentScore ?? null
      : clearingResultForTraining ? null : existing.opponentScore;
    if (
      (ownScore !== null && (!Number.isSafeInteger(ownScore) || ownScore < 0 || ownScore > 2_147_483_647))
      || (opponentScore !== null && (!Number.isSafeInteger(opponentScore) || opponentScore < 0 || opponentScore > 2_147_483_647))
    ) {
      res.status(400).json({ error: "Scores must be non-negative whole numbers" });
      return;
    }
    if ((ownScore === null) !== (opponentScore === null)) {
      res.status(400).json({ error: "Both result scores must be set or cleared together" });
      return;
    }
    if (nextType === "training" && (ownScore !== null || opponentScore !== null)) {
      res.status(400).json({ error: "Results are only supported for match sessions" });
      return;
    }
    if ("ownScore" in body.data || "opponentScore" in body.data || nextType === "training") {
      updates.ownScore = nextType === "match" ? ownScore : null;
      updates.opponentScore = nextType === "match" ? opponentScore : null;
    }

    if (Object.keys(updates).length === 0) {
      res.status(400).json({ error: "At least one session field is required" });
      return;
    }
    const [updated] = await db
      .update(academySessionsTable)
      .set(updates)
      .where(and(
        eq(academySessionsTable.id, sessionId),
        eq(academySessionsTable.academyId, academyId),
      ))
      .returning({ id: academySessionsTable.id });
    if (!updated) {
      res.status(404).json({ error: "Session not found in this academy" });
      return;
    }

    const [summary] = await academySessionSummaries(academyId, sessionId);
    res.json(UpdateAcademyConsoleSessionResponse.parse(summary));
  },
);

router.delete(
  "/academy/console/academies/:academyId/sessions/:sessionId",
  async (req, res): Promise<void> => {
    const user = await requireAcademyConsoleUser(req, res);
    if (!user) return;

    const parsedParams = DeleteAcademyConsoleSessionParams.safeParse({
      academyId: rawParam(req.params.academyId),
      sessionId: rawParam(req.params.sessionId),
    });
  if (!parsedParams.success
    || !Number.isSafeInteger(parsedParams.data?.academyId)
    || !Number.isSafeInteger(parsedParams.data?.sessionId)) {
    res.status(400).json({ error: parsedParams.success ? "Invalid session parameters" : parsedParams.error.message });
      return;
    }
    const { academyId, sessionId } = parsedParams.data;
    const roles = await requireAcademyMembership(user.id, academyId, res);
    if (!roles) return;
    if (!(await academyExists(academyId))) {
      res.status(404).json({ error: "Academy not found" });
      return;
    }

    const [deleted] = await db
      .delete(academySessionsTable)
      .where(and(
        eq(academySessionsTable.id, sessionId),
        eq(academySessionsTable.academyId, academyId),
      ))
      .returning({ id: academySessionsTable.id });
    if (!deleted) {
      res.status(404).json({ error: "Session not found in this academy" });
      return;
    }

    res.status(204).send();
  },
);

router.get("/admin/academies/:academyId/members", async (req, res): Promise<void> => {
  const user = await requireAcademyConsoleUser(req, res);
  if (!user) return;
  if (!(await requireAcademyConsoleAdmin(user, res))) return;

  const parsedParams = ListAcademyMembersParams.safeParse({
    academyId: rawParam(req.params.academyId),
  });
  if (!parsedParams.success || !Number.isSafeInteger(parsedParams.data?.academyId)) {
    res.status(400).json({ error: parsedParams.success ? "Invalid academy id" : parsedParams.error.message });
    return;
  }
  const academyId = parsedParams.data.academyId;

  const [academy] = await db
    .select({ id: academiesTable.id })
    .from(academiesTable)
    .where(eq(academiesTable.id, academyId));
  if (!academy) {
    res.status(404).json({ error: "Academy not found" });
    return;
  }

  res.json(ListAcademyMembersResponse.parse(await listAcademyMemberSummaries(academyId)));
});

router.post("/admin/academies/:academyId/members", async (req, res): Promise<void> => {
  const user = await requireAcademyConsoleUser(req, res);
  if (!user) return;
  if (!(await requireAcademyConsoleAdmin(user, res))) return;

  const parsedParams = AddAcademyMemberParams.safeParse({
    academyId: rawParam(req.params.academyId),
  });
  if (!parsedParams.success || !Number.isSafeInteger(parsedParams.data?.academyId)) {
    res.status(400).json({ error: parsedParams.success ? "Invalid academy id" : parsedParams.error.message });
    return;
  }
  const body = AddAcademyMemberBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const academyId = parsedParams.data.academyId;

  const [academy] = await db
    .select({ id: academiesTable.id })
    .from(academiesTable)
    .where(eq(academiesTable.id, academyId));
  if (!academy) {
    res.status(404).json({ error: "Academy not found" });
    return;
  }

  const normalizedEmail = body.data.email.trim().toLowerCase();
  const [target] = await db
    .select({
      id: usersTable.id,
      name: usersTable.name,
      email: usersTable.email,
      isGuest: usersTable.isGuest,
      isDisabled: usersTable.isDisabled,
    })
    .from(usersTable)
    .where(sql`lower(${usersTable.email}) = ${normalizedEmail}`);
  if (!target || target.isGuest || target.isDisabled) {
    res.status(404).json({ error: "Existing Replay user not found" });
    return;
  }

  await db
    .insert(academyMembersTable)
    .values({ userId: target.id, academyId, role: body.data.role })
    .onConflictDoNothing();

  const roles = await academyRolesForUser(target.id, academyId);
  res.json(AddAcademyMemberResponse.parse({
    userId: target.id,
    name: target.name,
    email: target.email,
    roles: sortedRoles(roles),
  }));
});

router.delete("/admin/academies/:academyId/members/:userId/:role", async (req, res): Promise<void> => {
  const user = await requireAcademyConsoleUser(req, res);
  if (!user) return;
  if (!(await requireAcademyConsoleAdmin(user, res))) return;

  const parsedParams = RemoveAcademyMemberRoleParams.safeParse({
    academyId: rawParam(req.params.academyId),
    userId: rawParam(req.params.userId),
    role: rawParam(req.params.role),
  });
  if (!parsedParams.success
    || !Number.isSafeInteger(parsedParams.data?.academyId)
    || !Number.isSafeInteger(parsedParams.data?.userId)) {
    res.status(400).json({ error: parsedParams.success ? "Invalid member parameters" : parsedParams.error.message });
    return;
  }

  const [removed] = await db
    .delete(academyMembersTable)
    .where(and(
      eq(academyMembersTable.academyId, parsedParams.data.academyId),
      eq(academyMembersTable.userId, parsedParams.data.userId),
      eq(academyMembersTable.role, parsedParams.data.role),
    ))
    .returning({ id: academyMembersTable.id });
  if (!removed) {
    res.status(404).json({ error: "Academy member role not found" });
    return;
  }

  res.status(204).send();
});

export default router;