import { createHash } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { db, recordingTrackingBundlesTable, type TrackingManifest } from "@workspace/db";
import { readClaimSegment } from "./claimMatchStorage";
import { goalVotesFor, reviewedGoalsOf } from "./goalReview";
import { playedOnly, TEAM_SPLIT } from "./matchFeed";
import { mergeSpans } from "./matchFlow";
import {
  assignObservedKits,
  bibObservedKits,
  bibPick,
  detectedShots,
  kitAcrossBib,
  kitOfParts,
  observedTeamKits,
  passEvents,
  pitchSizeOf,
  playerMoments,
  playerPlay,
  shotContext,
  sideOfKit,
  teamDribbles,
  teamStats,
  type ClaimedPart,
  type Lab,
  type TeamPick,
} from "./matchPlay";
import { loadRecordingPlay } from "./matchPlayLoad";
import { clipRangeToMatchWindow } from "./matchWindow";
import type { MatchRoster, MatchRosterPlayer } from "./matchRoster";
import { buildPlayerMetrics } from "./playerMetrics";

/**
 * Academy match stats.
 *
 * Match rooms give a player numbers only after he finds himself in the footage
 * ("Find yourself" writes a claim). Academy players are mostly children without
 * accounts, so here the owner says which player the analysis found is which (the
 * shirt number does most of it), and that player's tracks are used directly as
 * his claimed parts. The numbers themselves are computed exactly as matchStats
 * does for a claimed room player.
 */

export type AcademyPlayerStats = {
  playerId: number;
  rosterPlayerId: string;
  minutes: number | null;
  distanceKm: number | null;
  topSpeedKmh: number | null;
  touches: number | null;
  passesTried: number | null;
  passesCompleted: number | null;
  passesReceived: number | null;
  dribbles: number | null;
  dribblesWon: number | null;
  dribblesLost: number | null;
  shots: number | null;
  goals: number | null;
};

/** Index 0 is the academy, 1 the opponent. */
export type AcademyTeamStats = {
  touches: [number, number];
  passesTried: [number, number];
  passesCompleted: [number, number];
  possessionPercent: [number, number];
  completionPercent: number;
  dribbles: [number, number];
  dribblesWon: [number, number];
  shots: [number, number];
  goals: [number, number];
};

export type AcademyMatchStatsResult = {
  available: boolean;
  hasBall: boolean;
  hasPitch: boolean;
  team: AcademyTeamStats | null;
  players: AcademyPlayerStats[];
};

export type RosterBinding = { playerId: number; rosterPlayerId: string };

export async function latestBundle(recordingId: number): Promise<{ id: number; manifest: TrackingManifest } | null> {
  const [row] = await db
    .select({ id: recordingTrackingBundlesTable.id, manifest: recordingTrackingBundlesTable.manifest })
    .from(recordingTrackingBundlesTable)
    .where(eq(recordingTrackingBundlesTable.recordingId, recordingId))
    .orderBy(desc(recordingTrackingBundlesTable.id))
    .limit(1);
  return row ? { id: row.id, manifest: row.manifest as TrackingManifest } : null;
}

/** The analysis's match roster (people/match.json, parsed at upload), or null when the bundle has none. */
export async function loadMatchRoster(manifest: TrackingManifest): Promise<MatchRoster | null> {
  if (!manifest.matchRosterPath) return null;
  try {
    const bytes = await readClaimSegment(manifest.matchRosterPath);
    const roster = JSON.parse(bytes.toString("utf8")) as MatchRoster;
    return Array.isArray(roster?.players) ? roster : null;
  } catch {
    return null;
  }
}

/**
 * Who is who: hand-picked links first, then each lineup shirt number to the one
 * detected player wearing it. A number two detected players share (or a player
 * already picked by hand) is left for the owner to pick.
 */
