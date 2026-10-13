import { describe, expect, it } from "vitest";
import { isGuardianOnlyState } from "./auth";

describe("guardian-only auth identity", () => {
  it("requires an active guardian link and no player profile or academy player link", () => {
    expect(isGuardianOnlyState(true, false, null)).toBe(true);
    expect(isGuardianOnlyState(false, false, null)).toBe(false);
    expect(isGuardianOnlyState(true, true, null)).toBe(false);
    expect(isGuardianOnlyState(true, false, "forward")).toBe(false);
  });
});
