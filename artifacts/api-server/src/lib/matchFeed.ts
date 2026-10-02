/**
 * The claim feeds the match.
 *
 * A match (a booking, /m/:code) and a recording (an hour of footage the claim
 * is made on) are different rows that never pointed at each other: a booking
 * is keyed by field and time, a recording by field, date and hour. They are
 * joined here the only way they can be -- same field, overlapping time -- and
 * three things follow from that join:
 *
 *   1. Finishing a claim puts you on the roster of the match you played in,
 *      on the team whose shirt matches yours (joinMatchesFromClaim).
 *   2. The match page's Stats tab reads every claimant's distance, top speed,
 *      touches and passes (matchStats).
 *   3. The match's two teams get possession and passing numbers, with the
 *      team colours taken from the claimants who are on each team -- the
 *      captain's bib colour is only the fallback, because a picked swatch is a
 *      guess and a claimed player's shirt was measured.
 */
import { createHash } from "node:crypto";
import { and, eq, inArray, notInArray } from "drizzle-orm";
import {
  db,
  footageRequestsTable,
  matchPlayersTable,
  matchTeamSpansTable,
  matchGamesTable,
  claimMatchProgressTable,
  matchRoomsTable,
  recordingTrackingBundlesTable,
  recordingsTable,
  usersTable,
  type MatchPlayer,
  type MatchRoom,
  type MatchGame,
  type Recording,
  type TrackingManifest,
} from "@workspace/db";

import { claimIdentityId } from "../routes/claimChain";
import { ammanLocalInstant, loadRoomById, randomToken, rosterFor, type RoomContext } from "./matchRooms";
import { matchStatsCacheIsCurrent, persistMatchStatsCache, type MatchStatsCacheFingerprint, type MatchStatsCacheInput } from "./matchStatsCache";
import { queueMatchStatsCacheForMatch } from "./matchStatsCacheJobs";
import { logger } from "./logger";
import { readOptionalMatchTeamSpans } from "./optionalMatchTeamSpans";
import {
  detectedGoals,
  detectedShots,
  pitchSizeOf,
  hexToLab,
  kitDistance,
  kitOfParts,
  mineTest,
  passEvents,
  PASS,
  playerMoments,
  playerPlay,
  sideOfKit,
  teamDribbles,
  teamStats,
  type ClaimedPart,
  type DetectedGoal,
  type DetectedShot,
  type Dribble,
  type Lab,
  type TeamPick,
  type Touch,
} from "./matchPlay";
import { loadRecordingPlay, type RecordingPlay } from "./matchPlayLoad";
import { buildPlayerMetrics } from "./playerMetrics";
import { matchFlow, type MatchFlow, type RecordingFlowInput } from "./matchFlow";
import { MatchPlayerReportBuilder, REPORT_BLOCK_SECONDS, type MatchPlayerReport } from "./matchPlayerReport";
import { teamAtTime, type TeamSpanAtTime, type TeamSpanTeam } from "./matchTeamSpans";

function teamFor(base: string | null, spans: readonly unknown[], offsetSec: number): string | null {
  return teamAtTime(base as TeamSpanTeam, spans as readonly TeamSpanAtTime[], offsetSec);
}

const DEAD_BOOKINGS = ["cancelled", "refunded", "failed"];