export function resolveBindings(
  lineup: Array<{ playerId: number; shirtNumber: number | null; inSquad: boolean; rosterPlayerId: string | null; boundBy: string | null }>,
  roster: MatchRoster | null,
): Array<RosterBinding & { how: "owner" | "number" }> {
  if (!roster) return [];
  const known = new Set(roster.players.map((p) => p.id));
  const out: Array<RosterBinding & { how: "owner" | "number" }> = [];
  const taken = new Set<string>();
  const decided = new Set<number>();
  for (const row of lineup) {
    if (row.boundBy !== "owner") continue;
    decided.add(row.playerId);
    if (row.rosterPlayerId && known.has(row.rosterPlayerId) && !taken.has(row.rosterPlayerId)) {
      out.push({ playerId: row.playerId, rosterPlayerId: row.rosterPlayerId, how: "owner" });
      taken.add(row.rosterPlayerId);
    }
  }
  const byNumber = new Map<string, MatchRosterPlayer[]>();
  for (const p of roster.players) {
    if (!p.number || taken.has(p.id)) continue;
    byNumber.set(p.number, [...(byNumber.get(p.number) ?? []), p]);
  }
  const lineupByNumber = new Map<number, number[]>();
  for (const row of lineup) {
    if (decided.has(row.playerId) || !row.inSquad || row.shirtNumber === null) continue;
    lineupByNumber.set(row.shirtNumber, [...(lineupByNumber.get(row.shirtNumber) ?? []), row.playerId]);
  }
  for (const [number, playerIds] of lineupByNumber) {
    const found = byNumber.get(String(number)) ?? [];
    if (playerIds.length !== 1 || found.length !== 1) continue;
    out.push({ playerId: playerIds[0], rosterPlayerId: found[0].id, how: "number" });
    taken.add(found[0].id);
  }
  return out;
}

export function statsFingerprint(bundleId: number, bindings: RosterBinding[], votes: number): string {
  const key = bindings.map((b) => `${b.playerId}=${b.rosterPlayerId}`).sort().join(",");
  return createHash("sha1").update(`v1|${bundleId}|${key}|${votes}`).digest("hex");
}

export async function goalVoteCount(recordingId: number): Promise<number> {
  return (await goalVotesFor([recordingId])).get(recordingId)?.length ?? 0;
}

function clip(parts: ClaimedPart[], fromSeconds: number, toSeconds: number, fps: number): ClaimedPart[] {
  const a = Math.floor(fromSeconds * fps);
  const b = Math.ceil(toSeconds * fps);
  return parts
    .map((p) => ({ trackId: p.trackId, fromFrame: Math.max(p.fromFrame, a), toFrame: Math.min(p.toFrame, b) }))
    .filter((p) => p.toFrame > p.fromFrame);
}

const pair = (a: number, b: number): [number, number] => [a, b];

