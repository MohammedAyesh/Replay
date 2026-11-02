import { and, asc, desc, eq, inArray, isNotNull, or } from "drizzle-orm";
import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import {
  academiesTable,
  academyMatchLineupsTable,
  academyMatchPagesTable,
  academyMatchPlayerStatsTable,
  academyMembersTable,
  academyPlayerGuardiansTable,
  academyPlayersTable,
  academyRecordingsTable,
  academySessionsTable,
  academySquadsTable,
  analysisJobsTable,
  db,
  recordingsTable,
  type AcademyMatchPage,
  type TrackingManifest,
} from "@workspace/db";
import { requireAcademyConsoleUser, requireAcademyMembership, type AcademyConsoleUser } from "../lib/academyAccess";
import { familyScreensFor } from "../lib/academyPermissions";
import {
  computeAcademyMatchStats,
  goalVoteCount,
  latestBundle,
  loadMatchRoster,
  resolveBindings,
  statsFingerprint,
  type AcademyPlayerStats,
  type AcademyTeamStats,
} from "../lib/academyMatchStats";
import { ACTIVE_STATUSES } from "../lib/analysisJobs";
import { getLocalUserRecord, unauthenticatedResponse } from "../lib/clerkUserBridge";
import { logger } from "../lib/logger";
import { canViewPinnedAcademyRecording } from "../lib/publicFootage";
import type { MatchRoster } from "../lib/matchRoster";
import { rosterInsideMatchWindow, rosterPlayersWithPhotos } from "./claimMatch";

const router: IRouter = Router();

function intParam(value: string | string[] | undefined): number | null {
  const n = Number(Array.isArray(value) ? value[0] : value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

// ─── Loading a match ─────────────────────────────────────────────────────────

type SessionRow = {
  id: number;
  academyId: number;
  squadId: number | null;
  squadName: string | null;
  type: string;
  startsAt: Date;
  endsAt: Date | null;
  location: string;
  opponent: string | null;
  ownScore: number | null;
  opponentScore: number | null;
};

async function loadSession(academyId: number, sessionId: number): Promise<SessionRow | null> {
  const [row] = await db
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
    })
    .from(academySessionsTable)
    .leftJoin(academySquadsTable, eq(academySquadsTable.id, academySessionsTable.squadId))
    .where(and(eq(academySessionsTable.id, sessionId), eq(academySessionsTable.academyId, academyId)));
  return row ? { ...row, squadName: row.squadName ?? null } : null;
}

const DEFAULT_PAGE = (sessionId: number, academyId: number): AcademyMatchPage => ({
  sessionId,
  academyId,
  recordingId: null,
  published: false,
  kitColor: null,
  opponentKitColor: null,
  playersPerSide: null,
  shirtsHaveNumbers: "yes",
  teamStats: null,
  statsFingerprint: null,
  statsComputedAt: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
});

async function loadPage(session: SessionRow): Promise<AcademyMatchPage> {
  const [page] = await db.select().from(academyMatchPagesTable).where(eq(academyMatchPagesTable.sessionId, session.id));
  return page ?? DEFAULT_PAGE(session.id, session.academyId);
}

async function savePage(session: SessionRow, patch: Partial<AcademyMatchPage>) {
  await db
    .insert(academyMatchPagesTable)
    .values({ sessionId: session.id, academyId: session.academyId, ...patch, updatedAt: new Date() })
    .onConflictDoUpdate({ target: academyMatchPagesTable.sessionId, set: { ...patch, updatedAt: new Date() } });
}

async function sessionRecordings(session: SessionRow) {
  return db
    .select({
      id: recordingsTable.id,
      date: recordingsTable.date,
      timeSlot: recordingsTable.timeSlot,
      duration: recordingsTable.duration,
      videoUrl: recordingsTable.videoUrl,
      court: recordingsTable.court,
    })
    .from(academyRecordingsTable)
    .innerJoin(recordingsTable, eq(recordingsTable.id, academyRecordingsTable.recordingId))
    .where(and(eq(academyRecordingsTable.academyId, session.academyId), eq(academyRecordingsTable.sessionId, session.id)))
    .orderBy(asc(recordingsTable.id));
}

export type LineupEntry = {
  playerId: number;
  name: string;
  squadName: string | null;
  isActive: boolean;
  shirtNumber: number | null;
  inSquad: boolean;
  rosterPlayerId: string | null;
  boundBy: string | null;
  saved: boolean;
};

