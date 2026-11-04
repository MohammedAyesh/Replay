import { describe, expect, it } from "vitest";
import { wallMinutes, wallString } from "./core";
import {
  DEFAULT_IG_SLOTS,
  announcingWeek,
  awardTimes,
  boardTimes,
  commentChoice,
  commentVotes,
  isQuiet,
  milestoneCrossed,
  normaliseIgSlots,
  pacing,
  planSlots,
  slotsFor,
  voteWinner,
  weekStartOf,
  weeklyTimes,
  type PlanItem,
} from "./igCalendar";

const OPEN = Object.fromEntries(["0", "1", "2", "3", "4", "5", "6"].map((d) => [d, { open: "16:00", close: "01:00" }]));
const at = (local: string) => wallMinutes(local);
const s = DEFAULT_IG_SLOTS;

describe("Instagram calendar: settings", () => {
  it("defaults to stories every 3 h, Reels at 14:00 and 21:00, nothing 01:00–10:00", () => {
    expect(normaliseIgSlots({})).toEqual(DEFAULT_IG_SLOTS);
    expect(s).toMatchObject({ storyEveryHours: 3, reelTimes: ["14:00", "21:00"], quietFrom: "01:00", quietTo: "10:00", nomineesDay: 0, votingEndDay: 2, winnerDay: 3 });
  });

  it("clamps what the owner sends and keeps 1–3 sorted Reel times", () => {
    const n = normaliseIgSlots({ storyEveryHours: 40, reelTimes: ["22:00", "13:00", "bad", "22:00", "18:00", "09:00"], quietFrom: "25:00" });
    expect(n.storyEveryHours).toBe(12);
    expect(n.reelTimes).toEqual(["09:00", "13:00", "18:00"]);
    expect(n.quietFrom).toBe("01:00");
  });

  it("treats a night window that runs past midnight as quiet on both sides", () => {
    expect(isQuiet(s, at("2026-11-05 00:30"))).toBe(false);
    expect(isQuiet(s, at("2026-11-05 01:00"))).toBe(true);
    expect(isQuiet(s, at("2026-11-05 09:59"))).toBe(true);
    expect(isQuiet(s, at("2026-11-05 10:00"))).toBe(false);
    expect(isQuiet({ quietFrom: "23:00", quietTo: "08:00" }, at("2026-11-05 23:30"))).toBe(true);
    expect(isQuiet({ quietFrom: "23:00", quietTo: "08:00" }, at("2026-11-05 07:59"))).toBe(true);
  });
});

describe("Instagram calendar: slots", () => {
  it("puts stories on the hour every 3 h while open, never at night, and the day's Reels", () => {
    const slots = slotsFor(s, OPEN, "2026-11-05", 1);
    const stories = slots.filter((x) => x.kind === "story").map((x) => wallString(x.at).slice(11));
    const reels = slots.filter((x) => x.kind === "reel").map((x) => wallString(x.at).slice(11));
    // Open 16:00–01:00: 16, 19, 22 (the next would be 01:00, when it closes and the night starts).
    expect(stories).toEqual(["16:00", "19:00", "22:00"]);
    expect(reels).toEqual(["14:00", "21:00"]);
  });

  it("has no story slots on a closed day but keeps its Reel times", () => {
    const closedThu = { ...OPEN, "4": null, "3": null };
    const slots = slotsFor(s, closedThu, "2026-11-05", 1); // 5 Nov 2026 is a Thursday
    expect(slots.filter((x) => x.kind === "story")).toHaveLength(0);
    expect(slots.filter((x) => x.kind === "reel")).toHaveLength(2);
  });
});

