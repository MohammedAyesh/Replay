/**
 * Creative hub → Library: what the academy can build from, read from the
 * database. Every query is scoped to one academy:
 *
 *   matches   sessions with footage linked to THIS academy (academy_recordings),
 *             never a field's public or paid matches
 *   moments   one of those sessions: analysis goals / chances / dribbles on its
 *             recordings, and clips the academy's members saved from them
 *   clips     user_clips made under this academy by its members (as Studio)
 *   uploads   academy_ad_media of this academy (shared with Ads → Media)
 *   players   the academy's active players: shirt number, first name if allowed,
 *             and (names allowed) the primary photo
 *   player    one player's media for the Player picker: his photo gallery (names
 *             allowed), his own clips, and match moments the analysis bound to him
 *
 * Names: libraryPlayer() is the only way a player reaches a response, so the
 * academy's "show player names" setting is applied here, whatever the browser
 * asks for.
 */
import { and, asc, desc, eq, getTableColumns, gte, inArray, isNotNull, lt, or, sql, type SQL } from "drizzle-orm";
import {
  academyAdMediaTable,
  academyPhoneMediaTable,
  academyMatchLineupsTable,
  academyMatchPagesTable,
  academyMembersTable,
  academyPlayersTable,
  academyRecordingsTable,
  academySessionsTable,
  academySquadsTable,
  db,
  recordingTrackingBundlesTable,
  recordingsTable,
  userClipsTable,
  type TrackingManifest,
} from "@workspace/db";
import { getBunnyProxiedThumbnailUrl, isBunnyConfigured } from "../bunny";
import { clipSpans } from "./clipSpan";
import { academyPlayerPhotosTable, usersTable } from "@workspace/db";
import { photoView } from "../academyPlayerPhotos";
import { logger } from "../logger";
import { academyClipStatus } from "../userClipExportState";
import {
  ammanClock,
  ammanDate,
  bunnyVideoIdOf,
  creativeClipStillUrl,
  frameSource,
  libraryPlayer,
  matchMinute,
  pageOf,
  recordingSeconds,
  savedClipWindow,
  windowSource,
  type LibraryFilters,
  type LibraryPlayer,
  type RecordingWindow,
} from "./library";
import { analysisMoments, filterMoments, trackPlayerLookup, type LibraryMoment } from "./libraryMoments";
import type { MediaSource } from "@workspace/api-zod";

const MAX_SESSIONS = 1000;

/**
 * Which academy player a LibraryPlayer stands for. The browser never sees the
 * player id on a moment; the Player picker's filter (playerMedia) reads it here.
 */
const playerIdOf = new WeakMap<LibraryPlayer, number>();
function taggedPlayer(p: SessionPlayer, showNames: boolean): LibraryPlayer {
  const out = libraryPlayer(p, showNames);
  playerIdOf.set(out, p.playerId);
  return out;
}

/** A Bunny thumbnail through the API's proxy, as Studio does; null when it can't be made. */
function thumbAt(videoUrl: string | null | undefined, seconds: number): string | null {
  const id = bunnyVideoIdOf(videoUrl);
  if (!id || !isBunnyConfigured()) return null;
  return getBunnyProxiedThumbnailUrl(id, Math.max(0, seconds));
}

// ── Matches ─────────────────────────────────────────────────────────────────

type AcademyRecordingRow = { sessionId: number; recordingId: number; duration: string; videoUrl: string };

async function academySessionRecordings(academyId: number, sessionIds?: number[]): Promise<AcademyRecordingRow[]> {
  const where = [eq(academyRecordingsTable.academyId, academyId), isNotNull(academyRecordingsTable.sessionId)];
  if (sessionIds) {
    if (!sessionIds.length) return [];
    where.push(inArray(academyRecordingsTable.sessionId, sessionIds));
  }
  const rows = await db.select({
    sessionId: academyRecordingsTable.sessionId,
    recordingId: academyRecordingsTable.recordingId,
    duration: recordingsTable.duration,
    videoUrl: recordingsTable.videoUrl,
  }).from(academyRecordingsTable)
    .innerJoin(recordingsTable, eq(recordingsTable.id, academyRecordingsTable.recordingId))
    .where(and(...where))
    .orderBy(asc(academyRecordingsTable.recordingId));
  return rows.filter((r): r is AcademyRecordingRow => r.sessionId !== null);
}

