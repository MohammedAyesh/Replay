import { describe, expect, it } from "vitest";
import { BALL_TRAIL, ballTrailAt, drawBallTrail, type BallTrailSample, type TrailContext } from "@workspace/api-zod";

/** A ball rolling right at `speed` frame widths per second, sampled at `hz`. */
function rolling(from: number, to: number, hz: number, speed = 0.2, x0 = 0.2, y = 0.5): BallTrailSample[] {
  const out: BallTrailSample[] = [];
  for (let t = from; t <= to + 1e-9; t += 1 / hz) out.push([Math.round(t * 1000) / 1000, x0 + (t - from) * speed, y]);
  return out;
}

describe("ballTrailAt", () => {
  it("draws the last ~0.9 s behind a moving ball, ending on it", () => {
    const path = rolling(10, 20, 20);
    const trail = ballTrailAt(path, 15.025)!;
    expect(trail).not.toBeNull();
    const head = trail[trail.length - 1];
    expect(head.t).toBeCloseTo(15.025, 3);
    expect(head.x).toBeCloseTo(0.2 + 5.025 * 0.2, 3);
    expect(trail[0].t).toBeCloseTo(15.025 - BALL_TRAIL.seconds, 2);
    for (let i = 1; i < trail.length; i++) expect(trail[i].t).toBeGreaterThanOrEqual(trail[i - 1].t);
  });

  it("never draws across a gap in the path", () => {
    const path = [...rolling(10, 12, 20), ...rolling(13, 15, 20, 0.2, 0.6)];
    const trail = ballTrailAt(path, 13.3)!;
    expect(trail[0].t).toBeGreaterThanOrEqual(13 - 1e-6);
  });

  it("stops at a jump no ball could make (the path restarting on a boot)", () => {
    const path = [...rolling(10, 12, 20), ...rolling(12.05, 14, 20, 0.2, 0.9)];
    const trail = ballTrailAt(path, 12.5)!;
    expect(trail[0].t).toBeGreaterThanOrEqual(12.05 - 1e-6);
    expect(Math.min(...trail.map((p) => p.x))).toBeGreaterThan(0.85);
  });

  it("draws nothing for a ball at rest", () => {
    const still: BallTrailSample[] = Array.from({ length: 40 }, (_, i) => [10 + i / 20, 0.5, 0.5]);
    expect(ballTrailAt(still, 11)).toBeNull();
  });

  it("draws nothing once the ball is lost", () => {
    const path = rolling(10, 12, 20);
    expect(ballTrailAt(path, 12.1)).not.toBeNull();
    expect(ballTrailAt(path, 12.5)).toBeNull();
    expect(ballTrailAt(path, 5)).toBeNull();
  });

  it("curves a 4-per-second path into a smooth streak", () => {
    const path = rolling(10, 20, 4);
    const trail = ballTrailAt(path, 15.1)!;
    expect(trail.length).toBeGreaterThan(20);
  });
});

describe("drawBallTrail", () => {
  it("strokes thin and faint at the tail, wide and solid at the ball", () => {
    const strokes: Array<{ w: number; style: string }> = [];
    let w = 0;
    let style = "";
    const ctx = {
      lineCap: "", lineJoin: "", globalCompositeOperation: "",
      get lineWidth() { return w; }, set lineWidth(v: number) { w = v; },
      get strokeStyle() { return style; }, set strokeStyle(v: unknown) { style = String(v); },
      beginPath() {}, moveTo() {}, lineTo() {}, save() {}, restore() {},
      stroke() { strokes.push({ w, style }); },
    } as unknown as TrailContext;
    const trail = ballTrailAt(rolling(10, 20, 20), 15)!;
    drawBallTrail(ctx, trail, (x, y) => [x * 1000, y * 300], 10);
    const main = strokes.slice(strokes.length / 2);
    expect(main[0].w).toBeLessThan(main[main.length - 1].w);
    expect(main[main.length - 1].w).toBeCloseTo(10, 1);
    expect(main[main.length - 1].style).toMatch(/^rgba\(255,38,38,0\.9/);
  });
});
