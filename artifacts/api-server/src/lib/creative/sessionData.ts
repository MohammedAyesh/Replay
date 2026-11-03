import { and, asc, desc, eq } from "drizzle-orm";
import {
  academyMatchLineupsTable,
  academyMatchPagesTable,
  academyMatchPlayerStatsTable,
  academyPlayersTable,
  academyRecordingsTable,
  academySessionsTable,
  academySquadsTable,
  brandingProfilesTable,
  db,
  recordingsTable,
  userClipsTable,
  type Academy,
} from "@workspace/db";
import type { CreativeData, MediaSource } from "@workspace/api-zod";
import { displayPhone, instagramHandle } from "../academyOwner";
import { latestBundle, type AcademyPlayerStats, type AcademyTeamStats } from "../academyMatchStats";
import { GOAL_REVIEW, goalVotesFor, type GoalVote } from "../goalReview";
import { durationSeconds } from "../matchFeed";
import { ammanDayLabel, ammanTime, firstName } from "../../routes/academyStudio";
import { playerPictures } from "../academyPlayerPhotos";

/**
 * Creative hub: the facts of one academy session (a match or a training) as
 * CreativeData, the values a template's {{bindings}} read.
 *
 * Players are mostly children. A player appears by first name only, and only
 * when the academy's own branding profile allows names; otherwise by shirt
 * number. That is decided here, on the server, whatever the browser asks for.
 *
 * Loading (DB) and building (pure) are split so the rules can be tested
 * without a database.
 */

export type CreativeLocale = "en" | "ar";

/** A short stretch of the academy's footage worth showing. Times are ms into the recording video. */
export type SessionMoment = {
  /** "<recordingId>-<atTenths>" for a goal, "clip-<id>" for a member's clip. */
  id: string;
  kind: "goal" | "clip";
  recordingId: number;
  atMs: number;
  fromMs: number;
  toMs: number;
  /** goal votes behind it (goals), or the clip's score (clips) */
  weight: number;
};

export type SessionPlayerFacts = {
  playerId: number;
  /** Full name as stored; never leaves this module unfiltered. */
  name: string | null;
  number: number | null;
  stats: Partial<AcademyPlayerStats> | null;
};

/** A player picked for the match (line-up, in squad) or, before a line-up exists, in the session's squad. */
export type SquadPlayer = { playerId: number; name: string | null; number: number | null; position: string | null };

/** That a player has a picture, and whether it is a cut-out (transparent background). */
export type PictureFact = { cutout: boolean };

export type SessionFacts = {
  session: {
    id: number;
    type: "match" | "training";
    startsAt: Date;
    endsAt: Date | null;
    location: string | null;
    opponent: string | null;
    ownScore: number | null;
    opponentScore: number | null;
    squad: string | null;
  };
  academy: { name: string; nameAr: string | null; phone: string | null; instagram: string | null };
  showNames: boolean;
  players: SessionPlayerFacts[];
  team: AcademyTeamStats | null;
  /** The recording the match page shows, if the session has footage. */
  recording: { id: number; durationSeconds: number; videoStartSeconds: number } | null;
  goals: SessionMoment[];
  clips: SessionMoment[];
  /** The match squad: the line-up's in-squad players, else the session squad's roster. */
  squad?: SquadPlayer[];
  /** Players with a picture, by player id. Loaded only when the academy shows names. */
  pictures?: Map<number, PictureFact>;
};

// ── Pure rules ──────────────────────────────────────────────────────────────

/** Rows a line-up template has (call-up 9; the line-up reads the first 7). */
export const LINEUP_ROWS = 9;

const POSITIONS: Array<{ re: RegExp; en: string; ar: string }> = [
  { re: /^(gk|goal ?keeper|keeper|حارس)/i, en: "GK", ar: "حارس" },
  { re: /^(df|def|defen[cs]e|defender|back|cb|lb|rb|دفاع|مدافع)/i, en: "DF", ar: "دفاع" },
  { re: /^(mf|mid|midfield|midfielder|cm|dm|am|وسط)/i, en: "MF", ar: "وسط" },
  { re: /^(fw|fwd|forward|striker|attack|attacker|winger|st|هجوم|مهاجم)/i, en: "FW", ar: "هجوم" },
];

