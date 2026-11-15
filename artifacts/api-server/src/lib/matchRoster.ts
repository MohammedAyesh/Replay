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
  /** The pipeline's best reading when it declined to name one (people/match.json number_cand). */
  numberCandidate?: string | null;
  /** A rejected reading is retained for auditability, but must never be shown or used to bind a player. */
  numberDropped?: { number?: string | number; why?: string; [key: string]: unknown };
  adult?: boolean;
  group?: string | number | null;
  minutes: number;
  parts: MatchRosterPart[];
};

export type MatchTrainingGroup = {
  id: string;
  name: string;
  torso?: [number, number, number];
  trackMinutes?: number;
};

export type MatchTraining = {
  mode?: unknown;
  groups?: unknown;
  timeline?: unknown;
  [key: string]: unknown;
};

export type MatchRoster = { v: 1; players: MatchRosterPlayer[]; training?: MatchTraining };

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
 * The same rule as the pipeline's number_revote.py (vps1, 2026-10-25), checked by
 * eye on recordings 394, 396, 401 and 402.
 * - FOLD_MIN: a shorter read folds into a longer number that contains it only when
 *   the longer one has a quarter of the pair's frames. 44 half-read as 4 folds; a
 *   white 8 read "18" on 9 frames against "8" on 112 (rec 394) does not.
 * - SHARE: the winner needs three quarters of the player's frames, so a front-print
 *   10 read "70" 9 times and "10" 4 times (rec 394) is not renamed 70.
 * - Corroboration: a two-digit winner needs two tracks; a single digit must be the
 *   pipeline's own candidate. One-track "0"s on plain shirts (rec 396, three players)
 *   and a one-track "44" on a man in a jacket (rec 401) passed every other test.
 */
export const ROSTER_NUMBER_VOTE = { foldMin: 0.25, share: 0.75, minFrames: 8, minTracks: 2, minTrackFrames: 3 };

const rosterShirtNumber = (value: string | null | undefined): string | null => (
  typeof value === "string" && /^\d{1,2}$/.test(value) && !(value.length > 1 && value.startsWith("0")) ? value : null
);

/**
 * Second opinion on a match roster number from the per-track jersey votes, one
 * read per track. Returns the pipeline's number when the vote is not convincing;
 * it never removes a number.
 */
export function voteMatchRosterShirtNumber(
  matchNumber: string | null,
  reads: MatchRosterJerseyRead[],
  candidate: string | null = null,
): string | null {
  const { foldMin, share, minFrames, minTracks, minTrackFrames } = ROSTER_NUMBER_VOTE;
  const frames = new Map<string, number>();
  const tracks = new Map<string, number>();
  for (const read of reads) {
    const number = rosterShirtNumber(read.number);
    if (!number || !Number.isFinite(read.seenFrames) || read.seenFrames < minTrackFrames) continue;
    frames.set(number, (frames.get(number) ?? 0) + read.seenFrames);
    tracks.set(number, (tracks.get(number) ?? 0) + 1);
  }
  if (!frames.size) return matchNumber;

  const byWeight = ([aNumber, aFrames]: [string, number], [bNumber, bFrames]: [string, number]) => (
    bFrames - aFrames || (aNumber < bNumber ? -1 : aNumber > bNumber ? 1 : 0)
  );
  const foldedFrames = new Map(frames);
  const foldedTracks = new Map(tracks);
  for (const [shortNumber, shortFrames] of frames) {
    const target = [...frames.entries()]
      .filter(([number, longFrames]) => (
        number.length > shortNumber.length
        && number.includes(shortNumber)
        && longFrames >= foldMin * (longFrames + shortFrames)
      ))
      .sort(byWeight)[0]?.[0];
    if (!target) continue;
    foldedFrames.set(shortNumber, 0);
    foldedFrames.set(target, (foldedFrames.get(target) ?? 0) + shortFrames);
    foldedTracks.set(target, (foldedTracks.get(target) ?? 0) + (tracks.get(shortNumber) ?? 0));
    foldedTracks.set(shortNumber, 0);
  }

  const totalFrames = [...foldedFrames.values()].reduce((sum, value) => sum + value, 0);
  const [topNumber, topFrames] = [...foldedFrames.entries()].sort(byWeight)[0];
  if (topFrames < minFrames || topFrames < share * totalFrames) return matchNumber;
  const hints = [rosterShirtNumber(candidate), rosterShirtNumber(matchNumber)].filter((hint): hint is string => !!hint);
  if (topNumber.length === 1) return hints.includes(topNumber) ? topNumber : matchNumber;
  return (foldedTracks.get(topNumber) ?? 0) >= minTracks ? topNumber : matchNumber;
}