/** "60:00", "1:59:57", "3600" or "60" -> seconds. Bare small numbers are minutes. */
export function durationSeconds(text: string | null | undefined): number {
  const raw = String(text ?? "").trim();
  if (!raw) return 3600;
  if (raw.includes(":")) {
    const parts = raw.split(":").map(Number);
    if (parts.some((v) => !Number.isFinite(v))) return 3600;
    return parts.reduce((acc, v) => acc * 60 + v, 0);
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 3600;
  return n <= 300 ? n * 60 : n;
}

/**
 * When a recording's TRACKED footage ran, as epoch ms. The recording row says
 * when the file starts (date + hour slot, Amman local); the bundle says where
 * tracking starts inside it and how long it runs.
 */
export function recordingWindow(recording: Pick<Recording, "date" | "timeSlot" | "duration">, manifest?: Pick<TrackingManifest, "videoStartSeconds" | "duration"> | null) {
  const slot = /^(\d{1,2}):(\d{2})/.exec(recording.timeSlot ?? "");
  const fileStart = slot ? ammanLocalInstant(`${recording.date} ${slot[1].padStart(2, "0")}:${slot[2]}`) : Number.NaN;
  const trackStart = fileStart + (manifest?.videoStartSeconds ?? 0) * 1000;
  const length = manifest?.duration && manifest.duration > 0 ? manifest.duration : durationSeconds(recording.duration);
  return { fileStartMs: fileStart, startMs: trackStart, endMs: trackStart + length * 1000 };
}

export type LinkedRecording = {
  recordingId: number;
  bundleId: number;
  manifest: TrackingManifest;
  /** the booking's window on this recording's tracking clock, seconds */
  fromSeconds: number;
  toSeconds: number;
  /** tracking clock zero relative to the booking clock */
  recordingOffsetSec: number;
};

/** Recordings with tracking that overlap a booking on its field. */
type FieldRecordingRows = Array<{ recording: Recording; bundleId: number; manifest: TrackingManifest }>;
export type FieldRecordingCache = Map<number, Promise<FieldRecordingRows>>;

/**
 * Recordings with tracking that overlap a booking on its field. `perField`
 * lets a caller listing many matches (My matches) read each field's
 * recordings once instead of once per match.
 */
export async function recordingsForRoom(ctx: RoomContext, perField?: FieldRecordingCache): Promise<LinkedRecording[]> {
  const start = ammanLocalInstant(ctx.request.startLocal);
  const end = ammanLocalInstant(ctx.request.endLocal);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return [];
  const load = () => db
    .select({
      recording: recordingsTable,
      bundleId: recordingTrackingBundlesTable.id,
      manifest: recordingTrackingBundlesTable.manifest,
    })
    .from(recordingsTable)
    .innerJoin(recordingTrackingBundlesTable, eq(recordingTrackingBundlesTable.recordingId, recordingsTable.id))
    .where(eq(recordingsTable.fieldId, ctx.room.fieldId));
  let pending = perField?.get(ctx.room.fieldId);
  if (!pending) {
    pending = load();
    perField?.set(ctx.room.fieldId, pending);
  }
  const rows = await pending;
  const out: LinkedRecording[] = [];
  for (const { recording, bundleId, manifest } of rows) {
    const w = recordingWindow(recording, manifest);
    if (!Number.isFinite(w.startMs) || w.endMs <= start || w.startMs >= end) continue;
    out.push({
      recordingId: recording.id,
      bundleId,
      manifest,
      fromSeconds: Math.max(0, (start - w.startMs) / 1000),
      toSeconds: Math.min(manifest.duration, (end - w.startMs) / 1000),
      recordingOffsetSec: (w.startMs - start) / 1000,
    });
  }
  return out.sort((a, b) => a.recordingId - b.recordingId);
}

/** Live bookings (with a match room) on a recording's field that overlap its tracked footage. */
export async function roomsForRecording(recordingId: number): Promise<Array<{ room: MatchRoom; fromSeconds: number; toSeconds: number }>> {
  const [row] = await db
    .select({ recording: recordingsTable, manifest: recordingTrackingBundlesTable.manifest })
    .from(recordingsTable)
    .leftJoin(recordingTrackingBundlesTable, eq(recordingTrackingBundlesTable.recordingId, recordingsTable.id))
    .where(eq(recordingsTable.id, recordingId));
  if (!row) return [];
  const w = recordingWindow(row.recording, row.manifest);
  if (!Number.isFinite(w.startMs)) return [];
  const rooms = await db
    .select({ room: matchRoomsTable, request: footageRequestsTable })
    .from(matchRoomsTable)
    .innerJoin(footageRequestsTable, eq(footageRequestsTable.id, matchRoomsTable.footageRequestId))
    .where(and(eq(matchRoomsTable.fieldId, row.recording.fieldId), notInArray(footageRequestsTable.status, DEAD_BOOKINGS)));
  const out: Array<{ room: MatchRoom; fromSeconds: number; toSeconds: number }> = [];
  for (const { room, request } of rooms) {
    const start = ammanLocalInstant(request.startLocal);
    const end = ammanLocalInstant(request.endLocal);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= w.startMs || start >= w.endMs) continue;
    out.push({ room, fromSeconds: Math.max(0, (start - w.startMs) / 1000), toSeconds: (end - w.startMs) / 1000 });
  }
  return out;
}

function partsOf(manifest: TrackingManifest, userId: number, recordingId: number): ClaimedPart[] {
  const identity = (manifest.identities ?? []).find((item) => item.id === claimIdentityId(userId, recordingId));
  return (identity?.parts ?? []).map((p) => ({ trackId: p.trackId, fromFrame: p.fromFrame, toFrame: p.toFrame }));
}

/** Claimed parts clipped to a window of the recording (a booking shorter than the hour). */
function clipParts(parts: ClaimedPart[], fromSeconds: number, toSeconds: number, fps: number): ClaimedPart[] {
  const a = Math.floor(fromSeconds * fps);
  const b = Math.ceil(toSeconds * fps);
  return parts
    .map((p) => ({ trackId: p.trackId, fromFrame: Math.max(p.fromFrame, a), toFrame: Math.min(p.toFrame, b) }))
    .filter((p) => p.toFrame > p.fromFrame);
}

function cacheFingerprints(
  matchId: number,
  roster: MatchPlayer[],
  links: LinkedRecording[],
): MatchStatsCacheFingerprint[] {
  const fingerprints: MatchStatsCacheFingerprint[] = [];
  const sourceLinks = new Map<number, LinkedRecording>();
  for (const link of links) {
    const previous = sourceLinks.get(link.recordingId);
    sourceLinks.set(link.recordingId, previous ? {
      ...previous,
      fromSeconds: Math.min(previous.fromSeconds, link.fromSeconds),
      toSeconds: Math.max(previous.toSeconds, link.toSeconds),
    } : link);
  }
  for (const player of roster) {
    if (!player.userId) continue;
    const sources: Array<{
      recordingId: number;
      bundleId: number;
      fromSeconds: number;
      toSeconds: number;
      parts: ClaimedPart[];
    }> = [];
    for (const link of sourceLinks.values()) {
      const fps = link.manifest.frameRate;
      if (!Number.isFinite(fps) || fps <= 0) continue;
      const parts = clipParts(
        partsOf(link.manifest, player.userId, link.recordingId),
        link.fromSeconds,
        link.toSeconds,
        fps,
      );
      if (!parts.length) continue;
      sources.push({
        recordingId: link.recordingId,
        bundleId: link.bundleId,
        fromSeconds: link.fromSeconds,
        toSeconds: link.toSeconds,
        parts,
      });
    }
    if (!sources.length) continue;
    const input = {
      // 2: the cached row also carries the timeline extras the Home tiles use.
      version: 2,
      matchId,
      matchPlayerId: player.id,
      userId: player.userId,
      sources,
    };
    fingerprints.push({
      matchId,
      matchPlayerId: player.id,
      userId: player.userId,
      recordingIds: sources.map((source) => source.recordingId),
      fingerprint: createHash("sha256").update(JSON.stringify(input)).digest("hex"),
    });
  }
  return fingerprints;
}