/** A short position label ("GK" / "حارس"); anything unrecognised is kept, shortened (as autoDrafts.positionLabel). */
export function rowPosition(raw: string | null | undefined, locale: CreativeLocale): string {
  const v = (raw ?? "").trim();
  if (!v) return "";
  const hit = POSITIONS.find((p) => p.re.test(v));
  return hit ? hit[locale === "ar" ? "ar" : "en"] : v.slice(0, 12);
}

/** The player picture a design reads: always the player's own source, so the server decides what it shows. */
export const playerSource = (playerId: number, pic: PictureFact): MediaSource => ({ type: "player", playerId, cutout: pic.cutout });

/**
 * A line-up's rows (custom.n1/p1/pos1 … n9/p9/pos9) and their photos
 * (photos[i] is row i+1): goalkeepers first, then shirt order, as the call-up
 * draft. Names (first name) and photos only when the academy shows names;
 * otherwise numbers and positions only and no photos at all.
 */
export function lineupRows(
  squad: SquadPlayer[], showNames: boolean, locale: CreativeLocale, pictures?: Map<number, PictureFact>,
): { custom: Record<string, string>; photos?: Array<MediaSource | null> } {
  const gk = (p: SquadPlayer) => (rowPosition(p.position, "en") === "GK" ? 0 : 1);
  const rows = [...squad]
    .sort((a, b) => gk(a) - gk(b) || (a.number ?? 999) - (b.number ?? 999) || (a.name ?? "").localeCompare(b.name ?? ""))
    .slice(0, LINEUP_ROWS);
  const custom: Record<string, string> = {};
  rows.forEach((p, i) => {
    custom[`n${i + 1}`] = p.number !== null && p.number !== undefined ? String(p.number) : "";
    custom[`p${i + 1}`] = showNames ? firstName(p.name) ?? "" : "";
    custom[`pos${i + 1}`] = rowPosition(p.position, locale);
  });
  if (!showNames || !pictures?.size) return { custom };
  const photos = rows.map((p) => {
    const pic = pictures.get(p.playerId);
    return pic ? playerSource(p.playerId, pic) : null;
  });
  return photos.some(Boolean) ? { custom, photos } : { custom };
}

/** How a player is named on a post: a first name when the academy allows names, else "#<shirt>". */
export function playerLabel(p: { name: string | null; number: number | null }, showNames: boolean): string | null {
  const first = showNames ? firstName(p.name) : null;
  if (first) return first;
  return p.number !== null && p.number !== undefined ? `#${p.number}` : null;
}

const goalsOf = (s: Partial<AcademyPlayerStats> | null | undefined) =>
  Math.max(0, Math.round(Number(s?.goals ?? 0)) || 0);

/** "Ahmad ×2, #7" / "Ahmad ×2، #7" — most goals first, then shirt number. */
export function scorerLine(players: SessionPlayerFacts[], showNames: boolean, locale: CreativeLocale): string {
  return players
    .map((p) => ({ p, goals: goalsOf(p.stats) }))
    .filter((r) => r.goals > 0)
    .sort((a, b) => b.goals - a.goals || (a.p.number ?? 999) - (b.p.number ?? 999))
    .map(({ p, goals }) => {
      const label = playerLabel(p, showNames);
      return label ? (goals > 1 ? `${label} ×${goals}` : label) : null;
    })
    .filter((s): s is string => Boolean(s))
    .join(locale === "ar" ? "، " : ", ");
}

/** Players need this many minutes on camera to be player of the match. */
export const POTM_MIN_MINUTES = 10;
/** And this many players must have been measured, or a "best" says nothing. */
export const POTM_MIN_PLAYERS = 3;

