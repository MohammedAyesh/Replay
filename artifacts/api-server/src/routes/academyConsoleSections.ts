import { and, asc, desc, eq, isNotNull, or, sql } from "drizzle-orm";
import { Router, type IRouter, type Response } from "express";
import {
  CreateAcademyConsoleAnnouncementBody,
  CreateAcademyConsoleAnnouncementParams,
  CreateAcademyConsoleAnnouncementResponse,
  DeleteAcademyConsoleAnnouncementParams,
  GetAcademyConsoleAttendanceParams,
  GetAcademyConsoleAttendanceResponse,
  ListAcademyConsoleAnnouncementsParams,
  ListAcademyConsoleAnnouncementsResponse,
  ListAcademyConsoleRecordingsParams,
  ListAcademyConsoleRecordingsResponse,
  UpdateAcademyConsoleAnnouncementBody,
  UpdateAcademyConsoleAnnouncementParams,
  UpdateAcademyConsoleAnnouncementResponse,
  UpdateAcademyConsoleAttendanceBody,
  UpdateAcademyConsoleAttendanceParams,
  UpdateAcademyConsoleAttendanceResponse,
} from "@workspace/api-zod";
import {
  academyAnnouncementsTable,
  academyAttendanceTable,
  academyPlayersTable,
  academyRecordingsTable,
  academySessionsTable,
  academySquadsTable,
  academiesTable,
  db,
  fieldsTable,
  recordingsTable,
  usersTable,
} from "@workspace/db";
import {
  type AcademyConsoleUser,
  requireAcademyConsoleUser,
  requireAcademyMembership,
} from "../lib/academyAccess";

const router: IRouter = Router();

type AttendanceStatus = "present" | "absent" | "late" | "excused";

function rawParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

async function authorizeAcademy(
  user: AcademyConsoleUser,
  res: Response,
  academyId: number,
  ownerOnly = false,
) {
  const roles = await requireAcademyMembership(user.id, academyId, res);
  if (!roles) return null;
  if (ownerOnly && !roles.includes("owner")) {
    res.status(403).json({ error: "Academy owner role required" });
    return null;
  }

  const [academy] = await db
    .select({ id: academiesTable.id })
    .from(academiesTable)
    .where(eq(academiesTable.id, academyId));
  if (!academy) {
    res.status(404).json({ error: "Academy not found" });
    return null;
  }

  return { user, roles };
}

async function attendanceSheet(academyId: number, sessionId: number) {
  const [session] = await db
    .select({
      id: academySessionsTable.id,
      squadId: academySessionsTable.squadId,
    })
    .from(academySessionsTable)
    .where(and(
      eq(academySessionsTable.id, sessionId),
      eq(academySessionsTable.academyId, academyId),
    ));
  if (!session) return null;

  const eligiblePlayers = await db
    .select({
      playerId: academyPlayersTable.id,
      playerName: academyPlayersTable.name,
      jerseyNumber: academyPlayersTable.jerseyNumber,
      status: academyAttendanceTable.status,
    })
    .from(academyPlayersTable)
    .leftJoin(
      academyAttendanceTable,
      and(
        eq(academyAttendanceTable.playerId, academyPlayersTable.id),
        eq(academyAttendanceTable.sessionId, sessionId),
      ),
    )
    .where(and(
      eq(academyPlayersTable.academyId, academyId),
      ...(session.squadId === null
        ? [or(
            eq(academyPlayersTable.isActive, true),
            isNotNull(academyAttendanceTable.playerId),
          )!]
        : [or(
            eq(academyPlayersTable.squadId, session.squadId),
            isNotNull(academyAttendanceTable.playerId),
          )!]),
    ))
    .orderBy(asc(academyPlayersTable.name), asc(academyPlayersTable.id));

  return {
    sessionId,
    players: eligiblePlayers.map((player) => ({
      ...player,
      status: player.status ?? null,
    })),
  };
}

