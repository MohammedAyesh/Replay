import { describe, expect, it } from "vitest";
import { teamAtTime, type TeamSpanAtTime } from "./matchTeamSpans";

const span = (overrides: Partial<TeamSpanAtTime>) => ({
  id: 1,
  fromOffsetSec: 0,
  toOffsetSec: 600,
  team: "A" as const,
  source: "claim" as const,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  ...overrides,
});

describe("teamAtTime", () => {
  it("uses half-open coverage and falls back to the roster team when uncovered", () => {
    const s = span({});
    expect(teamAtTime("C", [s], 0)).toBe("A");
    expect(teamAtTime("C", [s], 600)).toBe("C");
  });

  it("preserves an explicit sat-out answer instead of falling back", () => {
    expect(teamAtTime("A", [span({ team: null })], 120)).toBeNull();
  });

  it("prefers captain/self spans over claims, including an intentional sit-out", () => {
    expect(teamAtTime("A", [
      span({ id: 1, team: "A" }),
      span({ id: 2, source: "captain", team: null }),
    ], 100)).toBeNull();
  });

  it("uses the latest covering span within the same priority", () => {
    expect(teamAtTime("A", [
      span({ id: 1, team: "A" }),
      span({ id: 2, team: "B", createdAt: new Date("2026-01-02T00:00:00Z") }),
    ], 100)).toBe("B");
  });
});