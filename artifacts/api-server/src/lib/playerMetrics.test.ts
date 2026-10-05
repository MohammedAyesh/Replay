import { describe, expect, it } from "vitest";

import { buildPlayerMetrics, type ClaimedRange } from "./playerMetrics";

// A long 4000×200 px strip of 400×20 m: 1 px = 0.1 m in both directions, room for a minute of running.
const FPS = 20;
const manifest = {
  frameRate: FPS,
  width: 4000,
  height: 200,
  duration: 600,
  pitchModel: {
    calibrationId: "test",
    fittedAt: "2026-10-03T00:00:00.000Z",
    calibratedAspectRatio: 20,
    pitchWidthMetres: 400,
    pitchHeightMetres: 20,
    grid: [
      [{ x: 0, y: 0 }, { x: 400, y: 0 }],
      [{ x: 0, y: 20 }, { x: 400, y: 20 }],
    ],
  },
} as never;

type Box = { frame: number; x: number; y: number; w: number; h: number };

/** A box whose foot point is (footX, footY) in pixels. */
const box = (frame: number, footX: number, footY = 140): Box => ({ frame, x: footX - 10, y: footY - 40, w: 20, h: 40 });

/** A player running along the pitch at metresPerSecond from frame `from` for `seconds`. */
function run(from: number, seconds: number, metresPerSecond: number, startX = 20, footY = 140): Box[] {
  const boxes: Box[] = [];
  for (let i = 0; i <= seconds * FPS; i++) boxes.push(box(from + i, startX + (i / FPS) * metresPerSecond * 10, footY));
  return boxes;
}

function topSpeed(tracks: Array<{ id: string; boxes: Box[] }>, claimed: ClaimedRange[], coveredSeconds: number) {
  const segments = [{ tracks }] as never;
  const metrics = buildPlayerMetrics(manifest, segments, claimed, coveredSeconds, 0, 0, 0, 0, 0, 0, [], { bucketOfFrame: () => 0 });
  return { ...metrics.adminPlayerStats, frame: metrics.timing?.topSpeedFrame ?? null };
}

const whole = (id: string, boxes: Box[]): ClaimedRange => ({ trackId: id, fromFrame: boxes[0].frame, toFrame: boxes.at(-1)!.frame });

describe("top speed", () => {
  it("reads a steady run", () => {
    const boxes = run(0, 30, 6);
    const result = topSpeed([{ id: "t1", boxes }], [whole("t1", boxes)], 30);
    expect(result.topSpeedMetresPerSecond).toBeCloseTo(6, 1);
    expect(result.topSpeedUsableTimeFraction).toBeGreaterThan(0.9);
  });

  it("one bad second drops only its own steps, not the rest of the match", () => {
    // The shipped 10 Hz version invalidated every sample after the first bad one.
    const boxes = run(0, 60, 5).map((b) => (b.frame >= 200 && b.frame < 220 ? { ...b, x: b.x + 150 } : b));
    const result = topSpeed([{ id: "t1", boxes }], [whole("t1", boxes)], 60);
    expect(result.topSpeedMetresPerSecond).toBeCloseTo(5, 1);
    expect(result.topSpeedUsableTimeFraction).toBeGreaterThan(0.85);
  });

  it("a hand-over between two tracks is not a sprint", () => {
    const standingA = run(0, 20, 0, 50);
    const standingB = run(401, 20, 0, 350);
    const result = topSpeed(
      [{ id: "t1", boxes: standingA }, { id: "t2", boxes: standingB }],
      [whole("t1", standingA), whole("t2", standingB)],
      40,
    );
    expect(result.topSpeedMetresPerSecond).toBeLessThan(0.5);
  });

  it("frame-to-frame box jitter does not read as speed", () => {
    // ±3 px (0.3 m) every frame: differencing raw positions at 10 Hz reads ~6 m/s.
    const boxes = run(0, 30, 0, 200).map((b) => ({ ...b, x: b.x + (b.frame % 2 ? 3 : -3) }));
    const result = topSpeed([{ id: "t1", boxes }], [whole("t1", boxes)], 30);
    expect(result.topSpeedMetresPerSecond).toBeLessThan(1);
  });

  it("skips pieces shorter than 8 seconds", () => {
    const fragment = run(0, 6, 8.5);
    const long = run(200, 30, 5);
    const result = topSpeed(
      [{ id: "t1", boxes: fragment }, { id: "t2", boxes: long }],
      [whole("t1", fragment), whole("t2", long)],
      36,
    );
    expect(result.topSpeedMetresPerSecond).toBeCloseTo(5, 1);
    expect(result.frame).toBeGreaterThanOrEqual(200);
  });

  it("ignores the start and end of a piece", () => {
    // A burst in the first half-second and the last second, walking in between.
    const boxes: Box[] = [];
    let x = 20;
    for (let frame = 0; frame <= 30 * FPS; frame++) {
      const t = frame / FPS;
      x += (t < 0.5 || t > 29 ? 8.5 : 2) * 10 / FPS;
      boxes.push(box(frame, x));
    }
    const result = topSpeed([{ id: "t1", boxes }], [whole("t1", boxes)], 30);
    expect(result.topSpeedMetresPerSecond).toBeLessThan(3);
  });

  it("does not measure in the far third, where a pixel is too many metres", () => {
    const boxes = run(0, 30, 6, 20, 40); // foot at 4 m from the far line
    const result = topSpeed([{ id: "t1", boxes }], [whole("t1", boxes)], 30);
    expect(result.topSpeedMetresPerSecond).toBeNull();
  });
});

function distance(boxes: Box[], seconds: number) {
  const segments = [{ tracks: [{ id: "t1", boxes }] }] as never;
  return buildPlayerMetrics(manifest, segments, [whole("t1", boxes)], seconds, 0, 0, 0, 0, 0, 0, []).distanceMetres!;
}

/** ±4 px (0.4 m) of irregular wobble on the foot point, the way a detection box moves frame to frame. */
const wobble = (boxes: Box[]) => boxes.map((b) => ({
  ...b,
  x: b.x + 4 * Math.sin(b.frame * 1.7) * Math.cos(b.frame * 0.37),
  y: b.y + 4 * Math.sin(b.frame * 2.3 + 1),
}));

describe("distance", () => {
  it("reads a steady run", () => {
    expect(distance(run(0, 60, 3), 60)).toBeGreaterThan(170);
    expect(distance(run(0, 60, 3), 60)).toBeLessThan(181);
  });

  it("does not count box wobble while standing still as running", () => {
    // Summing every 10 Hz step read this as several hundred metres a minute.
    expect(distance(wobble(run(0, 60, 0, 200)), 60)).toBeLessThan(12);
  });

  it("adds little to a run when the box wobbles", () => {
    const clean = distance(run(0, 60, 3), 60);
    const noisy = distance(wobble(run(0, 60, 3)), 60);
    expect(noisy).toBeLessThan(clean * 1.08);
  });

  it("still breaks the path at a gap of more than 2 s", () => {
    const first = run(0, 20, 0, 50);
    const second = run(20 * FPS + 100, 20, 0, 350); // 5 s later, 30 m away
    expect(distance([...first, ...second], 40)).toBeLessThan(5);
  });
});