/** The squad's players with this match's numbers; anyone added from another squad stays listed. */
async function loadLineup(session: SessionRow): Promise<LineupEntry[]> {
  const rows = await db.select().from(academyMatchLineupsTable).where(eq(academyMatchLineupsTable.sessionId, session.id));
  const byPlayer = new Map(rows.map((r) => [r.playerId, r]));
  const squadFilter = session.squadId === null
    ? eq(academyPlayersTable.isActive, true)
    : and(eq(academyPlayersTable.isActive, true), eq(academyPlayersTable.squadId, session.squadId));
  const ids = rows.map((r) => r.playerId);
  const players = await db
    .select({
      id: academyPlayersTable.id,
      name: academyPlayersTable.name,
      jerseyNumber: academyPlayersTable.jerseyNumber,
      isActive: academyPlayersTable.isActive,
      squadName: academySquadsTable.name,
    })
    .from(academyPlayersTable)
    .leftJoin(academySquadsTable, eq(academySquadsTable.id, academyPlayersTable.squadId))
    .where(and(
      eq(academyPlayersTable.academyId, session.academyId),
      ids.length ? or(squadFilter, inArray(academyPlayersTable.id, ids)) : squadFilter,
    ))
    .orderBy(asc(academyPlayersTable.name));
  return players.map((p) => {
    const row = byPlayer.get(p.id);
    return {
      playerId: p.id,
      name: p.name,
      squadName: p.squadName ?? null,
      isActive: p.isActive,
      shirtNumber: row ? row.shirtNumber : p.jerseyNumber,
      inSquad: row ? row.inSquad : true,
      rosterPlayerId: row?.rosterPlayerId ?? null,
      boundBy: row?.boundBy ?? null,
      saved: Boolean(row),
    };
  });
}

async function latestJob(recordingId: number) {
  const [job] = await db
    .select({
      id: analysisJobsTable.id,
      status: analysisJobsTable.status,
      stage: analysisJobsTable.stage,
      progress: analysisJobsTable.progress,
      error: analysisJobsTable.error,
      createdAt: analysisJobsTable.createdAt,
    })
    .from(analysisJobsTable)
    .where(eq(analysisJobsTable.recordingId, recordingId))
    .orderBy(desc(analysisJobsTable.id))
    .limit(1);
  return job ?? null;
}

type MatchContext = {
  session: SessionRow;
  page: AcademyMatchPage;
  recordings: Awaited<ReturnType<typeof sessionRecordings>>;
  recordingId: number | null;
  lineup: LineupEntry[];
  bundle: { id: number; manifest: TrackingManifest } | null;
  roster: MatchRoster | null;
};

async function loadContext(session: SessionRow): Promise<MatchContext> {
  const page = await loadPage(session);
  const recordings = await sessionRecordings(session);
  const recordingId = recordings.find((r) => r.id === page.recordingId)?.id ?? recordings[0]?.id ?? null;
  const lineup = await loadLineup(session);
  const bundle = recordingId ? await latestBundle(recordingId) : null;
  const rawRoster = bundle ? await loadMatchRoster(bundle.manifest) : null;
  const roster = rawRoster && bundle ? rosterInsideMatchWindow(rawRoster, bundle.manifest) : null;
  return { session, page, recordings, recordingId, lineup, bundle, roster };
}

type StatsView = {
  team: AcademyTeamStats | null;
  players: AcademyPlayerStats[];
  hasBall: boolean;
  computedAt: string | null;
};

/** Cached numbers while nothing they depend on changed; recomputed otherwise. */
async function statsFor(ctx: MatchContext, force = false): Promise<StatsView | null> {
  if (!ctx.recordingId || !ctx.bundle || !ctx.roster) return null;
  const bindings = resolveBindings(ctx.lineup, ctx.roster);
  const fingerprint = statsFingerprint(ctx.bundle.id, bindings, await goalVoteCount(ctx.recordingId));
  if (!force && ctx.page.statsFingerprint === fingerprint) {
    const rows = await db.select().from(academyMatchPlayerStatsTable).where(eq(academyMatchPlayerStatsTable.sessionId, ctx.session.id));
    const team = ctx.page.teamStats as (AcademyTeamStats & { hasBall?: boolean }) | null;
    return {
      team: team && "touches" in team ? team : null,
      players: rows.map((r) => r.stats as AcademyPlayerStats),
      hasBall: (ctx.page.teamStats as { hasBall?: boolean } | null)?.hasBall ?? rows.some((r) => (r.stats as AcademyPlayerStats).touches !== null),
      computedAt: ctx.page.statsComputedAt?.toISOString() ?? null,
    };
  }
  const result = await computeAcademyMatchStats(ctx.recordingId, ctx.roster, bindings);
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx.delete(academyMatchPlayerStatsTable).where(eq(academyMatchPlayerStatsTable.sessionId, ctx.session.id));
    if (result.players.length) {
      await tx.insert(academyMatchPlayerStatsTable).values(result.players.map((p) => ({
        sessionId: ctx.session.id,
        academyId: ctx.session.academyId,
        playerId: p.playerId,
        recordingId: ctx.recordingId!,
        rosterPlayerId: p.rosterPlayerId,
        stats: p,
        computedAt: now,
      })));
    }
    await tx
      .insert(academyMatchPagesTable)
      .values({
        sessionId: ctx.session.id,
        academyId: ctx.session.academyId,
        teamStats: result.team ? { ...result.team, hasBall: result.hasBall } : { hasBall: result.hasBall },
        statsFingerprint: result.available ? fingerprint : null,
        statsComputedAt: now,
      })
      .onConflictDoUpdate({
        target: academyMatchPagesTable.sessionId,
        set: {
          teamStats: result.team ? { ...result.team, hasBall: result.hasBall } : { hasBall: result.hasBall },
          statsFingerprint: result.available ? fingerprint : null,
          statsComputedAt: now,
        },
      });
  });
  return { team: result.team, players: result.players, hasBall: result.hasBall, computedAt: now.toISOString() };
}

