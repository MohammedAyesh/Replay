import { describe, expect, it } from "vitest";
import {
  createLiveClipWindow,
  formatAmmanClock,
  liveProgramTimeAtPosition,
} from "./liveTime";

describe("live clip time", () => {
  it("maps the playhead through the PDT fragment instead of a stale playing date", () => {
    const programDateTime = Date.parse("2026-09-24T20:52:55.000Z");
    expect(liveProgramTimeAtPosition(
      103.25,
      [{ start: 100, duration: 10, programDateTime }],
      programDateTime,
    )).toBe(programDateTime + 3_250);
  });

  it("uses the playing date only when no PDT fragment covers the playhead", () => {
    const playingDate = Date.parse("2026-09-24T20:52:55.000Z");
    expect(liveProgramTimeAtPosition(25, [], playingDate)).toBe(playingDate);
    expect(liveProgramTimeAtPosition(25, [], null)).toBeNull();
  });

  it("keeps a positive clip window in UTC and caps it at the configured duration", () => {
    const start = Date.parse("2026-09-24T20:52:55.250Z");
    const end = Date.parse("2026-09-24T20:53:03.875Z");
    expect(createLiveClipWindow(start, end, 600)).toEqual({
      startUtcMs: start,
      endUtcMs: end,
      durationSeconds: 8.625,
    });
    expect(createLiveClipWindow(start, start + 900_000, 600)).toEqual({
      startUtcMs: start,
      endUtcMs: start + 600_000,
      durationSeconds: 600,
    });
    expect(createLiveClipWindow(start, start, 600)).toBeNull();
    expect(createLiveClipWindow(start, start - 1, 600)).toBeNull();
  });

  it("formats the UTC timestamp as an Amman-local clock time", () => {
    const timestamp = Date.parse("2026-09-24T20:52:55.000Z");
    expect(formatAmmanClock(timestamp)).toBe("23:52:55");
    expect(formatAmmanClock(null)).toBe("—");
  });
});