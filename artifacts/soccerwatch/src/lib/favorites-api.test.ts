import { describe, expect, it } from "vitest";
import { starredFirst, toggled } from "./favorites-api";
import { favoriteStrings } from "@/i18n/favorite-strings";

describe("favourites", () => {
  it("puts starred items first, newest star first, and keeps the rest in order", () => {
    const items = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }];
    expect(starredFirst(items, (x) => x.id, ["4", "2"]).map((x) => x.id)).toEqual([4, 2, 1, 3]);
    expect(starredFirst(items, (x) => x.id, []).map((x) => x.id)).toEqual([1, 2, 3, 4]);
    expect(starredFirst(items, (x) => x.id, ["99"]).map((x) => x.id)).toEqual([1, 2, 3, 4]);
    expect(starredFirst(["match", "player", "training"], (t) => `studio:${t}`, ["studio:training"])).toEqual(["training", "match", "player"]);
  });
  it("stars to the front and unstars without touching other kinds", () => {
    const f = { template: ["a"], clip: ["1"], project: [] };
    expect(toggled(f, "template", "b", true)).toEqual({ template: ["b", "a"], clip: ["1"], project: [] });
    expect(toggled(f, "template", "a", false)).toEqual({ template: [], clip: ["1"], project: [] });
    expect(toggled(f, "clip", "1", true).clip).toEqual(["1"]);
  });
  it("has every string in Arabic", () => {
    expect(Object.keys(favoriteStrings.ar)).toEqual(Object.keys(favoriteStrings.en));
    expect(Object.keys(favoriteStrings.ar.tabs)).toEqual(["clips", "quick"]);
  });
});
