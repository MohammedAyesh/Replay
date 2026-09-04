import { describe, it, expect } from "vitest";
import {
  resolveSetting, resolveAll, compareRules, ruleApplies, ruleExcludes,
  withinRecurringWindow, localWeekdayAndMinute,
  DEFAULT_SETTINGS_TIMEZONE, SCOPE_SPECIFICITY,
  type SettingRule, type ResolveContext,
} from "./settingsResolver";

let nextId = 1;
const rule = (over: Partial<SettingRule> = {}): SettingRule => ({
  id: nextId++,
  key: "downloads.limit",
  value: 5,
  priority: 0,
  scopeType: "global",
  scopeId: null,
  excludes: [],
  enabled: true,
  effectiveFrom: null,
  effectiveUntil: null,
  daysOfWeek: null,
  startMinute: null,
  endMinute: null,
  timezone: DEFAULT_SETTINGS_TIMEZONE,
  ...over,
});

const AT = new Date("2026-09-04T18:00:00.000Z"); // Friday, 21:00 in Amman
const ctx = (over: Partial<ResolveContext> = {}): ResolveContext => ({ at: AT, ...over });

describe("falling back to the shipped default", () => {
  it("returns the registry default when there are no rules at all", () => {
    const r = resolveSetting("downloads.limit", [], ctx());
    expect(r).toEqual({ value: 5, rule: null, matched: [] });
  });

  it("an empty rules table leaves every setting exactly as it shipped", () => {
    // This is the property that makes it safe to put everything behind the
    // engine in one change: nothing moves until somebody writes a rule.
    expect(resolveAll(
      ["downloads.limit", "downloads.windowDays", "export.crf", "render.maxConcurrent", "playback.maxWidth"],
      [], ctx(),
    )).toEqual({
      "downloads.limit": 5,
      "downloads.windowDays": 30,
      "export.crf": 23,
      "render.maxConcurrent": 2,
      "playback.maxWidth": 1920,
    });
  });

  it("returns undefined rather than inventing a value for an unknown key", () => {
    expect(resolveSetting("nonsense.key", [], ctx()).value).toBeUndefined();
  });
});

describe("precedence", () => {
  it("highest priority wins, even when it is the broader rule", () => {
    // The whole point of priority-first: a campaign can beat a per-user override.
    const perUser = rule({ scopeType: "user", scopeId: 7, value: 1, priority: 0 });
    const promo = rule({ scopeType: "global", value: 50, priority: 100 });
    expect(resolveSetting("downloads.limit", [perUser, promo], ctx({ userId: 7 })).value).toBe(50);
  });

  it("breaks a priority tie by specificity — user beats academy beats field beats global", () => {
    const g = rule({ scopeType: "global", value: 5, priority: 10 });
    const f = rule({ scopeType: "field", scopeId: 2, value: 10, priority: 10 });
    const a = rule({ scopeType: "academy", scopeId: 3, value: 20, priority: 10 });
    const u = rule({ scopeType: "user", scopeId: 7, value: 0, priority: 10 });
    const c = ctx({ userId: 7, academyId: 3, fieldId: 2 });

    expect(resolveSetting("downloads.limit", [g, f, a, u], c).value).toBe(0);
    expect(resolveSetting("downloads.limit", [g, f, a], c).value).toBe(20);
    expect(resolveSetting("downloads.limit", [g, f], c).value).toBe(10);
    expect(resolveSetting("downloads.limit", [g], c).value).toBe(5);
  });

  it("breaks a remaining tie by the newest rule", () => {
    const older = rule({ value: 5, priority: 1 });
    const newer = rule({ value: 9, priority: 1 });
    expect(newer.id).toBeGreaterThan(older.id);
    expect(resolveSetting("downloads.limit", [older, newer], ctx()).value).toBe(9);
  });

  it("orders identically however the rules arrive", () => {
    const g = rule({ scopeType: "global", value: 5, priority: 10 });
    const u = rule({ scopeType: "user", scopeId: 7, value: 0, priority: 10 });
    const c = ctx({ userId: 7 });
    expect(resolveSetting("downloads.limit", [g, u], c).value)
      .toBe(resolveSetting("downloads.limit", [u, g], c).value);
    expect([g, u].sort(compareRules)[0]).toBe(u);
  });

  it("reports every rule that matched, winner first, so a decision is explainable", () => {
    const g = rule({ scopeType: "global", value: 5, priority: 0 });
    const a = rule({ scopeType: "academy", scopeId: 3, value: 20, priority: 0 });
    const r = resolveSetting("downloads.limit", [g, a], ctx({ academyId: 3 }));
    expect(r.value).toBe(20);
    expect(r.rule).toBe(a);
    expect(r.matched.map((m) => m.value)).toEqual([20, 5]);
  });

  it("never lets one key's rules leak into another", () => {
    const other = rule({ key: "export.crf", value: 99, priority: 1000 });
    expect(resolveSetting("downloads.limit", [other], ctx()).value).toBe(5);
  });
});

