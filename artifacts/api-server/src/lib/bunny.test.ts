import { describe, expect, it } from "vitest";
import { isBunnyVideoPlayable, isExcludedBunnyVideoTitle } from "./bunny";

describe("isBunnyVideoPlayable", () => {
  it.each([
    { name: "status missing", video: {}, expected: true },
    { name: "status 4", video: { status: 4 }, expected: true },
    { name: "status 3 with resolutions", video: { status: 3, availableResolutions: "720p" }, expected: true },
    { name: "status 3 with empty resolutions", video: { status: 3, availableResolutions: "" }, expected: false },
    { name: "status 3 without resolutions", video: { status: 3 }, expected: false },
    { name: "status 0", video: { status: 0, availableResolutions: "720p" }, expected: false },
    { name: "status 1", video: { status: 1, availableResolutions: "720p" }, expected: false },
    { name: "status 2", video: { status: 2, availableResolutions: "720p" }, expected: false },
    { name: "status 5", video: { status: 5, availableResolutions: "720p" }, expected: false },
    { name: "status 6", video: { status: 6, availableResolutions: "720p" }, expected: false },
  ])("$name", ({ video, expected }) => {
    expect(isBunnyVideoPlayable(video)).toBe(expected);
  });
});

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