function cacheStatsValues(stats: MatchPlayerStats, team: MatchTeamStats | null): MatchStatsCacheInput["stats"] {
  const side = stats.team && team ? team.sides.indexOf(stats.team) : -1;
  const report = stats.report;
  return {
    minutes: stats.minutes,
    distanceKm: stats.distanceKm,
    topSpeedKmh: stats.topSpeedKmh,
    touches: stats.touches,
    passesTried: stats.passesTried,
    passesCompleted: stats.passesCompleted,
    passesReceived: stats.passesReceived,
    dribbles: stats.dribbles,
    dribblesWon: stats.dribblesWon,
    dribblesLost: stats.dribblesLost,
    shots: stats.shots,
    goals: stats.goals,
    extras: {
      blocks: (report?.blocks ?? []).map((block) => [block.index, block.metres, block.touches]),
      topSpeedAt: report?.topSpeedAt ?? null,
      shotTimes: report?.shotTimes ?? [],
      goalTimes: report?.goalTimes ?? [],
      team: stats.team,
      teamPassesCompleted: side >= 0 && team ? team.passesCompleted[side] ?? null : null,
    },
  };
}

/** Queue at most `maxFills` stale recent matches without holding up /me/matches. */
export async function queueUncachedRecentMatchStats(
  contexts: RoomContext[],
  maxFills = 3,
  perField?: FieldRecordingCache,
): Promise<number> {
  let queued = 0;
  for (const ctx of contexts) {
    if (queued >= Math.max(0, maxFills)) break;
    try {
      const links = await recordingsForRoom(ctx, perField);
      if (!links.length) continue;
      const roster = await rosterFor(ctx.room.id);
      const expected = cacheFingerprints(ctx.room.id, roster, links);
      if (await matchStatsCacheIsCurrent(ctx.room.id, expected)) continue;
      queueMatchStatsCacheForMatch(ctx.room.id);
      queued++;
    } catch (error) {
      logger.warn({ matchId: ctx.room.id, err: error }, "Could not inspect recent match stats cache");
    }
  }
  return queued;
}

export async function fillMatchStatsCacheForMatch(matchId: number): Promise<void> {
  const ctx = await loadRoomById(matchId);
  if (!ctx) return;
  const links = await recordingsForRoom(ctx);
  if (!links.length) return;
  const roster = await rosterFor(matchId);
  const expected = cacheFingerprints(matchId, roster, links);
  if (await matchStatsCacheIsCurrent(matchId, expected)) return;
  await matchStats(ctx, true);
}

export async function fillMatchStatsCacheForRecording(recordingId: number): Promise<void> {
  const rooms = await roomsForRecording(recordingId);
  for (const { room } of rooms) {
    await fillMatchStatsCacheForMatch(room.id);
  }
}

const SIDES = ["A", "B", "C"] as const;

function roomColour(room: MatchRoom, side: string): string {
  return side === "A" ? room.teamAColor : side === "B" ? room.teamBColor : room.teamCColor;
}

/**
 * Each side's shirt: the claimed players already on it, weighted by claimed
 * time; the captain's colour only when nobody on that side has claimed.
 */
function sideKits(room: MatchRoom, roster: MatchPlayer[], play: RecordingPlay, recordingId: number, window: { fromSeconds: number; toSeconds: number }, sidesForPlayer?: (p: MatchPlayer, at: number) => string | null, validPlayerAt?: (p: MatchPlayer, at: number) => boolean) {
  const sides = SIDES.slice(0, room.teamCount >= 3 ? 3 : 2);
  const kits: Record<string, { lab: Lab; measured: boolean }> = {};
  for (const side of sides) {
    const parts = roster
      .filter((p) => p.userId)
      .flatMap((p) => clipParts(partsOf(play.manifest, p.userId!, recordingId), window.fromSeconds, window.toSeconds, play.fps)
        .filter((part) => {
          const at = (part.fromFrame + part.toFrame) / 2 / play.fps;
          return (sidesForPlayer ? sidesForPlayer(p, at) : p.team) === side && (!validPlayerAt || validPlayerAt(p, at));
        }));
    const measured = kitOfParts(parts, play.sidecars, play.fps);
    const fallback = hexToLab(roomColour(room, side));
    if (measured) kits[side] = { lab: measured, measured: true };
    else if (fallback) kits[side] = { lab: fallback, measured: false };
  }
  return kits;
}

/**
 * Put a claimant on the roster of every match booked over the recording, on
 * the side whose shirt is nearest theirs. Someone already placed on a team
 * keeps it (the captain may know better); someone new or unplaced is placed.
 */
export async function joinMatchesFromClaim(userId: number, recordingId: number, chain: ClaimedPart[], matchCodes?: string[]): Promise<number> {
  const overlappingRooms = await roomsForRecording(recordingId);
  const selectedCodes = matchCodes?.length ? new Set(matchCodes) : null;
  const rooms = selectedCodes
    ? overlappingRooms.filter(({ room }) => selectedCodes.has(room.code))
    : overlappingRooms;
  if (!rooms.length) return 0;
  const play = await loadRecordingPlay(recordingId);
  const [user] = await db.select({ name: usersTable.name }).from(usersTable).where(eq(usersTable.id, userId));
  let joined = 0;
  for (const { room, fromSeconds, toSeconds } of rooms) {
    const own = play ? kitOfParts(clipParts(chain, fromSeconds, toSeconds, play.fps), play.sidecars, play.fps) : null;
    if (play && !clipParts(chain, fromSeconds, toSeconds, play.fps).length) continue; // claimed, but not during this booking
    const roster = await rosterFor(room.id);
    let team: string | null = null;
    if (own && play) {
      const kits = sideKits(room, roster.filter((p) => p.userId !== userId), play, recordingId, { fromSeconds, toSeconds });
      let best = Number.POSITIVE_INFINITY;
      for (const [side, kit] of Object.entries(kits)) {
        const d = kitDistance(own, kit.lab) - (kit.measured ? 5 : 0); // a measured shirt beats a picked swatch at a tie
        if (d < best) { best = d; team = side; }
      }
    }
    const existing = roster.find((p) => p.userId === userId);
    if (existing) {
      const patch: Partial<MatchPlayer> = {};
      if (existing.rsvp !== "in") patch.rsvp = "in";
      if (!existing.team && team) patch.team = team;
      if (Object.keys(patch).length) {
        await db.update(matchPlayersTable).set({ ...patch, rsvpAt: new Date(), updatedAt: new Date() }).where(eq(matchPlayersTable.id, existing.id));
      }
    } else {
      await db.insert(matchPlayersTable).values({
        matchId: room.id,
        userId,
        displayName: user?.name ?? "",
        inviteToken: randomToken(),
        rsvp: "in",
        team,
        rsvpAt: new Date(),
      }).onConflictDoNothing();
    }
    joined++;
  }
  return joined;
}