function analysisView(job: Awaited<ReturnType<typeof latestJob>> | null, ctx: MatchContext) {
  return {
    hasVideo: ctx.recordingId !== null,
    analysed: Boolean(ctx.bundle),
    hasRoster: Boolean(ctx.roster),
    detectedPlayers: ctx.roster?.players.length ?? 0,
    job: job ? { id: job.id, status: job.status, stage: job.stage, progress: job.progress, error: job.error, createdAt: job.createdAt } : null,
  };
}

function sessionView(session: SessionRow) {
  return {
    id: session.id,
    type: session.type,
    squadId: session.squadId,
    squadName: session.squadName,
    startsAt: session.startsAt,
    endsAt: session.endsAt,
    location: session.location,
    opponent: session.opponent,
    ownScore: session.ownScore,
    opponentScore: session.opponentScore,
  };
}

// ─── Console ─────────────────────────────────────────────────────────────────

async function consoleAccess(req: Request, res: Response, ownerOnly = false): Promise<{ user: AcademyConsoleUser; academyId: number; isOwner: boolean } | null> {
  const user = await requireAcademyConsoleUser(req, res);
  if (!user) return null;
  const academyId = intParam(req.params.academyId);
  if (!academyId) {
    res.status(400).json({ error: "Invalid academy id" });
    return null;
  }
  const roles = await requireAcademyMembership(user.id, academyId, res);
  if (!roles) return null;
  if (ownerOnly && !roles.includes("owner")) {
    res.status(403).json({ error: "Academy owner role required" });
    return null;
  }
  return { user, academyId, isOwner: roles.includes("owner") };
}

async function consoleSession(req: Request, res: Response, ownerOnly = false) {
  const access = await consoleAccess(req, res, ownerOnly);
  if (!access) return null;
  const sessionId = intParam(req.params.sessionId);
  const session = sessionId ? await loadSession(access.academyId, sessionId) : null;
  if (!session) {
    res.status(404).json({ error: "Match not found in this academy" });
    return null;
  }
  return { ...access, session };
}

