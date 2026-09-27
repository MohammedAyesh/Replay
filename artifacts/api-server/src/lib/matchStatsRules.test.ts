import { describe, expect, it } from "vitest";
import {
  canViewMatchPlayerRows,
  competitionAwards,
  competitionCallouts,
  historyBeforeMatch,
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

  it("requires at least three successful dribbles for the Magician award", () => {
    const belowThreshold = competitionAwards([
      player(1, { dribblesWon: 2 }),
      player(2, { dribblesWon: 1 }),
    ]);
    expect(belowThreshold.some((award) => award.key === "dribbles")).toBe(false);

    const atThreshold = competitionAwards([
      player(1, { dribblesWon: 3 }),
      player(2, { dribblesWon: 2 }),
    ]);
    expect(atThreshold.find((award) => award.key === "dribbles")?.playerIds).toEqual([1]);
  });

  it("shares tied awards and puts eligible closed-vote MOTM first", () => {
    const awards = competitionAwards([
      player(1, { minutes: 12, distanceKm: 8, goals: 2 }),
      player(2, { minutes: 18, distanceKm: 8, goals: 2 }),
      player(3, { minutes: 25, distanceKm: 7, goals: 1 }),
    ], [1, 2, 3]);
    expect(awards[0]).toEqual({ key: "motm", playerIds: [1, 2, 3], value: null, personalBest: false });
    expect(awards.find((award) => award.key === "distance")?.playerIds).toEqual([1, 2]);
    expect(awards.find((award) => award.key === "goals")?.playerIds).toEqual([1, 2]);
  });

  it("builds viewer-focused callouts from claimed player rows, ordered by relative margin", () => {
    const callouts = competitionCallouts([
      player(1, { team: "A", distanceKm: 8, topSpeedKmh: 29, dribblesWon: 4 }),
      player(2, { team: "A", distanceKm: 7, topSpeedKmh: 30.2, dribblesWon: 3 }),
      player(3, { team: "B", distanceKm: 5, topSpeedKmh: 28, dribblesWon: 8 }),
      player(4, { team: "A", distanceKm: 4, topSpeedKmh: 25, dribblesWon: 1 }),
      player(5, { claimed: false, distanceKm: 40, topSpeedKmh: 50, dribblesWon: 20 }),
    ], 1);
    expect(callouts).toHaveLength(3);
    expect(callouts[0]).toEqual({ kind: "team-dribbles-lead" });
    expect(callouts[1]).toEqual({ kind: "outran", outran: 3, total: 3 });
    expect(callouts[2]).toEqual({ kind: "speed-beaten", otherPlayerId: 2, gap: 1.2 });
    expect(competitionCallouts([player(1, { claimed: false })], 1)).toEqual([]);
    expect(competitionCallouts([player(1)], null)).toEqual([]);
    expect(competitionCallouts([
      player(1, { team: "A", dribblesWon: 4 }),
      player(2, { team: "A", dribblesWon: null }),
    ], 1).some((callout) => callout.kind === "team-dribbles-lead")).toBe(false);
  });

  it("compares personal bests only with earlier cached matches and gives first matches no PB", () => {
    const current = player(1, { distanceKm: 7, topSpeedKmh: null, goals: 1 });
    const earlier = historyRow(3, player(2, { distanceKm: 7, topSpeedKmh: 33, goals: 2 }));
    const later = historyRow(20, player(3, { distanceKm: 40, topSpeedKmh: 50, goals: 20 }));
    const priorRows = historyBeforeMatch([later, earlier], "2026-09-15 20:00");
    expect(priorRows.map((row) => row.matchId)).toEqual([3]);
    expect(personalBestMetrics(current, priorRows.map((row) => row.stats))).toContain("distanceKm");
    expect(personalBestMetrics(current, [])).toEqual([]);
    expect(personalBestMetrics(current, [player(2, { distanceKm: null })])).not.toContain("distanceKm");
    expect(personalBestMetrics(current, [player(2, { distanceKm: 7, topSpeedKmh: 33, goals: 2 })])).not.toContain("topSpeedKmh");
    expect(personalBestMetrics(current, [player(2, { distanceKm: 7, topSpeedKmh: 33, goals: 2 })])).not.toContain("goals");
  });

  it("marks an award as a personal best when its winning value sets the player's PB", () => {
    const awards = competitionAwards([
      player(1, { distanceKm: 8, personalBestMetrics: ["distanceKm"] }),
      player(2, { distanceKm: 6 }),
    ]);
    expect(awards.find((award) => award.key === "distance")?.personalBest).toBe(true);
    expect(awards.find((award) => award.key === "speed")?.personalBest).toBe(false);
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