export type MatchPlayerStats = {
  playerId: number;
  name: string;
  team: string | null;
  claimed: boolean;
  minutes: number | null;
  distanceKm: number | null;
  topSpeedKmh: number | null;
  touches: number | null;
  passesTried: number | null;
  passesCompleted: number | null;
  passesReceived: number | null;
  /** dribbles (runs past an opponent), and of them successful (won) and failed (lost) */
  dribbles: number | null;
  dribblesWon: number | null;
  dribblesLost: number | null;
  shots: number | null;
  goals: number | null;
  /** the whole-match report timeline; only on claimed rows of a whole-match request */
  report?: MatchPlayerReport;
};

export type MatchTeamStats = {
  sides: string[];
  colours: Lab[];
  measured: boolean[];
  touches: number[];
  passesTried: number[];
  passesCompleted: number[];
  passesReceived?: number[];
  possessionSeconds: number[];
  possessionPercent: number[];
  completionPercent: number;
  contested: number;
  ambiguous: number;
  dribbles: number[];
  dribblesWon: number[];
  dribblesLost: number[];
  shots: number[];
  goals: number[];
};

/** One recording's share of a booking: its touches, sides and detected events inside the booking's window. */
type LinkPlay = {
  link: LinkedRecording;
  play: RecordingPlay;
  touches: Touch[];
  pick: TeamPick | null;
  kits: ReturnType<typeof sideKits> | null;
  dribbles: Dribble[];
  goals: DetectedGoal[];
  shots: DetectedShot[];
};

async function linkPlays(ctx: RoomContext, roster: MatchPlayer[], keepSegments: boolean, game?: MatchGame, spans = new Map<number, Array<{
  id: number; fromOffsetSec: number; toOffsetSec?: number | null; team: string | null; source: string; changedShirt?: boolean; createdAt: Date | string | number;
}>>(), shirtEpochs = new Map<string, number[]>()) : Promise<LinkPlay[]> {
  const linked = await recordingsForRoom(ctx);
  const out: LinkPlay[] = [];
  for (const link of linked) {
    const windowFrom = game ? Math.max(link.fromSeconds, game.startOffsetSec - link.recordingOffsetSec) : link.fromSeconds;
    const windowTo = game ? Math.min(link.toSeconds, game.endOffsetSec - link.recordingOffsetSec) : link.toSeconds;
    if (windowTo <= windowFrom) continue;
    const play = await loadRecordingPlay(link.recordingId, { keepSegments });
    if (!play) continue;
    const spansInBookingClock = roster.flatMap((p) => spans.get(p.id) ?? []);
    const points = [windowFrom, windowTo];
    for (const span of spansInBookingClock) {
      for (const offset of [span.fromOffsetSec, span.toOffsetSec]) {
        if (typeof offset !== "number") continue;
        const at = offset - link.recordingOffsetSec;
        if (at > windowFrom && at < windowTo) points.push(at);
      }
    }
    for (const p of roster) {
      if (!p.userId) continue;
      for (const epoch of shirtEpochs.get(`${link.recordingId}:${p.userId}`) ?? []) {
        if (epoch > windowFrom && epoch < windowTo) points.push(epoch);
      }
    }
    // All claim parts and tracking touches are frame-based; align split points
    // so adjacent windows neither double-count nor drop a frame.
    const boundaries = [...new Set(points.map((at) => Math.round(at * play.fps) / play.fps))].sort((a, b) => a - b);
    for (let i = 0; i < boundaries.length - 1; i++) {
      const from = boundaries[i], to = boundaries[i + 1];
      if (to <= from) continue;
      const window = { fromSeconds: from, toSeconds: to };
      const within = (t: number) => t >= from && t < to;
      const touches = play.touches.filter((t) => within(t.t));
      const sideAt = (p: MatchPlayer, at: number) => {
        const playerSpans = spans.get(p.id);
        return playerSpans?.length ? teamFor(p.team, playerSpans, at + link.recordingOffsetSec) : p.team;
      };
      const shirtEpochsInBookingClock = (p: MatchPlayer) => [
        ...(spans.get(p.id) ?? []).filter((span) => span.changedShirt).map((span) => span.fromOffsetSec),
        ...(p.userId ? shirtEpochs.get(`${link.recordingId}:${p.userId}`) ?? [] : [])
          .map((epoch) => epoch + link.recordingOffsetSec),
      ];
      const shirtEpochAtWindowStart = new Map(roster.map((p) => [
        p.id,
        Math.max(...shirtEpochsInBookingClock(p).filter((epoch) => epoch <= from + link.recordingOffsetSec), -Infinity),
      ]));
      const validAt = (p: MatchPlayer, at: number) =>
        at + link.recordingOffsetSec >= (shirtEpochAtWindowStart.get(p.id) ?? -Infinity);
      let pick: TeamPick | null = null;
      let kits: ReturnType<typeof sideKits> | null = null;
      if (play.hasKits) {
        kits = sideKits(ctx.room, roster, play, link.recordingId, window, sideAt, validAt);
        const x = game?.teamX ?? "A", y = game?.teamY ?? "B";
        if (kits[x] && kits[y]) pick = { a: kits[x].lab, b: kits[y].lab };
      }
      out.push({
        link: { ...link, fromSeconds: from, toSeconds: to },
        play,
        touches,
        pick,
        kits,
        dribbles: play.dribbles.filter((d) => within(d.t0)),
        goals: detectedGoals(play.events.filter((e) => within(e.t)), play.touches.filter((t) => within(t.t)), pitchSizeOf(play.manifest)),
        shots: detectedShots(play.events.filter((e) => within(e.t)), play.touches.filter((t) => within(t.t)), pitchSizeOf(play.manifest)),
      });
    }
  }
  return out;
}