const n = (v: number | null | undefined) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/**
 * Player of the match from the analysis: most goals, then the most completed
 * passes and won dribbles, then touches, then distance. Nobody when fewer than
 * three players were measured, when the leader did nothing measurable, or
 * when the top two cannot be told apart.
 */
export function pickPlayerOfMatch(players: SessionPlayerFacts[]): SessionPlayerFacts | null {
  const eligible = players.filter((p) => p.stats && (p.stats.minutes === null || p.stats.minutes === undefined || p.stats.minutes >= POTM_MIN_MINUTES));
  if (eligible.length < POTM_MIN_PLAYERS) return null;
  const key = (p: SessionPlayerFacts) => [
    goalsOf(p.stats),
    n(p.stats?.passesCompleted) + n(p.stats?.dribblesWon),
    n(p.stats?.touches),
    Math.round(n(p.stats?.distanceKm) * 100),
  ];
  const cmp = (a: number[], b: number[]) => {
    for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return b[i] - a[i];
    return 0;
  };
  const ranked = [...eligible].sort((a, b) => cmp(key(a), key(b)));
  const [top, next] = ranked;
  if (key(top).every((v) => v === 0)) return null;
  if (next && cmp(key(top), key(next)) === 0) return null;
  return top;
}

/** Seconds of video a goal moment shows before and after the strike. */
export const GOAL_WINDOW = { beforeMs: 6000, afterMs: 4000 } as const;
/** A member's clip is used for at most this long. */
const CLIP_MAX_MS = 15_000;

/**
 * The goals players confirmed on a recording ("that was a goal" — one vote
 * confirms, as on the match page). Votes this close together are one goal;
 * the moment with the most goal votes stands for it (then the later one).
 */
export function confirmedGoalMoments(recordingId: number, votes: GoalVote[], videoStartSeconds: number): SessionMoment[] {
  const byKey = new Map<number, number>();
  for (const v of votes) if (v.verdict === "goal") byKey.set(v.atTenths, (byKey.get(v.atTenths) ?? 0) + 1);
  const points = [...byKey.entries()].map(([atTenths, count]) => ({ atTenths, count })).sort((a, b) => a.atTenths - b.atTenths);
  const kept: typeof points = [];
  let cluster: typeof points = [];
  const settle = () => {
    if (cluster.length) kept.push(cluster.reduce((best, c) => (c.count > best.count || (c.count === best.count && c.atTenths > best.atTenths) ? c : best)));
    cluster = [];
  };
  for (const p of points) {
    if (cluster.length && (p.atTenths - cluster[cluster.length - 1].atTenths) / 10 > GOAL_REVIEW.confirmedMinGap) settle();
    cluster.push(p);
  }
  settle();
  return kept.map(({ atTenths, count }) => {
    const atMs = Math.round((atTenths / 10 + videoStartSeconds) * 1000);
    return {
      id: `${recordingId}-${atTenths}`,
      kind: "goal" as const,
      recordingId,
      atMs,
      fromMs: Math.max(0, atMs - GOAL_WINDOW.beforeMs),
      toMs: atMs + GOAL_WINDOW.afterMs,
      weight: count,
    };
  });
}

/** A member's clip of the recording as a moment (clip times are video seconds). */
export function clipMoment(clip: { id: number; recordingId: number; startTime: number; endTime: number; score: number }): SessionMoment | null {
  const from = Math.max(0, Math.round(clip.startTime * 1000));
  const to = Math.round(clip.endTime * 1000);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return null;
  const end = Math.min(to, from + CLIP_MAX_MS);
  return { id: `clip-${clip.id}`, kind: "clip", recordingId: clip.recordingId, atMs: Math.round((from + end) / 2), fromMs: from, toMs: end, weight: clip.score };
}

/**
 * Whether the confirmed goals on the footage can only be the academy's: votes
 * do not say which side scored, so only when the opponent scored nothing.
 */