/** Every match, plus any training with video, newest first. */
router.get("/academy/console/academies/:academyId/matches", async (req, res): Promise<void> => {
  const access = await consoleAccess(req, res);
  if (!access) return;
  const sessions = await db
    .select({
      id: academySessionsTable.id,
      type: academySessionsTable.type,
      squadName: academySquadsTable.name,
      startsAt: academySessionsTable.startsAt,
      location: academySessionsTable.location,
      opponent: academySessionsTable.opponent,
      ownScore: academySessionsTable.ownScore,
      opponentScore: academySessionsTable.opponentScore,
    })
    .from(academySessionsTable)
    .leftJoin(academySquadsTable, eq(academySquadsTable.id, academySessionsTable.squadId))
    .where(eq(academySessionsTable.academyId, access.academyId))
    .orderBy(desc(academySessionsTable.startsAt))
    .limit(300);
  const ids = sessions.map((s) => s.id);
  if (!ids.length) {
    res.json([]);
    return;
  }
  const [recs, pages, statRows] = await Promise.all([
    db.select({ sessionId: academyRecordingsTable.sessionId, recordingId: academyRecordingsTable.recordingId })
      .from(academyRecordingsTable).where(and(eq(academyRecordingsTable.academyId, access.academyId), inArray(academyRecordingsTable.sessionId, ids))),
    db.select().from(academyMatchPagesTable).where(inArray(academyMatchPagesTable.sessionId, ids)),
    db.select({ sessionId: academyMatchPlayerStatsTable.sessionId }).from(academyMatchPlayerStatsTable)
      .where(inArray(academyMatchPlayerStatsTable.sessionId, ids)),
  ]);
  const recordingsBySession = new Map<number, number[]>();
  for (const r of recs) if (r.sessionId) recordingsBySession.set(r.sessionId, [...(recordingsBySession.get(r.sessionId) ?? []), r.recordingId]);
  const allRecordingIds = recs.map((r) => r.recordingId);
  const jobs = allRecordingIds.length
    ? await db.select({ recordingId: analysisJobsTable.recordingId, status: analysisJobsTable.status, id: analysisJobsTable.id })
      .from(analysisJobsTable).where(inArray(analysisJobsTable.recordingId, allRecordingIds)).orderBy(desc(analysisJobsTable.id))
    : [];
  const jobByRecording = new Map<number, string>();
  for (const j of jobs) if (!jobByRecording.has(j.recordingId)) jobByRecording.set(j.recordingId, j.status);
  const pageBySession = new Map(pages.map((p) => [p.sessionId, p]));
  const statCount = new Map<number, number>();
  for (const s of statRows) statCount.set(s.sessionId, (statCount.get(s.sessionId) ?? 0) + 1);

  res.json(sessions
    .filter((s) => s.type === "match" || (recordingsBySession.get(s.id)?.length ?? 0) > 0)
    .map((s) => {
      const recordingIds = recordingsBySession.get(s.id) ?? [];
      const page = pageBySession.get(s.id);
      const recordingId = recordingIds.find((id) => id === page?.recordingId) ?? recordingIds[0] ?? null;
      return {
        ...s,
        squadName: s.squadName ?? null,
        hasVideo: recordingIds.length > 0,
        analysis: recordingId ? jobByRecording.get(recordingId) ?? null : null,
        playersWithStats: statCount.get(s.id) ?? 0,
        published: page?.published ?? false,
      };
    }));
});

router.get("/academy/console/academies/:academyId/matches/:sessionId", async (req, res): Promise<void> => {
  const found = await consoleSession(req, res);
  if (!found) return;
  const ctx = await loadContext(found.session);
  const job = ctx.recordingId ? await latestJob(ctx.recordingId) : null;
  let stats: StatsView | null = null;
  try {
    stats = await statsFor(ctx);
  } catch (error) {
    logger.warn({ sessionId: found.session.id, error: (error as Error).message }, "Academy match stats failed");
  }
  let detected: unknown[] = [];
  if (ctx.roster && ctx.bundle) {
    try {
      detected = (await rosterPlayersWithPhotos(ctx.bundle.manifest, ctx.roster)).map((p) => ({
        id: p.id,
        number: p.number,
        numberCandidate: p.numberCandidate ?? null,
        minutes: Math.round(p.minutes * 10) / 10,
        photos: p.photos.slice(0, 3).map((photo) => photo.jpeg),
      }));
    } catch (error) {
      logger.warn({ sessionId: found.session.id, error: (error as Error).message }, "Academy match roster photos failed");
    }
  }
  const bindings = resolveBindings(ctx.lineup, ctx.roster);
  res.json({
    session: sessionView(ctx.session),
    role: found.isOwner ? "owner" : "coach",
    page: {
      published: ctx.page.published,
      recordingId: ctx.recordingId,
      kitColor: ctx.page.kitColor,
      opponentKitColor: ctx.page.opponentKitColor,
      playersPerSide: ctx.page.playersPerSide,
      shirtsHaveNumbers: ctx.page.shirtsHaveNumbers,
    },
    recordings: ctx.recordings,
    analysis: analysisView(job, ctx),
    lineup: ctx.lineup.map((p) => {
      const binding = bindings.find((b) => b.playerId === p.playerId);
      return { ...p, boundTo: binding?.rosterPlayerId ?? null, boundHow: binding?.how ?? null };
    }),
    detected,
    stats,
  });
});

const PageBody = z.object({
  published: z.boolean().optional(),
  recordingId: z.number().int().positive().nullable().optional(),
  kitColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
  opponentKitColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
  playersPerSide: z.number().int().min(3).max(11).nullable().optional(),
  shirtsHaveNumbers: z.enum(["yes", "no", "unknown"]).optional(),
});

router.put("/academy/console/academies/:academyId/matches/:sessionId", async (req, res): Promise<void> => {
  const found = await consoleSession(req, res);
  if (!found) return;
  const body = PageBody.safeParse(req.body ?? {});
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  if (body.data.published !== undefined && !found.isOwner) {
    res.status(403).json({ error: "Only the owner can show a match page to parents" });
    return;
  }
  if (body.data.recordingId) {
    const recordings = await sessionRecordings(found.session);
    if (!recordings.some((r) => r.id === body.data.recordingId)) {
      res.status(404).json({ error: "That video is not attached to this match" });
      return;
    }
  }
  await savePage(found.session, body.data);
  res.json({ ok: true });
});