export async function matchStats(ctx: RoomContext, includePlayers: boolean, game?: MatchGame): Promise<{
  available: boolean;
  recordings: number[];
  hasBall: boolean;
  hasPitch: boolean;
  players: MatchPlayerStats[] | null;
  team: MatchTeamStats | null;
}> {
  const roster = await rosterFor(ctx.room.id);
  const spanRows = await readOptionalMatchTeamSpans("matchStats", () => db.select().from(matchTeamSpansTable)
    .where(eq(matchTeamSpansTable.matchId, ctx.room.id)));
  const spans = new Map<number, Array<{
    id: number; fromOffsetSec: number; toOffsetSec?: number | null; team: string | null; source: string; changedShirt?: boolean; createdAt: Date | string | number;
  }>>();
  for (const span of spanRows) {
    const list = spans.get(span.matchPlayerId) ?? [];
    list.push(span);
    spans.set(span.matchPlayerId, list);
  }
  const linked = await recordingsForRoom(ctx);
  const userIds = roster.flatMap((p) => p.userId ? [p.userId] : []);
  const progressRows = linked.length && userIds.length
    ? await db.select({ userId: claimMatchProgressTable.userId, recordingId: claimMatchProgressTable.recordingId, gameState: claimMatchProgressTable.gameState })
      .from(claimMatchProgressTable)
      .where(and(inArray(claimMatchProgressTable.recordingId, linked.map((x) => x.recordingId)), inArray(claimMatchProgressTable.userId, userIds)))
    : [];
  const shirtEpochs = new Map<string, number[]>();
  for (const row of progressRows) {
    const state = row.gameState as { matchChoices?: unknown; switches?: unknown } | null;
    const choices = Array.isArray(state?.matchChoices) ? state.matchChoices.filter((x): x is string => typeof x === "string") : [];
    if (choices.length && !choices.includes(ctx.room.code)) continue;
    for (const entry of Array.isArray(state?.switches) ? state.switches : []) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      if (e.shirtChanged !== true || (typeof e.matchCode === "string" && e.matchCode !== ctx.room.code) || typeof e.atSeconds !== "number") continue;
      const key = `${row.recordingId}:${row.userId}`;
      const list = shirtEpochs.get(key) ?? [];
      list.push(e.atSeconds);
      shirtEpochs.set(key, list);
    }
  }
  const plays = await linkPlays(ctx, roster, includePlayers, game, spans, shirtEpochs);
  if (!plays.length) {
    return { available: false, recordings: [], hasBall: false, hasPitch: false, players: null, team: null };
  }
  // One recording is the common case; a booking spanning two hours sums them.
  const perPlayer = new Map<number, MatchPlayerStats>();
  const blank = (p: MatchPlayer): MatchPlayerStats => ({
    playerId: p.id,
    name: p.displayName,
    team: game ? (spans.get(p.id)?.length ? teamFor(p.team, spans.get(p.id)!, game.startOffsetSec) : p.team) : p.team,
    claimed: false,
    minutes: null,
    distanceKm: null,
    topSpeedKmh: null,
    touches: null,
    passesTried: null,
    passesCompleted: null,
    passesReceived: null,
    dribbles: null,
    dribblesWon: null,
    dribblesLost: null,
    shots: null,
    goals: null,
  });
  for (const p of roster) perPlayer.set(p.id, blank(p));
  // The report timeline only makes sense for the whole booking, not one game of it.
  const reports = new Map<number, MatchPlayerReportBuilder>();
  const reportFor = (playerId: number) => {
    let builder = reports.get(playerId);
    if (!builder) {
      builder = new MatchPlayerReportBuilder();
      reports.set(playerId, builder);
    }
    return builder;
  };
  let hasBall = false;
  let hasPitch = false;
  let team: MatchTeamStats | null = null;
  const add = (a: number | null, b: number | null) => (a === null && b === null ? null : (a ?? 0) + (b ?? 0));
  const sum = (p: number[], q: number[]): number[] => p.map((v, i) => v + (q[i] ?? 0));
  const perSide = <T extends { kit: Lab | null }>(rows: T[], pick: TeamPick): [number, number] => {
    const n: [number, number] = [0, 0];
    for (const r of rows) { const side = sideOfKit(r.kit, pick); if (side !== null) n[side]++; }
    return n;
  };
  /** Three-team classification deliberately uses claimant kits, not roster colours. */
  const multiSideStats = (ts: Touch[], ds: Dribble[], gs: DetectedGoal[], ss: DetectedShot[], trackKits: Map<string, Lab>, sideColours: ReturnType<typeof sideKits>, sideNames: string[]) => {
    const labs = sideNames.map((s) => sideColours[s]?.lab ?? null);
    const classify = (kit: Lab | null) => {
      if (!kit) return { side: null as number | null, margin: Infinity };
      const distances = labs.flatMap((lab, side) => lab ? [{ side, distance: kitDistance(kit, lab) }] : [])
        .sort((a, b) => a.distance - b.distance);
      return {
        side: distances[0]?.side ?? null,
        margin: distances.length > 1 ? distances[1].distance - distances[0].distance : Infinity,
      };
    };
    const sideOf = (kit: Lab | null) => classify(kit).side;
    const n = sideNames.length, touchesN = Array(n).fill(0), tried = Array(n).fill(0), completed = Array(n).fill(0);
    const possession = Array(n).fill(0), dribbleN = Array(n).fill(0), won = Array(n).fill(0), lost = Array(n).fill(0);
    const shotsN = Array(n).fill(0), goalsN = Array(n).fill(0);
    const raw = passEvents(ts, null, (touch) => sideOf(touch.kit));
    let contested = 0, ambiguous = 0;
    for (let i = 0; i < ts.length; i++) {
      const classification = classify(ts[i].kit), a = classification.side;
      if (a === null) continue;
      if (classification.margin < PASS.ambiguousKit) ambiguous++;
      touchesN[a]++;
      const next = ts[i + 1], b = next ? sideOf(next.kit) : null;
      possession[a] += next ? Math.min(Math.max(next.t - ts[i].t, 0), PASS.possessionCapSeconds) : 1.5;
      const e = raw[i]; if (!e || !next) continue;
      if (e.kind === "contest") { contested++; continue; }
      if (e.kind === "pass") { tried[a]++; if (a === b) completed[a]++; }
    }
    for (const d of ds) {
      const a = sideOf(trackKits.get(d.trackId) ?? null);
      if (a !== null) { dribbleN[a]++; if (d.outcome === "won") won[a]++; else if (d.outcome === "lost") lost[a]++; }
    }
    for (const x of ss) { const a = sideOf(x.kit); if (a !== null) shotsN[a]++; }
    for (const x of gs) { const a = sideOf(x.kit); if (a !== null) goalsN[a]++; }
    const attempts = tried.reduce((a, b) => a + b, 0);
    const completions = completed.reduce((a, b) => a + b, 0);
    return {
      touches: touchesN, passesTried: tried, passesCompleted: completed,
      possessionSeconds: possession.map(Math.round), possessionPercent: possession,
      completionPercent: attempts ? Math.round(completions * 1000 / attempts) / 10 : 0,
      contested, ambiguous, total: touchesN.reduce((a, b) => a + b, 0),
      dribbles: dribbleN, dribblesWon: won, dribblesLost: lost,
      shots: shotsN, goals: goalsN,
      totalDribbles: dribbleN, totalWon: won, totalLost: lost,
    };
  };

  for (const { link, play, touches, pick, kits, dribbles, goals, shots } of plays) {
    hasBall ||= play.hasBall;
    hasPitch ||= play.hasPitch;
    const events = passEvents(touches, pick);
    if (pick && kits && touches.length) {
      const sideNames = ctx.room.teamCount >= 3 && !game ? ["A", "B", "C"] : [game?.teamX ?? "A", game?.teamY ?? "B"];
      const multi = ctx.room.teamCount >= 3 && !game
        ? multiSideStats(touches, dribbles, goals, shots, play.kits, kits, sideNames)
        : null;
      const metricSides = multi ? sideNames : [game?.teamX ?? "A", game?.teamY ?? "B"];
      const metricColours = metricSides.map((side) => kits[side]?.lab ?? hexToLab(roomColour(ctx.room, side)) ?? pick.a);
      const metricMeasured = metricSides.map((side) => kits[side]?.measured ?? false);
      const s: any = multi ?? teamStats(touches, events, pick);
      const dr: any = multi ?? teamDribbles(dribbles, play.kits, pick);
      const sh = multi?.shots ?? perSide(shots, pick);
      const gl = multi?.goals ?? perSide(goals, pick);
      const prev = team as MatchTeamStats | null;
      team = prev
        ? {
          ...prev,
          touches: sum(prev.touches, s.touches),
          passesTried: sum(prev.passesTried, s.passesTried),
          passesCompleted: sum(prev.passesCompleted, s.passesCompleted),
          possessionSeconds: sum(prev.possessionSeconds, s.possessionSeconds),
          contested: prev.contested + s.contested,
          ambiguous: prev.ambiguous + s.ambiguous,
           dribbles: sum(prev.dribbles, multi ? multi.dribbles : dr.total),
           dribblesWon: sum(prev.dribblesWon, multi ? multi.dribblesWon : dr.won),
           dribblesLost: sum(prev.dribblesLost, multi ? multi.dribblesLost : dr.lost),
          shots: sum(prev.shots, sh),
          goals: sum(prev.goals, gl),
        }
        : {
          sides: metricSides,
          colours: metricColours,
          measured: metricMeasured,
          touches: s.touches,
          passesTried: s.passesTried,
          passesCompleted: s.passesCompleted,
          possessionSeconds: s.possessionSeconds,
          possessionPercent: s.possessionPercent,
          completionPercent: s.completionPercent,
          contested: s.contested,
          ambiguous: s.ambiguous,
           dribbles: multi ? multi.dribbles : dr.total,
           dribblesWon: multi ? multi.dribblesWon : dr.won,
           dribblesLost: multi ? multi.dribblesLost : dr.lost,
          shots: sh,
          goals: gl,
        };
    }

    if (!includePlayers) continue;
    for (const p of roster) {
      if (!p.userId) continue;
      const parts = clipParts(partsOf(play.manifest, p.userId, link.recordingId), link.fromSeconds, link.toSeconds, play.fps);
      const eligibleParts = game
        ? parts.filter((part) => {
          const at = (part.fromFrame + part.toFrame) / 2 / play.fps;
          const matchOffset = at + link.recordingOffsetSec;
          const playerSpans = spans.get(p.id) ?? [];
          const side = playerSpans.length ? teamFor(p.team, playerSpans, matchOffset) : p.team;
          const hasOverride = playerSpans.some((span) =>
            span.fromOffsetSec <= matchOffset
            && (span.toOffsetSec == null || span.toOffsetSec > matchOffset));
          if (hasOverride && side === null) return false;
          return side === null || side === game.teamX || side === game.teamY;
        })
        : parts.filter((part) => {
          const at = (part.fromFrame + part.toFrame) / 2 / play.fps;
          const matchOffset = at + link.recordingOffsetSec;
          const playerSpans = spans.get(p.id) ?? [];
          if (!playerSpans.length) return true;
          const side = teamFor(p.team, playerSpans, matchOffset);
          const hasOverride = playerSpans.some((span) =>
            span.fromOffsetSec <= matchOffset
            && (span.toOffsetSec == null || span.toOffsetSec > matchOffset));
          return !(hasOverride && side === null);
        });
      if (!eligibleParts.length) continue;
      const row = perPlayer.get(p.id)!;
      row.claimed = true;
      const seconds = eligibleParts.reduce((s, x) => s + (x.toFrame - x.fromFrame) / play.fps, 0);
      row.minutes = Math.round(((row.minutes ?? 0) + seconds / 60) * 10) / 10;
      const report = game ? null : reportFor(p.id);
      const bookingSeconds = (frame: number) => frame / play.fps + link.recordingOffsetSec;
      if (report) {
        report.beginRecording();
        for (const part of eligibleParts) report.addSpan(bookingSeconds(part.fromFrame), bookingSeconds(part.toFrame));
      }
      if (play.segments) {
        const frameRate = Math.max(play.manifest.frameRate, 0.001);
        const m = buildPlayerMetrics(
          play.manifest, play.segments, eligibleParts, seconds, 0, 0, 0, 0, 0, 0, [],
          report ? { bucketOfFrame: (frame) => Math.floor(Math.max(0, frame / frameRate + link.recordingOffsetSec) / REPORT_BLOCK_SECONDS) } : undefined,
        );
        if (m.distanceMetres !== null) row.distanceKm = Math.round(((row.distanceKm ?? 0) + m.distanceMetres / 1000) * 100) / 100;
        const top = m.adminPlayerStats.topSpeedMetresPerSecond;
        if (typeof top === "number") row.topSpeedKmh = Math.max(row.topSpeedKmh ?? 0, Math.round(top * 36) / 10);
        if (report) {
          if (m.distanceMetres !== null) {
            report.markDistanceMeasured();
            report.addDistance(m.timing?.distanceByBucket ?? {});
          }
          const topFrame = m.timing?.topSpeedFrame ?? null;
          report.addTopSpeed(typeof top === "number" ? top * 3.6 : null, topFrame === null ? null : topFrame / frameRate + link.recordingOffsetSec);
          report.addHeatmap(m.heatmap.coordinateSpace, m.heatmap.cells, seconds);
        }
      }
      if (play.hasBall) {
         const mine = playerPlay(touches, events, eligibleParts, Boolean(pick));
        row.touches = add(row.touches, mine.touches.length);
        row.passesTried = add(row.passesTried, mine.passesTried);
        row.passesCompleted = pick ? add(row.passesCompleted, mine.passesCompleted) : null;
        row.passesReceived = pick ? add(row.passesReceived, mine.passesReceived) : null;
         const own = playerMoments(eligibleParts, dribbles, goals, shots);
        row.dribbles = add(row.dribbles, own.dribbles.length);
        row.dribblesWon = add(row.dribblesWon, own.dribblesWon);
        row.dribblesLost = add(row.dribblesLost, own.dribblesLost);
        row.shots = add(row.shots, own.shots.length);
        row.goals = add(row.goals, own.goals.length);
        if (report) {
          report.addTouches(mine.touches.map((touch) => touch.t + link.recordingOffsetSec));
          report.addGoals(own.goals.map((goal) => goal.t + link.recordingOffsetSec));
          report.addDribblesWon(own.dribbles.filter((d) => d.outcome === "won").map((d) => d.t0 + link.recordingOffsetSec));
          report.addShots(own.shots.map((shot) => shot.t + link.recordingOffsetSec));
          report.addPasses(mine.passes.filter((pass) => pass.give).map((pass) => ({ t: pass.t0 + link.recordingOffsetSec, completed: pick ? pass.completed : null })));
          report.addDribbles(own.dribbles.map((d) => ({ t: d.t0 + link.recordingOffsetSec, outcome: d.outcome })));
        }
      }
    }
  }
  if (team) {
    // Re-derived from the sums rather than averaged across recordings.
    const t = team as MatchTeamStats;
    const totalPossession = t.possessionSeconds.reduce((a, b) => a + b, 0) || 1;
    t.possessionPercent = t.possessionSeconds.map((value) => Math.round((1000 * value) / totalPossession) / 10);
    const attempts = t.passesTried.reduce((a, b) => a + b, 0);
    const completions = t.passesCompleted.reduce((a, b) => a + b, 0);
    t.completionPercent = attempts ? Math.round((1000 * completions) / attempts) / 10 : 0;
  }
  for (const [playerId, builder] of reports) {
    const row = perPlayer.get(playerId);
    if (row?.claimed) row.report = builder.build();
  }
  if (includePlayers && !game) {
    try {
      const byPlayerId = new Map([...perPlayer.values()].map((player) => [player.playerId, player]));
      const cacheRows: MatchStatsCacheInput[] = cacheFingerprints(ctx.room.id, roster, plays.map((item) => item.link))
        .flatMap((fingerprint) => {
          const player = byPlayerId.get(fingerprint.matchPlayerId);
          return player?.claimed ? [{ ...fingerprint, stats: cacheStatsValues(player, team) }] : [];
        });
      await persistMatchStatsCache(ctx.room.id, cacheRows);
    } catch (error) {
      logger.error({ matchId: ctx.room.id, err: error }, "Could not persist match player stats cache");
    }
  }
  return {
    available: true,
    recordings: [...new Set(plays.map((l) => l.link.recordingId))],
    hasBall,
    hasPitch,
    players: includePlayers ? [...perPlayer.values()] : null,
    team,
  };
}