export function goalsAreOurs(facts: Pick<SessionFacts, "session">): boolean {
  return facts.session.opponentScore === 0 && (facts.session.ownScore ?? 0) > 0;
}

const byWeight = (a: SessionMoment, b: SessionMoment) => b.weight - a.weight || a.atMs - b.atMs;

/**
 * The moments worth showing, best first: our goals (when they can only be
 * ours), then members' clips made under the academy. A goal we cannot tell
 * was ours is not shown.
 */
export function rankedMoments(facts: SessionFacts): SessionMoment[] {
  const goals = goalsAreOurs(facts) ? [...facts.goals].sort(byWeight) : [];
  return [...goals, ...[...facts.clips].sort(byWeight)];
}

export const windowSource = (m: SessionMoment): MediaSource => ({ type: "recording", recordingId: m.recordingId, fromMs: m.fromMs, toMs: m.toMs });
export const frameSource = (m: SessionMoment): MediaSource => ({ type: "frame", recordingId: m.recordingId, atMs: m.atMs });

/** With no moment, a still from a few minutes into the footage. */
export function fallbackFrame(recording: NonNullable<SessionFacts["recording"]>): MediaSource {
  const into = Math.min(300, Math.max(0, recording.durationSeconds / 2));
  return { type: "frame", recordingId: recording.id, atMs: Math.round((recording.videoStartSeconds + into) * 1000) };
}

/** With no moment, a video's stretch from a few minutes into the footage. */
export function fallbackWindow(recording: NonNullable<SessionFacts["recording"]>, lengthMs = 15_000): MediaSource {
  const frame = fallbackFrame(recording) as Extract<MediaSource, { type: "frame" }>;
  return { type: "recording", recordingId: recording.id, fromMs: frame.atMs, toMs: frame.atMs + lengthMs };
}

/**
 * Who scored, when the stats leave no doubt: one academy player scored every
 * goal. Otherwise nobody, so a goal clip never credits the wrong child.
 */
export function soleScorer(players: SessionPlayerFacts[]): SessionPlayerFacts | null {
  const scorers = players.filter((p) => goalsOf(p.stats) > 0);
  return scorers.length === 1 ? scorers[0] : null;
}

const pct = (v: number) => `${Math.round(v)}%`;

/** The team numbers a stats template shows; only what the analysis measured. */
export function teamStatsSummary(team: AcademyTeamStats | null): Record<string, string | number> {
  if (!team || !Array.isArray(team.touches)) return {};
  const out: Record<string, string | number> = {};
  const both = (key: string, pair: [number, number] | undefined, fmt: (v: number) => string | number = (v) => v) => {
    if (!pair || pair.length !== 2 || pair.some((v) => typeof v !== "number" || !Number.isFinite(v))) return;
    out[key] = fmt(pair[0]);
    out[`opponent${key[0].toUpperCase()}${key.slice(1)}`] = fmt(pair[1]);
  };
  both("possession", team.possessionPercent, pct);
  both("shots", team.shots);
  both("passes", team.passesCompleted);
  both("touches", team.touches);
  both("dribbles", team.dribblesWon);
  if (typeof team.completionPercent === "number" && Number.isFinite(team.completionPercent)) out.passAccuracy = pct(team.completionPercent);
  return out;
}

/** One player's numbers, prefixed (e.g. "potm" → potmGoals, potmDistanceKm). */
export function playerStatsSummary(stats: Partial<AcademyPlayerStats> | null, prefix = ""): Record<string, string | number> {
  if (!stats) return {};
  const out: Record<string, string | number> = {};
  const put = (key: string, v: number | null | undefined, fmt: (v: number) => string | number = (x) => x) => {
    if (typeof v !== "number" || !Number.isFinite(v)) return;
    out[prefix ? `${prefix}${key[0].toUpperCase()}${key.slice(1)}` : key] = fmt(v);
  };
  put("goals", stats.goals);
  put("shots", stats.shots);
  put("passes", stats.passesCompleted);
  put("dribbles", stats.dribblesWon);
  put("touches", stats.touches);
  put("distanceKm", stats.distanceKm, (v) => Math.round(v * 10) / 10);
  put("topSpeedKmh", stats.topSpeedKmh, (v) => Math.round(v));
  put("minutes", stats.minutes, (v) => Math.round(v));
  return out;
}

