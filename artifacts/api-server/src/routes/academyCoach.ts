import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { Router, type IRouter, type Request, type Response } from "express";

import { coachBoardSchema, coachNoteInputSchema, type CoachBoard, type CoachNote } from "@workspace/api-zod";
import {
  academiesTable,
  academyCoachNotesTable,
  academyPlayersTable,
  academySessionsTable,
  academySquadsTable,
  db,
  usersTable,
  type AcademyCoachNote,
} from "@workspace/db";
import { resolveBindings } from "../lib/academyMatchStats";
import { ballInWindow, rosterBoxes, trackIndex } from "../lib/coachTracks";
import { recordingBall } from "../lib/creative/framing";
import { logger } from "../lib/logger";
import { loadRecordingPlay } from "../lib/matchPlayLoad";
import { readMatchWindow } from "../lib/matchWindow";
import {
  consoleSession,
  familyCanSee,
  familyViewer,
  loadContext,
  loadSession,
  type MatchContext,
} from "./academyMatches";

/**
 * Coach board (academy console → Matches → Coach view).
 *
 * Staff (owner, managers, coaches who see Matches):
 *   GET    …/matches/:sessionId/coach                  the video, every tracked player (named when bound), notes
 *   GET    …/matches/:sessionId/coach/tracks?from&to   players' boxes and the ball through ≤ 120 s of video
 *   POST   …/matches/:sessionId/coach/notes            save a moment (drawings, spotlights, comment)
 *   PATCH  …/matches/:sessionId/coach/notes/:noteId    change it (its author or the owner)
 *   DELETE …/matches/:sessionId/coach/notes/:noteId    remove it (its author or the owner)
 *
 * Families (a parent, or the player himself):
 *   GET /academy/family/coach-notes                              shared notes about the viewer's children
 *   GET /academy/family/coach-notes/:noteId                      one, with its match's video
 *   GET /academy/family/coach-notes/:noteId/tracks?from&to       the spotlighted players only, inside the note
 *
 * A note reaches a family only when the coach shares it AND tags one of their
 * children; the video is the session's own recording (canViewPinnedAcademyRecording).
 */

const router: IRouter = Router();
const base = "/academy/console/academies/:academyId/matches/:sessionId/coach";

const MAX_WINDOW_SECONDS = 120;
/** A family's tracks: the note's moment, a little before and its whole play-through. */
const FAMILY_LEAD_SECONDS = 3;
const FAMILY_MAX_SECONDS = 60;