async function eligiblePlayerIds(academyId: number, sessionId: number) {
  const [session] = await db
    .select({
      id: academySessionsTable.id,
      squadId: academySessionsTable.squadId,
    })
    .from(academySessionsTable)
    .where(and(
      eq(academySessionsTable.id, sessionId),
      eq(academySessionsTable.academyId, academyId),
    ));
  if (!session) return null;

  const players = await db
    .select({ id: academyPlayersTable.id })
    .from(academyPlayersTable)
    .leftJoin(
      academyAttendanceTable,
      and(
        eq(academyAttendanceTable.playerId, academyPlayersTable.id),
        eq(academyAttendanceTable.sessionId, sessionId),
      ),
    )
    .where(and(
      eq(academyPlayersTable.academyId, academyId),
      ...(session.squadId === null
        ? [or(
            eq(academyPlayersTable.isActive, true),
            isNotNull(academyAttendanceTable.playerId),
          )!]
        : [or(
            eq(academyPlayersTable.squadId, session.squadId),
            isNotNull(academyAttendanceTable.playerId),
          )!]),
    ));

  return new Set(players.map((player) => player.id));
}

async function academyAnnouncementSummaries(academyId: number, announcementId?: number) {
  return db
    .select({
      id: academyAnnouncementsTable.id,
      academyId: academyAnnouncementsTable.academyId,
      squadId: academyAnnouncementsTable.squadId,
      squadName: academySquadsTable.name,
      title: academyAnnouncementsTable.title,
      body: academyAnnouncementsTable.body,
      createdBy: academyAnnouncementsTable.createdBy,
      authorName: usersTable.name,
      createdAt: academyAnnouncementsTable.createdAt,
    })
    .from(academyAnnouncementsTable)
    .leftJoin(
      academySquadsTable,
      and(
        eq(academySquadsTable.id, academyAnnouncementsTable.squadId),
        eq(academySquadsTable.academyId, academyId),
      ),
    )
    .innerJoin(usersTable, eq(usersTable.id, academyAnnouncementsTable.createdBy))
    .where(and(
      eq(academyAnnouncementsTable.academyId, academyId),
      ...(announcementId === undefined ? [] : [eq(academyAnnouncementsTable.id, announcementId)]),
    ))
    .orderBy(desc(academyAnnouncementsTable.createdAt), desc(academyAnnouncementsTable.id));
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

router.get(
  "/academy/console/academies/:academyId/sessions/:sessionId/attendance",
  async (req, res): Promise<void> => {
    const user = await requireAcademyConsoleUser(req, res);
    if (!user) return;

    const parsed = GetAcademyConsoleAttendanceParams.safeParse({
      academyId: rawParam(req.params.academyId),
      sessionId: rawParam(req.params.sessionId),
    });
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const { academyId, sessionId } = parsed.data;
    if (!(await authorizeAcademy(user, res, academyId))) return;

    const sheet = await attendanceSheet(academyId, sessionId);
    if (!sheet) {
      res.status(404).json({ error: "Session not found in this academy" });
      return;
    }
    res.json(GetAcademyConsoleAttendanceResponse.parse(sheet));
  },
);

router.put(
  "/academy/console/academies/:academyId/sessions/:sessionId/attendance",
  async (req, res): Promise<void> => {
    const user = await requireAcademyConsoleUser(req, res);
    if (!user) return;

    const parsed = UpdateAcademyConsoleAttendanceParams.safeParse({
      academyId: rawParam(req.params.academyId),
      sessionId: rawParam(req.params.sessionId),
    });
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const { academyId, sessionId } = parsed.data;
    if (!(await authorizeAcademy(user, res, academyId))) return;

    const body = UpdateAcademyConsoleAttendanceBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: body.error.message });
      return;
    }
    const playerIds = body.data.entries.map((entry) => entry.playerId);
    if (new Set(playerIds).size !== playerIds.length) {
      res.status(400).json({ error: "A player can appear only once per attendance update" });
      return;
    }

    const eligible = await eligiblePlayerIds(academyId, sessionId);
    if (!eligible) {
      res.status(404).json({ error: "Session not found in this academy" });
      return;
    }
    if (playerIds.some((playerId) => !eligible.has(playerId))) {
      res.status(404).json({ error: "Player not found in this session roster" });
      return;
    }

    const entriesToSet = body.data.entries.filter((entry) => entry.status !== null);
    const entriesToClear = body.data.entries.filter((entry) => entry.status === null);
    if (entriesToSet.length > 0 || entriesToClear.length > 0) {
      await db.transaction(async (tx) => {
        if (entriesToSet.length > 0) {
          await tx
            .insert(academyAttendanceTable)
            .values(entriesToSet.map((entry) => ({
              sessionId,
              playerId: entry.playerId,
              status: entry.status as AttendanceStatus,
            })))
            .onConflictDoUpdate({
              target: [academyAttendanceTable.sessionId, academyAttendanceTable.playerId],
              set: { status: sql`excluded.status` },
            });
        }
        for (const entry of entriesToClear) {
          await tx.delete(academyAttendanceTable).where(and(
            eq(academyAttendanceTable.sessionId, sessionId),
            eq(academyAttendanceTable.playerId, entry.playerId),
          ));
        }
      });
    }

    const sheet = await attendanceSheet(academyId, sessionId);
    if (!sheet) {
      res.status(404).json({ error: "Session not found in this academy" });
      return;
    }
    res.json(UpdateAcademyConsoleAttendanceResponse.parse(sheet));
  },
);