/** The session as template data, names already filtered. */
export function buildSessionData(facts: SessionFacts, locale: CreativeLocale): CreativeData {
  const { session, academy, showNames } = facts;
  const ownName = locale === "ar" ? academy.nameAr || academy.name : academy.name;
  const data: CreativeData = {
    academy: { name: academy.name, nameAr: academy.nameAr, phone: academy.phone, instagram: academy.instagram },
    match: {
      ownName,
      date: ammanDayLabel(session.startsAt, locale),
      time: ammanTime(session.startsAt),
      ...(session.opponent ? { opponent: session.opponent } : {}),
      ...(session.location ? { place: session.location } : {}),
      ...(session.squad ? { squad: session.squad } : {}),
      ...(session.ownScore !== null && session.opponentScore !== null ? { ownScore: session.ownScore, opponentScore: session.opponentScore } : {}),
    },
  };
  const scorers = scorerLine(facts.players, showNames, locale);
  if (scorers) data.match!.scorers = scorers;

  const stats: Record<string, string | number> = { ...teamStatsSummary(facts.team) };
  const potm = session.type === "match" ? pickPlayerOfMatch(facts.players) : null;
  if (potm) {
    const pic = showNames ? facts.pictures?.get(potm.playerId) : undefined;
    data.player = {
      name: showNames ? firstName(potm.name) : null,
      number: potm.number,
      ...(session.squad ? { squad: session.squad } : {}),
      ...(pic ? { photo: playerSource(potm.playerId, pic) } : {}),
    };
    Object.assign(stats, playerStatsSummary(potm.stats, "potm"));
  }
  if (Object.keys(stats).length) data.stats = stats;

  if (facts.squad?.length) {
    const rows = lineupRows(facts.squad, showNames, locale, facts.pictures);
    data.custom = { ...(data.custom ?? {}), ...rows.custom };
    if (rows.photos) data.photos = rows.photos;
  }

  const moments = rankedMoments(facts);
  if (moments.length) {
    data.media = windowSource(moments[0]);
    if (moments.length > 1) data.more = moments.slice(1, 4).map(windowSource);
  } else if (facts.recording) {
    data.media = fallbackFrame(facts.recording);
  }
  return data;
}

// ── Loading ─────────────────────────────────────────────────────────────────

export type AcademyCreativeProfile = {
  showNames: boolean;
  academy: SessionFacts["academy"];
};

/** The academy's names, contacts and whether players' names may be shown (its own profile only). */
export async function academyCreativeProfile(academy: Academy): Promise<AcademyCreativeProfile> {
  let profile: { nameEn: string; nameAr: string | null; bookingPhone: string | null; instagram: string | null; show: boolean } | undefined;
  try {
    [profile] = await db.select({
      nameEn: brandingProfilesTable.nameEn,
      nameAr: brandingProfilesTable.nameAr,
      bookingPhone: brandingProfilesTable.bookingPhone,
      instagram: brandingProfilesTable.instagram,
      show: brandingProfilesTable.showPlayerNames,
    }).from(brandingProfilesTable)
      .where(and(eq(brandingProfilesTable.scopeType, "academy"), eq(brandingProfilesTable.scopeId, academy.id)));
  } catch {
    profile = undefined;
  }
  return {
    showNames: profile?.show === true,
    academy: {
      name: profile?.nameEn || academy.name,
      nameAr: profile?.nameAr || academy.nameAr || null,
      phone: profile?.bookingPhone || displayPhone(academy.whatsappPhone) || academy.contactPhone || null,
      instagram: profile?.instagram || instagramHandle(academy.instagramUrl) || null,
    },
  };
}

