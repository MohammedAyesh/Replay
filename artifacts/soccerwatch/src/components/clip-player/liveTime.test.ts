import { describe, expect, it } from "vitest";
import {
  createLiveClipWindow,
  formatAmmanClock,
  liveElapsedSeconds,
  liveProgramTimeAtPosition,
} from "./liveTime";

describe("live clip time", () => {
  it("maps the playhead through the active fragment PDT, including across a PDT jump", () => {
    const programDateTime = Date.parse("2026-09-24T20:52:55.000Z");
    expect(liveProgramTimeAtPosition(
      113.25,
      [
        { start: 100, duration: 10, programDateTime },
        { start: 110, duration: 10, programDateTime: programDateTime + 18_000 },
      ],
    )).toBe(programDateTime + 21_250);
  });

  it("does not substitute a stale playing date when the active fragment has no PDT", () => {
    expect(liveProgramTimeAtPosition(25, [])).toBeNull();
    expect(liveProgramTimeAtPosition(25, [
      { start: 20, duration: 10, programDateTime: null },
    ])).toBeNull();
    expect(liveProgramTimeAtPosition(110, [
      { start: 100, duration: 10, programDateTime: Date.parse("2026-09-24T20:52:55.000Z") },
      { start: 110, duration: 10, programDateTime: null },
    ])).toBeNull();
  });

  it("keeps the recording timer moving through PDT jumps without moving backward", () => {
    const start = Date.parse("2026-09-24T20:52:55.000Z");
    expect(liveElapsedSeconds(start, start + 10_000)).toBe(10);
    expect(liveElapsedSeconds(start, start + 8_000, 10)).toBe(10);
    expect(liveElapsedSeconds(start, start + 18_000, 10)).toBe(18);
    expect(liveElapsedSeconds(start, null, 18)).toBeNull();
  });

  it("keeps a valid clip window in UTC without truncating its selected duration", () => {
    const start = Date.parse("2026-09-24T20:52:55.250Z");
    const end = Date.parse("2026-09-24T20:53:03.875Z");
    expect(createLiveClipWindow(start, end, 600)).toEqual({
      startUtcMs: start,
      endUtcMs: end,
      durationSeconds: 8.625,
    });
    expect(createLiveClipWindow(start, start + 600_000, 600)).toEqual({
      startUtcMs: start,
      endUtcMs: start + 600_000,
      durationSeconds: 600,
    });
    expect(createLiveClipWindow(start, start + 600_001, 600)).toBeNull();
    expect(createLiveClipWindow(start, start + 999, 600)).toBeNull();
    expect(createLiveClipWindow(start, start, 600)).toBeNull();
    expect(createLiveClipWindow(start, start - 1, 600)).toBeNull();
  });

  it("formats the UTC timestamp as an Amman-local clock time", () => {
    const timestamp = Date.parse("2026-09-24T20:52:55.000Z");
    expect(formatAmmanClock(timestamp)).toBe("23:52:55");
    expect(formatAmmanClock(null)).toBe("—");
  });
});