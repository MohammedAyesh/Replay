import { and, asc, desc, eq, gte, inArray, lt } from "drizzle-orm";
import { Router, type IRouter } from "express";
import { academyCreativeProjectsTable, academySessionsTable, academySquadsTable, db } from "@workspace/db";
import { CREATIVE_BASE, creativeOwner, loadCreativeProject, projectIdParam, publicProject } from "../lib/creative/projects";
import { FOR_YOU, ensureAutoDrafts, groupOf, inFeed, parseOriginKey } from "../lib/creative/autoDrafts";
import { academyCreativeProfile, buildSessionData, loadSessionFacts, type CreativeLocale } from "../lib/creative/sessionData";
import { logger } from "../lib/logger";
import { CalendarBody, loadCalendar, saveCalendar } from "../lib/marketing/calendar";
import { ammanDayLabel, ammanTime } from "./academyStudio";

/**
 * Creative hub → For you (owner only; see routes/academyCreative.ts).
 *
 *   GET  …/creative/sessions/:sessionId/data  CreativeData for one session
 *   GET  …/creative/for-you                   drafts Replay prepared + fixtures coming up
 *   POST …/creative/for-you/:projectId/skip   not interested: the draft never comes back
 *   GET  …/creative/content-calendar          the weekly calendar (which kind of post on which day)
 *   PUT  …/creative/content-calendar          change it ({ slots: null } = the default week)
 *
 * Drafts are made lazily here, at most once per academy per 10 minutes (see
 * lib/creative/autoDrafts.ts).
 */
const router: IRouter = Router();
const base = CREATIVE_BASE;
const DAY = 86_400_000;

const localeOf = (v: unknown): CreativeLocale => (v === "en" ? "en" : "ar");

router.get(`${base}/sessions/:sessionId/data`, async (req, res): Promise<void> => {
  const access = await creativeOwner(req, res);
  if (!access) return;
  const sessionId = projectIdParam(req.params.sessionId);
  if (!sessionId) { res.status(400).json({ error: "Invalid session id" }); return; }
  const profile = await academyCreativeProfile(access.academy);
  const facts = await loadSessionFacts(access.academyId, sessionId, profile);
  if (!facts) { res.status(404).json({ error: "Session not found in this academy" }); return; }
  res.json({ data: buildSessionData(facts, localeOf(req.query.locale)) });
});

router.get(`${base}/for-you`, async (req, res): Promise<void> => {
  const access = await creativeOwner(req, res);
  if (!access) return;
  const now = new Date();
  await ensureAutoDrafts(access.academy, now);

  const [rows, fixtures] = await Promise.all([
    db.select().from(academyCreativeProjectsTable)
      .where(and(
        eq(academyCreativeProjectsTable.academyId, access.academyId),
        eq(academyCreativeProjectsTable.origin, "auto"),
        inArray(academyCreativeProjectsTable.status, ["draft", "ready"]),
      ))
      .orderBy(desc(academyCreativeProjectsTable.createdAt), desc(academyCreativeProjectsTable.id))
      .limit(120),
    db.select({
      id: academySessionsTable.id,
      startsAt: academySessionsTable.startsAt,
      opponent: academySessionsTable.opponent,
      location: academySessionsTable.location,
      squad: academySquadsTable.name,
    }).from(academySessionsTable)
      .leftJoin(academySquadsTable, eq(academySquadsTable.id, academySessionsTable.squadId))
      .where(and(
        eq(academySessionsTable.academyId, access.academyId),
        eq(academySessionsTable.type, "match"),
        gte(academySessionsTable.startsAt, now),
        lt(academySessionsTable.startsAt, new Date(now.getTime() + FOR_YOU.aheadDays * DAY)),
      ))
      .orderBy(asc(academySessionsTable.startsAt))
      .limit(20),
  ]);

  const sessionIds = [...new Set(rows.map((r) => r.sourceSessionId).filter((id): id is number => id !== null))];
  const sessions = sessionIds.length
    ? await db.select({
      id: academySessionsTable.id,
      startsAt: academySessionsTable.startsAt,
      opponent: academySessionsTable.opponent,
      ownScore: academySessionsTable.ownScore,
      opponentScore: academySessionsTable.opponentScore,
      squad: academySquadsTable.name,
    }).from(academySessionsTable)
      .leftJoin(academySquadsTable, eq(academySquadsTable.id, academySessionsTable.squadId))
      .where(and(eq(academySessionsTable.academyId, access.academyId), inArray(academySessionsTable.id, sessionIds)))
    : [];
  const sessionById = new Map(sessions.map((s) => [s.id, s]));

  const drafts = rows.flatMap((row) => {
    const parsed = parseOriginKey(row.originKey);
    const session = row.sourceSessionId !== null ? sessionById.get(row.sourceSessionId) ?? null : null;
    if (!parsed || !inFeed(parsed, row.createdAt, session, now)) return [];
    return [{
      ...publicProject(row),
      originKey: row.originKey,
      group: groupOf(parsed.kind),
      reason: {
        kind: parsed.kind,
        startsAt: session?.startsAt.toISOString() ?? null,
        opponent: session?.opponent ?? null,
        ownScore: session?.ownScore ?? null,
        opponentScore: session?.opponentScore ?? null,
        squad: session?.squad ?? null,
      },
    }];
  });

  const matchdayDraft = new Map<number, number>();
  for (const d of drafts) if (d.reason.kind === "matchday" && d.sourceSessionId !== null) matchdayDraft.set(d.sourceSessionId, d.id);

  res.json({
    drafts,
    upcoming: fixtures.map((f) => ({
      sessionId: f.id,
      startsAt: f.startsAt.toISOString(),
      dateLabel: { en: ammanDayLabel(f.startsAt, "en"), ar: ammanDayLabel(f.startsAt, "ar") },
      time: ammanTime(f.startsAt),
      opponent: f.opponent ?? null,
      squad: f.squad ?? null,
      place: f.location || null,
      draftId: matchdayDraft.get(f.id) ?? null,
    })),
  });
});

router.post(`${base}/for-you/:projectId/skip`, async (req, res): Promise<void> => {
  const access = await creativeOwner(req, res);
  if (!access) return;
  const row = await loadCreativeProject(access, req, res);
  if (!row) return;
  const [updated] = await db.update(academyCreativeProjectsTable).set({ status: "skipped", updatedAt: new Date() })
    .where(and(eq(academyCreativeProjectsTable.id, row.id), eq(academyCreativeProjectsTable.academyId, access.academyId)))
    .returning();
  if (!updated) { res.status(404).json({ error: "Not found" }); return; }
  logger.debug({ academyId: access.academyId, projectId: row.id }, "Creative hub: draft skipped");
  res.json({ project: publicProject(updated) });
});

router.get(`${base}/content-calendar`, async (req, res): Promise<void> => {
  const access = await creativeOwner(req, res);
  if (!access) return;
  res.json(await loadCalendar(access.academyId));
});

router.put(`${base}/content-calendar`, async (req, res): Promise<void> => {
  const access = await creativeOwner(req, res);
  if (!access) return;
  const body = CalendarBody.safeParse(req.body ?? {});
  if (!body.success) { res.status(400).json({ error: "Invalid calendar" }); return; }
  res.json(await saveCalendar(access.academyId, body.data.slots));
});

export default router;
