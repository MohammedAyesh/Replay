import { describe, expect, it } from "vitest";
import { hasActiveOwnerHold, shouldShowAdminVarPlayer } from "./AdminVarTab";

describe("AdminVarTab state helpers", () => {
  it("only treats a non-empty stillOnFor array as an owner hold", () => {
    expect(hasActiveOwnerHold([{ title: "Owner booking" }])).toBe(true);
    expect(hasActiveOwnerHold([])).toBe(false);
    expect(hasActiveOwnerHold(null)).toBe(false);
    expect(hasActiveOwnerHold(undefined)).toBe(false);
  });

  it("shows the player only when VAR is on and live", () => {
    expect(shouldShowAdminVarPlayer(true, true)).toBe(true);
    expect(shouldShowAdminVarPlayer(true, false)).toBe(false);
    expect(shouldShowAdminVarPlayer(false, true)).toBe(false);
    expect(shouldShowAdminVarPlayer(undefined, true)).toBe(false);
  });
});