describe("scope matching", () => {
  it("ignores a scoped rule when the context has no such id", () => {
    const a = rule({ scopeType: "academy", scopeId: 3, value: 20 });
    expect(resolveSetting("downloads.limit", [a], ctx()).value).toBe(5);
    expect(resolveSetting("downloads.limit", [a], ctx({ academyId: 4 })).value).toBe(5);
    expect(resolveSetting("downloads.limit", [a], ctx({ academyId: 3 })).value).toBe(20);
  });

  it("does not match a user rule against an academy of the same number", () => {
    const u = rule({ scopeType: "user", scopeId: 3, value: 20 });
    expect(resolveSetting("downloads.limit", [u], ctx({ academyId: 3 })).value).toBe(5);
  });

  it("skips a disabled rule entirely", () => {
    const off = rule({ value: 99, priority: 100, enabled: false });
    expect(resolveSetting("downloads.limit", [off], ctx()).value).toBe(5);
  });
});

describe("exclusions — everyone except", () => {
  it("skips the rule for an excluded academy and falls through to the next", () => {
    const promo = rule({ scopeType: "global", value: 50, priority: 10, excludes: [{ scopeType: "academy", scopeId: 3 }] });
    const base = rule({ scopeType: "global", value: 5, priority: 0 });
    expect(resolveSetting("downloads.limit", [promo, base], ctx({ academyId: 9 })).value).toBe(50);
    expect(resolveSetting("downloads.limit", [promo, base], ctx({ academyId: 3 })).value).toBe(5);
  });

  it("falls all the way back to the shipped default when the only rule excludes you", () => {
    const promo = rule({ value: 50, priority: 10, excludes: [{ scopeType: "user", scopeId: 7 }] });
    expect(resolveSetting("downloads.limit", [promo], ctx({ userId: 7 })).value).toBe(5);
  });

  it("excludes on any listed scope", () => {
    const r = rule({ excludes: [{ scopeType: "user", scopeId: 1 }, { scopeType: "field", scopeId: 2 }] });
    expect(ruleExcludes(r, ctx({ userId: 1 }))).toBe(true);
    expect(ruleExcludes(r, ctx({ fieldId: 2 }))).toBe(true);
    expect(ruleExcludes(r, ctx({ userId: 5, fieldId: 5 }))).toBe(false);
  });
});

describe("absolute time windows", () => {
  it("applies only inside the window", () => {
    const r = rule({
      value: 50, priority: 10,
      effectiveFrom: new Date("2026-09-04T00:00:00Z"),
      effectiveUntil: new Date("2026-09-05T00:00:00Z"),
    });
    expect(resolveSetting("downloads.limit", [r], ctx({ at: new Date("2026-09-03T23:59:59Z") })).value).toBe(5);
    expect(resolveSetting("downloads.limit", [r], ctx({ at: new Date("2026-09-04T12:00:00Z") })).value).toBe(50);
    // End is exclusive, so a rule ending at midnight does not bleed into the next day.
    expect(resolveSetting("downloads.limit", [r], ctx({ at: new Date("2026-09-05T00:00:00Z") })).value).toBe(5);
  });

  it("treats an open end as running forever", () => {
    const r = rule({ value: 50, priority: 10, effectiveFrom: new Date("2020-01-01T00:00:00Z") });
    expect(resolveSetting("downloads.limit", [r], ctx({ at: new Date("2030-01-01T00:00:00Z") })).value).toBe(50);
  });
});