/** Sessions where shirt `n` played: in the lineup, or (no lineup saved) in the squad wearing it. */
async function sessionsWithNumber(academyId: number, n: number, candidateIds: number[]): Promise<Set<number>> {
  if (!candidateIds.length) return new Set();
  const [lineups, wearers] = await Promise.all([
    db.select({ sessionId: academyMatchLineupsTable.sessionId, shirt: academyMatchLineupsTable.shirtNumber, inSquad: academyMatchLineupsTable.inSquad })
      .from(academyMatchLineupsTable).where(inArray(academyMatchLineupsTable.sessionId, candidateIds)),
    db.select({ squadId: academyPlayersTable.squadId }).from(academyPlayersTable)
      .where(and(eq(academyPlayersTable.academyId, academyId), eq(academyPlayersTable.isActive, true), eq(academyPlayersTable.jerseyNumber, n))),
  ]);
  const out = new Set<number>();
  const withLineup = new Set<number>();
  for (const l of lineups) {
    withLineup.add(l.sessionId);
    if (l.inSquad && l.shirt === n) out.add(l.sessionId);
  }
  const squads = new Set(wearers.map((w) => w.squadId));
  if (squads.size) {
    const rows = await db.select({ id: academySessionsTable.id, squadId: academySessionsTable.squadId }).from(academySessionsTable)
      .where(and(eq(academySessionsTable.academyId, academyId), inArray(academySessionsTable.id, candidateIds)));
    // A session with no squad: anyone at the academy may have played.
    for (const r of rows) if (!withLineup.has(r.id) && (r.squadId === null || squads.has(r.squadId))) out.add(r.id);
  }
  return out;
}

export async function libraryMatches(academyId: number, f: LibraryFilters) {
  const recordings = await academySessionRecordings(academyId);
  const bySession = new Map<number, AcademyRecordingRow[]>();
  for (const r of recordings) bySession.set(r.sessionId, [...(bySession.get(r.sessionId) ?? []), r]);
  let ids = [...bySession.keys()];
  if (f.playerNumber !== null) {
    const hit = await sessionsWithNumber(academyId, f.playerNumber, ids);
    ids = ids.filter((id) => hit.has(id));
  }
  if (!ids.length) return { matches: [], total: 0, nextOffset: null };

  const where: SQL[] = [eq(academySessionsTable.academyId, academyId), inArray(academySessionsTable.id, ids)];
  if (f.squadId) where.push(eq(academySessionsTable.squadId, f.squadId));
  if (f.from) where.push(gte(academySessionsTable.startsAt, f.from));
  if (f.until) where.push(lt(academySessionsTable.startsAt, f.until));
  if (f.sessionType) where.push(eq(academySessionsTable.type, f.sessionType));
  const sessions = await db.select({
    id: academySessionsTable.id,
    type: academySessionsTable.type,
    startsAt: academySessionsTable.startsAt,
    endsAt: academySessionsTable.endsAt,
    location: academySessionsTable.location,
    opponent: academySessionsTable.opponent,
    ownScore: academySessionsTable.ownScore,
    opponentScore: academySessionsTable.opponentScore,
    squadId: academySessionsTable.squadId,
    squadName: academySquadsTable.name,
  }).from(academySessionsTable)
    .leftJoin(academySquadsTable, eq(academySquadsTable.id, academySessionsTable.squadId))
    .where(and(...where))
    .orderBy(desc(academySessionsTable.startsAt), desc(academySessionsTable.id))
    .limit(MAX_SESSIONS);

  const page = pageOf(sessions, f);
  const pageIds = page.items.map((s) => s.id);
  const pageRecordingIds = page.items.flatMap((s) => (bySession.get(s.id) ?? []).map((r) => r.recordingId));
  const [pages, bundles] = pageIds.length
    ? await Promise.all([
      db.select({ sessionId: academyMatchPagesTable.sessionId, recordingId: academyMatchPagesTable.recordingId })
        .from(academyMatchPagesTable).where(and(eq(academyMatchPagesTable.academyId, academyId), inArray(academyMatchPagesTable.sessionId, pageIds))),
      pageRecordingIds.length
        ? db.select({ recordingId: recordingTrackingBundlesTable.recordingId }).from(recordingTrackingBundlesTable)
          .where(inArray(recordingTrackingBundlesTable.recordingId, pageRecordingIds))
        : Promise.resolve([] as Array<{ recordingId: number }>),
    ])
    : [[], []];
  const chosen = new Map(pages.map((p) => [p.sessionId, p.recordingId]));
  const analysed = new Set(bundles.map((b) => b.recordingId));

  const matches = page.items.map((s) => {
    const recs = bySession.get(s.id) ?? [];
    const main = recs.find((r) => r.recordingId === chosen.get(s.id)) ?? recs[0];
    const seconds = recs.reduce((sum, r) => sum + (recordingSeconds(r.duration) ?? 0), 0);
    const mainSeconds = main ? recordingSeconds(main.duration) : null;
    const thumbSec = mainSeconds ? Math.min(600, mainSeconds / 4) : 60;
    return {
      sessionId: s.id,
      type: s.type,
      startsAt: s.startsAt.toISOString(),
      date: ammanDate(s.startsAt),
      time: ammanClock(s.startsAt),
      location: s.location || null,
      opponent: s.opponent ?? null,
      ownScore: s.ownScore,
      opponentScore: s.opponentScore,
      squad: s.squadId ? { id: s.squadId, name: s.squadName ?? "" } : null,
      durationMs: seconds ? Math.round(seconds * 1000) : null,
      recordingIds: recs.map((r) => r.recordingId),
      recordingId: main?.recordingId ?? null,
      analysed: recs.some((r) => analysed.has(r.recordingId)),
      still: main ? frameSource(main.recordingId, thumbSec * 1000) : null,
      thumbnailUrl: main ? thumbAt(main.videoUrl, thumbSec) : null,
    };
  });
  return { matches, total: page.total, nextOffset: page.nextOffset };
}

