import { describe, expect, it } from "vitest";
import { detectMatchWindow } from "./matchWindowDetector";

describe("match-window detector", () => {
  it("uses a single in-play period and includes its game phase bounds", () => {
    expect(detectMatchWindow({
      duration: 1800,
      inPlay: [[420, 900], [920, 1500]],
      phases: [
        { kind: "before", start: 0, end: 400 },
        { kind: "game", start: 400, end: 1550 },
      ],
    })).toMatchObject({
      startSeconds: 400,
      endSeconds: 1550,
      source: "detector",
    });
  });

  it("keeps a half-time break inside one game window", () => {
    expect(detectMatchWindow({
      duration: 3600,
      inPlay: [[300, 1700], [1900, 3300]],
      phases: [
        { kind: "game", start: 250, end: 1700 },
        { kind: "break", start: 1700, end: 1900 },
        { kind: "game", start: 1900, end: 3350 },
      ],
    })).toMatchObject({ startSeconds: 250, endSeconds: 3350, source: "detector" });
  });

  it("does not guess which of two games was booked", () => {
    expect(detectMatchWindow({
      duration: 3600,
      inPlay: [[100, 900], [1500, 2500]],
      phases: [
        { kind: "game", start: 80, end: 950 },
        { kind: "game", start: 1480, end: 2550 },
      ],
    })).toBeNull();
  });

  it("rejects missing, invalid, and empty timelines", () => {
    expect(detectMatchWindow({ duration: 0, inPlay: [[1, 3]] })).toBeNull();
    expect(detectMatchWindow({ duration: 10, inPlay: [[4, 4], [12, 14]] })).toBeNull();
  });
});
