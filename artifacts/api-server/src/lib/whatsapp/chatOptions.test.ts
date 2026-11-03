import { describe, expect, it } from "vitest";
import { defaultChatOptions, isClosed, parseChatOptions } from "./chatOptions";

// Amman is UTC+3 all year. 2026-11-04 is a Wednesday.
const at = (iso: string) => new Date(`${iso}+03:00`);

describe("chat options", () => {
  it("falls back to defaults and ignores malformed values", () => {
    const parsed = parseChatOptions({ readReceipts: false, away: { enabled: true, days: [9, "x", 2], start: "7am", end: "22:30" }, greeting: "nope" }, "en");
    expect(parsed.readReceipts).toBe(false);
    expect(parsed.greeting.enabled).toBe(false);
    expect(parsed.away).toMatchObject({ enabled: true, days: [2], start: "09:00", end: "22:30" });
    expect(parseChatOptions(null, "ar")).toEqual(defaultChatOptions("ar"));
  });

  it("is closed outside the open hours and on closed days, in Amman time", () => {
    const away = { enabled: true, text: "x", days: [0, 1, 2, 3, 4, 6], start: "09:00", end: "21:00" };
    expect(isClosed(away, at("2026-11-04T10:00:00"))).toBe(false);
    expect(isClosed(away, at("2026-11-04T08:59:00"))).toBe(true);
    expect(isClosed(away, at("2026-11-04T21:00:00"))).toBe(true);
    // Friday (5) is not an open day.
    expect(isClosed(away, at("2026-11-06T12:00:00"))).toBe(true);
    // The same moment seen from UTC is still judged in Amman.
    expect(isClosed(away, new Date("2026-11-04T06:30:00Z"))).toBe(false);
  });

  it("supports hours that cross midnight", () => {
    const away = { enabled: true, text: "x", days: [0, 1, 2, 3, 4, 5, 6], start: "18:00", end: "02:00" };
    expect(isClosed(away, at("2026-11-04T23:00:00"))).toBe(false);
    expect(isClosed(away, at("2026-11-04T01:00:00"))).toBe(false);
    expect(isClosed(away, at("2026-11-04T12:00:00"))).toBe(true);
  });
});