describe("Instagram calendar: the planner", () => {
  const slots = slotsFor(s, OPEN, "2026-11-05", 3);
  const item = (id: number, ready: string, score = 10, extra: Partial<PlanItem> = {}): PlanItem => ({
    id, kind: "booking_clip", status: "planned", placement: "story", slotAt: null, pinned: false, score, readyAt: at(ready), ...extra,
  });

  it("promotes the best clip ready before each Reel time, confirmed goals first, and stories the rest", () => {
    const now = at("2026-11-05 15:00");
    const plan = planSlots({ now, slots, items: [
      item(1, "2026-11-05 15:05", 20), // a saved clip
      item(2, "2026-11-05 15:10", 30), // a confirmed goal
      item(3, "2026-11-05 15:20", 10), // a shot
    ] });
    expect(plan.get(2)).toEqual({ slotAt: at("2026-11-05 21:00"), placement: "reel" });
    // Tomorrow's 14:00 Reel takes the next best still waiting.
    expect(plan.get(1)).toEqual({ slotAt: at("2026-11-06 14:00"), placement: "reel" });
    expect(plan.get(3)).toEqual({ slotAt: at("2026-11-05 16:00"), placement: "story" });
  });

  it("fills a story slot up to its capacity, then the next one", () => {
    const now = at("2026-11-05 15:00");
    const items = [1, 2, 3, 4].map((id) => item(id, "2026-11-05 15:00", 0)); // score 0: never a Reel
    const plan = planSlots({ now, slots, items });
    expect([1, 2, 3, 4].map((id) => wallString(plan.get(id)!.slotAt!).slice(11))).toEqual(["16:00", "16:00", "19:00", "19:00"]);
  });

  it("keeps pinned and in-flight items where they are and plans around them", () => {
    const now = at("2026-11-05 15:00");
    const plan = planSlots({ now, slots, items: [
      item(1, "2026-11-05 14:00", 0, { pinned: true, slotAt: at("2026-11-05 16:00") }),
      item(2, "2026-11-05 14:00", 0, { status: "publishing", slotAt: at("2026-11-05 16:00") }),
      item(3, "2026-11-05 14:00", 0),
    ] });
    expect(plan.has(1)).toBe(false);
    expect(plan.has(2)).toBe(false);
    expect(wallString(plan.get(3)!.slotAt!).slice(11)).toBe("19:00");
  });

  it("rolls a clip whose slot passed unapproved on to the next slot", () => {
    const plan = planSlots({ now: at("2026-11-05 16:30"), slots, items: [item(1, "2026-11-05 15:00", 0, { slotAt: at("2026-11-05 16:00") })] });
    expect(wallString(plan.get(1)!.slotAt!).slice(11)).toBe("19:00");
  });

  it("leaves time to render: a clip ready 5 minutes before a slot waits for the next", () => {
    const plan = planSlots({ now: at("2026-11-05 15:00"), slots, items: [item(1, "2026-11-05 15:55", 0)] });
    expect(wallString(plan.get(1)!.slotAt!).slice(11)).toBe("19:00");
  });
});

describe("Instagram calendar: pacing and awards", () => {
  it("keeps a reserve under Instagram's 100 posts a day", () => {
    expect(pacing(0)).toEqual({ used: 0, total: 100, left: 90, paused: false });
    expect(pacing(90)).toMatchObject({ left: 0, paused: true });
    expect(pacing(20, 50)).toMatchObject({ total: 50, left: 20 });
  });

  it("announces a games week the following Sunday, votes until Tuesday, posts winners on Wednesday", () => {
    expect(weekStartOf(at("2026-11-05 20:00"))).toBe("2026-11-01"); // Thu → its Sunday
    expect(announcingWeek(at("2026-11-08 12:00"))).toBe("2026-11-01");
    const t = awardTimes(s, "2026-11-01");
    expect(wallString(t.nominees)).toBe("2026-11-08 12:00");
    expect(wallString(t.votingEnds)).toBe("2026-11-10 23:59");
    expect(wallString(t.winner)).toBe("2026-11-11 19:00");
  });

  it("lets the owner pick when the vote is thin, otherwise the most votes win (first listed on a tie)", () => {
    expect(voteWinner(["a", "b"], [{ nomineeKey: "a" }], 5)).toMatchObject({ key: null, total: 1 });
    const votes = ["b", "a", "b", "a", "c", "x"].map((k) => ({ nomineeKey: k }));
    expect(voteWinner(["a", "b", "c"], votes, 5)).toMatchObject({ key: "a", total: 5, counts: { a: 2, b: 2, c: 1 } });
  });
});