function intParam(value: unknown): number | null {
  const n = Number(Array.isArray(value) ? value[0] : value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function secondsParam(value: unknown): number | null {
  const n = Number(Array.isArray(value) ? value[0] : value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function failed(res: Response, error: unknown, what: string) {
  logger.error({ error: (error as Error)?.message }, what);
  if (!res.headersSent) res.status(500).json({ error: "Something went wrong. Try again." });
}

type VideoView = {
  recordingId: number;
  videoUrl: string;
  videoStartSeconds: number;
  width: number;
  height: number;
  fps: number;
  /** seconds of video */
  duration: number | null;
  /** the match itself inside the recording, video seconds; null: the whole recording */
  matchWindow: { from: number; to: number } | null;
};

function videoView(ctx: MatchContext): VideoView | null {
  const recording = ctx.recordings.find((r) => r.id === ctx.recordingId);
  if (!recording?.videoUrl) return null;
  const m = ctx.bundle?.manifest;
  const offset = m?.videoStartSeconds ?? 0;
  const window = m ? readMatchWindow(m) : null;
  return {
    recordingId: recording.id,
    videoUrl: recording.videoUrl,
    videoStartSeconds: offset,
    width: m?.width ?? 3840,
    height: m?.height ?? 1080,
    fps: m?.frameRate && m.frameRate > 0 ? m.frameRate : 20,
    duration: m ? m.duration + offset : null,
    matchWindow: window ? { from: Math.round((window.startSeconds + offset) * 10) / 10, to: Math.round((window.endSeconds + offset) * 10) / 10 } : null,
  };
}

export type CoachPlayerView = {
  rosterId: string;
  /** the shirt number the analysis read (or its best guess), as text */
  number: string | null;
  minutes: number;
  /** the academy player the owner's line-up bound to this track, when there is one */
  playerId: number | null;
  name: string | null;
  shirtNumber: number | null;
};

/** Every tracked player, ours first (named, by shirt number), then the rest by time on camera. */
export function coachPlayers(ctx: Pick<MatchContext, "roster" | "lineup">): CoachPlayerView[] {
  if (!ctx.roster) return [];
  const bindings = resolveBindings(ctx.lineup, ctx.roster);
  const byRoster = new Map(bindings.map((b) => [b.rosterPlayerId, b.playerId]));
  const lineup = new Map(ctx.lineup.map((l) => [l.playerId, l]));
  const out = ctx.roster.players.map((p) => {
    const playerId = byRoster.get(p.id) ?? null;
    const entry = playerId ? lineup.get(playerId) : undefined;
    return {
      rosterId: p.id,
      number: p.number ?? p.numberCandidate ?? null,
      minutes: Math.round(p.minutes * 10) / 10,
      playerId,
      name: entry?.name ?? null,
      shirtNumber: entry?.shirtNumber ?? null,
    };
  });
  return out.sort((a, b) => {
    if ((a.playerId === null) !== (b.playerId === null)) return a.playerId === null ? 1 : -1;
    if (a.playerId !== null) return (a.shirtNumber ?? 999) - (b.shirtNumber ?? 999) || (a.name ?? "").localeCompare(b.name ?? "");
    return b.minutes - a.minutes;
  });
}

function noteView(row: AcademyCoachNote & { authorName?: string | null }, viewerId: number | null): CoachNote {
  const board = coachBoardSchema.safeParse(row.board);
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    atMs: row.atMs,
    endMs: row.endMs,
    board: board.success ? board.data : { v: 1, shapes: [], spotlights: [] },
    playerIds: Array.isArray(row.playerIds) ? row.playerIds.filter((n) => Number.isSafeInteger(n)) : [],
    shared: row.shared,
    author: row.authorName ?? null,
    mine: viewerId !== null && row.createdBy === viewerId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function notesFor(sessionId: number, viewerId: number) {
  const rows = await db.select({ note: academyCoachNotesTable, authorName: usersTable.name })
    .from(academyCoachNotesTable)
    .leftJoin(usersTable, eq(usersTable.id, academyCoachNotesTable.createdBy))
    .where(eq(academyCoachNotesTable.sessionId, sessionId))
    .orderBy(asc(academyCoachNotesTable.atMs), asc(academyCoachNotesTable.id))
    .limit(500);
  return rows.map((r) => noteView({ ...r.note, authorName: r.authorName }, viewerId));
}

/** Players tagged on a note must be this academy's. */
async function academyPlayerIds(academyId: number, ids: number[]): Promise<number[]> {
  if (!ids.length) return [];
  const rows = await db.select({ id: academyPlayersTable.id }).from(academyPlayersTable)
    .where(and(eq(academyPlayersTable.academyId, academyId), inArray(academyPlayersTable.id, ids)));
  const ok = new Set(rows.map((r) => r.id));
  return [...new Set(ids)].filter((id) => ok.has(id));
}

/** Spotlights must name players the analysis tracked in this match. */
function boardForRoster(board: CoachBoard, ctx: MatchContext): CoachBoard {
  const known = new Set(ctx.roster?.players.map((p) => p.id) ?? []);
  return { ...board, spotlights: board.spotlights.filter((s) => known.has(s.rosterId)) };
}

router.get(base, async (req, res): Promise<void> => {
  const found = await consoleSession(req, res);
  if (!found) return;
  try {
    const ctx = await loadContext(found.session);
    res.setHeader("Cache-Control", "private, no-store");
    res.json({
      session: {
        id: found.session.id,
        type: found.session.type,
        squadName: found.session.squadName,
        startsAt: found.session.startsAt,
        opponent: found.session.opponent,
        ownScore: found.session.ownScore,
        opponentScore: found.session.opponentScore,
        location: found.session.location,
      },
      role: found.isOwner ? "owner" : "staff",
      video: videoView(ctx),
      analysed: Boolean(ctx.bundle && ctx.roster),
      players: coachPlayers(ctx),
      lineup: ctx.lineup.filter((l) => l.inSquad).map((l) => ({ playerId: l.playerId, name: l.name, shirtNumber: l.shirtNumber })),
      notes: await notesFor(found.session.id, found.user.id),
    });
  } catch (error) {
    failed(res, error, "Coach board: match failed");
  }
});

/** Boxes of the players in `only` (or everyone), and the ball, through [from, to] video seconds. */
async function tracksFor(ctx: MatchContext, from: number, to: number, only?: ReadonlySet<string>) {
  if (!ctx.recordingId || !ctx.roster) return null;
  const play = await loadRecordingPlay(ctx.recordingId, { keepSegments: true });
  if (!play?.segments) return null;
  const m = play.manifest;
  const players = rosterBoxes(trackIndex(play.segments), ctx.roster, m, from, to, { only, perSecond: 10 });
  const ball = ballInWindow(await recordingBall(ctx.recordingId).catch(() => null), from, to);
  return { from, to, players, ball };
}

function windowParams(req: Request, res: Response, max: number): { from: number; to: number } | null {
  const from = secondsParam(req.query.from);
  const to = secondsParam(req.query.to);
  if (from === null || to === null || to <= from || to - from > max) {
    res.status(400).json({ error: `Ask for at most ${max} seconds of video` });
    return null;
  }
  return { from, to };
}

router.get(`${base}/tracks`, async (req, res): Promise<void> => {
  const found = await consoleSession(req, res);
  if (!found) return;
  const window = windowParams(req, res, MAX_WINDOW_SECONDS);
  if (!window) return;
  try {
    const ctx = await loadContext(found.session);
    const out = await tracksFor(ctx, window.from, window.to);
    if (!out) { res.status(404).json({ error: "This match has not been analysed" }); return; }
    res.setHeader("Cache-Control", "private, max-age=300");
    res.json(out);
  } catch (error) {
    failed(res, error, "Coach board: tracks failed");
  }
});

router.post(`${base}/notes`, async (req, res): Promise<void> => {
  const found = await consoleSession(req, res);
  if (!found) return;
  const body = coachNoteInputSchema.safeParse(req.body ?? {});
  if (!body.success) { res.status(400).json({ error: "That note could not be saved", issues: body.error.issues.slice(0, 5) }); return; }
  try {
    const ctx = await loadContext(found.session);
    const b = body.data;
    const [row] = await db.insert(academyCoachNotesTable).values({
      academyId: found.academyId,
      sessionId: found.session.id,
      recordingId: ctx.recordingId,
      title: b.title,
      body: b.body ?? null,
      atMs: b.atMs,
      endMs: b.endMs !== null && b.endMs !== undefined && b.endMs > b.atMs ? b.endMs : null,
      board: boardForRoster(b.board, ctx),
      playerIds: await academyPlayerIds(found.academyId, b.playerIds),
      shared: b.shared,
      createdBy: found.user.id,
    }).returning();
    res.status(201).json({ note: noteView({ ...row, authorName: found.user.name ?? null }, found.user.id) });
  } catch (error) {
    failed(res, error, "Coach board: save failed");
  }
});

async function editableNote(req: Request, res: Response) {
  const found = await consoleSession(req, res);
  if (!found) return null;
  const noteId = intParam(req.params.noteId);
  const [row] = noteId
    ? await db.select().from(academyCoachNotesTable).where(and(eq(academyCoachNotesTable.id, noteId), eq(academyCoachNotesTable.sessionId, found.session.id)))
    : [];
  if (!row) { res.status(404).json({ error: "Note not found" }); return null; }
  if (row.createdBy !== found.user.id && !found.isOwner) { res.status(403).json({ error: "Only its author or the owner can change a note" }); return null; }
  return { ...found, row };
}

const patchBody = coachNoteInputSchema.partial();

router.patch(`${base}/notes/:noteId`, async (req, res): Promise<void> => {
  const found = await editableNote(req, res);
  if (!found) return;
  const body = patchBody.safeParse(req.body ?? {});
  if (!body.success) { res.status(400).json({ error: "That change could not be saved", issues: body.error.issues.slice(0, 5) }); return; }
  try {
    const b = body.data;
    const set: Partial<typeof academyCoachNotesTable.$inferInsert> = { updatedAt: new Date() };
    if (b.title !== undefined) set.title = b.title;
    if (b.body !== undefined) set.body = b.body ?? null;
    if (b.atMs !== undefined) set.atMs = b.atMs;
    if (b.endMs !== undefined) set.endMs = b.endMs ?? null;
    if (b.shared !== undefined) set.shared = b.shared;
    if (b.playerIds !== undefined) set.playerIds = await academyPlayerIds(found.academyId, b.playerIds);
    if (b.board !== undefined) set.board = boardForRoster(b.board, await loadContext(found.session));
    const atMs = set.atMs ?? found.row.atMs;
    if (set.endMs !== undefined && set.endMs !== null && set.endMs <= atMs) set.endMs = null;
    const [row] = await db.update(academyCoachNotesTable).set(set).where(eq(academyCoachNotesTable.id, found.row.id)).returning();
    const [author] = row.createdBy ? await db.select({ name: usersTable.name }).from(usersTable).where(eq(usersTable.id, row.createdBy)) : [];
    res.json({ note: noteView({ ...row, authorName: author?.name ?? null }, found.user.id) });
  } catch (error) {
    failed(res, error, "Coach board: change failed");
  }
});

router.delete(`${base}/notes/:noteId`, async (req, res): Promise<void> => {
  const found = await editableNote(req, res);
  if (!found) return;
  try {
    await db.delete(academyCoachNotesTable).where(eq(academyCoachNotesTable.id, found.row.id));
    res.status(204).end();
  } catch (error) {
    failed(res, error, "Coach board: delete failed");
  }
});

// ─── Families ────────────────────────────────────────────────────────────────

type Viewer = NonNullable<Awaited<ReturnType<typeof familyViewer>>>;

/** A shared note this viewer may open, with its session; null otherwise. */
async function familyNote(viewer: Viewer, noteId: number | null) {
  if (!noteId) return null;
  const [row] = await db.select().from(academyCoachNotesTable).where(and(eq(academyCoachNotesTable.id, noteId), eq(academyCoachNotesTable.shared, true)));
  if (!row) return null;
  const tagged = (Array.isArray(row.playerIds) ? row.playerIds : []).filter((id) => viewer.familyPlayerIds.has(id));
  if (!tagged.length) return null;
  const session = await loadSession(row.academyId, row.sessionId);
  if (!session || !(await familyCanSee(viewer, session))) return null;
  return { row, session, tagged };
}

router.get("/academy/family/coach-notes", async (req, res): Promise<void> => {
  const viewer = await familyViewer(req, res);
  if (!viewer) return;
  res.setHeader("Cache-Control", "no-store");
  try {
    const ids = [...viewer.familyPlayerIds];
    if (!ids.length) { res.json({ notes: [] }); return; }
    const players = await db.select({ id: academyPlayersTable.id, academyId: academyPlayersTable.academyId, name: academyPlayersTable.name })
      .from(academyPlayersTable).where(inArray(academyPlayersTable.id, ids));
    const academyIds = [...new Set(players.map((p) => p.academyId))];
    if (!academyIds.length) { res.json({ notes: [] }); return; }
    const rows = await db.select({
      note: academyCoachNotesTable,
      authorName: usersTable.name,
      startsAt: academySessionsTable.startsAt,
      opponent: academySessionsTable.opponent,
      type: academySessionsTable.type,
      squadName: academySquadsTable.name,
      academyName: academiesTable.name,
    })
      .from(academyCoachNotesTable)
      .innerJoin(academySessionsTable, eq(academySessionsTable.id, academyCoachNotesTable.sessionId))
      .leftJoin(academySquadsTable, eq(academySquadsTable.id, academySessionsTable.squadId))
      .innerJoin(academiesTable, eq(academiesTable.id, academyCoachNotesTable.academyId))
      .leftJoin(usersTable, eq(usersTable.id, academyCoachNotesTable.createdBy))
      .where(and(eq(academyCoachNotesTable.shared, true), inArray(academyCoachNotesTable.academyId, academyIds)))
      .orderBy(desc(academySessionsTable.startsAt), asc(academyCoachNotesTable.atMs))
      .limit(300);
    const nameOf = new Map(players.map((p) => [p.id, p.name]));
    const seen = new Map<number, boolean>();
    const out = [];
    for (const r of rows) {
      const tagged = (Array.isArray(r.note.playerIds) ? r.note.playerIds : []).filter((id) => viewer.familyPlayerIds.has(id));
      if (!tagged.length) continue;
      if (!seen.has(r.note.sessionId)) {
        const session = await loadSession(r.note.academyId, r.note.sessionId);
        seen.set(r.note.sessionId, Boolean(session && (await familyCanSee(viewer, session))));
      }
      if (!seen.get(r.note.sessionId)) continue;
      out.push({
        ...noteView({ ...r.note, authorName: r.authorName }, null),
        sessionId: r.note.sessionId,
        academyName: r.academyName,
        session: { startsAt: r.startsAt, opponent: r.opponent, type: r.type, squadName: r.squadName ?? null },
        players: tagged.map((id) => ({ playerId: id, name: nameOf.get(id) ?? "" })),
      });
    }
    res.json({ notes: out });
  } catch (error) {
    failed(res, error, "Coach board: family notes failed");
  }
});

router.get("/academy/family/coach-notes/:noteId", async (req, res): Promise<void> => {
  const viewer = await familyViewer(req, res);
  if (!viewer) return;
  res.setHeader("Cache-Control", "no-store");
  try {
    const found = await familyNote(viewer, intParam(req.params.noteId));
    if (!found) { res.status(404).json({ error: "Note not found" }); return; }
    const ctx = await loadContext(found.session);
    const spotlit = new Set(coachBoardSchema.safeParse(found.row.board).data?.spotlights.map((s) => s.rosterId) ?? []);
    const [author] = found.row.createdBy ? await db.select({ name: usersTable.name }).from(usersTable).where(eq(usersTable.id, found.row.createdBy)) : [];
    res.json({
      note: noteView({ ...found.row, authorName: author?.name ?? null }, null),
      session: { id: found.session.id, type: found.session.type, squadName: found.session.squadName, startsAt: found.session.startsAt, opponent: found.session.opponent },
      video: videoView(ctx),
      // Only the players the coach pointed at, labelled as he labelled them.
      players: coachPlayers(ctx).filter((p) => spotlit.has(p.rosterId)).map((p) => ({ ...p, name: found.tagged.includes(p.playerId ?? -1) ? p.name : null })),
    });
  } catch (error) {
    failed(res, error, "Coach board: family note failed");
  }
});

router.get("/academy/family/coach-notes/:noteId/tracks", async (req, res): Promise<void> => {
  const viewer = await familyViewer(req, res);
  if (!viewer) return;
  const window = windowParams(req, res, FAMILY_MAX_SECONDS + FAMILY_LEAD_SECONDS);
  if (!window) return;
  try {
    const found = await familyNote(viewer, intParam(req.params.noteId));
    if (!found) { res.status(404).json({ error: "Note not found" }); return; }
    // Only inside the note: its moment, a little before, and its play-through.
    const lo = found.row.atMs / 1000 - FAMILY_LEAD_SECONDS;
    const hi = Math.max(found.row.atMs / 1000 + 2, (found.row.endMs ?? found.row.atMs) / 1000) + 1;
    const from = Math.max(window.from, lo);
    const to = Math.min(window.to, hi, lo + FAMILY_LEAD_SECONDS + FAMILY_MAX_SECONDS);
    const board = coachBoardSchema.safeParse(found.row.board);
    const spotlit = new Set(board.success ? board.data.spotlights.map((s) => s.rosterId) : []);
    if (to <= from || !spotlit.size) { res.json({ from: window.from, to: window.to, players: {}, ball: [] }); return; }
    const ctx = await loadContext(found.session);
    const out = await tracksFor(ctx, from, to, spotlit);
    res.setHeader("Cache-Control", "private, max-age=300");
    res.json(out ? { ...out, ball: board.success && board.data.ball ? out.ball : [] } : { from, to, players: {}, ball: [] });
  } catch (error) {
    failed(res, error, "Coach board: family tracks failed");
  }
});


export default router;
