import { describe, expect, it } from "vitest";
import { isOwnerFootageTitle } from "./publicFootage";

describe("owner footage title filtering", () => {
  it("recognizes the new machine-readable owner title", () => {
    expect(isOwnerFootageTitle("cam1_owner-42_2026-09-22_23:00")).toBe(true);
    expect(isOwnerFootageTitle("cam1_owner-42_2026-09-22_23:00.mp4")).toBe(true);
  });

  it("keeps ordinary camera titles public-filterable", () => {
    expect(isOwnerFootageTitle("cam1_2026092219")).toBe(false);
    expect(isOwnerFootageTitle("cam1_Field_01_22092026_230000")).toBe(false);
  });
});