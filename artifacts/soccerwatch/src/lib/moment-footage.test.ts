import { describe, expect, it } from "vitest";
import { ballAt, momentStart, pieceAt, tileOf, type MomentPiece } from "./moment-footage";

const piece: MomentPiece = { recordingId: 1, srcW: 3840, srcH: 1080, from: 0, to: 3000, shift: 601.48 };

describe("moment footage", () => {
  it("opens a moment 5 s before it, on the video clock, inside its recording", () => {
    expect(momentStart(piece, 100, 5)).toBeCloseTo(696.48, 3);
    expect(tileOf(momentStart(piece, 100, 5))).toBe(69);
    // a moment in the first seconds opens at the start of the footage
    expect(momentStart(piece, 2, 5)).toBeCloseTo(601.48, 3);
    // never past the end
    expect(momentStart(piece, 3001, 5)).toBeLessThan(piece.to + piece.shift);
  });

  it("finds the recording a moment is on, or the nearest within 30 s", () => {
    const later: MomentPiece = { ...piece, recordingId: 2, from: 3100, to: 6000 };
    expect(pieceAt([piece, later], 3020)?.recordingId).toBe(1);
    expect(pieceAt([piece, later], 3090)?.recordingId).toBe(2);
    expect(pieceAt([piece], 3100)).toBeNull();
  });

  it("puts the camera between the ball's points", () => {
    const points: Array<[number, number, number]> = [[10, 0.2, 0.5], [11, 0.4, 0.7]];
    expect(ballAt(points, 10.5)).toEqual([0.30000000000000004, 0.6]);
    expect(ballAt(points, 5)).toEqual([0.2, 0.5]);
    expect(ballAt(points, 20)).toEqual([0.4, 0.7]);
    expect(ballAt([], 1)).toBeNull();
  });
});
