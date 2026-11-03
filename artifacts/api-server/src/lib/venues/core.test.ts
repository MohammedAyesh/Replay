import { describe, expect, it } from "vitest";
import {
  ammanLocal,
  bookingReference,
  businessDayFor,
  checkRequest,
  dueOnline,
  formatJod,
  fromAmmanLocal,
  normaliseDomain,
  normaliseDurations,
  normaliseHours,
  openingWindow,
  priceFor,
  slotsFor,
  slugify,
  wallMinutes,
  wallString,
} from "./core";

const lateHours = normaliseHours(Object.fromEntries(["0", "1", "2", "3", "4", "5", "6"].map((d) => [d, { open: "16:00", close: "02:00" }])));

describe("Amman time", () => {
  it("round-trips wall time through the instant", () => {
    const instant = fromAmmanLocal("2026-11-05 21:30")!;
    expect(instant.toISOString()).toBe("2026-11-05T18:30:00.000Z");
    expect(ammanLocal(instant)).toBe("2026-11-05 21:30");
  });
  it("does wall arithmetic across midnight", () => {
    expect(wallString(wallMinutes("2026-11-05 23:30") + 90)).toBe("2026-11-06 01:00");
  });
});

describe("opening hours", () => {
  it("runs a late opening past midnight and files it under the day it opened", () => {
    const w = openingWindow(lateHours, "2026-11-05")!;
    expect(wallString(w.start)).toBe("2026-11-05 16:00");
    expect(wallString(w.end)).toBe("2026-11-06 02:00");
    expect(businessDayFor(lateHours, "2026-11-06 01:00")).toBe("2026-11-05");
    expect(businessDayFor(lateHours, "2026-11-06 03:00")).toBeNull();
  });
  it("treats a missing day as closed", () => {
    const hours = normaliseHours({ "4": { open: "10:00", close: "22:00" } });
    expect(openingWindow(hours, "2026-11-05")).not.toBeNull(); // Thursday
    expect(openingWindow(hours, "2026-11-06")).toBeNull();
  });
});

describe("prices", () => {
  const pitch = {
    pricePerHourFils: 20000,
    priceRules: [{ days: [4, 5], from: "18:00", to: "02:00", pricePerHourFils: 30000 }],
  };
  it("charges the base rate off-peak", () => {
    expect(priceFor(pitch, "2026-11-03 16:00", 60)).toBe(20000); // Tuesday
  });
  it("charges peak inside the rule and splits a booking that crosses into it", () => {
    expect(priceFor(pitch, "2026-11-05 19:00", 120)).toBe(60000); // Thursday night
    expect(priceFor(pitch, "2026-11-05 17:00", 120)).toBe(50000); // one hour each side of 18:00
  });
  it("keeps a past-midnight peak with the day it started", () => {
    expect(priceFor(pitch, "2026-11-07 01:00", 60)).toBe(30000); // Saturday 01:00 is Friday's night
    expect(priceFor(pitch, "2026-11-08 01:00", 60)).toBe(20000); // Sunday 01:00 is Saturday's: off-peak
  });
});

describe("slots", () => {
  it("lists kick-offs with the lengths that fit and marks taken ones", () => {
    const busy = [{ start: wallMinutes("2026-11-05 20:00"), end: wallMinutes("2026-11-05 21:30") }];
    const slots = slotsFor({
      date: "2026-11-05",
      hours: lateHours,
      stepMinutes: 30,
      durations: [60, 90, 120],
      busy,
      pitch: { pricePerHourFils: 20000, priceRules: [] },
      nowMinute: wallMinutes("2026-11-05 12:00"),
      minNoticeMinutes: 30,
    });
    expect(slots[0].startLocal).toBe("2026-11-05 16:00");
    const at19 = slots.find((s) => s.startLocal === "2026-11-05 19:00")!;
    expect(at19.options.map((o) => [o.minutes, o.available])).toEqual([[60, true], [90, false], [120, false]]);
    const at20 = slots.find((s) => s.startLocal === "2026-11-05 20:00")!;
    expect(at20.available).toBe(false);
    const last = slots[slots.length - 1];
    expect(last.startLocal).toBe("2026-11-06 01:00");
    expect(last.options.map((o) => o.minutes)).toEqual([60]);
  });
  it("hides kick-offs inside the notice period", () => {
    const slots = slotsFor({
      date: "2026-11-05", hours: lateHours, stepMinutes: 30, durations: [60], busy: [],
      pitch: { pricePerHourFils: 1, priceRules: [] }, nowMinute: wallMinutes("2026-11-05 18:10"), minNoticeMinutes: 30,
    });
    expect(slots[0].startLocal).toBe("2026-11-05 19:00");
  });
});

describe("checkRequest", () => {
  const base = { hours: lateHours, stepMinutes: 30, durations: [60, 90], nowMinute: wallMinutes("2026-11-05 12:00"), minNoticeMinutes: 30, maxDaysAhead: 14 };
  it("accepts a normal booking and names its business day", () => {
    expect(checkRequest({ ...base, startLocal: "2026-11-06 00:30", minutes: 90 })).toEqual({ ok: true, businessDay: "2026-11-05" });
  });
  it("refuses one that runs past closing, a length not offered, or one off the step", () => {
    expect(checkRequest({ ...base, startLocal: "2026-11-06 01:00", minutes: 90 }).ok).toBe(false);
    expect(checkRequest({ ...base, startLocal: "2026-11-05 18:00", minutes: 120 }).ok).toBe(false);
    expect(checkRequest({ ...base, startLocal: "2026-11-05 18:15", minutes: 60 }).ok).toBe(false);
  });
  it("lets staff book any quarter-hour length and short notice", () => {
    expect(checkRequest({ ...base, startLocal: "2026-11-05 18:15", minutes: 75, nowMinute: wallMinutes("2026-11-05 18:10"), staff: true }).ok).toBe(true);
  });
  it("refuses beyond the booking horizon", () => {
    expect(checkRequest({ ...base, startLocal: "2026-12-05 18:00", minutes: 60 }).ok).toBe(false);
  });
});

describe("helpers", () => {
  it("makes references that can't be misread", () => {
    expect(bookingReference("Jordan Galaxy")).toMatch(/^JG-[2-9A-HJKMNP-Z]{6}$/);
    expect(bookingReference("ملعب النجوم")).toMatch(/^RP-/);
  });
  it("slugs names", () => {
    expect(slugify("Jordan Galaxy — Lower!")).toBe("jordan-galaxy-lower");
    expect(slugify("ملعب")).toBe("field");
  });
  it("normalises domains and refuses ours", () => {
    expect(normaliseDomain("https://Book.JordanGalaxy.com/path")).toBe("book.jordangalaxy.com");
    expect(normaliseDomain("replayjo.com")).toBeNull();
    expect(normaliseDomain("x.replit.app")).toBeNull();
    expect(normaliseDomain("localhost")).toBeNull();
  });
  it("works out deposits and money", () => {
    expect(dueOnline(40000, "full", 0)).toBe(40000);
    expect(dueOnline(40000, "deposit", 10000)).toBe(10000);
    expect(dueOnline(40000, "none", 10000)).toBe(0);
    expect(formatJod(40000)).toBe("40 JOD");
    expect(formatJod(12500, "ar")).toBe("12.5 دينار");
    expect(normaliseDurations([90, "60", 7, 90])).toEqual([60, 90]);
  });
});
