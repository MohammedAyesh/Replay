import { describe, expect, it } from "vitest";
import {
  addMinutesToAmmanInput,
  ammanInputToUtcIso,
  formatAmmanDateTime,
  suggestAmmanSessionEnd,
  utcIsoToAmmanInput,
} from "./academy-session-time";

describe("academy session Amman time", () => {
  it("converts UTC instants to the Amman wall clock and calendar day", () => {
    const utc = "2026-10-02T22:30:00.000Z";

    expect(utcIsoToAmmanInput(utc)).toBe("2026-10-03T01:30");
    expect(formatAmmanDateTime(utc, "en").dateKey).toBe("2026-10-03");
  });

  it("converts Amman input back to the exact UTC instant", () => {
    expect(ammanInputToUtcIso("2026-10-03T01:30")).toBe("2026-10-02T22:30:00.000Z");
  });

  it("rejects malformed and impossible Amman wall-clock values", () => {
    expect(ammanInputToUtcIso("2026-02-30T18:00")).toBeNull();
    expect(ammanInputToUtcIso("2026-10-03 01:30")).toBeNull();
    expect(utcIsoToAmmanInput("not-a-date")).toBe("");
  });

  it("suggests a 90-minute end time across date boundaries", () => {
    expect(addMinutesToAmmanInput("2026-10-03T23:00", 90)).toBe("2026-10-04T00:30");
  });

  it("updates an empty or previously suggested end but preserves a manual end", () => {
    const first = suggestAmmanSessionEnd("2026-10-03T10:00", "", null);
    expect(first).toEqual({ endsAt: "2026-10-03T11:30", autoEnd: "2026-10-03T11:30" });
    expect(suggestAmmanSessionEnd("2026-10-03T11:00", first.endsAt, first.autoEnd))
      .toEqual({ endsAt: "2026-10-03T12:30", autoEnd: "2026-10-03T12:30" });
    expect(suggestAmmanSessionEnd("2026-10-03T12:00", "2026-10-03T14:45", null))
      .toEqual({ endsAt: "2026-10-03T14:45", autoEnd: null });
  });
});