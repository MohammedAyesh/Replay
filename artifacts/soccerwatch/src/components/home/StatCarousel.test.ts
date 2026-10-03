import { describe, expect, it } from "vitest";

import { tileCopies } from "@/i18n/stat-tile-strings";
import { slideIndex } from "./StatCarousel";

describe("stat carousel", () => {
  it("knows which slide is showing, in either direction", () => {
    expect(slideIndex(0, 330, 5)).toBe(0);
    expect(slideIndex(340, 330, 5)).toBe(1);
    expect(slideIndex(-660, 330, 5)).toBe(2); // RTL scrolls negative
    expect(slideIndex(9999, 330, 5)).toBe(4);
    expect(slideIndex(100, 0, 5)).toBe(0);
  });
});

describe("the word beside the big number", () => {
  it("is singular or plural in English", () => {
    expect(tileCopies.en.bigUnit("passesCompleted", 17)).toBe("passes");
    expect(tileCopies.en.bigUnit("goals", 1)).toBe("goal");
    expect(tileCopies.en.bigUnit("distanceKm", 4.8)).toBe("km");
  });

  it("follows Arabic counting: 1 and 11+ singular, 2 dual, 3 to 10 plural", () => {
    expect(tileCopies.ar.bigUnit("passesCompleted", 17)).toBe("تمريرة");
    expect(tileCopies.ar.bigUnit("passesCompleted", 2)).toBe("تمريرتين");
    expect(tileCopies.ar.bigUnit("passesCompleted", 6)).toBe("تمريرات");
    expect(tileCopies.ar.bigUnit("goals", 1)).toBe("هدف");
  });
});