// ── One session: its moments ────────────────────────────────────────────────

export async function academySession(academyId: number, sessionId: number) {
  const [row] = await db.select({
    id: academySessionsTable.id,
    squadId: academySessionsTable.squadId,
    type: academySessionsTable.type,
    startsAt: academySessionsTable.startsAt,
  }).from(academySessionsTable)
    .where(and(eq(academySessionsTable.id, sessionId), eq(academySessionsTable.academyId, academyId)));
  return row ?? null;
}

type SessionPlayer = { playerId: number; name: string; number: number | null; squad: string | null; userId: number | null };

/** The match's players with their numbers for it (lineup first, then squad shirt numbers), as academyMatches.loadLineup. */
async function sessionLineup(academyId: number, session: { id: number; squadId: number | null }) {
  const rows = await db.select().from(academyMatchLineupsTable).where(eq(academyMatchLineupsTable.sessionId, session.id));
  const byPlayer = new Map(rows.map((r) => [r.playerId, r]));
  const squadFilter = session.squadId === null
    ? eq(academyPlayersTable.isActive, true)
    : and(eq(academyPlayersTable.isActive, true), eq(academyPlayersTable.squadId, session.squadId));
  const ids = rows.map((r) => r.playerId);
  const players = await db.select({
    id: academyPlayersTable.id,
    name: academyPlayersTable.name,
    jerseyNumber: academyPlayersTable.jerseyNumber,
    userId: academyPlayersTable.userId,
    squadName: academySquadsTable.name,
  }).from(academyPlayersTable)
    .leftJoin(academySquadsTable, eq(academySquadsTable.id, academyPlayersTable.squadId))
    .where(and(eq(academyPlayersTable.academyId, academyId), ids.length ? or(squadFilter, inArray(academyPlayersTable.id, ids)) : squadFilter));
  const lineup = players.map((p) => {
    const row = byPlayer.get(p.id);
    return {
      playerId: p.id,
      shirtNumber: row ? row.shirtNumber : p.jerseyNumber,
      inSquad: row ? row.inSquad : true,
      rosterPlayerId: row?.rosterPlayerId ?? null,
      boundBy: row?.boundBy ?? null,
    };
  });
  const info = new Map<number, SessionPlayer>(players.map((p) => [p.id, {
    playerId: p.id,
    name: p.name,
    number: byPlayer.get(p.id)?.shirtNumber ?? p.jerseyNumber ?? null,
    squad: p.squadName ?? null,
    userId: p.userId ?? null,
  }]));
  return { lineup, info };
}

type AnalysisState = "ready" | "none" | "failed";

