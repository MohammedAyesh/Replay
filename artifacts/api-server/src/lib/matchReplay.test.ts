import { describe, expect, it } from "vitest";
import { replaySideForGoal } from "./matchFeed";

const kits = {
  A: { lab: [10, 0, 0] as [number, number, number], measured: true },
  B: { lab: [60, 0, 0] as [number, number, number], measured: true },
  C: { lab: [110, 0, 0] as [number, number, number], measured: true },
};

describe("replaySideForGoal", () => {
  it("maps three-team goals to the active game's actual sides", () => {
    expect(replaySideForGoal(3, { teamX: "B", teamY: "C" }, kits, null, [60, 0, 0])).toBe("B");
    expect(replaySideForGoal(3, { teamX: "B", teamY: "C" }, kits, null, [110, 0, 0])).toBe("C");
  });

  it("does not guess a three-team side outside a configured game", () => {
    expect(replaySideForGoal(3, undefined, kits, { a: kits.A.lab, b: kits.B.lab }, kits.C.lab)).toBeNull();
  });

  it("keeps the existing A/B mapping for two-team matches", () => {
    expect(replaySideForGoal(2, undefined, kits, { a: kits.A.lab, b: kits.B.lab }, kits.B.lab)).toBe("B");
  });
});