import { describe, expect, it } from "vitest";
import { forYouStrings } from "@/i18n/creative-foryou-strings";
import { ammanDateKey, dayWord, whyLine } from "./why";

const NOW = new Date("2026-11-02T09:00:00Z"); // Monday noon in Amman
const strip = (s: string) => s.replace(/[⁦⁩]/g, "");
const reason = (over: Partial<Parameters<typeof whyLine>[0]> = {}): Parameters<typeof whyLine>[0] => ({
  kind: "fulltime", startsAt: "2026-10-31T15:00:00Z", opponent: "Al-Wehdat", ownScore: 3, opponentScore: 1, squad: "U-12", ...over,
});

describe("for you: why it's suggested", () => {
  it("names the Amman day, not the browser's", () => {
    // 21:30 UTC Sunday is already Monday in Amman.
    expect(ammanDateKey(new Date("2026-11-01T21:30:00Z"))).toBe("2026-11-02");
    expect(dayWord(new Date("2026-11-01T21:30:00Z"), NOW, forYouStrings.en, "en")).toBe("today");
    expect(dayWord(new Date("2026-11-01T15:00:00Z"), NOW, forYouStrings.en, "en")).toBe("yesterday");
    expect(dayWord(new Date("2026-11-03T15:00:00Z"), NOW, forYouStrings.ar, "ar")).toBe("بكرا");
    expect(dayWord(new Date("2026-10-31T15:00:00Z"), NOW, forYouStrings.en, "en")).toBe("Saturday");
    expect(dayWord(new Date("2026-10-31T15:00:00Z"), NOW, forYouStrings.ar, "ar")).toBe("السبت");
  });

  it("reads the result", () => {
    expect(strip(whyLine(reason(), forYouStrings.en, "en", NOW))).toBe("After Saturday's 3–1 win vs Al-Wehdat");
    expect(strip(whyLine(reason(), forYouStrings.ar, "ar", NOW))).toBe("بعد فوز السبت 3–1 ضد Al-Wehdat");
    expect(strip(whyLine(reason({ ownScore: 2, opponentScore: 2 }), forYouStrings.en, "en", NOW))).toBe("After Saturday's 2–2 draw vs Al-Wehdat");
    expect(strip(whyLine(reason({ ownScore: 1, opponentScore: 2 }), forYouStrings.en, "en", NOW))).toBe("After Saturday's game vs Al-Wehdat (1–2)");
    expect(whyLine(reason({ kind: "matchday", startsAt: "2026-11-03T15:00:00Z", ownScore: null, opponentScore: null }), forYouStrings.en, "en", NOW))
      .toBe("Tomorrow vs Al-Wehdat: let your fans know");
    expect(whyLine(reason({ kind: "weekly", startsAt: null }), forYouStrings.ar, "ar", NOW)).toBe(forYouStrings.ar.why.weekly);
  });
});
