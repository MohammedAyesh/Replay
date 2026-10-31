import { describe, expect, it } from "vitest";
import { checkStrings } from "./check-strings";

const { en, ar } = checkStrings;
/** a Latin digit, with or without the bidi isolates round it */
const digit = (n: number) => new RegExp(`(^|[^0-9])${n}([^0-9]|$)`);

describe("Arabic counts: 1, 2 (dual), 3-10 (plural), 11+ (singular)", () => {
  it("says 'لحظتين', not '2 لحظات'", () => {
    expect(ar.introTitle(2)).toContain("لحظتين");
    expect(ar.introTitle(2)).not.toMatch(digit(2));
    expect(ar.pausedTitle(2)).toContain("لحظتين");
    expect(ar.pausedTitle(2)).not.toMatch(digit(2));
  });

  it("says 'هدفين', not '2 أهداف'", () => {
    for (const s of [ar.introGoalsOnly(2), ar.introGoals(2)]) {
      expect(s).toContain("هدفين");
      expect(s).not.toMatch(digit(2));
    }
  });

  it("takes the plural for 3-10 and the singular for 11 and up", () => {
    expect(ar.introTitle(5)).toContain("5 لحظات");
    expect(ar.introTitle(11)).toContain("11 لحظة");
    expect(ar.pausedTitle(3)).toContain("3 لحظات");
    expect(ar.pausedTitle(12)).toContain("12 لحظة");
    expect(ar.introGoalsOnly(4)).toContain("4 أهداف");
    expect(ar.introGoalsOnly(11)).toContain("11 هدف");
    expect(ar.introGoalsOnly(11)).not.toContain("أهداف");
    expect(ar.introGoals(13)).toContain("13 هدف");
    expect(ar.introGoals(13)).not.toContain("أهداف");
  });

  it("counts the players a dribble beat the same way", () => {
    expect(ar.momentDribble(1)).toBe("مراوغة لاعب");
    expect(ar.momentDribble(2)).toBe("مراوغة لاعبين");
    expect(ar.momentDribble(3)).toBe("مراوغة 3 لاعبين");
    expect(ar.momentDribble(11)).toBe("مراوغة 11 لاعب");
  });

  it("agrees the done-screen labels with the number above them", () => {
    expect(ar.kept(1)).toContain("كليب جديد");
    expect(ar.kept(2)).toContain("كليبين");
    expect(ar.kept(5)).toContain("كليبات");
    expect(ar.kept(11)).toContain("كليب جديد");
    expect(ar.goalsConfirmed(2)).toContain("هدفين");
    expect(ar.goalsConfirmed(4)).toContain("أهداف");
    expect(en.kept(1)).toBe("new clip of you");
    expect(en.kept(3)).toBe("new clips of you");
    expect(en.goalsConfirmed(1)).toBe("goal you confirmed");
  });
});

describe("Arabic wording", () => {
  it("labels the skip button 'تخطّى'", () => {
    expect(ar.skip).toBe("تخطّى");
  });
});

describe("copy the deck needs in both languages", () => {
  it("has the minimap's 'field view' label", () => {
    expect(en.fieldView).toBe("field view");
    expect(ar.fieldView).toMatch(/[؀-ۿ]/);
  });

  it("has a neutral 'kept' for a moment that makes no clip yet", () => {
    expect(en.toastKept).toMatch(/kept/i);
    expect(en.toastKept).not.toMatch(/clip/i);
    expect(ar.toastKept).toMatch(/[؀-ۿ]/);
    expect(ar.toastKept).not.toContain("كليب");
    expect(en.toastStale).toBeTruthy();
    expect(ar.toastStale).toMatch(/[؀-ۿ]/);
    expect(en.doneDescPending).toBeTruthy();
    expect(ar.doneDescPending).toMatch(/[؀-ۿ]/);
  });
});
