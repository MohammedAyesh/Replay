import { describe, expect, it } from "vitest";
import {
  canViewMatchPlayerRows,
  competitionAwards,
  competitionCallouts,
  personalBestMetrics,
  playerForm,
  type CompetitionPlayer,
  type PlayerFormHistoryRow,
} from "./matchStatsRules";

function player(playerId: number, overrides: Partial<CompetitionPlayer> = {}): CompetitionPlayer {
  return {
    playerId,
    name: `Player ${playerId}`,
    team: playerId % 2 ? "A" : "B",
    claimed: true,
    minutes: 20,
    distanceKm: 5 + playerId,
    topSpeedKmh: 20 + playerId,
    touches: 30 + playerId,
    passesTried: 10 + playerId,
    passesCompleted: 8 + playerId,
    passesReceived: 5 + playerId,
    dribbles: 3 + playerId,
    dribblesWon: 2 + playerId,
    dribblesLost: 1,
    shots: 2,
    goals: 1,
    ...overrides,
  };
}

function historyRow(matchId: number, stats: PlayerFormHistoryRow["stats"]): PlayerFormHistoryRow {
  return { matchId, code: `M${matchId}`, startLocal: `2026-09-${String(matchId).padStart(2, "0")} 19:00`, stats };
}

describe("match stats competition rules", () => {
  it("allows player-level stats only to current members, field owners, and admins", () => {
    const roster = [
      { userId: 10, rsvp: "in" },
      { userId: 11, rsvp: "maybe" },
      { userId: 12, rsvp: "invited" },
    ];
    const canView = (viewer: { id: number; isAdmin: boolean; isGuest: boolean } | null, isFieldOwner = false) =>
      canViewMatchPlayerRows({ viewer, captainUserId: 20, isFieldOwner, roster });

    expect(canView({ id: 10, isAdmin: false, isGuest: false })).toBe(true);
    expect(canView({ id: 11, isAdmin: false, isGuest: false })).toBe(false);
    expect(canView({ id: 12, isAdmin: false, isGuest: false })).toBe(false);
    expect(canView({ id: 20, isAdmin: false, isGuest: false })).toBe(true);
    expect(canView({ id: 30, isAdmin: false, isGuest: false }, true)).toBe(true);
    expect(canView({ id: 40, isAdmin: true, isGuest: false })).toBe(true);
    expect(canView({ id: 10, isAdmin: false, isGuest: true })).toBe(false);
    expect(canView(null, true)).toBe(false);
  });

  it("requires two claimed players and ten claimed minutes for awards", () => {
    expect(competitionAwards([player(1)], [1])).toEqual([]);
    const awards = competitionAwards([
      player(1, { minutes: 9, goals: 4 }),
      player(2, { minutes: 15, goals: 2 }),
    ], [1, 2]);
    expect(awards.some((award) => award.key === "motm" && award.playerIds.includes(1))).toBe(false);
    expect(awards.some((award) => award.key === "goals" && award.playerIds.includes(1))).toBe(false);
  });

  it("shares tied awards and puts eligible closed-vote MOTM first", () => {
    const awards = competitionAwards([
      player(1, { minutes: 12, distanceKm: 8, goals: 2 }),
      player(2, { minutes: 18, distanceKm: 8, goals: 2 }),
      player(3, { minutes: 25, distanceKm: 7, goals: 1 }),
    ], [1, 2, 3]);
    expect(awards[0]).toEqual({ key: "motm", playerIds: [1, 2, 3], value: null });
    expect(awards.find((award) => award.key === "distance")?.playerIds).toEqual([1, 2]);
    expect(awards.find((award) => award.key === "goals")?.playerIds).toEqual([1, 2]);
  });

  it("uses only claimed players for factual callouts and returns at most three", () => {
    const callouts = competitionCallouts([
      player(1, { distanceKm: 9, topSpeedKmh: 32, touches: 90, goals: 4 }),
      player(2, { distanceKm: 6, topSpeedKmh: 25, touches: 70, goals: 2 }),
      player(3, { distanceKm: 4, topSpeedKmh: 22, touches: 40, goals: 1 }),
      player(4, { claimed: false, distanceKm: 40, topSpeedKmh: 50, touches: 300, goals: 20 }),
      player(5, { distanceKm: null, topSpeedKmh: null, touches: null, goals: null }),
    ]);
    expect(callouts).toHaveLength(3);
    expect(callouts.every((callout) => callout.leaderId !== 4 && callout.runnerUpId !== 4)).toBe(true);
    expect(callouts.some((callout) => callout.metric === "distanceKm" && callout.gap === 3)).toBe(true);
  });

  it("marks tied personal records and ignores unavailable metrics", () => {
    const current = player(1, { distanceKm: 7, topSpeedKmh: null, goals: 1 });
    const previous = [player(2, { distanceKm: 7, topSpeedKmh: 33, goals: 2 })];
    expect(personalBestMetrics(current, previous)).toContain("distanceKm");
    expect(personalBestMetrics(current, previous)).not.toContain("topSpeedKmh");
    expect(personalBestMetrics(current, previous)).not.toContain("goals");
  });

  it("averages the latest five matches and keeps bests across all history", () => {
    const row = (matchId: number, distanceKm: number, goals: number) => historyRow(matchId, {
      minutes: 30,
      distanceKm,
      topSpeedKmh: null,
      touches: 10,
      passesTried: null,
      passesCompleted: null,
      passesReceived: null,
      dribbles: null,
      dribblesWon: null,
      dribblesLost: null,
      shots: null,
      goals,
    });
    const form = playerForm([row(6, 6, 2), row(5, 5, 1), row(4, 4, 0), row(3, 3, 0), row(2, 2, 1), row(1, 20, 8)]);
    expect(form?.matchesUsed).toBe(5);
    expect(form?.averages.distanceKm).toBe(4);
    expect(form?.bests.distanceKm).toBe(20);
    expect(form?.averages.goals).toBe(0.8);
    expect(form?.lastFive.map((match) => match.matchId)).toEqual([6, 5, 4, 3, 2]);
  });
});