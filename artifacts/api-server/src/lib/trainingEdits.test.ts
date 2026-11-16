import { describe, expect, it } from "vitest";
import { gamesForSegments, normaliseSegments, withTrainingEdits } from "./trainingEdits";
import { isTrainingBlock } from "./rosterTraining";

describe("normaliseSegments", () => {
  it("orders, trims overlaps, drops slivers, clamps to the video and joins same-kind neighbours", () => {
    expect(normaliseSegments([
      { start: 300, end: 500, label: "game" },
      { start: 0, end: 120, label: "warm-up" },
      { start: 100, end: 310, label: "drill" },
      { start: 500, end: 500.5, label: "break" },
      { start: 500.5, end: 900, label: "game" },
      { start: 950, end: 2000, label: "team talk" },
    ], 1200)).toEqual([
      { start: 0, end: 100, label: "warm-up" },
      { start: 100, end: 300, label: "drill" },
      { start: 300, end: 900, label: "game" },
      { start: 950, end: 1200, label: "team talk" },
    ]);
  });
});

describe("gamesForSegments", () => {
  const g = (start: number, end: number, teams: string[]) => ({ start, end, teams, teamNames: teams, resting: [], players: [{ number: "7" }], teamTotals: {} });
  it("keeps the analysis's games inside the coach's game parts, clipped, and adds an empty one where it had none", () => {
    const games = gamesForSegments(
      [{ start: 100, end: 400, label: "game" }, { start: 400, end: 500, label: "drill" }, { start: 600, end: 700, label: "game" }],
      [g(90, 250, ["a", "b"]), g(250, 420, ["a", "c"]), g(450, 520, ["b", "c"])],
    );
    expect(games.map((x) => [x.start, x.end, x.teams])).toEqual([[100, 250, ["a", "b"]], [250, 400, ["a", "c"]], [600, 700, []]]);
  });
});

describe("withTrainingEdits", () => {
  const base = { groups: [{ id: "1" }], segments: [{ start: 0, end: 60, label: "drill" }], games: [], ground: null };
  it("leaves the analysis's split alone without edits, and is null without either", () => {
    expect(withTrainingEdits(base, undefined, () => base)).toMatchObject({ edited: false, segments: base.segments });
    expect(withTrainingEdits(null, undefined, () => base)).toBeNull();
  });
  it("puts the coach's parts over it, keeping the groups, and gives a session with no split one", () => {
    const edits = { segments: [{ start: 0, end: 60, label: "warm-up" }], at: "2026-11-16T15:00:00Z" };
    expect(withTrainingEdits(base, edits, () => base)).toMatchObject({ edited: true, groups: base.groups, segments: edits.segments, analysisSegments: base.segments });
    expect(withTrainingEdits(null, edits, () => ({ groups: [], segments: [], games: [], ground: null }))).toMatchObject({ edited: true, segments: edits.segments, analysisSegments: [] });
  });
});

describe("isTrainingBlock", () => {
  it("wants segments and games", () => {
    expect(isTrainingBlock({ segments: [{ start: 0, end: 5, label: "game" }], games: [] })).toBe(true);
    expect(isTrainingBlock({ segments: [] })).toBe(false);
    expect(isTrainingBlock({ segments: [{ start: "x", end: 5, label: "game" }], games: [] })).toBe(false);
  });
});
