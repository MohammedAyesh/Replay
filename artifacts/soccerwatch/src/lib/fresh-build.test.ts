import { describe, expect, it } from "vitest";

import { bundleIn, shouldReload } from "./fresh-build";

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
});