/** Everything a draft or the data endpoint needs about one session of this academy, or null. */
export async function loadSessionFacts(academyId: number, sessionId: number, profile: AcademyCreativeProfile): Promise<SessionFacts | null> {
  const [s] = await db.select({
    id: academySessionsTable.id,
    type: academySessionsTable.type,
    squadId: academySessionsTable.squadId,
    startsAt: academySessionsTable.startsAt,
    endsAt: academySessionsTable.endsAt,
    location: academySessionsTable.location,
    opponent: academySessionsTable.opponent,
    ownScore: academySessionsTable.ownScore,
    opponentScore: academySessionsTable.opponentScore,
    squad: academySquadsTable.name,
  }).from(academySessionsTable)
    .leftJoin(academySquadsTable, eq(academySquadsTable.id, academySessionsTable.squadId))
    .where(and(eq(academySessionsTable.id, sessionId), eq(academySessionsTable.academyId, academyId)));
  if (!s) return null;

  const [statRows, lineups, recs, pages, squad] = await Promise.all([
    db.select({
      playerId: academyMatchPlayerStatsTable.playerId,
      stats: academyMatchPlayerStatsTable.stats,
      name: academyPlayersTable.name,
      jersey: academyPlayersTable.jerseyNumber,
    }).from(academyMatchPlayerStatsTable)
      .innerJoin(academyPlayersTable, eq(academyPlayersTable.id, academyMatchPlayerStatsTable.playerId))
      .where(and(eq(academyMatchPlayerStatsTable.academyId, academyId), eq(academyMatchPlayerStatsTable.sessionId, s.id))),
    db.select({ playerId: academyMatchLineupsTable.playerId, shirt: academyMatchLineupsTable.shirtNumber })
      .from(academyMatchLineupsTable).where(eq(academyMatchLineupsTable.sessionId, s.id)),
    db.select({ id: recordingsTable.id, duration: recordingsTable.duration })
      .from(academyRecordingsTable)
      .innerJoin(recordingsTable, eq(recordingsTable.id, academyRecordingsTable.recordingId))
      .where(and(eq(academyRecordingsTable.academyId, academyId), eq(academyRecordingsTable.sessionId, s.id)))
      .orderBy(asc(recordingsTable.id)),
    db.select({ recordingId: academyMatchPagesTable.recordingId, teamStats: academyMatchPagesTable.teamStats })
      .from(academyMatchPagesTable).where(and(eq(academyMatchPagesTable.sessionId, s.id), eq(academyMatchPagesTable.academyId, academyId))),
    loadMatchSquad(academyId, s.id, s.squadId),
  ]);
  const shirt = new Map(lineups.map((l) => [l.playerId, l.shirt]));
  const pictureIds = [...new Set([...squad.map((p) => p.playerId), ...statRows.map((r) => r.playerId)])];
  const pictures = new Map<number, PictureFact>();
  if (profile.showNames && pictureIds.length) {
    for (const [id, pic] of await playerPictures(academyId, pictureIds).catch(() => new Map())) {
      pictures.set(id, { cutout: pic.kind === "photo" && pic.photo.transparent });
    }
  }
  const players: SessionPlayerFacts[] = statRows.map((r) => ({
    playerId: r.playerId,
    name: r.name ?? null,
    number: shirt.get(r.playerId) ?? r.jersey ?? null,
    stats: (r.stats ?? null) as Partial<AcademyPlayerStats> | null,
  }));
  const page = pages[0];
  const rec = recs.find((r) => r.id === page?.recordingId) ?? recs[0] ?? null;
  const teamRaw = page?.teamStats as (AcademyTeamStats & { hasBall?: boolean }) | null | undefined;
  const team = teamRaw && "touches" in teamRaw ? teamRaw : null;

  let recording: SessionFacts["recording"] = null;
  let goals: SessionMoment[] = [];
  let clips: SessionMoment[] = [];
  if (rec) {
    const bundle = await latestBundle(rec.id).catch(() => null);
    const videoStartSeconds = Number(bundle?.manifest.videoStartSeconds ?? 0) || 0;
    recording = { id: rec.id, durationSeconds: durationSeconds(rec.duration), videoStartSeconds };
    const [votes, clipRows] = await Promise.all([
      bundle ? goalVotesFor([rec.id]).catch(() => new Map<number, GoalVote[]>()) : Promise.resolve(new Map<number, GoalVote[]>()),
      db.select({
        id: userClipsTable.id,
        startTime: userClipsTable.startTime,
        endTime: userClipsTable.endTime,
        score: userClipsTable.score,
        likeCount: userClipsTable.likeCount,
      }).from(userClipsTable)
        .where(and(
          eq(userClipsTable.academyId, academyId),
          eq(userClipsTable.sourceRecordingId, rec.id),
          eq(userClipsTable.isHidden, false),
        ))
        .orderBy(desc(userClipsTable.score), desc(userClipsTable.likeCount), desc(userClipsTable.id))
        .limit(5),
    ]);
    if (bundle) goals = confirmedGoalMoments(rec.id, votes.get(rec.id) ?? [], videoStartSeconds);
    clips = clipRows
      .map((c) => clipMoment({ id: c.id, recordingId: rec.id, startTime: Number(c.startTime), endTime: Number(c.endTime), score: c.score + c.likeCount }))
      .filter((m): m is SessionMoment => m !== null);
  }

  return {
    session: {
      id: s.id,
      type: s.type === "match" ? "match" : "training",
      startsAt: s.startsAt,
      endsAt: s.endsAt,
      location: s.location || null,
      opponent: s.opponent || null,
      ownScore: s.ownScore,
      opponentScore: s.opponentScore,
      squad: s.squad ?? null,
    },
    academy: profile.academy,
    showNames: profile.showNames,
    players,
    team,
    recording,
    goals,
    clips,
    squad,
    pictures,
  };
}