/** Goals, chances and dribbles on one analysed recording. */
async function recordingAnalysisMoments(
  rec: AcademyRecordingRow,
  lineup: Awaited<ReturnType<typeof sessionLineup>>,
  showNames: boolean,
): Promise<{ state: AnalysisState; moments: LibraryMoment[]; manifest: TrackingManifest | null }> {
  // Loaded on demand: the analysis modules are large and only this list needs them.
  const [{ latestBundle, loadMatchRoster, resolveBindings }, { loadRecordingPlay }, { goalVotesFor, reviewedGoalsOf }, { clipRangeToMatchWindow, readMatchWindow }] = await Promise.all([
    import("../academyMatchStats"),
    import("../matchPlayLoad"),
    import("../goalReview"),
    import("../matchWindow"),
  ]);
  const bundle = await latestBundle(rec.recordingId);
  if (!bundle) return { state: "none", moments: [], manifest: null };
  try {
    const manifest = bundle.manifest;
    const [roster, play, votes] = await Promise.all([
      loadMatchRoster(manifest),
      loadRecordingPlay(rec.recordingId),
      goalVotesFor([rec.recordingId]),
    ]);
    if (!play) return { state: "none", moments: [], manifest };
    const bound = new Map<string, LibraryPlayer>();
    for (const b of resolveBindings(lineup.lineup, roster)) {
      const p = lineup.info.get(b.playerId);
      if (p) bound.set(b.rosterPlayerId, taggedPlayer(p, showNames));
    }
    const games = (play.phases ?? []).filter((p) => p.kind === "game");
    const stored = readMatchWindow(manifest);
    const window = clipRangeToMatchWindow(0, manifest.duration, manifest)
      ?? (games.length ? { fromSeconds: games[0].start, toSeconds: games[games.length - 1].end } : null);
    const kickOff = stored?.startSeconds ?? games[0]?.start ?? 0;
    const reviewed = play.hasBall ? reviewedGoalsOf(play, votes.get(rec.recordingId) ?? []) : [];
    const moments = analysisMoments({
      recordingId: rec.recordingId,
      videoStartSeconds: manifest.videoStartSeconds ?? 0,
      durationSec: recordingSeconds(rec.duration),
      kickOffSeconds: kickOff,
      window,
      fps: play.fps,
      chances: reviewed.map((g) => ({ t: g.t, status: g.status, trackId: g.trackId, touchF: g.touchF, ownGoal: g.ownGoal })),
      dribbles: play.hasBall ? play.dribbles : [],
      playerAt: trackPlayerLookup(roster, bound),
      thumbnailAt: (atMs) => thumbAt(rec.videoUrl, atMs / 1000),
    });
    return { state: "ready", moments, manifest };
  } catch (error) {
    logger.warn({ recordingId: rec.recordingId, error: (error as Error).message }, "Creative library: match analysis moments failed");
    return { state: "failed", moments: [], manifest: bundle.manifest };
  }
}

/** Clips the academy's members saved from these recordings, as moments. */
async function savedMoments(
  academyId: number,
  recs: AcademyRecordingRow[],
  manifests: Map<number, TrackingManifest | null>,
  players: Map<number, SessionPlayer>,
  showNames: boolean,
): Promise<LibraryMoment[]> {
  if (!recs.length) return [];
  const byId = new Map(recs.map((r) => [r.recordingId, r]));
  const [rows, members] = await Promise.all([
    db.select().from(userClipsTable).where(inArray(userClipsTable.sourceRecordingId, recs.map((r) => r.recordingId)))
      .orderBy(asc(userClipsTable.startTime)).limit(500),
    db.select({ userId: academyMembersTable.userId }).from(academyMembersTable).where(eq(academyMembersTable.academyId, academyId)),
  ]);
  const memberIds = new Set(members.map((m) => m.userId));
  const playerByUser = new Map<number, SessionPlayer>();
  for (const p of players.values()) if (p.userId) playerByUser.set(p.userId, p);
  const out: LibraryMoment[] = [];
  const spans = await clipSpans(rows, (c) => byId.get(rows.find((r) => r.id === c.id)?.sourceRecordingId ?? 0)?.duration);
  for (const clip of rows) {
    if (clip.hiddenReason || clip.isHidden || clip.videoId.startsWith("live:")) continue;
    // Made under this academy, or by one of its people (a player with an account, a coach).
    if (clip.academyId !== academyId && !memberIds.has(clip.userId) && !playerByUser.has(clip.userId)) continue;
    const rec = clip.sourceRecordingId ? byId.get(clip.sourceRecordingId) : undefined;
    if (!rec) continue;
    const span = spans.get(clip.id);
    const w = span ? savedClipWindow(rec.recordingId, span.startSec, span.endSec, span.thumbSec) : null;
    if (!w) continue;
    const manifest = manifests.get(rec.recordingId) ?? null;
    const kickOff = (manifest?.provenance as { matchWindow?: { startSeconds?: number } } | undefined)?.matchWindow?.startSeconds ?? 0;
    const tracking = span!.startSec - (manifest?.videoStartSeconds ?? 0);
    const who = playerByUser.get(clip.userId);
    const player = who ? taggedPlayer(who, showNames) : null;
    const window: RecordingWindow = { recordingId: w.recordingId, fromMs: w.fromMs, toMs: w.toMs };
    out.push({
      id: `saved:${clip.id}`,
      type: "saved",
      recordingId: rec.recordingId,
      window,
      atMs: w.atMs,
      durationMs: w.toMs - w.fromMs,
      minute: manifest ? matchMinute(tracking, kickOff) : Math.floor(span!.startSec / 60) + 1,
      player,
      ours: who ? true : null,
      ownGoal: false,
      // A member's own title may name a child: shown only when names are allowed.
      title: showNames ? clip.title.slice(0, 80) : null,
      clipId: clip.id,
      source: windowSource(window),
      still: frameSource(rec.recordingId, w.atMs),
      thumbnailUrl: thumbAt(rec.videoUrl, w.atMs / 1000),
    });
  }
  return out;
}

