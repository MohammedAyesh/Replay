import { describe, expect, it } from "vitest";
import { kitColourKey, plausibleStatRows } from "./igFieldPosts";

const team = (over: Partial<Parameters<typeof plausibleStatRows>[0] & object> = {}) => ({
  sides: ["a", "b"], measured: [true, true], possessionPercent: [54, 46], shots: [7, 5], dribblesWon: [9, 6], passesCompleted: [112, 98], ...over,
});

describe("match of the week: which stats rows are shown (2026-11-07)", () => {
  it("shows every row when the numbers hold up", () => {
    expect(plausibleStatRows(team())).toEqual([[54, 46], [7, 5], [9, 6], [112, 98]]);
  });

  it("leaves off a row that can't be right (the 28 Oct review: 34 v 24 shots, 459 v 451 passes)", () => {
    expect(plausibleStatRows(team({ shots: [34, 24], passesCompleted: [459, 451] }))).toEqual([[54, 46], null, [9, 6], null]);
    // Possession that doesn't add up, or one side barely touching the ball.
    expect(plausibleStatRows(team({ possessionPercent: [70, 20] }))[0]).toBeNull();
    expect(plausibleStatRows(team({ possessionPercent: [90, 10] }))[0]).toBeNull();
  });

  it("shows nothing when the sides weren't both measured", () => {
    expect(plausibleStatRows(team({ measured: [true, false] }))).toEqual([null, null, null, null]);
    expect(plausibleStatRows(null)).toEqual([null, null, null, null]);
  });
});

describe("the sides' names from their shirt colours", () => {
  it("names plain colours like the claim page does", () => {
    expect(kitColourKey("#f07a1a")).toBe("orange");
    expect(kitColourKey("#f2f2f2")).toBe("light");
    expect(kitColourKey("#111111")).toBe("dark");
    expect(kitColourKey("#1f4fd1")).toBe("blue");
    expect(kitColourKey("#5a1020")).toBe("maroon");
  });
});