function rosterId(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim().slice(0, 120);
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  return null;
}

/** A safe display view of groups; the stored training object itself is untouched. */
export function matchTrainingGroups(roster: MatchRoster | null | undefined): MatchTrainingGroup[] {
  const rawGroups = roster?.training?.groups;
  if (!Array.isArray(rawGroups)) return [];
  return rawGroups.flatMap((value): MatchTrainingGroup[] => {
    const raw = asRecord(value);
    const id = rosterId(raw.id);
    if (!id) return [];
    const name = firstString(raw.name)?.trim().slice(0, 120) || id;
    const torso = Array.isArray(raw.torso)
      && raw.torso.length >= 3
      && raw.torso.slice(0, 3).every((part) => typeof part === "number" && Number.isFinite(part))
      ? raw.torso.slice(0, 3) as [number, number, number]
      : undefined;
    const trackMinutes = firstNumber(raw.trackMinutes ?? raw.track_minutes);
    return [{
      id,
      name,
      ...(torso ? { torso } : {}),
      ...(trackMinutes !== undefined ? { trackMinutes } : {}),
    }];
  });
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
  const rawTraining = asRecord(raw.training);
  const hasTraining = Boolean(raw.training && typeof raw.training === "object" && !Array.isArray(raw.training));
  if (!Array.isArray(raw.players) && !hasTraining) return null;

  const segmentByName = new Map(trackingSegments.map((segment) => [segment.name, segment]));
  const seenPlayerIds = new Set<string>();
  const assignedTracks = new Set<string>();
  const players: MatchRosterPlayer[] = [];

  for (const value of (Array.isArray(raw.players) ? raw.players : []).slice(0, MAX_MATCH_ROSTER_PLAYERS)) {
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
    const numberCandidate = shirtNumber(player.number_cand ?? player.numberCandidate);
    const minutes = firstNumber(player.minutes);
    const dropped = asRecord(player.number_dropped ?? player.numberDropped);
    const adult = typeof player.adult === "boolean" ? player.adult : undefined;
    const group = typeof player.group === "string" || typeof player.group === "number" || player.group === null
      ? player.group
      : undefined;
    players.push({
      id,
      name: name?.trim().slice(0, 120) || null,
      number: shirtNumber(player.number),
      ...(numberCandidate ? { numberCandidate } : {}),
      ...(Object.keys(dropped).length ? { numberDropped: dropped as MatchRosterPlayer["numberDropped"] } : {}),
      ...(adult !== undefined ? { adult } : {}),
      ...(group !== undefined ? { group } : {}),
      minutes: minutes !== undefined && minutes >= 0 ? minutes : 0,
      parts: parts.sort((a, b) => a.segmentIndex - b.segmentIndex || a.fromFrame - b.fromFrame),
    });
  }

  if (!players.length && !hasTraining) return null;
  return { v: 1, players, ...(hasTraining ? { training: rawTraining as MatchTraining } : {}) };
}

export function summarizeMatchRoster(roster: MatchRoster): MatchRosterSummary {
  return {
    playerCount: roster.players.length,
    numberedPlayerCount: roster.players.filter((player) => player.number !== null && !player.numberDropped).length,
    playerMinutes: Math.round(roster.players.reduce((sum, player) => sum + player.minutes, 0) * 10) / 10,
  };
}