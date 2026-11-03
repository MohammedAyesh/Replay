import { describe, expect, it } from "vitest";
import { formatMoment, parseMoment, planWeek, type CalendarSlot } from "./academy-trials-api";
import { marketingStrings } from "@/i18n/marketing-strings";

describe("trial moments", () => {
  it("reads min:sec and h:mm:ss, and nothing else", () => {
    expect(parseMoment("12:30")).toBe(750);
    expect(parseMoment(" 0:05 ")).toBe(5);
    expect(parseMoment("1:02:03")).toBe(3723);
    expect(parseMoment("75:00")).toBe(4500);
    for (const bad of ["", "12", "12:60", "1:60:00", "a:10", "12.30", "-1:00"]) expect(parseMoment(bad)).toBeNull();
    expect(formatMoment(750)).toBe("12:30");
    expect(formatMoment(3723)).toBe("1:02:03");
  });
});

describe("week plan", () => {
  const slots: CalendarSlot[] = [{ day: 1, kind: "player" }, { day: 3, kind: "training" }, { day: 4, kind: "matchday" }, { day: 6, kind: "fulltime" }];
  const drafts = [
    { id: 1, kind: "fulltime", startsAt: "2026-10-31T15:00:00Z" },
    { id: 2, kind: "potm", startsAt: "2026-10-31T15:00:00Z" },
    { id: 3, kind: "matchday", startsAt: "2026-11-05T15:00:00Z" },
    { id: 4, kind: "matchday", startsAt: "2026-11-01T15:00:00Z" },
    { id: 5, kind: "weekmoment", startsAt: null },
  ];
  it("lays out the next seven days from today and fills each slot once", () => {
    // Tuesday 3 November 2026.
    const week = planWeek(slots, drafts, "2026-11-03");
    expect(week.map((d) => d.date)).toEqual(["2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-07", "2026-11-08", "2026-11-09"]);
    expect(week.map((d) => d.day)).toEqual([2, 3, 4, 5, 6, 0, 1]);
    const at = (date: string) => week.find((d) => d.date === date)!.slots;
    // Wednesday's training slot takes the moment of the week; Monday's player slot the player of the match.
    expect(at("2026-11-04")).toEqual([{ kind: "training", draft: drafts[4] }]);
    expect(at("2026-11-09")).toEqual([{ kind: "player", draft: drafts[1] }]);
    // Thursday's matchday is the match on or after Thursday, never last Sunday's.
    expect(at("2026-11-05")).toEqual([{ kind: "matchday", draft: drafts[2] }]);
    expect(at("2026-11-07")).toEqual([{ kind: "fulltime", draft: drafts[0] }]);
    expect(at("2026-11-03")).toEqual([]);
  });
  it("leaves a slot empty rather than reuse a draft", () => {
    const week = planWeek([{ day: 3, kind: "player" }, { day: 4, kind: "player" }], [drafts[1]], "2026-11-03");
    expect(week.flatMap((d) => d.slots.map((s) => s.draft?.id ?? null))).toEqual([2, null]);
  });
});

describe("marketing strings", () => {
  it("has every English string in Arabic, and seven day names", () => {
    const keys = (o: object, p = ""): string[] => Object.entries(o).flatMap(([k, v]) => (typeof v === "object" && v && !Array.isArray(v) ? keys(v, `${p}${k}.`) : [`${p}${k}`]));
    expect(keys(marketingStrings.ar).sort()).toEqual(keys(marketingStrings.en).sort());
    expect(marketingStrings.ar.calendar.days).toHaveLength(7);
    expect(marketingStrings.ar.trials.due(0)).toContain("متأخر");
    expect(marketingStrings.en.trials.due(5)).toBe("Send within 5 h");
  });
});
