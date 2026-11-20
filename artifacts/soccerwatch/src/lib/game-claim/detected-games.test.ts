import { describe, expect, it } from "vitest";
import {
  bookingsForDetectedGame,
  claimCoverageForWindow,
  claimWindowsForSelection,
  defaultDetectedGame,
  detectedGameTimeRange,
  detectedGamesFromProvenance,
} from "./detected-games";

const games = detectedGamesFromProvenance({
  phases: {
    sessions: [
      { start: 100, end: 220, spans: [[110, 190]], players: 12 },
      { start: 400, end: 520, spans: [[410, 470]], players: 10 },
      { start: 700, end: 900, spans: [[710, 880]], players: 14 },
    ],
  },
}, 1_000);

describe("detected game sessions", () => {
  it("uses the requested second-game threshold for exactly two sessions", () => {
    const first = { ...games[0], playedSeconds: 101 };
    const second = { ...games[1], playedSeconds: 99 };
    expect(defaultDetectedGame([first, second])?.key).toBe(first.key);
    expect(defaultDetectedGame([first, { ...second, playedSeconds: 101 }])?.key).toBe(second.key);
  });

  it("selects the longest-played game when three or more are detected", () => {
    expect(defaultDetectedGame(games)?.key).toBe(games[2].key);
  });

  it("maps a selected session to overlapping booking windows only", () => {
    const matches = [
      {
        code: "game-a",
        startSeconds: 0,
        endSeconds: 300,
        games: [{ startSeconds: 150, endSeconds: 200 }],
      },
      {
        code: "game-b",
        startSeconds: 300,
        endSeconds: 600,
        games: [{ startSeconds: 430, endSeconds: 500 }],
      },
    ];
    expect(bookingsForDetectedGame(matches, games[1])).toEqual(["game-b"]);
    expect(claimWindowsForSelection(matches, ["game-b"], [0, 600], games[1])).toEqual([[430, 500]]);
  });

  it("counts claimed coverage only inside the selected game and excludes off-pitch spans", () => {
    expect(claimCoverageForWindow(
      [{ fromFrame: 0, toFrame: 2_000 }],
      20,
      [20, 80],
      [{ fromSeconds: 40, toSeconds: 50 }],
    )).toBe(100);
    expect(claimCoverageForWindow(
      [{ fromFrame: 0, toFrame: 999 }],
      20,
      [20, 80],
    )).toBe(50);
  });

  it("formats a detected game's clock range in Amman across midnight", () => {
    expect(detectedGameTimeRange(
      { ...games[0], startSeconds: 3_600, endSeconds: 5_400 },
      "2026-11-20",
      "23:00",
      0,
      "en",
    )).toBe("00:00–00:30");
  });
});
