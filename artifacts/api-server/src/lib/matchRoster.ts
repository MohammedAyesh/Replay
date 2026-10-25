import type { TrackingSegmentPayload } from "@workspace/db";
import { asRecord, firstNumber, firstString } from "./jsonCoerce";

export type MatchRosterPart = {
  segmentIndex: number;
  segmentName: string;
  trackId: string;
  /** The referenced track's exact frame bounds in the bundle's tracking timeline. */
  fromFrame: number;
  toFrame: number;
};

export type MatchRosterPlayer = {
  id: string;
  name: string | null;
  number: string | null;
  minutes: number;
  parts: MatchRosterPart[];
};

export type MatchRoster = { v: 1; players: MatchRosterPlayer[] };

export type MatchRosterSummary = {
  playerCount: number;
  numberedPlayerCount: number;
  playerMinutes: number;
};

export type MatchRosterJerseyRead = {
  number: string;
  seenFrames: number;
};

const MAX_MATCH_ROSTER_PLAYERS = 200;
const MAX_MATCH_ROSTER_PARTS_PER_PLAYER = 256;

/**
 * Prefer a stable per-track jersey vote over the possibly truncated match
 * roster value. Single-digit reads are folded into the strongest longer
 * number on this player that contains them (for example, 4 into 44).
 */
export function voteMatchRosterShirtNumber(
  matchNumber: string | null,
  reads: MatchRosterJerseyRead[],
): string | null {
  const tallies = new Map<string, number>();
  for (const read of reads) {
    if (!/^\d+$/.test(read.number) || !Number.isFinite(read.seenFrames) || read.seenFrames <= 0) continue;
    tallies.set(read.number, (tallies.get(read.number) ?? 0) + read.seenFrames);
  }
  if (!tallies.size) return matchNumber;

  const folded = new Map(tallies);
  for (const [shortNumber, frames] of tallies) {
    const longerCandidates = [...tallies.entries()]
      .filter(([number]) => number.length > shortNumber.length && number.includes(shortNumber))
      .sort(([aNumber, aFrames], [bNumber, bFrames]) => bFrames - aFrames || aNumber.localeCompare(bNumber));
    if (!longerCandidates.length) continue;
    const [target] = longerCandidates[0];
    folded.set(shortNumber, 0);
    folded.set(target, (folded.get(target) ?? 0) + frames);
  }

  const totalFrames = [...folded.values()].reduce((sum, frames) => sum + frames, 0);
  const [topNumber, topFrames] = [...folded.entries()]
    .sort(([aNumber, aFrames], [bNumber, bFrames]) => bFrames - aFrames || aNumber.localeCompare(bNumber))[0];
  return topFrames >= 8 && topFrames / totalFrames >= 0.6 ? topNumber : matchNumber;
}

function rosterId(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim().slice(0, 120);
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  return null;
}

function shirtNumber(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim().slice(0, 24);
  if (typeof value === "number" && Number.isFinite(value) && Number.isInteger(value)) return String(value);
  return null;
}

function namespacedTrackId(segmentIndex: number, value: unknown): string | null {
  const raw = rosterId(value);
  if (!raw) return null;
  const local = raw.replace(/^s\d+:/, "");
  return local ? `s${segmentIndex}:${local}` : null;
}

/**
 * Parse the optional match-wide roster. Invalid roster records are discarded;
 * a malformed optional sidecar must never make a valid tracking bundle fail.
 */
export function parseMatchRoster(
  input: unknown,
  trackingSegments: TrackingSegmentPayload[],
): MatchRoster | null {
  const raw = asRecord(input);
  if (!Array.isArray(raw.players)) return null;

  const segmentByName = new Map(trackingSegments.map((segment) => [segment.name, segment]));
  const seenPlayerIds = new Set<string>();
  const assignedTracks = new Set<string>();
  const players: MatchRosterPlayer[] = [];

  for (const value of raw.players.slice(0, MAX_MATCH_ROSTER_PLAYERS)) {
    const player = asRecord(value);
    const id = rosterId(player.id ?? player.playerId ?? player.player_id ?? player.pid);
    if (!id || seenPlayerIds.has(id) || !Array.isArray(player.parts)) continue;

    const parts: MatchRosterPart[] = [];
    const ownParts = new Set<string>();
    for (const valuePart of player.parts.slice(0, MAX_MATCH_ROSTER_PARTS_PER_PLAYER)) {
      if (!Array.isArray(valuePart) || valuePart.length !== 2) continue;
      const segmentName = firstString(valuePart[0]);
      const segment = segmentName ? segmentByName.get(segmentName) : undefined;
      const trackId = segment ? namespacedTrackId(segment.segmentIndex, valuePart[1]) : null;
      const track = segment?.tracks.find((candidate) => candidate.id === trackId);
      const fromFrame = track?.startFrame;
      const toFrame = track?.endFrame;
      if (
        !segment
        || !trackId
        || !track
        || fromFrame === undefined
        || toFrame === undefined
        || !Number.isSafeInteger(fromFrame)
        || !Number.isSafeInteger(toFrame)
        || fromFrame < 0
        || toFrame <= fromFrame
      ) continue;

      const key = `${segment.segmentIndex}\u0000${trackId}`;
      if (ownParts.has(key) || assignedTracks.has(key)) continue;
      ownParts.add(key);
      assignedTracks.add(key);
      parts.push({
        segmentIndex: segment.segmentIndex,
        segmentName: segment.name,
        trackId,
        fromFrame,
        toFrame,
      });
    }
    if (!parts.length) continue;
    seenPlayerIds.add(id);

    const name = firstString(player.name);
    const minutes = firstNumber(player.minutes);
    players.push({
      id,
      name: name?.trim().slice(0, 120) || null,
      number: shirtNumber(player.number),
      minutes: minutes !== undefined && minutes >= 0 ? minutes : 0,
      parts: parts.sort((a, b) => a.segmentIndex - b.segmentIndex || a.fromFrame - b.fromFrame),
    });
  }

  return players.length ? { v: 1, players } : null;
}

export function summarizeMatchRoster(roster: MatchRoster): MatchRosterSummary {
  return {
    playerCount: roster.players.length,
    numberedPlayerCount: roster.players.filter((player) => player.number !== null).length,
    playerMinutes: Math.round(roster.players.reduce((sum, player) => sum + player.minutes, 0) * 10) / 10,
  };
}