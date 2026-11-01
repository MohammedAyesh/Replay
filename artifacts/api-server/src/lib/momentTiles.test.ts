import { describe, expect, it } from "vitest";
import { momentPiece, momentTiles, pieceAt, tileFocus, tileInPiece, tileOf, tilesFor, tileWindow } from "./momentTiles";

const piece = momentPiece({
  recordingId: 7, srcW: 3840, srcH: 1080,
  duration: 3600, recordingOffsetSec: -600, videoStartSeconds: 1.48, bookingSeconds: 7200,
})!;

describe("momentPiece", () => {
  it("maps the booking clock to the video clock and clamps to the booking and the recording", () => {
    // the recording started 10 min before the booking: booking 0 is tracking 600
    expect(piece.from).toBe(0);
    expect(piece.to).toBe(3000);
    expect(piece.shift).toBeCloseTo(601.48, 3);
  });

  it("is null when the recording and the booking do not overlap", () => {
    expect(momentPiece({ recordingId: 1, srcW: 1, srcH: 1, duration: 100, recordingOffsetSec: 7300, videoStartSeconds: 0, bookingSeconds: 7200 })).toBeNull();
  });
});

describe("pieceAt", () => {
  it("finds the piece holding a moment, or the nearest within 30 s", () => {
    const later = momentPiece({ recordingId: 8, srcW: 1, srcH: 1, duration: 3600, recordingOffsetSec: 3100, videoStartSeconds: 0, bookingSeconds: 7200 })!;
    expect(pieceAt([piece, later], 120)?.recordingId).toBe(7);
    expect(pieceAt([piece, later], 3200)?.recordingId).toBe(8);
    expect(pieceAt([piece, later], 3020)?.recordingId).toBe(7);
    expect(pieceAt([piece], 3100)).toBeNull();
  });
});

describe("tiles", () => {
  it("sits on a fixed ten-second grid of the video clock", () => {
    expect(tileOf(0)).toBe(0);
    expect(tileOf(9.99)).toBe(0);
    expect(tileOf(10)).toBe(1);
    expect(tileWindow(3)).toEqual({ start: 30, end: 40 });
  });

  it("gives a moment the tiles for 5 s either side to open on and 15 s within reach", () => {
    // booking 100 -> video 701.48: opens on 696.48..706.48
    const t = momentTiles(piece, 100);
    expect(t.core).toEqual([69, 70]);
    expect(t.reach).toEqual([68, 69, 70, 71]);
  });

  it("never reaches outside the piece's footage", () => {
    const t = momentTiles(piece, 2);
    expect(t.reach[0]).toBe(tileOf(piece.from + piece.shift));
    expect(tilesFor(piece, 0, 10)).toEqual([]);
    expect(tileInPiece(piece, 0)).toBe(false);
    expect(tileInPiece(piece, 60)).toBe(true);
    expect(tileInPiece(piece, tileOf(piece.to + piece.shift) + 1)).toBe(false);
  });
});

describe("tileFocus", () => {
  const manifest = { frameRate: 20, width: 3840, height: 1080 };
  it("follows the ball through a tile on the video clock, holding the last place through a gap", () => {
    // tile 1 = video 10..20 = tracking 8.52..18.52 with a 1.48 s video start
    const ball: Array<[number, number, number, number]> = [
      [200, 1920, 540, 0.9], // tracking 10 s -> video 11.48
      [300, 3840, 1080, 0.9], // tracking 15 s -> video 16.48
    ];
    const f = tileFocus(ball, manifest, 1, 1.48);
    expect(f[0]).toEqual([10, 0.5, 0.5]);
    const at = (v: number) => f.find((p) => Math.abs(p[0] - v) < 1e-6);
    expect(at(11.5)?.slice(1)).toEqual([0.5, 0.5]);
    expect(at(14)?.slice(1)).toEqual([0.5, 0.5]);
    expect(at(16.5)?.slice(1)).toEqual([1, 1]);
    expect(at(20)?.slice(1)).toEqual([1, 1]);
  });

  it("has no points when the ball is never seen", () => {
    expect(tileFocus([], manifest, 1, 0)).toEqual([]);
    expect(tileFocus([[9999, 1, 1, 1]], manifest, 1, 0)).toEqual([]);
  });
});