export type ReplayGoal = {
  /** seconds from the booked kick-off */
  atSeconds: number;
  side: "A" | "B" | "C" | null;
  /** a claimed player on the roster whose touch it was */
  scorer: { playerId: number; name: string } | null;
  recordingId: number;
  /** configured game index when this goal falls inside a configured game */
  gameIndex: number | null;
  /** tracking seconds on that recording (for the footage player) */
  t: number;
};

export function replaySideForGoal(
  teamCount: number,
  game: Pick<MatchGame, "teamX" | "teamY"> | undefined,
  kits: ReturnType<typeof sideKits> | null,
  pick: TeamPick | null,
  kit: Lab | null,
): ReplayGoal["side"] {
  if (teamCount < 3) {
    const side = sideOfKit(kit, pick);
    return side === null ? null : side === 0 ? "A" : "B";
  }
  if (!game) return null;
  const x = kits?.[game.teamX]?.lab;
  const y = kits?.[game.teamY]?.lab;
  if (!x || !y) return null;
  const side = sideOfKit(kit, { a: x, b: y });
  return side === null ? null : side === 0 ? game.teamX as "A" | "B" | "C" : game.teamY as "A" | "B" | "C";
}

/**
 * What Replay saw of a booked match, for the scoreboard: the recordings that
 * have tracking (and so can be claimed at /find), and the goals the detector
 * found, each put on a side by the shirt of whoever touched the ball last.
 * The goal count is a suggestion for the captain, never the score itself --
 * goals.py has one externally verified goal behind it (2026-08-28), and on the
 * 19 Sep game its inferred goals had to be merged to stop one kick-off
 * counting two or three times.
 */