export async function librarySessionMoments(academyId: number, sessionId: number, f: LibraryFilters, showNames: boolean) {
  const session = await academySession(academyId, sessionId);
  if (!session) return null;
  const recs = await academySessionRecordings(academyId, [session.id]);
  const lineup = await sessionLineup(academyId, session);
  const analysed = await Promise.all(recs.map((r) => recordingAnalysisMoments(r, lineup, showNames)));
  const manifests = new Map(recs.map((r, i) => [r.recordingId, analysed[i].manifest]));
  const saved = await savedMoments(academyId, recs, manifests, lineup.info, showNames);
  const state: AnalysisState = analysed.some((a) => a.state === "ready") ? "ready" : analysed.some((a) => a.state === "failed") ? "failed" : "none";
  const order = new Map(recs.map((r, i) => [r.recordingId, i]));
  const all = [...analysed.flatMap((a) => a.moments), ...saved]
    .sort((a, b) => (order.get(a.recordingId)! - order.get(b.recordingId)!) || a.window.fromMs - b.window.fromMs || a.id.localeCompare(b.id));
  const counts = { goal: 0, chance: 0, highlight: 0, saved: 0 };
  for (const m of all) counts[m.type]++;
  const page = pageOf(filterMoments(all, f), f);
  return {
    sessionId: session.id,
    analysis: state,
    recordingIds: recs.map((r) => r.recordingId),
    counts,
    moments: page.items,
    total: page.total,
    nextOffset: page.nextOffset,
  };
}

// ── Clips ───────────────────────────────────────────────────────────────────

const clipStatus = academyClipStatus;

