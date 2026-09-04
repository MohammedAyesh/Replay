import { describe, expect, it } from "vitest";
import { formatStartTime, parseStartTime } from "./analysisStart";

/**
 * The kick-off field. An operator types what they read off the clock, and a
 * misread here is not visible until hours later as boxes drawn over empty
 * grass, so the parser is strict about what it accepts and returns null rather
 * than guessing.
 */
describe("parsing the match start an operator types", () => {
  it("reads minutes and seconds", () => {
    expect(parseStartTime("18:30")).toBe(1110);
    expect(parseStartTime("0:00")).toBe(0);
    expect(parseStartTime(" 2:05 ")).toBe(125);
  });

  it("reads hours as well", () => {
    expect(parseStartTime("1:18:30")).toBe(4710);
  });

  it("takes a bare number of seconds", () => {
    expect(parseStartTime("1080")).toBe(1080);
  });

  it("treats an empty field as the start of the recording", () => {
    expect(parseStartTime("")).toBe(0);
  });

  it("refuses anything it would have to guess at", () => {
    // "18:75" is the dangerous one: read as 18*60+75 it is a plausible number
    // that is not what the operator meant.
    expect(parseStartTime("18:75")).toBeNull();
    expect(parseStartTime("1:2:3:4")).toBeNull();
    expect(parseStartTime("ten past")).toBeNull();
    expect(parseStartTime("-5")).toBeNull();
    expect(parseStartTime("1:-5")).toBeNull();
  });
});

describe("showing it back", () => {
  it("round-trips what the parser accepted", () => {
    expect(formatStartTime(1110)).toBe("18:30");
    expect(formatStartTime(4710)).toBe("1:18:30");
    expect(formatStartTime(0)).toBe("0:00");
    expect(formatStartTime(65)).toBe("1:05");
  });
});