const LineupBody = z.object({
  players: z.array(z.object({
    playerId: z.number().int().positive(),
    shirtNumber: z.number().int().min(0).max(99).nullable(),
    inSquad: z.boolean(),
  })).max(60),
  /** Also keep each number as the player's usual number when he has none yet. */
  rememberNumbers: z.boolean().optional(),
});

router.put("/academy/console/academies/:academyId/matches/:sessionId/lineup", async (req, res): Promise<void> => {
  const found = await consoleSession(req, res);
  if (!found) return;
  const body = LineupBody.safeParse(req.body ?? {});
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const ids = body.data.players.map((p) => p.playerId);
  if (new Set(ids).size !== ids.length) {
    res.status(400).json({ error: "A player can appear only once" });
    return;
  }
  const numbers = body.data.players.filter((p) => p.inSquad && p.shirtNumber !== null).map((p) => p.shirtNumber);
  if (new Set(numbers).size !== numbers.length) {
    res.status(400).json({ error: "Two players in the squad have the same shirt number" });
    return;
  }
  if (ids.length) {
    const valid = await db.select({ id: academyPlayersTable.id, jerseyNumber: academyPlayersTable.jerseyNumber })
      .from(academyPlayersTable)
      .where(and(eq(academyPlayersTable.academyId, found.academyId), inArray(academyPlayersTable.id, ids)));
    if (valid.length !== ids.length) {
      res.status(404).json({ error: "Player not found in this academy" });
      return;
    }
    const usual = new Map(valid.map((v) => [v.id, v.jerseyNumber]));
    await db.transaction(async (tx) => {
      for (const p of body.data.players) {
        await tx.insert(academyMatchLineupsTable)
          .values({ sessionId: found.session.id, playerId: p.playerId, shirtNumber: p.shirtNumber, inSquad: p.inSquad })
          .onConflictDoUpdate({
            target: [academyMatchLineupsTable.sessionId, academyMatchLineupsTable.playerId],
            set: { shirtNumber: p.shirtNumber, inSquad: p.inSquad, updatedAt: new Date() },
          });
        if (body.data.rememberNumbers && p.shirtNumber !== null && usual.get(p.playerId) == null) {
          await tx.update(academyPlayersTable).set({ jerseyNumber: p.shirtNumber }).where(eq(academyPlayersTable.id, p.playerId));
        }
      }
    });
  }
  res.json({ ok: true });
});

const BindingBody = z.object({
  /** a detected player's id; null = "not in this video"; "auto" = back to the shirt number */
  rosterPlayerId: z.union([z.string().min(1).max(80), z.null(), z.literal("auto")]),
});

router.put("/academy/console/academies/:academyId/matches/:sessionId/players/:playerId/binding", async (req, res): Promise<void> => {
  const found = await consoleSession(req, res);
  if (!found) return;
  const playerId = intParam(req.params.playerId);
  const body = BindingBody.safeParse(req.body ?? {});
  if (!playerId || !body.success) {
    res.status(400).json({ error: body.success ? "Invalid player" : body.error.message });
    return;
  }
  const [player] = await db.select({ id: academyPlayersTable.id, jerseyNumber: academyPlayersTable.jerseyNumber })
    .from(academyPlayersTable)
    .where(and(eq(academyPlayersTable.id, playerId), eq(academyPlayersTable.academyId, found.academyId)));
  if (!player) {
    res.status(404).json({ error: "Player not found in this academy" });
    return;
  }
  const auto = body.data.rosterPlayerId === "auto";
  const rosterPlayerId = auto ? null : body.data.rosterPlayerId;
  await db.transaction(async (tx) => {
    // One detected player is one academy player: picking him for someone frees him elsewhere.
    if (rosterPlayerId) {
      await tx.update(academyMatchLineupsTable)
        .set({ rosterPlayerId: null, boundBy: null, updatedAt: new Date() })
        .where(and(
          eq(academyMatchLineupsTable.sessionId, found.session.id),
          eq(academyMatchLineupsTable.rosterPlayerId, rosterPlayerId),
        ));
    }
    await tx.insert(academyMatchLineupsTable)
      .values({
        sessionId: found.session.id,
        playerId,
        shirtNumber: player.jerseyNumber,
        inSquad: true,
        rosterPlayerId,
        boundBy: auto ? null : "owner",
      })
      .onConflictDoUpdate({
        target: [academyMatchLineupsTable.sessionId, academyMatchLineupsTable.playerId],
        set: { rosterPlayerId, boundBy: auto ? null : "owner", ...(rosterPlayerId ? { inSquad: true } : {}), updatedAt: new Date() },
      });
  });
  res.json({ ok: true });
});

