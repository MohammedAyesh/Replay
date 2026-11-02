/**
 * SceneCanvas editing maths, in canvas pixels (1080-wide design space).
 * Pure, so the gestures behave the same at any preview width.
 */

export type Box = { x: number; y: number; w: number; h: number; rotation: number };
export type Corner = "nw" | "ne" | "se" | "sw";

export const MIN_SIZE = 8;

const rad = (deg: number) => (deg * Math.PI) / 180;
function rotate(x: number, y: number, deg: number): [number, number] {
  const c = Math.cos(rad(deg));
  const s = Math.sin(rad(deg));
  return [x * c - y * s, x * s + y * c];
}

export type Snap = { x: boolean; y: boolean };

/** Move by (dx, dy); the box's centre snaps to the canvas's centre lines within `threshold`. */
export function moveBox(start: Box, dx: number, dy: number, canvas: { w: number; h: number }, threshold: number): { box: Box; snap: Snap } {
  let x = start.x + dx;
  let y = start.y + dy;
  const snap = { x: false, y: false };
  if (Math.abs(x + start.w / 2 - canvas.w / 2) <= threshold) { x = canvas.w / 2 - start.w / 2; snap.x = true; }
  if (Math.abs(y + start.h / 2 - canvas.h / 2) <= threshold) { y = canvas.h / 2 - start.h / 2; snap.y = true; }
  return { box: { ...start, x, y }, snap };
}

const SIGN: Record<Corner, [number, number]> = { nw: [-1, -1], ne: [1, -1], se: [1, 1], sw: [-1, 1] };

/**
 * Resize from a corner to pointer P (canvas px), the opposite corner staying
 * where it is on screen, in the box's own (rotated) frame. `keepAspect` keeps w:h.
 */
export function resizeBox(start: Box, corner: Corner, px: number, py: number, keepAspect = false): Box {
  const [sx, sy] = SIGN[corner];
  const cx = start.x + start.w / 2;
  const cy = start.y + start.h / 2;
  const [ax, ay] = rotate((-sx * start.w) / 2, (-sy * start.h) / 2, start.rotation);
  const anchor = [cx + ax, cy + ay];
  const [lx, ly] = rotate(px - anchor[0], py - anchor[1], -start.rotation);
  let w = Math.max(MIN_SIZE, sx * lx);
  let h = Math.max(MIN_SIZE, sy * ly);
  if (keepAspect && start.w > 0 && start.h > 0) {
    const k = Math.max(w / start.w, h / start.h);
    w = Math.max(MIN_SIZE, start.w * k);
    h = Math.max(MIN_SIZE, start.h * k);
  }
  const [ox, oy] = rotate((sx * w) / 2, (sy * h) / 2, start.rotation);
  const ncx = anchor[0] + ox;
  const ncy = anchor[1] + oy;
  return { ...start, x: ncx - w / 2, y: ncy - h / 2, w, h };
}

/** Rotation (degrees, −180…180) that points the box's top at P; snaps to right angles, or 15° steps with `step`. */
export function rotationTo(start: Box, px: number, py: number, step = false): number {
  const cx = start.x + start.w / 2;
  const cy = start.y + start.h / 2;
  let deg = (Math.atan2(py - cy, px - cx) * 180) / Math.PI + 90;
  if (step) deg = Math.round(deg / 15) * 15;
  else {
    const right = Math.round(deg / 90) * 90;
    if (Math.abs(deg - right) <= 4) deg = right;
  }
  deg = ((((deg + 180) % 360) + 360) % 360) - 180;
  return Math.abs(deg) < 1e-9 ? 0 : Math.round(deg * 10) / 10;
}

/** Whole pixels for x/y/w/h, a tenth of a degree for rotation. */
export function tidy(box: Box): Box {
  return { x: Math.round(box.x), y: Math.round(box.y), w: Math.max(1, Math.round(box.w)), h: Math.max(1, Math.round(box.h)), rotation: Math.round(box.rotation * 10) / 10 };
}
