import { describe, expect, it } from "vitest";
import { ballInWindow, partsBoxes, playerCentreSamples, rosterBoxes, trackIndex } from "./coachTracks";
import { ageOn } from "./creative/libraryData";
import { ballKeys } from "./creative/framing";

const M = { frameRate: 20, width: 4000, height: 1000, videoStartSeconds: 1 };
const segs = [{ tracks: [
  { id: "a", boxes: Array.from({ length: 41 }, (_, i) => ({ frame: i, x: 100 + i * 10, y: 200, w: 40, h: 100 })) },
  { id: "b", boxes: Array.from({ length: 41 }, (_, i) => ({ frame: 60 + i, x: 3000, y: 300, w: 40, h: 100 })) },
] }];

describe("coach tracks", () => {
  it("cuts a player's parts to the window on the video clock, thinned to the rate asked, as shares", () => {
    const index = trackIndex(segs);
    expect(trackIndex(segs)).toBe(index);
    // Part a holds frames 0–40, part b 60–100. Window 1.5–5 video s = tracking 0.5–4 s = frames 10–80.
    const boxes = partsBoxes(index, [{ trackId: "b", fromFrame: 60, toFrame: 100 }, { trackId: "a", fromFrame: 0, toFrame: 40 }], M, 1.5, 5, 10);
    expect(boxes[0]).toEqual([1.5, (100 + 100) / 4000, 0.2, 0.01, 0.1]);
    // Every second frame at 10 a second, and each part's last box in the window.
    expect(boxes.filter((b) => b[0] < 3.05).map((b) => b[0])).toEqual([1.5, 1.6, 1.7, 1.8, 1.9, 2, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9, 3]);
    expect(boxes.at(-1)![0]).toBe(5);
    expect(boxes.every((b, i) => i === 0 || b[0] >= boxes[i - 1][0])).toBe(true);
    expect(partsBoxes(index, [{ trackId: "a", fromFrame: 0, toFrame: 40 }], { ...M, width: 0 }, 0, 9)).toEqual([]);
  });

  it("keys every roster player seen in the window, and only those asked for", () => {
    const roster = { players: [
      { id: "p1", name: null, number: "7", minutes: 1, parts: [{ segmentIndex: 0, segmentName: "c0", trackId: "a", fromFrame: 0, toFrame: 40 }] },
      { id: "p2", name: null, number: null, minutes: 1, parts: [{ segmentIndex: 0, segmentName: "c0", trackId: "b", fromFrame: 60, toFrame: 100 }] },
    ] };
    expect(Object.keys(rosterBoxes(trackIndex(segs), roster, M, 1, 2))).toEqual(["p1"]);
    expect(Object.keys(rosterBoxes(trackIndex(segs), roster, M, 1, 9))).toEqual(["p1", "p2"]);
    expect(Object.keys(rosterBoxes(trackIndex(segs), roster, M, 1, 9, { only: new Set(["p2"]) }))).toEqual(["p2"]);
  });

  it("follows a player's upper body with the ball camera's smoothing", () => {
    const boxes = partsBoxes(trackIndex(segs), [{ trackId: "a", fromFrame: 0, toFrame: 40 }], M, 1, 3, 10);
    const samples = playerCentreSamples(boxes);
    expect(samples[0][0]).toBe(1);
    expect(samples[0][1]).toBeCloseTo(0.03, 6);
    expect(samples[0][2]).toBeCloseTo(0.245, 6);
    const keyed = ballKeys(samples, 1000, 3000);
    expect(keyed?.coverage).toBe(1);
    expect(keyed!.framing.keys[0][0]).toBe(0);
    // Moving right through the window.
    expect(keyed!.framing.keys.at(-1)![1]).toBeGreaterThan(keyed!.framing.keys[0][1]);
  });

  it("keeps the ball samples inside the window", () => {
    expect(ballInWindow([[1, 0.123456, 0.5], [2, 0.2, 0.2], [9, 0.3, 0.3]], 1.5, 8)).toEqual([[2, 0.2, 0.2]]);
    expect(ballInWindow(null, 0, 1)).toEqual([]);
  });
});

describe("ageOn", () => {
  it("counts whole years on the Amman calendar", () => {
    // 2026-11-09 22:30 UTC is already the 10th in Amman.
    const today = new Date("2026-11-09T22:30:00Z");
    expect(ageOn("2014-11-10", today)).toBe(12);
    expect(ageOn("2014-11-11", today)).toBe(11);
    expect(ageOn(null, today)).toBeNull();
    expect(ageOn("not a date", today)).toBeNull();
    expect(ageOn("2025-01-01", today)).toBeNull();
  });
});
