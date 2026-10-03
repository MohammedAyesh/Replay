import { describe, expect, it } from "vitest";
import {
  ammanInputToUtcIso,
  formatAmmanDateTime,
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
});