router.post("/academy/console/academies/:academyId/matches/:sessionId/stats/refresh", async (req, res): Promise<void> => {
  const found = await consoleSession(req, res);
  if (!found) return;
  const ctx = await loadContext(found.session);
  try {
    const stats = await statsFor(ctx, true);
    res.json({ stats });
  } catch (error) {
    logger.warn({ sessionId: found.session.id, error: (error as Error).message }, "Academy match stats refresh failed");
    res.status(500).json({ error: "Could not compute the stats" });
  }
});

const AnalyseBody = z.object({ again: z.boolean().optional() });

/** Owner-triggered analysis of the match video, with the lineup as roster hints for the pipeline. */
router.post("/academy/console/academies/:academyId/matches/:sessionId/analyse", async (req, res): Promise<void> => {
  const found = await consoleSession(req, res, true);
  if (!found) return;
  const body = AnalyseBody.safeParse(req.body ?? {});
  const ctx = await loadContext(found.session);
  if (!ctx.recordingId) {
    res.status(409).json({ error: "This match has no video yet" });
    return;
  }
  const recording = ctx.recordings.find((r) => r.id === ctx.recordingId)!;
  if (!recording.videoUrl) {
    res.status(409).json({ error: "This video is still being processed" });
    return;
  }
  const [active] = await db.select({ id: analysisJobsTable.id }).from(analysisJobsTable)
    .where(and(eq(analysisJobsTable.recordingId, ctx.recordingId), inArray(analysisJobsTable.status, ACTIVE_STATUSES)))
    .limit(1);
  if (active) {
    res.status(409).json({ error: "This match is already being analysed" });
    return;
  }
  if (ctx.bundle && !(body.success && body.data.again)) {
    res.status(409).json({ error: "This match is already analysed", code: "already_analysed" });
    return;
  }
  const squad = ctx.lineup.filter((p) => p.inSquad);
  const playersPerSide = ctx.page.playersPerSide ?? Math.max(5, Math.min(11, squad.length || 7));
  const numbers = squad.map((p) => p.shirtNumber).filter((n): n is number => n !== null).sort((a, b) => a - b);
  const [academy] = await db.select({ name: academiesTable.name }).from(academiesTable).where(eq(academiesTable.id, found.academyId));
  const rosterHints = {
    matchCode: `academy-session-${found.session.id}`,
    playersPerSide,
    teamCount: 2,
    substitutesPerTeam: Math.max(0, squad.length - playersPerSide),
    teams: [
      {
        key: "A",
        name: found.session.squadName ?? academy?.name ?? null,
        color: ctx.page.kitColor ?? "#ffffff",
        shirtsHaveNumbers: ctx.page.shirtsHaveNumbers === "unknown" && numbers.length >= 2 ? "yes, inferred" : ctx.page.shirtsHaveNumbers,
        shirtNumbers: numbers,
        squadSize: squad.length,
      },
      {
        key: "B",
        name: found.session.opponent,
        color: ctx.page.opponentKitColor ?? "#000000",
        shirtsHaveNumbers: "unknown",
        shirtNumbers: [],
        squadSize: playersPerSide,
      },
    ],
    totalPlayersExpected: playersPerSide * 2 + Math.max(0, squad.length - playersPerSide),
  };
  const [job] = await db.insert(analysisJobsTable).values({
    recordingId: ctx.recordingId,
    sourceRecordingIds: [ctx.recordingId],
    matchStartSeconds: 0,
    params: { academyId: found.academyId, academySessionId: found.session.id, rosterHints },
    createdBy: found.user.id,
  }).returning({ id: analysisJobsTable.id });
  await savePage(found.session, { recordingId: ctx.recordingId });
  logger.info({ jobId: job.id, academyId: found.academyId, sessionId: found.session.id }, "Academy match analysis queued");
  res.status(201).json({ jobId: job.id });
});

/** Every analysed match of every player, for comparing players. */
router.get("/academy/console/academies/:academyId/player-stats", async (req, res): Promise<void> => {
  const access = await consoleAccess(req, res);
  if (!access) return;
  res.json(await playerStatsRows(access.academyId, null, false));
});

