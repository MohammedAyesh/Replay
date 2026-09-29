import type { TrackingSegmentPayload } from "@workspace/db";
import { asRecord, firstNumber, firstString } from "./jsonCoerce";

export type MatchRosterPart = {
  segmentIndex: number;
  segmentName: string;
  trackId: string;
  /** Frames as supplied by the pipeline, local to segmentStartFrame. */
  fromFrame: number;
  toFrame: number;
  segmentStartFrame: number;
  /** Absolute tracking frames used when saving a claim. */
  absoluteFromFrame: number;
  absoluteToFrame: number;
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

const MAX_MATCH_ROSTER_PLAYERS = 200;
const MAX_MATCH_ROSTER_PARTS_PER_PLAYER = 256;

type RosterSegment = {
  index: number;
  name: string;
  startFrame: number;
  endFrame: number;
};

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
  segments: RosterSegment[],
  trackingSegments?: TrackingSegmentPayload[],
): MatchRoster | null {
  const raw = asRecord(input);
  if (!Array.isArray(raw.players)) return null;

  const segmentByName = new Map(segments.map((segment) => [segment.name, segment]));
  const tracksBySegment = trackingSegments
    ? new Map(trackingSegments.map((segment) => [segment.segmentIndex, new Set(segment.tracks.map((track) => track.id))]))
    : null;
  const seenPlayerIds = new Set<string>();
  const assignedTracks = new Set<string>();
  const players: MatchRosterPlayer[] = [];

  for (const value of raw.players.slice(0, MAX_MATCH_ROSTER_PLAYERS)) {
    const player = asRecord(value);
    const id = rosterId(player.id ?? player.playerId ?? player.player_id);
    if (!id || seenPlayerIds.has(id) || !Array.isArray(player.parts)) continue;

    const parts: MatchRosterPart[] = [];
    const ownParts = new Set<string>();
    for (const valuePart of player.parts.slice(0, MAX_MATCH_ROSTER_PARTS_PER_PLAYER)) {
      const part = asRecord(valuePart);
      const segmentName = firstString(part.segment, part.segmentName, part.segment_name, part.name);
      const segment = segmentName ? segmentByName.get(segmentName) : undefined;
      const trackId = segment ? namespacedTrackId(segment.index, part.trackId ?? part.track_id) : null;
      const fromFrame = firstNumber(part.fromFrame, part.from_frame);
      const toFrame = firstNumber(part.toFrame, part.to_frame);
      const segmentStartFrame = firstNumber(part.segmentStartFrame, part.segment_start_frame);
      if (
        !segment
        || !trackId
        || fromFrame === undefined
        || toFrame === undefined
        || segmentStartFrame === undefined
        || !Number.isSafeInteger(fromFrame)
        || !Number.isSafeInteger(toFrame)
        || !Number.isSafeInteger(segmentStartFrame)
        || fromFrame < 0
        || toFrame < fromFrame
        || segmentStartFrame < 0
      ) continue;
      const absoluteFromFrame = segmentStartFrame + fromFrame;
      const absoluteToFrame = segmentStartFrame + toFrame;
      if (
        !Number.isSafeInteger(absoluteFromFrame)
        || !Number.isSafeInteger(absoluteToFrame)
        || absoluteFromFrame < segment.startFrame
        || absoluteToFrame > segment.endFrame + 1
      ) continue;
      if (tracksBySegment && !tracksBySegment.get(segment.index)?.has(trackId)) continue;

      const key = `${segment.index}\u0000${trackId}\u0000${absoluteFromFrame}\u0000${absoluteToFrame}`;
      if (ownParts.has(key) || assignedTracks.has(`${segment.index}\u0000${trackId}`)) continue;
      ownParts.add(key);
      assignedTracks.add(`${segment.index}\u0000${trackId}`);
      parts.push({
        segmentIndex: segment.index,
        segmentName: segment.name,
        trackId,
        fromFrame,
        toFrame,
        segmentStartFrame,
        absoluteFromFrame,
        absoluteToFrame,
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
      parts: parts.sort((a, b) => a.segmentIndex - b.segmentIndex || a.absoluteFromFrame - b.absoluteFromFrame),
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