router.get(
  "/academy/console/academies/:academyId/recordings",
  async (req, res): Promise<void> => {
    const user = await requireAcademyConsoleUser(req, res);
    if (!user) return;

    const parsed = ListAcademyConsoleRecordingsParams.safeParse({
      academyId: rawParam(req.params.academyId),
    });
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const { academyId } = parsed.data;
    if (!(await authorizeAcademy(user, res, academyId))) return;

    const recordings = await db
      .select({
        id: recordingsTable.id,
        fieldId: recordingsTable.fieldId,
        court: recordingsTable.court,
        date: recordingsTable.date,
        timeSlot: recordingsTable.timeSlot,
        duration: recordingsTable.duration,
        score: recordingsTable.score,
        videoUrl: recordingsTable.videoUrl,
        highlightMoment: recordingsTable.highlightMoment,
        fieldName: fieldsTable.name,
      })
      .from(academyRecordingsTable)
      .innerJoin(recordingsTable, eq(recordingsTable.id, academyRecordingsTable.recordingId))
      .leftJoin(fieldsTable, eq(fieldsTable.id, recordingsTable.fieldId))
      .where(eq(academyRecordingsTable.academyId, academyId))
      .orderBy(desc(recordingsTable.date), desc(recordingsTable.createdAt), desc(recordingsTable.id));

    res.json(ListAcademyConsoleRecordingsResponse.parse(recordings));
  },
);

router.get(
  "/academy/console/academies/:academyId/announcements",
  async (req, res): Promise<void> => {
    const user = await requireAcademyConsoleUser(req, res);
    if (!user) return;

    const parsed = ListAcademyConsoleAnnouncementsParams.safeParse({
      academyId: rawParam(req.params.academyId),
    });
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const { academyId } = parsed.data;
    if (!(await authorizeAcademy(user, res, academyId))) return;

    const announcements = await academyAnnouncementSummaries(academyId);
    res.json(ListAcademyConsoleAnnouncementsResponse.parse(announcements));
  },
);