/** Studio's clip list (the academy's clips by its members), with the Library's filters and paging. */
export async function libraryClips(academyId: number, f: LibraryFilters, showNames: boolean) {
  const where: SQL[] = [eq(userClipsTable.academyId, academyId), isNotNull(userClipsTable.videoId)];
  if (f.from) where.push(gte(userClipsTable.createdAt, f.from));
  if (f.until) where.push(lt(userClipsTable.createdAt, f.until));
  const rows = await db
    .select({ clip: userClipsTable })
    .from(userClipsTable)
    .innerJoin(academyMembersTable, and(
      eq(academyMembersTable.academyId, academyId),
      eq(academyMembersTable.userId, userClipsTable.userId),
    ))
    .where(and(...where))
    .orderBy(desc(userClipsTable.createdAt), desc(userClipsTable.id))
    .limit(500);
  const recordingIds = [...new Set(rows.map((r) => r.clip.sourceRecordingId).filter((id): id is number => id !== null))];
  // Which of the source recordings are this academy's own, and from which session.
  const own = recordingIds.length
    ? await db.select({
      recordingId: academyRecordingsTable.recordingId,
      sessionId: academyRecordingsTable.sessionId,
      squadId: academySessionsTable.squadId,
    }).from(academyRecordingsTable)
      .leftJoin(academySessionsTable, eq(academySessionsTable.id, academyRecordingsTable.sessionId))
      .where(and(eq(academyRecordingsTable.academyId, academyId), inArray(academyRecordingsTable.recordingId, recordingIds)))
    : [];
  const ownBy = new Map(own.map((o) => [o.recordingId, o]));
  const seen = new Set<number>();
  const clips = [];
  const spans = await clipSpans(rows.map((r) => r.clip));
  for (const { clip } of rows) {
    if (seen.has(clip.id) || clip.hiddenReason === "deleted") continue;
    seen.add(clip.id);
    const status = clipStatus(clip);
    if (status === "expired") continue;
    const link = clip.sourceRecordingId ? ownBy.get(clip.sourceRecordingId) : undefined;
    if (f.squadId && link?.squadId !== f.squadId) continue;
    const isLive = clip.videoId.startsWith("live:");
    const span = spans.get(clip.id) ?? null;
    const start = span?.startSec ?? 0;
    const end = span?.endSec ?? 0;
    const thumbTime = span?.thumbSec ?? start;
    const w = link && span ? savedClipWindow(link.recordingId, start, end, thumbTime) : null;
    clips.push({
      clipId: clip.id,
      title: showNames ? clip.title.slice(0, 80) : null,
      status,
      aspectRatio: clip.aspectRatio === "9:16" ? "9:16" : "16:9",
      createdAt: clip.createdAt.toISOString(),
      date: ammanDate(clip.createdAt),
      durationMs: Math.max(0, Math.round((end - start) * 1000)),
      sessionId: link?.sessionId ?? null,
      source: { type: "clip", clipId: clip.id } as Extract<MediaSource, { type: "clip" }>,
      window: w ? { recordingId: w.recordingId, fromMs: w.fromMs, toMs: w.toMs } : null,
      still: w ? frameSource(w.recordingId, w.atMs) : null,
      thumbnailUrl: !isLive ? creativeClipStillUrl(academyId, clip.id) : null,
      videoUrl: status === "ready" ? `/api/academy/console/academies/${academyId}/studio/clips/${clip.id}/video` : null,
    });
  }
  const page = pageOf(clips, f);
  return { clips: page.items, total: page.total, nextOffset: page.nextOffset };
}

// ── Uploads ─────────────────────────────────────────────────────────────────

export const uploadsPrefix = (academyId: number) => `/api/academy/console/academies/${academyId}/ads/media`;

export type UploadRow = Omit<typeof academyAdMediaTable.$inferSelect, "imageData"> & { hasImage: boolean };

export function libraryUpload(m: UploadRow) {
  const prefix = uploadsPrefix(m.academyId);
  return {
    mediaId: m.id,
    kind: m.kind === "video" ? "video" as const : "image" as const,
    name: m.name,
    status: m.status,
    width: m.width,
    height: m.height,
    durationMs: m.durationSec ? Math.round(m.durationSec * 1000) : null,
    createdAt: m.createdAt.toISOString(),
    source: { type: "upload", mediaId: m.id } as Extract<MediaSource, { type: "upload" }>,
    thumbnailUrl: m.hasImage ? `${prefix}/${m.id}/thumb` : null,
    videoUrl: m.kind === "video" && m.storageUrl ? `${prefix}/${m.id}/file` : null,
  };
}

export async function libraryUploads(academyId: number, f: LibraryFilters, phone: { phase?: string | null; sessionId?: number | null } = {}) {
  // Everything but the image bytes (photos are megabytes each).
  const { imageData: _bytes, ...columns } = getTableColumns(academyAdMediaTable);
  const where: SQL[] = [eq(academyAdMediaTable.academyId, academyId), sql`${academyAdMediaTable.status} <> 'failed'`];
  // Phone files: sorted by match time (before / during / after / not linked).
  if (phone.phase) where.push(eq(academyPhoneMediaTable.phase, phone.phase));
  if (phone.sessionId) where.push(eq(academyPhoneMediaTable.sessionId, phone.sessionId));
  if (f.kind) where.push(eq(academyAdMediaTable.kind, f.kind));
  if (f.from) where.push(gte(academyAdMediaTable.createdAt, f.from));
  if (f.until) where.push(lt(academyAdMediaTable.createdAt, f.until));
  const [rows, [{ count }]] = await Promise.all([
    db.select({
      ...columns, hasImage: sql<boolean>`${academyAdMediaTable.imageData} is not null`,
      phoneId: academyPhoneMediaTable.id, phase: academyPhoneMediaTable.phase, phoneSessionId: academyPhoneMediaTable.sessionId,
      offsetSec: academyPhoneMediaTable.offsetSec, capturedStart: academyPhoneMediaTable.capturedStart, needsReview: academyPhoneMediaTable.needsReview,
    })
      .from(academyAdMediaTable).leftJoin(academyPhoneMediaTable, eq(academyPhoneMediaTable.mediaId, academyAdMediaTable.id)).where(and(...where))
      .orderBy(desc(academyAdMediaTable.createdAt), desc(academyAdMediaTable.id))
      .limit(f.limit).offset(f.offset),
    db.select({ count: sql<number>`count(*)::int` }).from(academyAdMediaTable)
      .leftJoin(academyPhoneMediaTable, eq(academyPhoneMediaTable.mediaId, academyAdMediaTable.id)).where(and(...where)),
  ]);
  const next = f.offset + rows.length;
  return {
    uploads: rows.map((r) => ({
      ...libraryUpload(r),
      phone: r.phoneId === null ? null : {
        id: r.phoneId, phase: r.phase, sessionId: r.phoneSessionId, offsetSec: r.offsetSec,
        capturedAt: r.capturedStart?.toISOString() ?? null, needsReview: r.needsReview,
      },
    })),
    total: count,
    nextOffset: next < count ? next : null,
  };
}