/**
 * The match squad: the line-up's in-squad players of this academy (shirt for
 * the match, else the player's own); with no line-up saved, the active
 * players of the session's squad (a call-up before the owner picked anyone).
 */
export async function loadMatchSquad(academyId: number, sessionId: number, squadId: number | null): Promise<SquadPlayer[]> {
  const rows = await db.select({
    playerId: academyMatchLineupsTable.playerId,
    inSquad: academyMatchLineupsTable.inSquad,
    shirt: academyMatchLineupsTable.shirtNumber,
    jersey: academyPlayersTable.jerseyNumber,
    name: academyPlayersTable.name,
    position: academyPlayersTable.position,
  }).from(academyMatchLineupsTable)
    .innerJoin(academyPlayersTable, eq(academyPlayersTable.id, academyMatchLineupsTable.playerId))
    .where(and(eq(academyMatchLineupsTable.sessionId, sessionId), eq(academyPlayersTable.academyId, academyId)));
  if (rows.length) {
    return rows.filter((r) => r.inSquad).map((r) => ({ playerId: r.playerId, name: r.name, number: r.shirt ?? r.jersey ?? null, position: r.position ?? null }));
  }
  if (!squadId) return [];
  const roster = await db.select({
    playerId: academyPlayersTable.id,
    name: academyPlayersTable.name,
    number: academyPlayersTable.jerseyNumber,
    position: academyPlayersTable.position,
  }).from(academyPlayersTable)
    .where(and(eq(academyPlayersTable.academyId, academyId), eq(academyPlayersTable.squadId, squadId), eq(academyPlayersTable.isActive, true)))
    .orderBy(asc(academyPlayersTable.jerseyNumber), asc(academyPlayersTable.id))
    .limit(60);
  return roster.map((r) => ({ playerId: r.playerId, name: r.name, number: r.number ?? null, position: r.position ?? null }));
}