describe("recurring windows, in the admin's own clock", () => {
  it("reads the local weekday and minute in the named zone, not the server's", () => {
    // 18:00 UTC on Friday is 21:00 Friday in Amman and 20:00 Friday in Berlin.
    expect(localWeekdayAndMinute(AT, "Asia/Amman")).toMatchObject({ weekday: 5, minute: 21 * 60 });
    expect(localWeekdayAndMinute(AT, "Europe/Berlin")).toMatchObject({ weekday: 5, minute: 20 * 60 });
    expect(localWeekdayAndMinute(AT, "UTC")).toMatchObject({ weekday: 5, minute: 18 * 60 });
  });

  it("falls back to UTC on an unusable zone instead of throwing", () => {
    // One malformed rule must not break resolution for every other request.
    expect(localWeekdayAndMinute(AT, "Not/AZone").zoneUsed).toBe("UTC");
    expect(() => withinRecurringWindow(rule({ timezone: "Not/AZone", startMinute: 0, endMinute: 1439 }), AT)).not.toThrow();
  });

  it("applies inside an evening window and not outside it", () => {
    const evening = rule({ value: 50, priority: 10, startMinute: 18 * 60, endMinute: 23 * 60 });
    // 21:00 Amman — inside.
    expect(resolveSetting("downloads.limit", [evening], ctx()).value).toBe(50);
    // 09:00 UTC = 12:00 Amman — outside.
    expect(resolveSetting("downloads.limit", [evening], ctx({ at: new Date("2026-09-04T09:00:00Z") })).value).toBe(5);
  });

  it("handles a window that wraps midnight, which is the normal case for night football", () => {
    const night = rule({ startMinute: 20 * 60, endMinute: 1 * 60 }); // 20:00–01:00 Amman
    expect(withinRecurringWindow(night, new Date("2026-09-04T18:00:00Z"))).toBe(true);  // 21:00 Amman, inside
    expect(withinRecurringWindow(night, new Date("2026-09-04T21:30:00Z"))).toBe(true);  // 00:30 next day, inside the tail
    expect(withinRecurringWindow(night, new Date("2026-09-04T22:30:00Z"))).toBe(false); // 01:30, just past the end
    expect(withinRecurringWindow(night, new Date("2026-09-04T12:00:00Z"))).toBe(false); // 15:00, well outside
  });

  it("keeps a Friday-night rule applying after midnight", () => {
    // The trap: a Friday 20:00–01:00 rule must not stop an hour into the match
    // just because the local date rolled over to Saturday.
    const fridayNight = rule({ daysOfWeek: [5], startMinute: 20 * 60, endMinute: 1 * 60 });
    expect(withinRecurringWindow(fridayNight, new Date("2026-09-04T18:00:00Z"))).toBe(true);  // Fri 21:00
    expect(withinRecurringWindow(fridayNight, new Date("2026-09-04T21:30:00Z"))).toBe(true);  // Sat 00:30, started Friday
    expect(withinRecurringWindow(fridayNight, new Date("2026-09-05T21:30:00Z"))).toBe(false); // Sun 00:30, started Saturday
  });

  it("supports day-only rules", () => {
    const weekend = rule({ daysOfWeek: [5, 6], value: 50, priority: 10 });
    expect(resolveSetting("downloads.limit", [weekend], ctx()).value).toBe(50);            // Friday
    expect(resolveSetting("downloads.limit", [weekend], ctx({ at: new Date("2026-09-07T18:00:00Z") })).value).toBe(5); // Monday
  });

  it("treats a rule with neither day nor time as always on", () => {
    expect(withinRecurringWindow(rule(), AT)).toBe(true);
  });
});

describe("ruleApplies", () => {
  it("requires every condition at once", () => {
    const r = rule({
      scopeType: "academy", scopeId: 3, priority: 5,
      excludes: [{ scopeType: "user", scopeId: 9 }],
      effectiveFrom: new Date("2026-09-01T00:00:00Z"),
      daysOfWeek: [5],
      startMinute: 18 * 60, endMinute: 23 * 60,
    });
    expect(ruleApplies(r, ctx({ academyId: 3, userId: 1 }))).toBe(true);
    expect(ruleApplies(r, ctx({ academyId: 4, userId: 1 }))).toBe(false); // wrong academy
    expect(ruleApplies(r, ctx({ academyId: 3, userId: 9 }))).toBe(false); // excluded user
    expect(ruleApplies(r, ctx({ academyId: 3, at: new Date("2026-08-01T18:00:00Z") }))).toBe(false); // before start
    expect(ruleApplies(r, ctx({ academyId: 3, at: new Date("2026-09-07T18:00:00Z") }))).toBe(false); // Monday
  });
});

describe("specificity table", () => {
  it("orders the scopes narrowest last", () => {
    expect(SCOPE_SPECIFICITY.user).toBeGreaterThan(SCOPE_SPECIFICITY.academy);
    expect(SCOPE_SPECIFICITY.academy).toBeGreaterThan(SCOPE_SPECIFICITY.field);
    expect(SCOPE_SPECIFICITY.field).toBeGreaterThan(SCOPE_SPECIFICITY.global);
  });
});