describe("Instagram calendar: weekly, monthly and milestone posts", () => {
  it("posts last week's thank-you on Sunday 21:00 and this week's which-is-nicer on Thursday", () => {
    const thu = at("2026-11-05 12:00"); // Thursday; the week started Sunday 1 Nov
    const thanks = weeklyTimes(s, "thanks", thu);
    expect(wallString(thanks.at)).toBe("2026-11-01 21:00");
    expect(thanks.gamesWeek).toBe("2026-10-25");
    const versus = weeklyTimes(s, "versus", thu);
    expect(wallString(versus.at)).toBe("2026-11-05 21:00");
    expect(versus.gamesWeek).toBe("2026-11-01");
    expect(wallString(versus.gamesUntil!)).toBe("2026-11-05 18:00");
  });

  it("names last month's board on the 1st", () => {
    const b = boardTimes(s, at("2026-11-01 09:00"));
    expect(b.month).toBe("2026-10");
    expect(wallString(b.at)).toBe("2026-11-01 14:00");
    expect(boardTimes(s, at("2027-01-01 09:00")).month).toBe("2026-12");
  });

  it("finds the milestone a count just passed, the biggest when it passed two", () => {
    expect(milestoneCrossed(98, 103)).toBe(100);
    expect(milestoneCrossed(100, 140)).toBeNull();
    expect(milestoneCrossed(40, 260)).toBe(250);
    expect(milestoneCrossed(990, 1001)).toBe(1000);
    expect(milestoneCrossed(2400, 2600)).toBe(2500);
  });

  it("keeps what the owner switched off and the weekly times he set", () => {
    const n = normaliseIgSlots({ off: ["top5", "bogus", "top5"], weekly: { versus: { day: 3, time: "20:30" }, thanks: { day: 9 } } });
    expect(n.off).toEqual(["top5"]);
    expect(n.weekly.versus).toEqual({ day: 3, time: "20:30" });
    expect(n.weekly.thanks).toEqual({ day: 6, time: "21:00" });
  });
});

describe("Instagram calendar: votes in the comments", () => {
  it("reads numbers, Arabic digits and letters as a choice", () => {
    expect(commentChoice("2", 4)).toBe(2);
    expect(commentChoice("٣ 🔥🔥", 4)).toBe(3);
    expect(commentChoice("رقم 1 أكيد", 4)).toBe(1);
    expect(commentChoice("#4", 4)).toBe(4);
    expect(commentChoice("B", 2)).toBe(2);
    expect(commentChoice("ب 🔥", 2)).toBe(2);
    expect(commentChoice("أ", 2)).toBe(1);
  });

  it("does not count a comment that names two, a number past the last, a mention or a stray letter", () => {
    expect(commentChoice("1 or 2", 4)).toBeNull();
    expect(commentChoice("5", 4)).toBeNull();
    expect(commentChoice("@yazan12 شوف", 4)).toBeNull();
    expect(commentChoice("what a goal", 2)).toBeNull();
    expect(commentChoice("بطل", 2)).toBeNull();
    expect(commentChoice("الجول 100%", 4)).toBeNull();
  });

  it("gives each account one vote, its latest choice, and never the field's own", () => {
    const t = (m: number) => new Date(Date.UTC(2026, 10, 2, 10, m));
    const votes = commentVotes([
      { fromId: "u1", body: "1", createdAt: t(0) },
      { fromId: "u1", body: "no wait 3", createdAt: t(5) },
      { fromId: "u2", body: "2", createdAt: t(1) },
      { fromId: "u2", body: "nice", createdAt: t(9) },
      { fromId: "field", body: "1", createdAt: t(2) },
      { fromId: null, body: "1", createdAt: t(3) },
    ], 4, ["field"]);
    expect([...votes]).toEqual([["u1", 3], ["u2", 2]]);
  });
});