// ── Players ─────────────────────────────────────────────────────────────────

export async function libraryPlayers(academyId: number, squadId: number | null, showNames: boolean) {
  const where: SQL[] = [eq(academyPlayersTable.academyId, academyId), eq(academyPlayersTable.isActive, true)];
  if (squadId) where.push(eq(academyPlayersTable.squadId, squadId));
  const [players, squads] = await Promise.all([
    db.select({
      playerId: academyPlayersTable.id,
      name: academyPlayersTable.name,
      number: academyPlayersTable.jerseyNumber,
      squadId: academyPlayersTable.squadId,
      squad: academySquadsTable.name,
      position: academyPlayersTable.position,
    }).from(academyPlayersTable)
      .leftJoin(academySquadsTable, eq(academySquadsTable.id, academyPlayersTable.squadId))
      .where(and(...where))
      .orderBy(asc(academyPlayersTable.jerseyNumber), asc(academyPlayersTable.id))
      .limit(500),
    db.select({ id: academySquadsTable.id, name: academySquadsTable.name }).from(academySquadsTable)
      .where(eq(academySquadsTable.academyId, academyId)).orderBy(asc(academySquadsTable.name)),
  ]);
  // Photos only for an academy that shows names (most players are children).
  const primary = showNames && players.length
    ? await db.select().from(academyPlayerPhotosTable)
      .where(and(eq(academyPlayerPhotosTable.academyId, academyId), eq(academyPlayerPhotosTable.isPrimary, true), inArray(academyPlayerPhotosTable.playerId, players.map((p) => p.playerId))))
    : [];
  const photoBy = new Map(primary.map((p) => [p.playerId, photoView(p)]));
  return {
    showNames,
    squads,
    players: players.map((p) => ({
      playerId: p.playerId,
      squadId: p.squadId,
      ...libraryPlayer(p, showNames),
      position: p.position ?? null,
      photo: photoBy.get(p.playerId) ?? null,
    })),
  };
}

/** Recent sessions with footage this player was picked for (or, with no line-up, his squad's), newest first. */
async function playerSessions(academyId: number, player: { id: number; squadId: number | null }, limit: number): Promise<number[]> {
  const recordings = await academySessionRecordings(academyId);
  const ids = [...new Set(recordings.map((r) => r.sessionId))];
  if (!ids.length) return [];
  const [lineups, sessions] = await Promise.all([
    db.select({ sessionId: academyMatchLineupsTable.sessionId, playerId: academyMatchLineupsTable.playerId, inSquad: academyMatchLineupsTable.inSquad })
      .from(academyMatchLineupsTable).where(inArray(academyMatchLineupsTable.sessionId, ids)),
    db.select({ id: academySessionsTable.id, squadId: academySessionsTable.squadId, startsAt: academySessionsTable.startsAt })
      .from(academySessionsTable).where(and(eq(academySessionsTable.academyId, academyId), inArray(academySessionsTable.id, ids)))
      .orderBy(desc(academySessionsTable.startsAt), desc(academySessionsTable.id)),
  ]);
  const withLineup = new Set(lineups.map((l) => l.sessionId));
  const picked = new Set(lineups.filter((l) => l.playerId === player.id && l.inSquad).map((l) => l.sessionId));
  return sessions
    .filter((s) => picked.has(s.id) || (!withLineup.has(s.id) && (s.squadId === null || s.squadId === player.squadId)))
    .slice(0, limit)
    .map((s) => s.id);
}

