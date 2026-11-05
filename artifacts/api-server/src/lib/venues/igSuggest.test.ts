import { describe, expect, it } from "vitest";
import { wallMinutes, wallString } from "./core";
import { DEFAULT_IG_SLOTS } from "./igCalendar";
import { nextOccurrence, suggestPosts, suggestionFor } from "./igSuggest";

const s = DEFAULT_IG_SLOTS;
const at = (x: string) => wallMinutes(x);

describe("Instagram suggestions", () => {
  it("always has something: the next of each kind, free pitches today and tomorrow, sorted by time", () => {
    // Thursday 5 Nov 2026, 09:00 in Amman.
    const now = at("2026-11-05 09:00");
    const out = suggestPosts({ s, now, days: 14, taken: new Set() });
    expect(out.length).toBeGreaterThanOrEqual(6);
    const slots = out.filter((x) => x.kind === "open_slots").map((x) => x.originKey);
    expect(slots).toEqual(["slots:2026-11-05", "slots:2026-11-06"]);
    expect(out.map((x) => x.at)).toEqual([...out.map((x) => x.at)].sort((a, b) => a - b));
    for (const x of out) expect(x.at).toBeGreaterThanOrEqual(now + 20);
    // Within three days the dashboard still gets the free pitches even with every weekly post switched off.
    const bare = suggestPosts({ s: { ...s, off: ["thanks", "top5", "match_week", "player_week", "versus", "leaderboard", "day_best"] }, now, days: 3, taken: new Set() });
    expect(bare.map((x) => x.kind)).toEqual(["open_slots", "open_slots"]);
  });

  it("skips what's on the calendar, and the scorers board rolls on to the 1st of next month", () => {
    const now = at("2026-11-05 09:00");
    const first = nextOccurrence(s, "leaderboard", now);
    expect(first.originKey).toBe("board:2026-11");
    expect(wallString(first.at).slice(0, 10)).toBe("2026-12-01");
    const taken = new Set(suggestPosts({ s, now, days: 14, taken: new Set() }).map((x) => x.originKey));
    expect(suggestPosts({ s, now, days: 14, taken })).toEqual([]);
  });

  it("accepts only a real time for that kind, from the server's own clock", () => {
    const now = at("2026-11-05 09:00");
    const o = nextOccurrence(s, "open_slots", now + 20);
    expect(suggestionFor(s, "open_slots", o.at, now)).toMatchObject({ originKey: o.originKey, placement: "story" });
    expect(suggestionFor(s, "open_slots", o.at + 7, now)).toBeNull();
    expect(suggestionFor(s, "open_slots", at("2026-11-04 18:00"), now)).toBeNull();
  });
});
