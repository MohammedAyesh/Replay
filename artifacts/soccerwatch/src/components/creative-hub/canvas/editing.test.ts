import { describe, expect, it } from "vitest";
import { moveBox, resizeBox, rotationTo, tidy } from "./editing";
import * as client from "./layout";

const box = { x: 100, y: 100, w: 200, h: 100, rotation: 0 };

describe("scene canvas gestures", () => {
  it("moves and snaps the centre to the canvas centre lines", () => {
    const free = moveBox(box, 10, 10, { w: 1080, h: 1080 }, 8);
    expect(free.box).toMatchObject({ x: 110, y: 110 });
    expect(free.snap).toEqual({ x: false, y: false });
    const snapped = moveBox(box, 335, 0, { w: 1080, h: 1080 }, 8); // centre at 535 → 540
    expect(snapped.box.x).toBe(440);
    expect(snapped.snap.x).toBe(true);
  });

  it("resizes from a corner keeping the opposite corner fixed", () => {
    expect(resizeBox(box, "se", 400, 300)).toMatchObject({ x: 100, y: 100, w: 300, h: 200 });
    expect(resizeBox(box, "nw", 50, 50)).toMatchObject({ x: 50, y: 50, w: 250, h: 150 });
    // Rotated 90°: the anchor (top-left in the box's frame) stays where it is on screen.
    const r = { ...box, rotation: 90 };
    const out = resizeBox(r, "se", 200, 150);
    const anchor = (b: typeof r) => {
      const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
      return [cx + b.h / 2, cy - b.w / 2]; // (-w/2, -h/2) rotated by 90°
    };
    expect(anchor(out)[0]).toBeCloseTo(anchor(r)[0]);
    expect(anchor(out)[1]).toBeCloseTo(anchor(r)[1]);
  });

  it("rotates towards the pointer and snaps to right angles", () => {
    expect(rotationTo(box, 200, 0)).toBe(0); // straight above the centre
    expect(rotationTo(box, 500, 152)).toBe(90); // a little off the right angle
    expect(rotationTo(box, 300, 50, true) % 15).toBe(0);
    expect(tidy({ x: 1.4, y: 2.6, w: 0.2, h: 3.5, rotation: 12.345 })).toEqual({ x: 1, y: 3, w: 1, h: 4, rotation: 12.3 });
  });
});

describe("client layout copy", () => {
  it("matches the API's text layout and video timeline", () => {
    const measure = (s: string, size: number) => s.length * size * 0.5;
    const layer = { size: 100, w: 500, h: 120, fit: true, align: "center" as const };
    const out = client.layoutText(layer, "FULL TIME TODAY", "ltr", false, measure);
    expect(out.size).toBeLessThan(100);
    expect(Math.max(...out.widths)).toBeLessThanOrEqual(500.5);
    const parts = client.videoParts({ trimInMs: 1000, trimOutMs: 7000, speed: 2, slowMo: { fromMs: 3000, toMs: 4000, speed: 0.25 } }, 10_000, 5000);
    expect(parts.map((p) => p.speed)).toEqual([2, 0.5, 2]);
  });
});
