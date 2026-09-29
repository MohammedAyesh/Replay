import { inArray } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import { roomsForRecording } from "./matchFeed";
import { rosterFor } from "./matchRooms";

export type RosterHintShirtStatus = "yes" | "no" | "unknown" | "yes, inferred";
export type RosterHintTeamKey = "A" | "B" | "C";

export interface RosterHintTeam {
  key: RosterHintTeamKey;
  name: string | null;
  color: string;
  shirtsHaveNumbers: RosterHintShirtStatus;
  shirtNumbers: number[];
  squadSize: number;
}

export interface RosterHints {
  matchCode: string;
  playersPerSide: number;
  teamCount: 2 | 3;
  substitutesPerTeam: number;
  teams: RosterHintTeam[];
  totalPlayersExpected: number;
}

export type RosterHintCache = Map<number, Promise<RosterHints | undefined>>;

/** Resolve the room using the same field and time-window overlap as match feeds. */
export async function buildRosterHintsForRecording(recordingId: number): Promise<RosterHints | undefined> {
  if (!Number.isSafeInteger(recordingId) || recordingId <= 0) return undefined;
  const matches = await roomsForRecording(recordingId);
  const selected = matches
    .slice()
    .sort((a, b) =>
      (b.toSeconds - b.fromSeconds) - (a.toSeconds - a.fromSeconds)
      || a.fromSeconds - b.fromSeconds
      || a.room.id - b.room.id,
    )[0];
  if (!selected) return undefined;

  const { room } = selected;
  const teamCount: 2 | 3 = room.teamCount === 3 ? 3 : 2;
  const teamRows: Array<{
    key: RosterHintTeamKey;
    name: string | null;
    color: string;
    status: "yes" | "no" | "unknown";
  }> = [
    { key: "A", name: room.teamAName, color: room.teamAColor, status: room.teamAShirtsHaveNumbers },
    { key: "B", name: room.teamBName, color: room.teamBColor, status: room.teamBShirtsHaveNumbers },
    ...(teamCount === 3
      ? [{ key: "C" as const, name: room.teamCName, color: room.teamCColor, status: room.teamCShirtsHaveNumbers }]
      : []),
  ];

  const roster = await rosterFor(room.id);
  const userIds = Array.from(new Set(
    roster.map((player) => player.userId).filter((id): id is number => typeof id === "number"),
  ));
  const userNumbers = userIds.length
    ? await db.select({ id: usersTable.id, shirtNumber: usersTable.shirtNumber })
      .from(usersTable)
      .where(inArray(usersTable.id, userIds))
    : [];
  const userShirtNumbers = new Map(userNumbers.map((user) => [user.id, user.shirtNumber]));

  const teams: RosterHintTeam[] = teamRows.map((team) => {
    const squad = roster.filter((player) =>
      player.team === team.key && (player.rsvp === "in" || player.rsvp === "maybe"),
    );
    const shirtNumbers = squad
      .map((player) => player.shirtNumber ?? (player.userId ? userShirtNumbers.get(player.userId) : null))
      .filter((number): number is number => typeof number === "number")
      .sort((a, b) => a - b);
    const shirtsHaveNumbers: RosterHintShirtStatus = team.status === "unknown" && shirtNumbers.length >= 2
      ? "yes, inferred"
      : team.status;
    return {
      key: team.key,
      name: team.name,
      color: team.color,
      shirtsHaveNumbers,
      shirtNumbers,
      squadSize: squad.length,
    };
  });

  const derivedSubstitutes = Math.max(
    0,
    ...teamRows.map((team) =>
      roster.filter((player) => player.team === team.key && player.rsvp === "in").length - room.playersPerSide,
    ),
  );
  const substitutesPerTeam = room.substitutesPerTeam ?? derivedSubstitutes;

  return {
    matchCode: room.code,
    playersPerSide: room.playersPerSide,
    teamCount,
    substitutesPerTeam,
    teams,
    totalPlayersExpected: room.playersPerSide * teamCount + substitutesPerTeam,
  };
}

/** The main recording is preferred; the first source is a fallback for split jobs. */
export async function buildRosterHintsForJob(
  recordingId: number,
  sourceRecordingIds: number[],
  cache?: RosterHintCache,
): Promise<RosterHints | undefined> {
  const get = (id: number) => {
    if (!cache) return buildRosterHintsForRecording(id);
    let pending = cache.get(id);
    if (!pending) {
      pending = buildRosterHintsForRecording(id);
      cache.set(id, pending);
    }
    return pending;
  };

  const primary = await get(recordingId);
  if (primary) return primary;
  const firstSource = sourceRecordingIds[0];
  if (firstSource && firstSource !== recordingId) return get(firstSource);
  return undefined;
}