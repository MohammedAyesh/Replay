import { describe, expect, it } from "vitest";
import { balanceOf, cancelQuote, changeQuote, depositFor, noShowQuote, policyOf, requirement, rulesSummary } from "./rules";

const base = policyOf({ depositMode: "deposit", depositFils: 5000, payAtField: true });
const money = (over: Partial<Parameters<typeof cancelQuote>[1]> = {}) => ({
  amountFils: 20000, paidFils: 0, dueOnlineFils: 0, feeFils: 0, startsAt: new Date(Date.now() + 48 * 3_600_000), changeCount: 0, status: "confirmed", ...over,
});
const online = { cliq: true, card: false };

describe("booking rules", () => {
  it("fills defaults and clamps a stored snapshot", () => {
    const p = policyOf({ depositPercent: 300, lateCancelMode: "nonsense", maxChanges: -2 });
    expect(p).toMatchObject({ depositMode: "full", depositPercent: 100, lateCancelMode: "refuse", maxChanges: 0, acceptCliq: true });
  });

  it("takes a percent deposit over a fixed one, never above the price", () => {
    expect(depositFor({ ...base, depositPercent: 25 }, 20000)).toBe(5000);
    expect(depositFor({ ...base, depositFils: 50000 }, 20000)).toBe(20000);
  });

  it("asks first-timers for a deposit and lets regulars pay at the field", () => {
    const p = { ...base, depositMode: "none" as const, newCustomerPolicy: "deposit" as const };
    expect(requirement(p, { played: 0, noShows: 0 }, 20000, online)).toMatchObject({ fieldAllowed: false, minimumOnlineFils: 5000, reason: "new_customer" });
    expect(requirement(p, { played: 3, noShows: 0 }, 20000, online)).toMatchObject({ fieldAllowed: true, minimumOnlineFils: 0, onlineDueFils: 0, reason: "standard" });
  });

  it("can't ask for money online when the field takes none", () => {
    const p = { ...base, acceptCliq: false, newCustomerPolicy: "full" as const };
    expect(requirement(p, { played: 0, noShows: 0 }, 20000, online)).toMatchObject({ fieldAllowed: true, minimumOnlineFils: 0 });
  });

  it("blocks or charges up front after a no-show", () => {
    expect(requirement({ ...base, noShowPolicy: "block" }, { played: 4, noShows: 1 }, 20000, online).blocked).toBe(true);
    expect(requirement({ ...base, noShowPolicy: "full" }, { played: 4, noShows: 1 }, 20000, online)).toMatchObject({ minimumOnlineFils: 20000, reason: "no_show" });
  });

  it("prices a late cancel by the field's rule, and the field cancelling costs nothing", () => {
    const late = money({ startsAt: new Date(Date.now() + 2 * 3_600_000), paidFils: 5000, dueOnlineFils: 5000 });
    expect(cancelQuote({ ...base, lateCancelMode: "refuse" }, late, "player").allowed).toBe(false);
    expect(cancelQuote({ ...base, lateCancelMode: "deposit" }, late, "player")).toMatchObject({ feeFils: 5000, refundFils: 0, owedFils: 0 });
    expect(cancelQuote({ ...base, lateCancelMode: "percent", lateCancelValue: 50 }, late, "player")).toMatchObject({ feeFils: 10000, refundFils: 0, owedFils: 5000 });
    expect(cancelQuote({ ...base, lateCancelMode: "fixed", lateCancelValue: 2000 }, late, "player")).toMatchObject({ feeFils: 2000, refundFils: 3000 });
    expect(cancelQuote({ ...base, lateCancelMode: "fixed", lateCancelValue: 2000 }, late, "field")).toMatchObject({ feeFils: 0, refundFils: 5000 });
    expect(cancelQuote({ ...base, lateCancelMode: "fixed", lateCancelValue: 2000 }, money({ startsAt: late.startsAt, status: "held" }), "player").feeFils).toBe(0);
    expect(cancelQuote({ ...base, lateCancelMode: "fixed", lateCancelValue: 2000 }, money(), "player")).toMatchObject({ late: false, feeFils: 0 });
  });

  it("charges a no-show and limits changes", () => {
    expect(noShowQuote({ ...base, noShowFeeMode: "fixed", noShowFeeValue: 8000 }, money({ paidFils: 5000 }))).toEqual({ feeFils: 8000, owedFils: 3000 });
    expect(changeQuote({ ...base, maxChanges: 1, changeFeeFils: 1000 }, money())).toMatchObject({ allowed: true, feeFils: 1000 });
    expect(changeQuote({ ...base, maxChanges: 1 }, money({ changeCount: 1 })).reason).toBe("too_many");
    expect(changeQuote({ ...base, changeHours: 6 }, money({ startsAt: new Date(Date.now() + 3_600_000) })).reason).toBe("too_late");
    expect(changeQuote({ ...base, allowChanges: false }, money()).reason).toBe("off");
    expect(balanceOf({ amountFils: 20000, feeFils: 2000, paidFils: 5000 })).toBe(17000);
  });

  it("explains the rules in both languages", () => {
    const lines = rulesSummary({ ...base, newCustomerPolicy: "deposit", lateCancelMode: "deposit" }, "en");
    expect(lines.join(" ")).toMatch(/deposit of 5 JOD/);
    expect(lines.join(" ")).toMatch(/First booking/);
    expect(rulesSummary(base, "ar")).toHaveLength(lines.length - 1);
  });
});