router.post(
  "/academy/console/academies/:academyId/announcements",
  async (req, res): Promise<void> => {
    const user = await requireAcademyConsoleUser(req, res);
    if (!user) return;

    const parsed = CreateAcademyConsoleAnnouncementParams.safeParse({
      academyId: rawParam(req.params.academyId),
    });
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const { academyId } = parsed.data;
    if (!(await authorizeAcademy(user, res, academyId))) return;

    const body = CreateAcademyConsoleAnnouncementBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: body.error.message });
      return;
    }
    const title = body.data.title.trim();
    const announcementBody = body.data.body.trim();
    if (!title || !announcementBody) {
      res.status(400).json({ error: "Announcement title and body cannot be empty" });
      return;
    }
    const squadId = body.data.squadId ?? null;
    if (squadId !== null && !(await academySquadBelongsToAcademy(squadId, academyId))) {
      res.status(404).json({ error: "Squad not found in this academy" });
      return;
    }

    const [created] = await db
      .insert(academyAnnouncementsTable)
      .values({
        academyId,
        squadId,
        title,
        body: announcementBody,
        createdBy: user.id,
      })
      .returning({ id: academyAnnouncementsTable.id });
    const [summary] = await academyAnnouncementSummaries(academyId, created.id);
    res.status(201).json(CreateAcademyConsoleAnnouncementResponse.parse(summary));
  },
);

router.patch(
  "/academy/console/academies/:academyId/announcements/:announcementId",
  async (req, res): Promise<void> => {
    const user = await requireAcademyConsoleUser(req, res);
    if (!user) return;

    const parsed = UpdateAcademyConsoleAnnouncementParams.safeParse({
      academyId: rawParam(req.params.academyId),
      announcementId: rawParam(req.params.announcementId),
    });
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const { academyId, announcementId } = parsed.data;
    if (!(await authorizeAcademy(user, res, academyId))) return;

    const body = UpdateAcademyConsoleAnnouncementBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: body.error.message });
      return;
    }
    if (Object.keys(body.data).length === 0) {
      res.status(400).json({ error: "At least one announcement field is required" });
      return;
    }

    const [existing] = await db
      .select({ id: academyAnnouncementsTable.id })
      .from(academyAnnouncementsTable)
      .where(and(
        eq(academyAnnouncementsTable.id, announcementId),
        eq(academyAnnouncementsTable.academyId, academyId),
      ));
    if (!existing) {
      res.status(404).json({ error: "Announcement not found in this academy" });
      return;
    }
    if (body.data.squadId != null
      && !(await academySquadBelongsToAcademy(body.data.squadId, academyId))) {
      res.status(404).json({ error: "Squad not found in this academy" });
      return;
    }
    if (body.data.title !== undefined && !body.data.title.trim()) {
      res.status(400).json({ error: "Announcement title cannot be empty" });
      return;
    }
    if (body.data.body !== undefined && !body.data.body.trim()) {
      res.status(400).json({ error: "Announcement body cannot be empty" });
      return;
    }

    const updates: Partial<typeof academyAnnouncementsTable.$inferInsert> = {};
    if (body.data.title !== undefined) updates.title = body.data.title.trim();
    if (body.data.body !== undefined) updates.body = body.data.body.trim();
    if ("squadId" in body.data) updates.squadId = body.data.squadId ?? null;

    await db
      .update(academyAnnouncementsTable)
      .set(updates)
      .where(and(
        eq(academyAnnouncementsTable.id, announcementId),
        eq(academyAnnouncementsTable.academyId, academyId),
      ));
    const [summary] = await academyAnnouncementSummaries(academyId, announcementId);
    res.json(UpdateAcademyConsoleAnnouncementResponse.parse(summary));
  },
);

router.delete(
  "/academy/console/academies/:academyId/announcements/:announcementId",
  async (req, res): Promise<void> => {
    const user = await requireAcademyConsoleUser(req, res);
    if (!user) return;

    const parsed = DeleteAcademyConsoleAnnouncementParams.safeParse({
      academyId: rawParam(req.params.academyId),
      announcementId: rawParam(req.params.announcementId),
    });
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const { academyId, announcementId } = parsed.data;
    if (!(await authorizeAcademy(user, res, academyId))) return;

    const [deleted] = await db
      .delete(academyAnnouncementsTable)
      .where(and(
        eq(academyAnnouncementsTable.id, announcementId),
        eq(academyAnnouncementsTable.academyId, academyId),
      ))
      .returning({ id: academyAnnouncementsTable.id });
    if (!deleted) {
      res.status(404).json({ error: "Announcement not found in this academy" });
      return;
    }
    res.status(204).send();
  },
);

export default router;