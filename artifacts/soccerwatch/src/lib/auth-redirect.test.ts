import { describe, expect, it } from "vitest";
import {
  getIncompleteProfileOnboardingRedirect,
  getPostAuthLanding,
  getRedirectPathFromSearchValue,
  isParentOnboardingRedirect,
} from "./auth-redirect";
import { isPublicStandalonePath } from "./public-paths";

describe("parent and guardian redirects", () => {
  it("sends guardian-only accounts to family view but keeps players at home", () => {
    expect(getPostAuthLanding(null, true)).toBe("/academy/me");
    expect(getPostAuthLanding(null, false)).toBe("/home");
  });

  it("keeps an explicit redirect ahead of guardian defaults", () => {
    expect(getPostAuthLanding("/matches?from=invite", true)).toBe("/matches?from=invite");
  });

  it("selects parent onboarding for family and invite redirects and exempts invite pages", () => {
    expect(isParentOnboardingRedirect("/academy/me?playerId=42")).toBe(true);
    expect(isParentOnboardingRedirect("/p/token")).toBe(true);
    expect(isParentOnboardingRedirect("/home")).toBe(false);
    expect(isPublicStandalonePath("/p/token")).toBe(true);
  });

  it("preserves an invited player through onboarding and its return path", () => {
    const invitedPlayerPath = "/academy/me?playerId=123";
    const onboardingUrl = getIncompleteProfileOnboardingRedirect(
      "/academy/me",
      "?playerId=123",
      "",
    );
    const onboardingSearch = new URL(onboardingUrl, "https://replay.local").search;

    expect(isParentOnboardingRedirect(invitedPlayerPath)).toBe(true);
    expect(new URLSearchParams(onboardingSearch).get("redirect_url")).toBe(invitedPlayerPath);
    expect(getRedirectPathFromSearchValue(onboardingSearch)).toBe(invitedPlayerPath);
  });

  it("retains URL fragments along with pathname and search", () => {
    const onboardingUrl = getIncompleteProfileOnboardingRedirect("/academy/me", "?playerId=123", "#family");
    const redirectUrl = new URLSearchParams(new URL(onboardingUrl, "https://replay.local").search).get("redirect_url");

    expect(redirectUrl).toBe("/academy/me?playerId=123#family");
  });
});
