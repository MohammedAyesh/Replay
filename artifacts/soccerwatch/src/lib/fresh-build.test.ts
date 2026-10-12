import { describe, expect, it } from "vitest";

import { bundleIn, isFindPath, mayCheckForBuild, shouldReload } from "./fresh-build";

describe("fresh build", () => {
  it("finds the entry bundle in the published HTML", () => {
    expect(bundleIn('<script type="module" crossorigin src="/assets/index-D0NsbHlf.js"></script>')).toBe("/assets/index-D0NsbHlf.js");
    expect(bundleIn("<html></html>")).toBeNull();
  });

  it("reloads once for a newer build and never loops", () => {
    expect(shouldReload("/assets/index-old.js", "/assets/index-new.js", null)).toBe(true);
    expect(shouldReload("/assets/index-old.js", "/assets/index-new.js", "/assets/index-new.js")).toBe(false);
    expect(shouldReload("/assets/index-new.js", "/assets/index-new.js", null)).toBe(false);
    expect(shouldReload(null, "/assets/index-new.js", null)).toBe(false);
    expect(shouldReload("/assets/index-old.js", null, null)).toBe(false);
  });

  it("checks again only after five minutes and recognizes /find routes", () => {
    expect(mayCheckForBuild(1_000, 1_000 + 5 * 60 * 1000)).toBe(true);
    expect(mayCheckForBuild(1_000, 1_000 + 5 * 60 * 1000 - 1)).toBe(false);
    expect(isFindPath("/find/393")).toBe(true);
    expect(isFindPath("/find-quick/393")).toBe(false);
    expect(isFindPath("/soccerwatch/find/393", "/soccerwatch/")).toBe(true);
  });
});
