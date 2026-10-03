import { describe, expect, it } from "vitest";
import {
  authPathWithReturn,
  findBackTarget,
  findPath,
  matchReportPath,
  previousInAppLocation,
  recordInAppLocation,
  resolveFindMatchCode,
} from "./find-nav";

describe("links into Find yourself", () => {
  it("passes the match when it is known", () => {
    expect(findPath(42, "AB12")).toBe("/find/42?match=AB12");
    expect(findPath(42, "a b&c")).toBe("/find/42?match=a%20b%26c");
    expect(findPath(42, null)).toBe("/find/42");
    expect(findPath(42)).toBe("/find/42");
  });

  it("finishes at the match report, or the player's matches without one", () => {
    expect(matchReportPath("AB12")).toBe("/m/AB12");
    expect(matchReportPath(null)).toBe("/matches");
  });
});

describe("sign up / sign in from Find yourself", () => {
  it("comes back to the exact /find URL, query included", () => {
    expect(authPathWithReturn("sign-up", "/find/42?match=AB12")).toBe("/sign-up?redirect_url=%2Ffind%2F42%3Fmatch%3DAB12");
    expect(authPathWithReturn("sign-in", "/find/42")).toBe("/sign-in?redirect_url=%2Ffind%2F42");
  });

  it("round-trips through the redirect param", () => {
    const href = authPathWithReturn("sign-in", "/find/7?match=X1&kit=red");
    const back = new URLSearchParams(href.split("?")[1]).get("redirect_url");
    expect(back).toBe("/find/7?match=X1&kit=red");
  });
});

describe("back / close on Find yourself", () => {
  it("goes back in history after arriving from another app page", () => {
    expect(findBackTarget("/m/AB12", "AB12")).toEqual({ kind: "history" });
    expect(findBackTarget("/home", null)).toEqual({ kind: "history" });
    expect(findBackTarget("/matches?tab=recent", null)).toEqual({ kind: "history" });
  });

  it("goes to the match when opened directly and the match is known", () => {
    expect(findBackTarget(null, "AB12")).toEqual({ kind: "path", path: "/m/AB12" });
  });

  it("goes to the player's matches when opened directly without a match", () => {
    expect(findBackTarget(null, null)).toEqual({ kind: "path", path: "/matches" });
  });

  it("never sends the player back into sign-in, onboarding or another /find", () => {
    for (const previous of ["/sign-in", "/sign-up/verify", "/onboarding", "/consent", "/", "/find/41", "/find-quick/41"]) {
      expect(findBackTarget(previous, "AB12")).toEqual({ kind: "path", path: "/m/AB12" });
    }
    // A page whose name merely starts like an auth page is still an app page.
    expect(findBackTarget("/sign-inside", null)).toEqual({ kind: "history" });
  });
});

describe("the match a /find visit is about", () => {
  const matches = [{ code: "A" }, { code: "B" }];
  it("prefers the link's match, then the claim's single choice, then the only match", () => {
    expect(resolveFindMatchCode({ requested: "Z", choices: ["A"], matches })).toBe("Z");
    expect(resolveFindMatchCode({ requested: null, choices: ["B"], matches })).toBe("B");
    expect(resolveFindMatchCode({ requested: null, choices: ["A", "B"], matches })).toBeNull();
    expect(resolveFindMatchCode({ requested: null, choices: [], matches: [{ code: "C" }] })).toBe("C");
    expect(resolveFindMatchCode({ requested: null, choices: [], matches })).toBeNull();
  });
});

describe("in-app navigation trail", () => {
  it("remembers the page before this one and ignores repeats", () => {
    recordInAppLocation("/m/AB12");
    recordInAppLocation("/find/42");
    recordInAppLocation("/find/42");
    expect(previousInAppLocation()).toBe("/m/AB12");
  });
});
