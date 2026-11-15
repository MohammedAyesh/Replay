import { describe, expect, it } from "vitest";
import {
  defendsAt,
  offsideLine,
  perspectiveScale,
  pitchMapper,
  pitchPolygon,
  pitchSegment,
  shareDistance,
  teamShape,
  type CoachPitch,
} from "@workspace/api-zod";

/**
 * A panorama-like camera, as cam1: 2.6 m up behind the middle of the near
 * touchline, azimuth linear in image x (a stitched cylinder, not a pinhole), so
 * straight pitch lines are curves in the picture.
 */
function syntheticPitch(rows = 65, cols = 193): CoachPitch {
  const x: number[] = [];
  const y: number[] = [];
  const cam = [20, 23.5];
  const h = 2.6;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const u = c / (cols - 1);
      const v = r / (rows - 1);
      const az = (u - 0.5) * Math.PI * 0.92;
      const tanDown = 0.06 + v * 0.95;
      const d = h / tanDown;
      x.push(cam[0] + d * Math.sin(az));
      y.push(cam[1] - d * Math.cos(az));
    }
  }
  return { calibrationId: "test", width: 40, height: 22.28, rows, cols, x, y };
}

const map = pitchMapper(syntheticPitch())!;

describe("pitchMapper", () => {
  it("rejects a grid whose size does not match its rows and columns", () => {
    expect(pitchMapper({ ...syntheticPitch(), rows: 3 })).toBeNull();
  });

  it("finds the frame point of a pitch position and back, across the pitch", () => {
    for (const [X, Y] of [[0, 0], [20, 11], [36, 20], [5, 18], [35, 3], [20, 0.5], [40, 0]] as Array<[number, number]>) {
      const s = map.toImage(X, Y);
      expect(s, `${X},${Y}`).not.toBeNull();
      const back = map.toPitch(s![0], s![1]);
      expect(Math.hypot(back[0] - X, back[1] - Y)).toBeLessThan(0.05);
    }
  });

  it("says so when the camera cannot see a spot (beside and behind it)", () => {
    expect(map.toImage(40, 22.2)).toBeNull();
    expect(map.toImage(20, 40)).toBeNull();
  });

  it("matches bilinear interpolation of the grid at a node", () => {
    const p = syntheticPitch();
    const r = 40;
    const c = 100;
    const at = map.toPitch(c / (p.cols - 1), r / (p.rows - 1));
    expect(at[0]).toBeCloseTo(p.x[r * p.cols + c], 6);
    expect(at[1]).toBeCloseTo(p.y[r * p.cols + c], 6);
  });

  it("measures metres, not frame shares", () => {
    const a = map.toImage(10, 11)!;
    const b = map.toImage(16, 11)!;
    expect(shareDistance(map, a, b)).toBeCloseTo(6, 1);
  });
});

describe("pitch lines", () => {
  it("draws the offside line across the whole pitch at one distance along it, curved in the picture", () => {
    const line = offsideLine(map, 30);
    expect(line.length).toBeGreaterThan(15);
    for (const s of line) expect(map.toPitch(s[0], s[1])[0]).toBeCloseTo(30, 1);
    const ys = line.map((s) => map.toPitch(s[0], s[1])[1]);
    expect(Math.min(...ys)).toBeLessThan(0.3);
    expect(Math.max(...ys)).toBeGreaterThan(22);
    // A straight pitch line is not a straight line on a panorama.
    const [first, last] = [line[0], line[line.length - 1]];
    const mid = line[Math.floor(line.length / 2)];
    const offChord = Math.abs((last[0] - first[0]) * (first[1] - mid[1]) - (first[0] - mid[0]) * (last[1] - first[1]))
      / Math.hypot(last[0] - first[0], last[1] - first[1]);
    expect(offChord).toBeGreaterThan(0.002);
  });

  it("samples a segment densely enough to follow the curve", () => {
    const seg = pitchSegment(map, [2, 2], [38, 2]);
    expect(seg.length).toBeGreaterThanOrEqual(36);
  });

  it("closes a drill area through its four corners", () => {
    const poly = pitchPolygon(map, [[10, 5], [22, 5], [22, 13], [10, 13]]);
    const metres = poly.map((s) => map.toPitch(s[0], s[1]));
    expect(Math.min(...metres.map((m) => m[0]))).toBeCloseTo(10, 1);
    expect(Math.max(...metres.map((m) => m[0]))).toBeCloseTo(22, 1);
    expect(Math.max(...metres.map((m) => m[1]))).toBeCloseTo(13, 1);
  });

  it("draws far players smaller than near ones", () => {
    const near = map.toImage(20, 20)!;
    const far = map.toImage(20, 2)!;
    expect(perspectiveScale(map, near, far, 32 / 9)).toBeLessThan(0.6);
    expect(perspectiveScale(map, far, near, 32 / 9)).toBeGreaterThan(1.6);
  });
});

describe("teamShape", () => {
  const p = (id: string, X: number, Y: number) => ({ id, at: [X, Y] as [number, number] });

  it("leaves the keeper out, splits back, middle and front at the gaps, and measures width and depth", () => {
    const shape = teamShape([
      p("gk", 2, 11),
      p("lb", 10, 4), p("cb", 9.5, 11), p("rb", 10.5, 18),
      p("cm", 17, 9), p("cm2", 18, 14),
      p("st", 26, 11),
    ], 40, "low")!;
    expect(shape.keeper).toBe("gk");
    expect(shape.lines).toEqual([["lb", "cb", "rb"], ["cm", "cm2"], ["st"]]);
    expect(shape.width).toBeCloseTo(14, 5);
    expect(shape.depth).toBeCloseTo(16.5, 5);
  });

  it("orders from the high end when the side defends it", () => {
    const shape = teamShape([p("gk", 38, 11), p("d", 30, 8), p("d2", 30, 14), p("f", 18, 11)], 40, "high")!;
    expect(shape.keeper).toBe("gk");
    expect(shape.lines).toEqual([["d", "d2"], ["f"]]);
  });

  it("finds the end it defends from its keeper when the direction is not known", () => {
    const shape = teamShape([p("a", 24, 5), p("b", 25, 15), p("k", 37, 11), p("c", 15, 11)], 40, null)!;
    expect(shape.defends).toBe("high");
    expect(shape.keeper).toBe("k");
    expect(shape.lines[0]).toEqual(["a", "b"]);
  });

  it("keeps the keeper in when asked", () => {
    const shape = teamShape([p("gk", 2, 11), p("a", 12, 5), p("b", 12, 15)], 40, "low", { keeper: false })!;
    expect(shape.keeper).toBeNull();
    expect(shape.depth).toBeCloseTo(10, 5);
  });

  it("is one line when nobody stands apart", () => {
    const shape = teamShape([p("a", 12, 5), p("b", 13, 10), p("c", 14, 15)], 40, null)!;
    expect(shape.keeper).toBeNull();
    expect(shape.lines).toEqual([["a", "b", "c"]]);
  });
});

describe("defendsAt", () => {
  it("follows the ends through a half-time swap", () => {
    const samples: Array<[number, 0 | 1 | null]> = [[0, 1], [1500, null], [1800, 0]];
    expect(defendsAt(samples, 0, 100)).toBe("high");
    expect(defendsAt(samples, 1, 100)).toBe("low");
    expect(defendsAt(samples, 0, 1600)).toBeNull();
    expect(defendsAt(samples, 0, 2000)).toBe("low");
  });
});
