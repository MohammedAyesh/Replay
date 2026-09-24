import { describe, expect, it } from "vitest";
import { isExcludedBunnyVideoTitle } from "./bunny";

describe("Bunny library video filtering", () => {
  it("excludes liveclip_ titles case-insensitively", () => {
    expect(isExcludedBunnyVideoTitle("liveclip_abc")).toBe(true);
    expect(isExcludedBunnyVideoTitle("LIVECLIP_abc")).toBe(true);
    expect(isExcludedBunnyVideoTitle("LiveClip_2026-08-03")).toBe(true);
  });

  it("keeps ordinary titles and non-string values", () => {
    expect(isExcludedBunnyVideoTitle("cam1_2026-08-03_18:00")).toBe(false);
    expect(isExcludedBunnyVideoTitle("liveclip")).toBe(false);
    expect(isExcludedBunnyVideoTitle(null)).toBe(false);
    expect(isExcludedBunnyVideoTitle(undefined)).toBe(false);
  });
});