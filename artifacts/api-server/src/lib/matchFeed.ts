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
import { and, eq, notInArray } from "drizzle-orm";
import {
  db,
  footageRequestsTable,
  matchPlayersTable,
  matchRoomsTable,
  recordingTrackingBundlesTable,
  recordingsTable,
  usersTable,
  type MatchPlayer,
  type MatchRoom,
  type Recording,
  type TrackingManifest,
} from "@workspace/db";

import { claimIdentityId } from "../routes/claimChain";
import { ammanLocalInstant, randomToken, rosterFor, type RoomContext } from "./matchRooms";
import {
  detectedGoals,
  detectedShots,
  hexToLab,
  kitDistance,
  kitOfParts,
  mineTest,
  passEvents,
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
  manifest: TrackingManifest;
  /** the booking's window on this recording's tracking clock, seconds */
  fromSeconds: number;
  toSeconds: number;
};

/** Recordings with tracking that overlap a booking on its field. */
type FieldRecordingRows = Array<{ recording: Recording; manifest: TrackingManifest }>;
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
    .select({ recording: recordingsTable, manifest: recordingTrackingBundlesTable.manifest })
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
  for (const { recording, manifest } of rows) {
    const w = recordingWindow(recording, manifest);
    if (!Number.isFinite(w.startMs) || w.endMs <= start || w.startMs >= end) continue;
    out.push({
      recordingId: recording.id,
      manifest,
      fromSeconds: Math.max(0, (start - w.startMs) / 1000),
      toSeconds: Math.min(manifest.duration, (end - w.startMs) / 1000),
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

const SIDES = ["A", "B", "C"] as const;

function roomColour(room: MatchRoom, side: string): string {
  return side === "A" ? room.teamAColor : side === "B" ? room.teamBColor : room.teamCColor;
}

/**
 * Each side's shirt: the claimed players already on it, weighted by claimed
 * time; the captain's colour only when nobody on that side has claimed.
 */
function sideKits(room: MatchRoom, roster: MatchPlayer[], play: RecordingPlay, recordingId: number, window: { fromSeconds: number; toSeconds: number }) {
  const sides = SIDES.slice(0, room.teamCount >= 3 ? 3 : 2);
  const kits: Record<string, { lab: Lab; measured: boolean }> = {};
  for (const side of sides) {
    const parts = roster
      .filter((p) => p.team === side && p.userId)
      .flatMap((p) => clipParts(partsOf(play.manifest, p.userId!, recordingId), window.fromSeconds, window.toSeconds, play.fps));
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
export async function joinMatchesFromClaim(userId: number, recordingId: number, chain: ClaimedPart[]): Promise<number> {
  const rooms = await roomsForRecording(recordingId);
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
  dribblesWon: number | null;
  dribblesLost: number | null;
  shots: number | null;
  goals: number | null;
};

export type MatchTeamStats = {
  sides: [string, string];
  colours: [Lab, Lab];
  measured: [boolean, boolean];
  touches: [number, number];
  passesTried: [number, number];
  passesCompleted: [number, number];
  possessionSeconds: [number, number];
  possessionPercent: [number, number];
  completionPercent: number;
  contested: number;
  ambiguous: number;
  dribblesWon: [number, number];
  dribblesLost: [number, number];
  shots: [number, number];
  goals: [number, number];
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

async function linkPlays(ctx: RoomContext, roster: MatchPlayer[], keepSegments: boolean): Promise<LinkPlay[]> {
  const linked = await recordingsForRoom(ctx);
  const out: LinkPlay[] = [];
  for (const link of linked) {
    const play = await loadRecordingPlay(link.recordingId, { keepSegments });
    if (!play) continue;
    const within = (t: number) => t >= link.fromSeconds && t <= link.toSeconds;
    const touches = play.touches.filter((t) => within(t.t));
    let pick: TeamPick | null = null;
    let kits: ReturnType<typeof sideKits> | null = null;
    if (play.hasKits && ctx.room.teamCount < 3) {
      kits = sideKits(ctx.room, roster, play, link.recordingId, link);
      if (kits.A && kits.B) pick = { a: kits.A.lab, b: kits.B.lab };
    }
    out.push({
      link,
      play,
      touches,
      pick,
      kits,
      dribbles: play.dribbles.filter((d) => within(d.t0)),
      goals: detectedGoals(play.events.filter((e) => within(e.t)), play.touches),
      shots: detectedShots(play.events.filter((e) => within(e.t)), play.touches),
    });
  }
  return out;
}

export async function matchStats(ctx: RoomContext, includePlayers: boolean): Promise<{
  available: boolean;
  recordings: number[];
  hasBall: boolean;
  hasPitch: boolean;
  players: MatchPlayerStats[] | null;
  team: MatchTeamStats | null;
}> {
  const roster = await rosterFor(ctx.room.id);
  const plays = await linkPlays(ctx, roster, includePlayers);
  if (!plays.length) {
    return { available: false, recordings: [], hasBall: false, hasPitch: false, players: null, team: null };
  }
  // One recording is the common case; a booking spanning two hours sums them.
  const perPlayer = new Map<number, MatchPlayerStats>();
  const blank = (p: MatchPlayer): MatchPlayerStats => ({
    playerId: p.id,
    name: p.displayName,
    team: p.team,
    claimed: false,
    minutes: null,
    distanceKm: null,
    topSpeedKmh: null,
    touches: null,
    passesTried: null,
    passesCompleted: null,
    passesReceived: null,
    dribblesWon: null,
    dribblesLost: null,
    shots: null,
    goals: null,
  });
  for (const p of roster) perPlayer.set(p.id, blank(p));
  let hasBall = false;
  let hasPitch = false;
  let team: MatchTeamStats | null = null;
  const add = (a: number | null, b: number | null) => (a === null && b === null ? null : (a ?? 0) + (b ?? 0));
  const sum = (p: [number, number], q: [number, number]): [number, number] => [p[0] + q[0], p[1] + q[1]];
  const perSide = <T extends { kit: Lab | null }>(rows: T[], pick: TeamPick): [number, number] => {
    const n: [number, number] = [0, 0];
    for (const r of rows) { const side = sideOfKit(r.kit, pick); if (side !== null) n[side]++; }
    return n;
  };

  for (const { link, play, touches, pick, kits, dribbles, goals, shots } of plays) {
    hasBall ||= play.hasBall;
    hasPitch ||= play.hasPitch;
    const events = passEvents(touches, pick);
    if (pick && kits && touches.length) {
      const s = teamStats(touches, events, pick);
      const dr = teamDribbles(dribbles, play.kits, pick);
      const sh = perSide(shots, pick);
      const gl = perSide(goals, pick);
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
          dribblesWon: sum(prev.dribblesWon, dr.won),
          dribblesLost: sum(prev.dribblesLost, dr.lost),
          shots: sum(prev.shots, sh),
          goals: sum(prev.goals, gl),
        }
        : {
          sides: ["A", "B"],
          colours: [pick.a, pick.b],
          measured: [kits.A!.measured, kits.B!.measured],
          touches: s.touches,
          passesTried: s.passesTried,
          passesCompleted: s.passesCompleted,
          possessionSeconds: s.possessionSeconds,
          possessionPercent: s.possessionPercent,
          completionPercent: s.completionPercent,
          contested: s.contested,
          ambiguous: s.ambiguous,
          dribblesWon: dr.won,
          dribblesLost: dr.lost,
          shots: sh,
          goals: gl,
        };
    }

    if (!includePlayers) continue;
    for (const p of roster) {
      if (!p.userId) continue;
      const parts = clipParts(partsOf(play.manifest, p.userId, link.recordingId), link.fromSeconds, link.toSeconds, play.fps);
      if (!parts.length) continue;
      const row = perPlayer.get(p.id)!;
      row.claimed = true;
      const seconds = parts.reduce((s, x) => s + (x.toFrame - x.fromFrame) / play.fps, 0);
      row.minutes = Math.round(((row.minutes ?? 0) + seconds / 60) * 10) / 10;
      if (play.segments) {
        const m = buildPlayerMetrics(play.manifest, play.segments, parts, seconds, 0, 0, 0, 0, 0, 0, []);
        if (m.distanceMetres !== null) row.distanceKm = Math.round(((row.distanceKm ?? 0) + m.distanceMetres / 1000) * 100) / 100;
        const top = m.adminPlayerStats.topSpeedMetresPerSecond;
        if (typeof top === "number") row.topSpeedKmh = Math.max(row.topSpeedKmh ?? 0, Math.round(top * 36) / 10);
      }
      if (play.hasBall) {
        const mine = playerPlay(touches, events, parts, Boolean(pick));
        row.touches = add(row.touches, mine.touches.length);
        row.passesTried = add(row.passesTried, mine.passesTried);
        row.passesCompleted = pick ? add(row.passesCompleted, mine.passesCompleted) : null;
        row.passesReceived = pick ? add(row.passesReceived, mine.passesReceived) : null;
        const own = playerMoments(parts, dribbles, goals, shots);
        row.dribblesWon = add(row.dribblesWon, own.dribblesWon);
        row.dribblesLost = add(row.dribblesLost, own.dribblesLost);
        row.shots = add(row.shots, own.shots.length);
        row.goals = add(row.goals, own.goals.length);
      }
    }
  }
  if (team) {
    // Re-derived from the sums rather than averaged across recordings.
    const t = team as MatchTeamStats;
    const pt = t.possessionSeconds[0] + t.possessionSeconds[1] || 1;
    t.possessionPercent = [Math.round((1000 * t.possessionSeconds[0]) / pt) / 10, Math.round((1000 * t.possessionSeconds[1]) / pt) / 10];
    const aT = t.passesTried[0] + t.passesTried[1];
    t.completionPercent = aT ? Math.round((1000 * (t.passesCompleted[0] + t.passesCompleted[1])) / aT) / 10 : 0;
  }
  return {
    available: true,
    recordings: plays.map((l) => l.link.recordingId),
    hasBall,
    hasPitch,
    players: includePlayers ? [...perPlayer.values()] : null,
    team,
  };
}

export type ReplayGoal = {
  /** seconds from the booked kick-off */
  atSeconds: number;
  side: "A" | "B" | null;
  /** a claimed player on the roster whose touch it was */
  scorer: { playerId: number; name: string } | null;
  recordingId: number;
  /** tracking seconds on that recording (for the footage player) */
  t: number;
};

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
}> {
  const roster = await rosterFor(ctx.room.id);
  const plays = await linkPlays(ctx, roster, false);
  const goals: ReplayGoal[] = [];
  let shots: [number, number] | null = null;
  for (const { link, play, pick, goals: found, shots: sh } of plays) {
    const claimed = roster
      .filter((p) => p.userId)
      .map((p) => ({ p, test: mineTest(clipParts(partsOf(play.manifest, p.userId!, link.recordingId), link.fromSeconds, link.toSeconds, play.fps)) }));
    for (const g of found) {
      const side = sideOfKit(g.kit, pick);
      const who = g.trackId && g.touchF !== null
        ? claimed.find((c) => c.test({ trackId: g.trackId!, f: g.touchF! } as Touch))?.p ?? null
        : null;
      goals.push({
        atSeconds: Math.max(0, g.t - link.fromSeconds),
        side: side === null ? null : side === 0 ? "A" : "B",
        scorer: who ? { playerId: who.id, name: who.displayName } : null,
        recordingId: link.recordingId,
        t: g.t,
      });
    }
    if (pick) {
      const n: [number, number] = [0, 0];
      for (const x of sh) { const side = sideOfKit(x.kit, pick); if (side !== null) n[side]++; }
      shots = shots ? [shots[0] + n[0], shots[1] + n[1]] : n;
    }
  }
  goals.sort((a, b) => a.atSeconds - b.atSeconds);
  const sided = goals.filter((g) => g.side);
  const suggested = goals.length && sided.length === goals.length
    ? { a: sided.filter((g) => g.side === "A").length, b: sided.filter((g) => g.side === "B").length }
    : null;
  return { recordings: plays.map((p) => p.link.recordingId), goals, shots, suggested };
}
