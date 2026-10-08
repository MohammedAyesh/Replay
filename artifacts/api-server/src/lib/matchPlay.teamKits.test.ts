import { describe, expect, it } from "vitest";
import {
  assignObservedKits,
  hexToLab,
  kitDistance,
  observedTeamKits,
  type BallSidecar,
  type Lab,
} from "./matchPlay";

const sidecar = (kits: Array<[number, number, number, number]>): BallSidecar => ({
  v: 1,
  fps: 20,
  touches: [],
  ball: [],
  kits: Object.fromEntries(kits.map((k, i) => [`t${i}`, k])),
});

// PNKLTQ (rec cam1_2026_10_05_22_00, 2026-10-05), segment c2 as the bundle has it:
// every track's [L, a, b, seconds]. White shirts read L 130-180 on this camera,
// the navy ones L 40-75. The booking said white v ORANGE.
const PNKLTQ_C2: Array<[number, number, number, number]> = [
  [48.6, 129.0, 128.4, 600.0], [159.0, 128.7, 129.8, 600.0], [44.1, 128.7, 128.9, 598.5], [173.9, 128.5, 129.6, 591.3],
  [56.4, 128.9, 128.6, 595.6], [60.8, 130.9, 122.1, 594.5], [168.4, 128.9, 129.5, 600.0], [131.4, 129.2, 129.3, 594.5],
  [161.5, 129.9, 128.6, 600.0], [51.8, 128.5, 129.2, 600.0], [152.0, 129.4, 130.5, 532.0], [166.2, 129.1, 128.8, 588.9],
  [63.7, 129.6, 124.2, 582.7], [158.5, 128.7, 129.8, 590.8], [47.3, 129.0, 128.9, 460.9], [48.0, 129.3, 126.7, 600.0],
  [136.4, 128.4, 130.6, 593.7], [167.7, 128.6, 129.9, 535.1], [72.7, 129.0, 128.7, 566.6], [71.1, 128.5, 128.3, 433.8],
  [174.1, 129.9, 127.3, 539.7], [70.7, 130.5, 123.1, 432.1], [161.7, 128.8, 130.8, 456.7], [66.5, 129.7, 123.6, 491.7],
  [52.0, 128.7, 130.3, 474.1], [53.4, 131.5, 121.7, 237.0], [64.8, 129.5, 126.7, 493.4], [56.7, 129.0, 126.9, 432.5],
  [155.0, 129.4, 129.8, 511.9], [161.2, 127.4, 131.4, 12.1], [152.7, 129.0, 130.6, 280.8], [72.2, 131.3, 125.8, 509.2],
  [43.1, 130.9, 126.9, 63.5], [13.8, 128.0, 129.5, 10.0], [64.5, 130.1, 126.5, 569.1], [45.3, 130.4, 127.2, 4.2],
  [50.3, 130.2, 124.7, 4.3], [125.0, 129.5, 129.3, 511.7], [131.2, 130.0, 131.0, 2.4], [87.6, 131.0, 126.7, 222.7],
  [162.4, 130.4, 129.9, 3.1], [49.4, 129.3, 127.6, 10.1], [47.3, 128.4, 128.1, 3.0], [179.1, 129.0, 130.1, 4.2],
  [154.2, 129.7, 129.1, 2.8], [134.2, 129.4, 132.6, 4.2], [145.0, 128.9, 131.7, 3.5], [49.3, 129.0, 129.8, 2.4],
  [56.3, 130.4, 128.0, 2.1], [156.5, 130.7, 127.7, 3.0],
];

describe("observedTeamKits", () => {
  it("finds white and navy in the PNKLTQ footage", () => {
    const o = observedTeamKits([sidecar(PNKLTQ_C2)]);
    expect(o).not.toBeNull();
    const [light, dark] = [...o!.kits].sort((p, q) => q[0] - p[0]);
    expect(light[0]).toBeGreaterThan(130);
    expect(dark[0]).toBeLessThan(75);
    expect(Math.min(...o!.share)).toBeGreaterThan(0.3);
    expect(o!.separation).toBeGreaterThan(40);
  });

  it("puts white on the white side and navy on the orange side when nobody has claimed", () => {
    const o = observedTeamKits([sidecar(PNKLTQ_C2)])!;
    const [a, b] = assignObservedKits(o.kits, [
      { measured: null, swatch: hexToLab("#F2F4F8") },
      { measured: null, swatch: hexToLab("#FF6B1A") },
    ]);
    expect(a[0]).toBeGreaterThan(130); // white
    expect(b[0]).toBeLessThan(75); // navy, not orange
  });

  it("splits teams that differ only in hue", () => {
    const red: Array<[number, number, number, number]> = Array.from({ length: 6 }, (_, i) => [120 + i, 165, 150, 500]);
    const blue: Array<[number, number, number, number]> = Array.from({ length: 6 }, (_, i) => [118 + i, 135, 90, 500]);
    const o = observedTeamKits([sidecar([...red, ...blue])]);
    expect(o).not.toBeNull();
    const reds = o!.kits.filter((k) => k[1] > 150);
    expect(reds).toHaveLength(1);
  });

  it("says nothing when the pitch shows one shirt, or when the second colour is a referee", () => {
    const one: Array<[number, number, number, number]> = Array.from({ length: 10 }, (_, i) => [150 + i, 129, 129, 500]);
    expect(observedTeamKits([sidecar(one)])).toBeNull();
    const ref: Array<[number, number, number, number]> = [...one, [60, 170, 170, 300]];
    expect(observedTeamKits([sidecar(ref)])).toBeNull(); // 300 s of 5300 is under the 15% floor
  });

  it("reads only the segments it is given", () => {
    const white = sidecar(Array.from({ length: 8 }, (_, i) => [160 + i, 129, 129, 500]));
    expect(observedTeamKits([sidecar(PNKLTQ_C2), white], new Set([1]))).toBeNull();
    expect(observedTeamKits([sidecar(PNKLTQ_C2), white], new Set([0]))).not.toBeNull();
  });
});

describe("assignObservedKits", () => {
  const W: Lab = [160, 129, 129];
  const N: Lab = [55, 129, 127];
  it("keeps a measured side and gives the other side the other shirt", () => {
    const measuredNavy: Lab = [58, 130, 126];
    const [a, b] = assignObservedKits([W, N], [{ measured: null, swatch: hexToLab("#FFFFFF") }, { measured: measuredNavy, swatch: null }]);
    expect(b).toEqual(measuredNavy);
    expect(kitDistance(a, W)).toBe(0);
  });
  it("leaves two measured sides alone", () => {
    const x: Lab = [100, 128, 128];
    const y: Lab = [101, 128, 128];
    expect(assignObservedKits([W, N], [{ measured: x, swatch: null }, { measured: y, swatch: null }])).toEqual([x, y]);
  });
  it("follows the booked colours when they are right", () => {
    const [a, b] = assignObservedKits([W, N], [
      { measured: null, swatch: hexToLab("#101828") },
      { measured: null, swatch: hexToLab("#FFFFFF") },
    ]);
    expect(a).toEqual(N);
    expect(b).toEqual(W);
  });
});
