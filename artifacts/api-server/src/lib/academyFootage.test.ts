import { describe, expect, it } from "vitest";
import { academyFootageWindow } from "./academyFootage";

describe("academyFootageWindow", () => {
  it("converts UTC session times to Amman and rounds outward to five minutes", () => {
    expect(academyFootageWindow(
      new Date("2026-10-08T12:03:00.000Z"),
      new Date("2026-10-08T13:37:00.000Z"),
    )).toEqual({
      startLocal: "2026-10-08 15:00",
      endLocal: "2026-10-08 16:40",
      requestedSeconds: 100 * 60,
      note: null,
    });
  });

  it("enforces the 15-minute minimum after rounding", () => {
    expect(academyFootageWindow(
      new Date("2026-10-08T12:03:00.000Z"),
      new Date("2026-10-08T12:04:00.000Z"),
    )).toEqual({
      startLocal: "2026-10-08 15:00",
      endLocal: "2026-10-08 15:15",
      requestedSeconds: 15 * 60,
      note: null,
    });
  });

  it("caps sessions longer than four hours and reports the cap", () => {
    expect(academyFootageWindow(
      new Date("2026-10-08T12:03:00.000Z"),
      new Date("2026-10-08T18:03:00.000Z"),
    )).toEqual({
      startLocal: "2026-10-08 15:00",
      endLocal: "2026-10-08 19:00",
      requestedSeconds: 4 * 60 * 60,
      note: "Recording limited to the first 4 hours.",
    });
  });

  it("rounds across midnight in Amman local time", () => {
    expect(academyFootageWindow(
      new Date("2026-10-08T20:58:00.000Z"),
      new Date("2026-10-08T21:06:00.000Z"),
    )).toEqual({
      startLocal: "2026-10-08 23:55",
      endLocal: "2026-10-09 00:10",
      requestedSeconds: 15 * 60,
      note: null,
    });
  });
});
