import { describe, expect, it } from "vitest";
import { chooseHomeHighlight, currentReplayWeekStart } from "./weeklyHighlights";

describe("weekly highlight selection", () => {
  it("starts Replay weeks on Saturday in Amman", () => {
    expect(currentReplayWeekStart(new Date("2026-10-30T12:00:00Z"))).toBe("2026-10-24");
  });
  it("prefers personal, accepts the exact prior-week boundary, and rejects older highlights", () => {
    const personal: import("./weeklyHighlights").HomeHighlightCandidate = { id: 1, kind: "personal", weekStart: "2026-10-24" };
    const field: import("./weeklyHighlights").HomeHighlightCandidate = { id: 2, kind: "field", weekStart: "2026-10-24" };
    expect(chooseHomeHighlight(personal, field, "2026-10-24")?.id).toBe(1);
    expect(chooseHomeHighlight(null, field, "2026-10-24")?.id).toBe(2);
    expect(chooseHomeHighlight({ ...personal, weekStart: "2026-10-10" }, { ...field, weekStart: "2026-10-17" }, "2026-10-24")?.id).toBe(2);
    expect(chooseHomeHighlight(null, { ...field, weekStart: "2026-10-10" }, "2026-10-24")).toBeNull();
  });
});
