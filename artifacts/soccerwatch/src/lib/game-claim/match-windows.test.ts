import { describe, expect, it } from "vitest";
import { matchBenchRanges, type ClaimMatchWindow, type ClaimTeamSwitch } from "./match-windows";

const match = (overrides: Partial<ClaimMatchWindow> = {}): ClaimMatchWindow => ({
  code: "match-a",
  startSeconds: 0,
  endSeconds: 60,
  rosterTeam: "A",
  games: [{ startSeconds: 0, endSeconds: 60, teamX: "A", teamY: "B" }],
  playerTeamSpans: [],
  ...overrides,
});

const span = (overrides: Partial<ClaimMatchWindow["playerTeamSpans"][number]> = {}) => ({
  id: 1,
  fromSeconds: 0,
  toSeconds: 60,
  team: "A" as const,
  source: "captain",
  createdAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

describe("matchBenchRanges", () => {
  it("keeps a player benched only until a later span puts them on a playing side", () => {
    expect(matchBenchRanges(match({
      rosterTeam: "C",
      playerTeamSpans: [span({ fromSeconds: 30, team: "A" })],
    }), [])).toEqual([[0, 30]]);
  });

  it("lets manual spans overrule claim switches", () => {
    const switches: ClaimTeamSwitch[] = [{ atSeconds: 20, teamChanged: true, team: "B", matchCode: "match-a" }];
    expect(matchBenchRanges(match({
      playerTeamSpans: [span({ fromSeconds: 40, team: "C", source: "captain" })],
    }), switches)).toEqual([[40, 60]]);
  });

  it("does not treat a side change as sitting out when no games are configured", () => {
    const switches: ClaimTeamSwitch[] = [{ atSeconds: 20, teamChanged: true, team: "B", matchCode: "match-a" }];
    expect(matchBenchRanges(match({ games: [] }), switches)).toEqual([]);
  });

  it("marks an explicit sat-out span as bench time", () => {
    expect(matchBenchRanges(match({
      games: [],
      playerTeamSpans: [span({ fromSeconds: 15, toSeconds: 35, team: null, source: "self" })],
    }), [])).toEqual([[15, 35]]);
  });

  it("does not apply a switch scoped to a different booking", () => {
    const switches: ClaimTeamSwitch[] = [{ atSeconds: 20, teamChanged: true, team: "C", matchCode: "match-b" }];
    expect(matchBenchRanges(match(), switches)).toEqual([]);
  });
});