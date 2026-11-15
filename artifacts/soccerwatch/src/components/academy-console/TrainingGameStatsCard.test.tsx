import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { MatchesStrings } from "@/i18n/matches-strings";
import { parseTrainingSession } from "@/lib/academy-training";
import { TrainingGameStatsCard } from "./TrainingGameStatsCard";
import { TrainingSessionTimeline } from "./TrainingSessionTimeline";

const copy = {
  locale: "en",
  gameStats: {
    title: "Game stats",
    games: "Games",
    sessionTotals: "Session totals",
    chooseGame: "Choose a game",
    game: (n: number, teams: string) => `Game ${n}${teams ? ` · ${teams}` : ""}`,
    noGames: "No game breakdown is available for this session.",
    noPlayers: "No shirt-number stats were recorded for this game.",
    number: "No.",
    minutes: "Min",
    distance: "Distance (m)",
    pace: "m/min",
    topSpeed: "Top speed (km/h)",
    sprints: "Sprints",
    touches: "Touches",
    keeper: "GK",
    shared: "Players may share this shirt number.",
    teamTotals: "Team totals",
    numberedShare: (share: number) => `${share}% of this team's time is from numbered players`,
    estimate: "Ground distances and speeds are estimates; this pitch is not calibrated.",
  },
  sessionTimeline: {
    title: "Session timeline",
    labels: {
      game: "Game",
      "multi-ball drill": "Multi-ball drill",
      "shooting / queue drill": "Shooting / queue drill",
      "warm-up": "Warm-up",
      "team talk": "Team talk",
      break: "Break",
      drill: "Drill",
      "adult game": "Other group",
      adults: "Other group",
      empty: "Empty",
    },
    gameTitle: (n: number, teams: string) => `Game ${n}${teams ? ` · ${teams}` : ""}`,
  },
} as unknown as MatchesStrings & { locale: "ar" | "en" };

const rawTraining = {
  groups: [{ id: "blue", name: "Blue", torso: [54, 28, 19] }],
  segments: [
    { start: 0, end: 240, label: "warm-up" },
    { start: 240, end: 900, label: "game" },
    { start: 900, end: 960, label: "adults" },
  ],
  games: [{
    start: 240,
    end: 900,
    teams: ["blue"],
    teamNames: ["Blue"],
    resting: [],
    players: [
      { number: 7, team: "blue", minutes: 10, distance: 800, mPerMin: 80, topKmh: 22, sprints: 3, touches: 21, keeper: true, shared: true },
      { number: "7", team: "blue", minutes: 5, distance: 350, mPerMin: 70, topKmh: 20, sprints: 1, touches: 8, keeper: false, shared: true },
      { number: "Player 4", team: "blue", minutes: 8, distance: 500, mPerMin: 62, topKmh: 18, sprints: 1, touches: 10, keeper: false, shared: false },
    ],
    teamTotals: { blue: { minutes: 20, distance: 1500, touches: 31, numberedShare: 0.8 } },
  }],
  ground: "approximate: no calibration",
};

describe("training game views", () => {
  it("shows only shirt-number rows, keeper/shared indicators, totals, and approximate-ground note", () => {
    const training = parseTrainingSession(rawTraining);
    const html = renderToStaticMarkup(createElement(TrainingGameStatsCard, { training, copy }));
    expect(html).toContain("#7");
    expect(html).toContain("GK");
    expect(html.match(/#7/g)).toHaveLength(1);
    expect(html).toContain("Players may share this shirt number.");
    expect(html).toContain("80% of this team&#x27;s time is from numbered players");
    expect(html).toContain("Ground distances and speeds are estimates");
    expect(html).not.toContain("Player 4");
  });

  it("labels segments with recording-clock times and maps adult segments to Other group", () => {
    const training = parseTrainingSession(rawTraining);
    const onSeek = vi.fn();
    const html = renderToStaticMarkup(createElement(TrainingSessionTimeline, {
      segments: training.segments,
      games: training.games,
      groups: training.groups,
      recordingDate: "2026-11-01",
      recordingTimeSlot: "17:00–18:00",
      copy,
      onSeek,
    }));
    expect(html).toContain("17:00:00");
    expect(html).toContain("17:04:00");
    expect(html).toContain("Other group");
    expect(html).toContain("training-segments-timeline");
  });
});