/** Sessions the Player picker looks through for a player's moments (each reads its match analysis). */
export const PLAYER_MEDIA_SESSIONS = 6;

/**
 * One player's media for the Player picker. Photos (his gallery) only when the
 * academy shows names; clips he made under the academy; moments of recent
 * matches where the analysis bound a track to him, and clips he saved there.
 */
export async function libraryPlayerMedia(academyId: number, playerId: number, showNames: boolean) {
  const [p] = await db.select({
    id: academyPlayersTable.id,
    name: academyPlayersTable.name,
    number: academyPlayersTable.jerseyNumber,
    position: academyPlayersTable.position,
    squadId: academyPlayersTable.squadId,
    squad: academySquadsTable.name,
    userId: academyPlayersTable.userId,
    avatarPath: usersTable.avatarPath,
  }).from(academyPlayersTable)
    .leftJoin(academySquadsTable, eq(academySquadsTable.id, academyPlayersTable.squadId))
    .leftJoin(usersTable, eq(usersTable.id, academyPlayersTable.userId))
    .where(and(eq(academyPlayersTable.id, playerId), eq(academyPlayersTable.academyId, academyId)));
  if (!p) return null;

  const photos = showNames
    ? (await db.select().from(academyPlayerPhotosTable)
      .where(and(eq(academyPlayerPhotosTable.academyId, academyId), eq(academyPlayerPhotosTable.playerId, p.id)))
      .orderBy(desc(academyPlayerPhotosTable.isPrimary), desc(academyPlayerPhotosTable.createdAt), desc(academyPlayerPhotosTable.id)))
      .map((row) => ({ ...photoView(row), source: { type: "player-photo", photoId: row.id, cutout: row.transparent } as Extract<MediaSource, { type: "player-photo" }> }))
    : [];

  // His own clips, made under this academy.
  const clipRows = p.userId
    ? await db.select().from(userClipsTable)
      .where(and(eq(userClipsTable.academyId, academyId), eq(userClipsTable.userId, p.userId), eq(userClipsTable.isHidden, false)))
      .orderBy(desc(userClipsTable.createdAt), desc(userClipsTable.id)).limit(60)
    : [];
  const playerSpans = await clipSpans(clipRows);
  const clips = clipRows
    .filter((c) => !c.hiddenReason && !c.videoId.startsWith("live:") && academyClipStatus(c) !== "expired")
    .map((clip) => {
      const span = playerSpans.get(clip.id) ?? null;
      const start = span?.startSec ?? 0;
      const end = span?.endSec ?? 0;
      const thumbTime = span?.thumbSec ?? start;
      return {
        clipId: clip.id,
        title: showNames ? clip.title.slice(0, 80) : null,
        date: ammanDate(clip.createdAt),
        durationMs: Math.max(0, Math.round((end - start) * 1000)),
        source: { type: "clip", clipId: clip.id } as Extract<MediaSource, { type: "clip" }>,
        thumbnailUrl: isBunnyConfigured() ? getBunnyProxiedThumbnailUrl(clip.videoId, thumbTime) : null,
      };
    });

  const moments: Array<LibraryMoment & { sessionId: number }> = [];
  const seenClips = new Set(clips.map((c) => c.clipId));
  for (const sessionId of await playerSessions(academyId, { id: p.id, squadId: p.squadId }, PLAYER_MEDIA_SESSIONS)) {
    const out = await librarySessionMoments(academyId, sessionId, { ...EVERYTHING }, showNames).catch((error) => {
      logger.warn({ academyId, sessionId, error: (error as Error).message }, "Creative library: player moments failed");
      return null;
    });
    for (const m of out?.moments ?? []) {
      if (!m.player || playerIdOf.get(m.player) !== p.id) continue;
      if (m.clipId !== null && seenClips.has(m.clipId)) continue;
      moments.push({ ...m, sessionId });
    }
  }

  return {
    showNames,
    player: { playerId: p.id, squadId: p.squadId, ...libraryPlayer(p, showNames), position: p.position ?? null },
    hasAvatar: showNames && Boolean(p.userId && p.avatarPath),
    photos,
    clips,
    moments,
  };
}

const EVERYTHING: LibraryFilters = { squadId: null, playerNumber: null, types: [], from: null, until: null, kind: null, sessionType: null, offset: 0, limit: 1000 };
