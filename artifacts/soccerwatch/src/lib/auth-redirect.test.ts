import { describe, expect, it } from "vitest";
import { getPostAuthLanding, isParentOnboardingRedirect } from "./auth-redirect";
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
});
