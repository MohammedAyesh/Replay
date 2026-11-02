import { describe, expect, it } from "vitest";
import { combine, METRICS, ratingsFor } from "@/lib/academy-match-metrics";
import { aggregatePlayers } from "@/components/academy-console/matches-section";
import { seasonVsSquad } from "@/pages/academy-match";
import type { AcademyPlayerStats, PlayerStatsRow } from "@/lib/academy-matches-api";

function stats(playerId: number, over: Partial<AcademyPlayerStats> = {}): AcademyPlayerStats {
  return {
    playerId, rosterPlayerId: `p${playerId}`, minutes: 40, distanceKm: 3, topSpeedKmh: 22, touches: 30,
    passesTried: 20, passesCompleted: 15, passesReceived: 12, dribbles: 4, dribblesWon: 2, dribblesLost: 2, shots: 1, goals: 0, ...over,
  };
}

function row(sessionId: number, playerId: number, over: Partial<AcademyPlayerStats> = {}): PlayerStatsRow {
  return {
    playerId, playerName: `P${playerId}`, squadName: "U12", jerseyNumber: playerId, sessionId, startsAt: "2026-10-01T15:00:00Z",
    type: "match", opponent: null, ownScore: null, opponentScore: null, published: true, stats: stats(playerId, over),
  };
}

describe("academy match metrics", () => {
  it("combines averages, bests and totals and skips missing values", () => {
    expect(combine([1, null, 3], "avg")).toBe(2);
    expect(combine([1, null, 3], "max")).toBe(3);
    expect(combine([1, null, 3], "sum")).toBe(4);
    expect(combine([null], "sum")).toBeNull();
  });

  it("only gives pass accuracy from three passes up", () => {
    const accuracy = METRICS.find((m) => m.key === "accuracy")!;
    expect(accuracy.value(stats(1, { passesTried: 2, passesCompleted: 2 }))).toBeNull();
    expect(accuracy.value(stats(1, { passesTried: 4, passesCompleted: 3 }))).toBe(75);
  });

  it("rates three or more players and nobody below that", () => {
    const two = [1, 2].map((id) => ({ playerId: id, name: "", stats: stats(id) }));
    expect(ratingsFor(two).size).toBe(0);
    const three = [1, 2, 3].map((id) => ({ playerId: id, name: "", stats: stats(id, { distanceKm: id }) }));
    const ratings = ratingsFor(three);
    expect(ratings.size).toBe(3);
    expect(ratings.get(3)!).toBeGreaterThan(ratings.get(1)!);
  });

  it("aggregates each player across matches: minutes and goals summed, top speed is the best", () => {
    const players = aggregatePlayers([
      row(1, 1, { topSpeedKmh: 20, goals: 1 }), row(1, 2), row(1, 3),
      row(2, 1, { topSpeedKmh: 25, goals: 2 }), row(2, 2),
    ]);
    const p1 = players.find((p) => p.playerId === 1)!;
    expect(p1.matches).toBe(2);
    expect(p1.values.minutes).toBe(80);
    expect(p1.values.goals).toBe(3);
    expect(p1.values.topSpeed).toBe(25);
    expect(players.find((p) => p.playerId === 3)!.matches).toBe(1);
  });

  it("puts a child's season next to the squad average of the same matches", () => {
    const season = seasonVsSquad({
      player: { id: 1, name: "P1" },
      matches: [
        { sessionId: 1, startsAt: "", opponent: null, ownScore: null, opponentScore: null, stats: stats(1, { distanceKm: 4 }), squad: [stats(1, { distanceKm: 4 }), stats(2, { distanceKm: 2 })] },
        { sessionId: 2, startsAt: "", opponent: null, ownScore: null, opponentScore: null, stats: stats(1, { distanceKm: 6 }), squad: [stats(2, { distanceKm: 2 })] },
      ],
    });
    expect(season.own.distance).toBe(5);
    expect(season.squad.distance).toBe(3.5);
  });
});