async function playerStatsRows(academyId: number, playerIds: number[] | null, publishedOnly: boolean) {
  const rows = await db
    .select({
      playerId: academyMatchPlayerStatsTable.playerId,
      playerName: academyPlayersTable.name,
      squadName: academySquadsTable.name,
      jerseyNumber: academyPlayersTable.jerseyNumber,
      sessionId: academyMatchPlayerStatsTable.sessionId,
      startsAt: academySessionsTable.startsAt,
      type: academySessionsTable.type,
      opponent: academySessionsTable.opponent,
      ownScore: academySessionsTable.ownScore,
      opponentScore: academySessionsTable.opponentScore,
      published: academyMatchPagesTable.published,
      stats: academyMatchPlayerStatsTable.stats,
    })
    .from(academyMatchPlayerStatsTable)
    .innerJoin(academyPlayersTable, eq(academyPlayersTable.id, academyMatchPlayerStatsTable.playerId))
    .leftJoin(academySquadsTable, eq(academySquadsTable.id, academyPlayersTable.squadId))
    .innerJoin(academySessionsTable, eq(academySessionsTable.id, academyMatchPlayerStatsTable.sessionId))
    .leftJoin(academyMatchPagesTable, eq(academyMatchPagesTable.sessionId, academyMatchPlayerStatsTable.sessionId))
    .where(and(
      eq(academyMatchPlayerStatsTable.academyId, academyId),
      ...(playerIds ? [inArray(academyMatchPlayerStatsTable.playerId, playerIds)] : []),
      ...(publishedOnly ? [eq(academyMatchPagesTable.published, true)] : []),
    ))
    .orderBy(desc(academySessionsTable.startsAt));
  return rows.map((r) => ({ ...r, squadName: r.squadName ?? null, published: r.published ?? false, stats: r.stats as AcademyPlayerStats }));
}

// ─── Family (parents and players) ────────────────────────────────────────────

async function familyViewer(req: Request, res: Response) {
  const user = await getLocalUserRecord(req);
  if (!user || user.isGuest || user.isDisabled) {
    unauthenticatedResponse(res, req);
    return null;
  }
  const [own, guardian, members] = await Promise.all([
    db.select({ id: academyPlayersTable.id }).from(academyPlayersTable).where(eq(academyPlayersTable.userId, user.id)),
    db.select({ id: academyPlayerGuardiansTable.playerId }).from(academyPlayerGuardiansTable).where(eq(academyPlayerGuardiansTable.userId, user.id)),
    db.select({ academyId: academyMembersTable.academyId }).from(academyMembersTable).where(eq(academyMembersTable.userId, user.id)),
  ]);
  return {
    user,
    familyPlayerIds: new Set([...own.map((r) => r.id), ...guardian.map((r) => r.id)]),
    guardianPlayerIds: new Set(guardian.map((r) => r.id)),
    memberAcademyIds: new Set(members.map((m) => m.academyId)),
  };
}

async function familyCanSee(viewer: NonNullable<Awaited<ReturnType<typeof familyViewer>>>, session: SessionRow): Promise<boolean> {
  const players = await db.select({
    id: academyPlayersTable.id,
    academyId: academyPlayersTable.academyId,
    squadId: academyPlayersTable.squadId,
    userId: academyPlayersTable.userId,
    isActive: academyPlayersTable.isActive,
  }).from(academyPlayersTable).where(eq(academyPlayersTable.academyId, session.academyId));
  return canViewPinnedAcademyRecording(
    viewer.user.id,
    { academyId: session.academyId, sessionSquadId: session.squadId },
    viewer.memberAcademyIds,
    players,
    viewer.guardianPlayerIds,
  );
}

/** Published match pages the viewer's children (or the viewer himself) can open. */
router.get("/academy/family/matches", async (req, res): Promise<void> => {
  const viewer = await familyViewer(req, res);
  if (!viewer) return;
  res.setHeader("Cache-Control", "no-store");
  if (!viewer.familyPlayerIds.size) {
    res.json([]);
    return;
  }
  const kids = await db.select({ academyId: academyPlayersTable.academyId, squadId: academyPlayersTable.squadId, userId: academyPlayersTable.userId })
    .from(academyPlayersTable).where(and(inArray(academyPlayersTable.id, [...viewer.familyPlayerIds]), eq(academyPlayersTable.isActive, true)));
  // Only academies that show match pages to this viewer (as the player himself, or as family).
  const academyIds: number[] = [];
  for (const academyId of new Set(kids.map((k) => k.academyId))) {
    const role = kids.some((k) => k.academyId === academyId && k.userId === viewer.user.id) ? "player" : "parent";
    if ((await familyScreensFor(academyId, role)).includes("matches")) academyIds.push(academyId);
  }
  if (!academyIds.length) {
    res.json([]);
    return;
  }
  const pages = await db
    .select({
      id: academySessionsTable.id,
      academyId: academySessionsTable.academyId,
      academyName: academiesTable.name,
      squadId: academySessionsTable.squadId,
      squadName: academySquadsTable.name,
      type: academySessionsTable.type,
      startsAt: academySessionsTable.startsAt,
      location: academySessionsTable.location,
      opponent: academySessionsTable.opponent,
      ownScore: academySessionsTable.ownScore,
      opponentScore: academySessionsTable.opponentScore,
    })
    .from(academyMatchPagesTable)
    .innerJoin(academySessionsTable, eq(academySessionsTable.id, academyMatchPagesTable.sessionId))
    .innerJoin(academiesTable, eq(academiesTable.id, academySessionsTable.academyId))
    .leftJoin(academySquadsTable, eq(academySquadsTable.id, academySessionsTable.squadId))
    .where(and(eq(academyMatchPagesTable.published, true), inArray(academySessionsTable.academyId, academyIds)))
    .orderBy(desc(academySessionsTable.startsAt))
    .limit(60);
  res.json(pages
    .filter((p) => p.squadId === null || kids.some((k) => k.academyId === p.academyId && k.squadId === p.squadId))
    .map((p) => ({ ...p, squadName: p.squadName ?? null })));
});