/** Every bound academy player's numbers, and the two teams', for one analysed recording. */
export async function computeAcademyMatchStats(
  recordingId: number,
  roster: MatchRoster,
  bindings: RosterBinding[],
): Promise<AcademyMatchStatsResult> {
  const play = await loadRecordingPlay(recordingId, { keepSegments: true });
  if (!play) return { available: false, hasBall: false, hasPitch: false, team: null, players: [] };
  const window = clipRangeToMatchWindow(0, play.manifest.duration, play.manifest)
    ?? { fromSeconds: 0, toSeconds: play.manifest.duration };
  const within = (t: number) => t >= window.fromSeconds && t < window.toSeconds;
  const touches = play.touches.filter((t) => within(t.t));
  const dribbles = play.dribbles.filter((d) => within(d.t0));
  const votes = (await goalVotesFor([recordingId])).get(recordingId) ?? [];
  const goals = play.hasBall ? reviewedGoalsOf(play, votes).filter((g) => g.status === "confirmed" && within(g.t)) : [];
  const shots = detectedShots(play.events.filter((e) => within(e.t)), touches, pitchSizeOf(play.manifest), shotContext(play));

  const rosterById = new Map(roster.players.map((p) => [p.id, p]));
  const partsByPlayer = new Map<number, { rosterPlayerId: string; parts: ClaimedPart[] }>();
  for (const binding of bindings) {
    const rosterPlayer = rosterById.get(binding.rosterPlayerId);
    if (!rosterPlayer) continue;
    const parts = clip(
      rosterPlayer.parts.map((p) => ({ trackId: p.trackId, fromFrame: p.fromFrame, toFrame: p.toFrame })),
      window.fromSeconds,
      window.toSeconds,
      play.fps,
    );
    if (parts.length) partsByPlayer.set(binding.playerId, { rosterPlayerId: binding.rosterPlayerId, parts });
  }

  // Our shirt is what our players were seen wearing; theirs is the other shirt on the pitch.
  let pick: TeamPick | null = null;
  if (play.hasKits) {
    const own = kitOfParts([...partsByPlayer.values()].flatMap((p) => p.parts), play.sidecars, play.fps);
    const segs = new Set(play.manifest.segments
      .filter((s) => s.endSeconds > window.fromSeconds && s.startSeconds < window.toSeconds)
      .map((s) => s.index));
    if (own) {
      const bibKits = play.bib ? bibObservedKits(play.sidecars, play.bib, segs) : null;
      let other: Lab | null = null;
      if (bibKits && play.bib) other = kitAcrossBib(own, play.bib, bibKits);
      else {
        const observed = observedTeamKits(play.sidecars, segs);
        if (observed) other = assignObservedKits(observed.kits, [{ measured: own, swatch: null }, { measured: null, swatch: null }])[1];
      }
      if (other) pick = bibPick(play.bib, own, other) ?? { a: own, b: other };
    }
  }

  const events = passEvents(touches, pick);
  let team: AcademyTeamStats | null = null;
  if (pick) {
    const played = playedOnly(play);
    const teamTouches = touches.filter((t) => played(t.t));
    const teamEvents = teamTouches.length === touches.length ? events : passEvents(teamTouches, pick);
    if (teamTouches.length) {
      const s = teamStats(teamTouches, teamEvents, pick);
      const dr = teamDribbles(dribbles.filter((d) => played(d.t0)), play.kits, pick);
      const perSide = (rows: Array<{ kit: Lab | null }>): [number, number] => {
        const n: [number, number] = [0, 0];
        for (const r of rows) { const side = sideOfKit(r.kit, pick); if (side !== null) n[side]++; }
        return n;
      };
      const touchTotal = s.touches[0] + s.touches[1];
      // A 99-to-1 split means the shirts were not told apart; leave team numbers out.
      if (!(touchTotal >= TEAM_SPLIT.minTouches && Math.min(...s.touches) < TEAM_SPLIT.minShare * touchTotal)) {
        team = {
          touches: s.touches,
          passesTried: s.passesTried,
          passesCompleted: s.passesCompleted,
          possessionPercent: pair(Math.round(s.possessionPercent[0] * 10) / 10, Math.round(s.possessionPercent[1] * 10) / 10),
          completionPercent: s.completionPercent,
          dribbles: dr.total,
          dribblesWon: dr.won,
          shots: perSide(shots.filter((x) => played(x.t))),
          goals: perSide(goals),
        };
      }
    }
  }

  const players: AcademyPlayerStats[] = [];
  for (const [playerId, { rosterPlayerId, parts }] of partsByPlayer) {
    const seconds = mergeSpans(parts.map((x) => [x.fromFrame / play.fps, x.toFrame / play.fps] as [number, number]))
      .reduce((s, [a, b]) => s + (b - a), 0);
    const row: AcademyPlayerStats = {
      playerId,
      rosterPlayerId,
      minutes: Math.round((seconds / 60) * 10) / 10,
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
    };
    if (play.segments) {
      const m = buildPlayerMetrics(play.manifest, play.segments, parts, seconds, 0, 0, 0, 0, 0, 0, []);
      if (m.distanceMetres !== null) row.distanceKm = Math.round((m.distanceMetres / 1000) * 100) / 100;
      const top = m.adminPlayerStats.topSpeedMetresPerSecond;
      if (typeof top === "number") row.topSpeedKmh = Math.round(top * 36) / 10;
    }
    if (play.hasBall) {
      const mine = playerPlay(touches, events, parts, Boolean(pick));
      row.touches = mine.touches.length;
      row.passesTried = mine.passesTried;
      row.passesCompleted = pick ? mine.passesCompleted : null;
      row.passesReceived = pick ? mine.passesReceived : null;
      const own = playerMoments(parts, dribbles, goals, shots);
      row.dribbles = own.dribbles.length;
      row.dribblesWon = own.dribblesWon;
      row.dribblesLost = own.dribblesLost;
      row.shots = own.shots.length;
      row.goals = own.goals.length;
    }
    players.push(row);
  }

  return { available: true, hasBall: play.hasBall, hasPitch: play.hasPitch, team, players };
}
