import { describe, expect, it } from "vitest";
import { changedMessage, confirmedMessage, termsLines, videoReadyMessage, type BookingFacts } from "./messages";

const base: BookingFacts = {
  venue: "Jordan Galaxy", name: "Omar Ali", pitch: "Pitch 1", day: "Thursday 5 Nov", time: "9:00 pm", minutes: 60,
  amountFils: 40_000, dueOnlineFils: 0, reference: "JG-7K2", alias: null, aliasName: null, holdUntil: null, cardUrl: null,
  balanceFils: 40_000, link: null,
};
const terms = {
  change: { allowed: true, until: "Thursday 5 Nov, 3:00 pm", feeFils: 0 },
  cancel: { until: "Thursday 5 Nov, 3:00 pm", late: "refuse" as const, value: 0 },
};

describe("the booking confirmation (2026-11-05: the match link, the change option and the cancel time)", () => {
  it("carries the match page, the free-cancellation deadline, the change deadline and the manage link", () => {
    const m = confirmedMessage({ ...base, matchLink: "https://replayjo.com/m/AB12", manageLink: "https://replayjo.com/v/galaxy?manage=JG-7K2#manage", terms }, "en");
    expect(m).toContain("Your booking is confirmed");
    expect(m).toContain("https://replayjo.com/m/AB12");
    expect(m).toContain("Free cancellation until Thursday 5 Nov, 3:00 pm; after that it can't be cancelled");
    expect(m).toContain("You can change the time until Thursday 5 Nov, 3:00 pm");
    expect(m).toContain("Change or cancel: https://replayjo.com/v/galaxy?manage=JG-7K2#manage");
    const ar = confirmedMessage({ ...base, matchLink: "https://replayjo.com/m/AB12", manageLink: "https://x/v/g?manage=JG-7K2", terms: { ...terms, cancel: { ...terms.cancel, until: "الخميس 5/11 الساعة 3:00 م" } } }, "ar");
    expect(ar).toContain("صفحة الماتش");
    expect(ar).toContain("الإلغاء مجاني لحد الخميس 5/11 الساعة 3:00 م");
    expect(ar).toContain("للتغيير أو الإلغاء: https://x/v/g?manage=JG-7K2");
  });
  it("says what a late cancellation costs, and drops the change line when changes are off", () => {
    expect(termsLines({ change: { allowed: false, until: null, feeFils: 0 }, cancel: { until: null, late: "percent", value: 50 } }, "en"))
      .toEqual(["❌ Cancelling now: there's a 50% fee"]);
    expect(termsLines({ change: { allowed: true, until: "Fri", feeFils: 2000 }, cancel: { until: "Fri", late: "fixed", value: 5000 } }, "en")[0]).toMatch(/until Fri; after that there's a .*5.* fee/);
    expect(termsLines({ change: { allowed: true, until: "Fri", feeFils: 2000 }, cancel: { until: "Fri", late: "free", value: 0 } }, "en"))
      .toEqual(["❌ Free cancellation up to kick-off", expect.stringMatching(/^✏️ You can change the time until Fri \(.*2.* fee\)$/)]);
    const noChange = confirmedMessage({ ...base, manageLink: "https://x", terms: { ...terms, change: { allowed: false, until: null, feeFils: 0 } } }, "en");
    expect(noChange).toContain("Cancel: https://x");
    expect(noChange).not.toContain("change the time");
  });
  it("a moved booking says the same; a confirmation with none of it is as before", () => {
    expect(changedMessage({ ...base, matchLink: "https://replayjo.com/m/AB12", terms }, "en")).toContain("https://replayjo.com/m/AB12");
    expect(confirmedMessage(base, "en")).toBe("Your booking is confirmed ✅\nPitch 1, Thursday 5 Nov at 9:00 pm (1 hour)\nBooking code: JG-7K2\nTo pay at the field: 40 JOD\nSee you on the pitch ⚽");
  });
});

describe("the video-ready message (2026-11-07: same time next week?)", () => {
  const ready = { ...base, link: "https://replayjo.com/w/abc" };
  it("asks to rebook the same slot next week when it is still free, with the booking site", () => {
    const m = videoReadyMessage(ready, "en", { day: "Thu 12 Nov", time: "9:00 pm", link: "https://replayjo.com/v/galaxy" });
    expect(m).toContain("https://replayjo.com/w/abc");
    expect(m).toContain("Same time next week? Thu 12 Nov at 9:00 pm is still free");
    expect(m.trim().endsWith("https://replayjo.com/v/galaxy")).toBe(true);
    expect(videoReadyMessage(ready, "ar", { day: "الخميس 12/11", time: "9:00 م", link: "https://replayjo.com/v/galaxy" })).toContain("نفس الوقت الأسبوع الجاي؟");
  });
  it("says nothing about next week when the slot is taken", () => {
    expect(videoReadyMessage(ready, "en")).not.toContain("next week");
  });
});
