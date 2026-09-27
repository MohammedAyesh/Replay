import { describe, expect, it } from "vitest";
import {
  metricDeltaDirection,
  podiumPlaces,
  rankCompetitionPlayers,
  visibleLeaderboardRows,
  type CompetitionLeaderboardPlayer,
} from "./competition-leaderboard";

function player(playerId: number, distanceKm: number): CompetitionLeaderboardPlayer {
  return {
    playerId,
    name: `Player ${playerId}`,
    distanceKm,
    topSpeedKmh: null,
    touches: null,
    passesCompleted: null,
    dribblesWon: null,
    goals: null,
  };
}

describe("competition leaderboard presentation", () => {
  it("orders the podium 2nd, 1st, 3rd while keeping the viewer in true rank order", () => {
    const players = [player(1, 10), player(2, 10), player(3, 8), player(4, 5)];
    const ranked = rankCompetitionPlayers(players, "distanceKm", 3);
    const places = podiumPlaces(ranked.sorted);

    expect(places.map((slot) => slot.player?.playerId)).toEqual([2, 1, 3]);
    expect(ranked.sorted.map((entry) => entry.playerId)).toEqual([1, 2, 3, 4]);
    expect(ranked.sorted.map((entry) => ranked.ranks.get(entry.playerId))).toEqual([1, 1, 3, 4]);
    expect(ranked.sorted.indexOf(ranked.viewer!)).toBe(2);
    expect(ranked.above?.playerId).toBe(2);
  });

  it("uses the closest better-ranked player as the viewer's player above", () => {
    const players = [
      player(1, 50),
      player(2, 40),
      player(3, 30),
      player(4, 20),
      player(5, 10),
    ];
    const ranked = rankCompetitionPlayers(players, "distanceKm", 5);

    expect(ranked.viewerRank).toBe(5);
    expect(ranked.above?.playerId).toBe(4);
  });

  it("keeps the top eight and pins an out-of-range viewer after the divider", () => {
    const players = Array.from({ length: 10 }, (_, index) => player(index + 1, 20 - index));
    const ranked = rankCompetitionPlayers(players, "distanceKm", 10);
    const visible = visibleLeaderboardRows(ranked.sorted, 10);

    expect(visible.topRows.map((entry) => entry.playerId)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(visible.pinnedViewer?.playerId).toBe(10);
  });

  it("shows a delta direction only when a comparable average exists", () => {
    expect(metricDeltaDirection(12, 10)).toBe("up");
    expect(metricDeltaDirection(8, 10)).toBe("down");
    expect(metricDeltaDirection(10, 10)).toBeNull();
    expect(metricDeltaDirection(10, null)).toBeNull();
    expect(metricDeltaDirection(null, 10)).toBeNull();
  });
});