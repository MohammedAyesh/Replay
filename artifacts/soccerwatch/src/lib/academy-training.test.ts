import { describe, expect, it } from "vitest";
import { aggregateTrainingGamePlayers, numberedSharePercent, parseTrainingSession } from "@/lib/academy-training";

const trainingFixture = {
  mode: "training",
  groups: [
    { id: "blue", name: "Blue", torso: [54, 28, 19] },
    { id: "yellow", name: "Yellow", torso: [220, 128, 128] },
  ],
  segments: [
    { start: 0, end: 240, label: "warm-up" },
    { start: 240, end: 900, label: "game" },
    { start: 900, end: 960, label: "adults" },
  ],
  games: [
    {
      start: 240,
      end: 900,
      teams: ["blue", "yellow"],
      teamNames: ["Blue", "Yellow"],
      resting: [],
      players: [
        { number: 7, team: "blue", minutes: 10, distance: 800, mPerMin: 80, topKmh: 22.4, sprints: 3, touches: 21, keeper: false, shared: false },
        { number: "9", team: "yellow", minutes: 9, distance: 690, mPerMin: 76.7, topKmh: 21.8, sprints: 2, touches: 18, keeper: true, shared: true },
        { number: "Player 4", team: "blue", minutes: 8, distance: 500, mPerMin: 62.5, topKmh: 18, sprints: 1, touches: 10, keeper: false, shared: false },
      ],
      teamTotals: {
        blue: { minutes: 20, distance: 1500, touches: 42, numberedShare: 0.8 },
        yellow: { minutes: 18, distance: 1350, touches: 37, numberedShare: 75 },
      },
    },
    {
      start: 960,
      end: 1500,
      teams: ["blue", "yellow"],
      teamNames: ["Blue", "Yellow"],
      resting: [],
      players: [
        { number: "7", team: "blue", minutes: 8, distance: 600, mPerMin: 75, topKmh: 23, sprints: 2, touches: 17, keeper: true, shared: true },
      ],
      teamTotals: {},
    },
  ],
  ground: "approximate: field has no pitch calibration",
};

describe("training session metadata", () => {
  it("parses the pipeline fixture, group swatches, segments, games and ground note", () => {
    const parsed = parseTrainingSession(trainingFixture);
    expect(parsed.groups).toEqual([
      { id: "blue", name: "Blue", color: expect.stringMatching(/^#[0-9a-f]{6}$/i) },
      { id: "yellow", name: "Yellow", color: expect.stringMatching(/^#[0-9a-f]{6}$/i) },
    ]);
    expect(parsed.segments).toEqual(trainingFixture.segments);
    expect(parsed.games[0]).toMatchObject({
      start: 240,
      end: 900,
      teams: ["blue", "yellow"],
      teamNames: ["Blue", "Yellow"],
      players: [
        { number: "7", team: "blue", minutes: 10, keeper: false, shared: false },
        { number: "9", team: "yellow", keeper: true, shared: true },
      ],
      teamTotals: {
        blue: { minutes: 20, distance: 1500, touches: 42, numberedShare: 0.8 },
        yellow: { numberedShare: 75 },
      },
    });
    expect(parsed.ground).toBe(trainingFixture.ground);
  });

  it("sums each shirt number per team across games and ignores non-shirt labels", () => {
    const parsed = parseTrainingSession(trainingFixture);
    expect(aggregateTrainingGamePlayers(parsed.games)).toEqual([
      { number: "7", team: "blue", minutes: 18, distance: 1400, mPerMin: 77.8, topKmh: 23, sprints: 5, touches: 38, keeper: true, shared: true },
      { number: "9", team: "yellow", minutes: 9, distance: 690, mPerMin: 76.7, topKmh: 21.8, sprints: 2, touches: 18, keeper: true, shared: true },
    ]);
    expect(numberedSharePercent(0.8)).toBe(80);
    expect(numberedSharePercent(75)).toBe(75);
  });
});
