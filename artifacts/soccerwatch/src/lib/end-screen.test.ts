import { describe, it, expect } from "vitest";
import { choiceBody, clipShape, effectiveCard, formatStatValue, maxStatsFor, previewQuery, toggleStat } from "./end-screen";

const cards = [
  { kind: "player" as const, available: false },
  { kind: "match" as const, available: true },
  { kind: "signOff" as const, available: true },
];

describe("end screen choice", () => {
  it("uses the chosen card when it has something to show, else the first available", () => {
    expect(effectiveCard(cards, "signOff")).toBe("signOff");
    expect(effectiveCard(cards, "player")).toBe("match");
    expect(effectiveCard(cards, "auto")).toBe("match");
    expect(effectiveCard([], "auto")).toBeNull();
  });

  it("adds numbers in tap order, takes them off, and stops at the card's limit", () => {
    let picked = toggleStat([], "distance", 4);
    picked = toggleStat(picked, "goals", 4);
    expect(picked).toEqual(["distance", "goals"]);
    expect(toggleStat(picked, "distance", 4)).toEqual(["goals"]);
    expect(toggleStat(["goals", "distance", "passes"], "topSpeed", maxStatsFor("academy"))).toEqual(["goals", "distance", "passes"]);
    expect(maxStatsFor("player")).toBe(4);
  });

  it("sends {} for fully automatic, and only what was picked otherwise", () => {
    expect(choiceBody("auto", [])).toEqual({});
    expect(choiceBody("match", [])).toEqual({ card: "match" });
    expect(choiceBody("auto", ["goals"])).toEqual({ stats: ["goals"] });
    expect(previewQuery("player", ["goals", "shotsOnTarget"])).toBe("card=player&stats=goals%2CshotsOnTarget");
    expect(previewQuery("auto", [])).toBe("");
  });

  it("groups clips by shape the way the server does", () => {
    expect(clipShape("9:16")).toBe("9:16");
    expect(clipShape("16:9")).toBe("16:9");
    expect(clipShape(null)).toBe("16:9");
  });

  it("formats a stat value with its unit, and a dash when not measured", () => {
    expect(formatStatValue(24.32, 1, "km/h")).toBe("24.3 km/h");
    expect(formatStatValue(3, 0, "")).toBe("3");
    expect(formatStatValue(null, 0, "")).toBe("—");
  });
});