export async function matchReplay(ctx: RoomContext): Promise<{
  recordings: number[];
  goals: ReplayGoal[];
  shots: [number, number] | null;
  suggested: { a: number; b: number } | null;
  /** where the game was on, and where the ball was in play, booking seconds */
  flow: MatchFlow;
}> {
  const roster = await rosterFor(ctx.room.id);
  const games = await db.select().from(matchGamesTable).where(eq(matchGamesTable.matchId, ctx.room.id));
  const plays = await linkPlays(ctx, roster, false);
  const goals: ReplayGoal[] = [];
  let shots: [number, number] | null = null;
  for (const { link, play, pick, kits, goals: found, shots: sh } of plays) {
    const claimed = roster
      .filter((p) => p.userId)
      .map((p) => ({ p, test: mineTest(clipParts(partsOf(play.manifest, p.userId!, link.recordingId), link.fromSeconds, link.toSeconds, play.fps)) }));
    for (const g of found) {
      const atSeconds = Math.max(0, g.t + link.recordingOffsetSec);
      const game = games.find((candidate) =>
        atSeconds >= candidate.startOffsetSec && atSeconds < candidate.endOffsetSec);
      const side = replaySideForGoal(ctx.room.teamCount, game, kits, pick, g.kit);
      const who = g.trackId && g.touchF !== null
        ? claimed.find((c) => c.test({ trackId: g.trackId!, f: g.touchF! } as Touch))?.p ?? null
        : null;
      goals.push({
        atSeconds,
        side,
        scorer: who ? { playerId: who.id, name: who.displayName } : null,
        recordingId: link.recordingId,
        gameIndex: game?.idx ?? null,
        t: g.t,
      });
    }
    if (ctx.room.teamCount < 3 && pick) {
      const n: [number, number] = [0, 0];
      for (const x of sh) { const side = sideOfKit(x.kit, pick); if (side !== null) n[side]++; }
      shots = shots ? [shots[0] + n[0], shots[1] + n[1]] : n;
    }
  }
  goals.sort((a, b) => a.atSeconds - b.atSeconds);
  // linkPlays splits each recording into windows; the flow wants its whole share.
  const shares = new Map<number, RecordingFlowInput>();
  for (const { link, play } of plays) {
    const share = shares.get(link.recordingId);
    if (share) {
      share.fromSeconds = Math.min(share.fromSeconds, link.fromSeconds);
      share.toSeconds = Math.max(share.toSeconds, link.toSeconds);
    } else {
      shares.set(link.recordingId, {
        fromSeconds: link.fromSeconds,
        toSeconds: link.toSeconds,
        offsetSec: link.recordingOffsetSec,
        phases: play.phases,
        inPlay: play.inPlay,
      });
    }
  }
  const sided = goals.filter((g) => g.side);
  const suggested = ctx.room.teamCount < 3 && goals.length && sided.length === goals.length
    ? { a: sided.filter((g) => g.side === "A").length, b: sided.filter((g) => g.side === "B").length }
    : null;
  return {
    recordings: [...new Set(plays.map((p) => p.link.recordingId))],
    goals,
    shots: ctx.room.teamCount < 3 ? shots : null,
    suggested,
    flow: matchFlow([...shares.values()]),
  };
}