router.get("/academy/family/matches/:sessionId", async (req, res): Promise<void> => {
  const viewer = await familyViewer(req, res);
  if (!viewer) return;
  res.setHeader("Cache-Control", "no-store");
  const sessionId = intParam(req.params.sessionId);
  const [owner] = sessionId
    ? await db.select({ academyId: academySessionsTable.academyId }).from(academySessionsTable).where(eq(academySessionsTable.id, sessionId))
    : [];
  const session = owner && sessionId ? await loadSession(owner.academyId, sessionId) : null;
  const page = session ? await loadPage(session) : null;
  const isMember = session ? viewer.memberAcademyIds.has(session.academyId) : false;
  if (!session || !page || (!page.published && !isMember) || !(await familyCanSee(viewer, session))) {
    res.status(404).json({ error: "Match not found" });
    return;
  }
  const ctx = await loadContext(session);
  let stats: StatsView | null = null;
  try {
    stats = await statsFor(ctx);
  } catch (error) {
    logger.warn({ sessionId: session.id, error: (error as Error).message }, "Academy family match stats failed");
  }
  const [academy] = await db.select({ name: academiesTable.name, logoUrl: academiesTable.logoUrl })
    .from(academiesTable).where(eq(academiesTable.id, session.academyId));
  const recording = ctx.recordings.find((r) => r.id === ctx.recordingId) ?? null;
  const statsByPlayer = new Map((stats?.players ?? []).map((p) => [p.playerId, p]));
  res.json({
    academy: { name: academy?.name ?? "", logoUrl: academy?.logoUrl ?? null },
    session: sessionView(session),
    recording: recording ? { id: recording.id, date: recording.date, timeSlot: recording.timeSlot, videoUrl: recording.videoUrl, court: recording.court } : null,
    analysed: Boolean(ctx.bundle),
    team: stats?.team ?? null,
    hasBall: stats?.hasBall ?? false,
    players: ctx.lineup
      .filter((p) => p.inSquad)
      .map((p) => ({
        playerId: p.playerId,
        name: p.name,
        shirtNumber: p.shirtNumber,
        mine: viewer.familyPlayerIds.has(p.playerId),
        stats: statsByPlayer.get(p.playerId) ?? null,
      })),
  });
});

/** One of the viewer's children across every published match, with the squad's average in each. */
router.get("/academy/family/players/:playerId/match-stats", async (req, res): Promise<void> => {
  const viewer = await familyViewer(req, res);
  if (!viewer) return;
  res.setHeader("Cache-Control", "no-store");
  const playerId = intParam(req.params.playerId);
  if (!playerId || !viewer.familyPlayerIds.has(playerId)) {
    res.status(404).json({ error: "Player not found" });
    return;
  }
  const [player] = await db.select({ academyId: academyPlayersTable.academyId, name: academyPlayersTable.name })
    .from(academyPlayersTable).where(eq(academyPlayersTable.id, playerId));
  if (!player) {
    res.status(404).json({ error: "Player not found" });
    return;
  }
  const mine = await playerStatsRows(player.academyId, [playerId], true);
  const sessionIds = mine.map((m) => m.sessionId);
  const others = sessionIds.length
    ? await db.select({ sessionId: academyMatchPlayerStatsTable.sessionId, playerId: academyMatchPlayerStatsTable.playerId, stats: academyMatchPlayerStatsTable.stats })
      .from(academyMatchPlayerStatsTable)
      .where(and(inArray(academyMatchPlayerStatsTable.sessionId, sessionIds), isNotNull(academyMatchPlayerStatsTable.stats)))
    : [];
  res.json({
    player: { id: playerId, name: player.name },
    matches: mine.map((m) => ({
      sessionId: m.sessionId,
      startsAt: m.startsAt,
      opponent: m.opponent,
      ownScore: m.ownScore,
      opponentScore: m.opponentScore,
      stats: m.stats,
      squad: others.filter((o) => o.sessionId === m.sessionId).map((o) => o.stats as AcademyPlayerStats),
    })),
  });
});

export default router;
