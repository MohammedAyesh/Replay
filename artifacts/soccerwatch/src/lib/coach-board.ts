import {
  coachBoxAt,
  coachFeet,
  coachShapeVisible,
  type CoachBall,
  type CoachBoard,
  type CoachBox,
  type CoachShape,
  type CoachSpotlight,
  type CoachTracks,
  type CoachView,
} from "@workspace/api-zod";

/**
 * Coach board geometry and drawing (components/coach-board). The camera frame
 * (the panorama) is fitted into the stage, zoomed and moved by a CoachView;
 * everything drawn over it is kept in shares of the frame and mapped to the
 * screen here, so drawings stay on the pitch through zoom and resizes.
 */

export type Rect = { left: number; top: number; width: number; height: number };
export type Pt = [number, number];

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 6;
export const WHOLE: CoachView = { zoom: 1, cx: 0.5, cy: 0.5 };

/** Where the whole frame sits on the stage for a view (it may run off the stage when zoomed). */
export function frameRect(stageW: number, stageH: number, aspect: number, view: CoachView): Rect {
  const baseW = Math.max(1, Math.min(stageW, stageH * aspect));
  const baseH = baseW / aspect;
  const width = baseW * view.zoom;
  const height = baseH * view.zoom;
  let left = stageW / 2 - view.cx * width;
  let top = stageH / 2 - view.cy * height;
  left = width >= stageW ? Math.min(0, Math.max(stageW - width, left)) : (stageW - width) / 2;
  top = height >= stageH ? Math.min(0, Math.max(stageH - height, top)) : (stageH - height) / 2;
  return { left, top, width, height };
}

/** The view a rect actually shows (centre read back after clamping), so stored views never drift off the frame. */
export function viewOf(rect: Rect, stageW: number, stageH: number, zoom: number): CoachView {
  const cx = (stageW / 2 - rect.left) / rect.width;
  const cy = (stageH / 2 - rect.top) / rect.height;
  return { zoom, cx: Math.min(1, Math.max(0, cx)), cy: Math.min(1, Math.max(0, cy)) };
}

export const toScreen = (r: Rect, p: Pt): Pt => [r.left + p[0] * r.width, r.top + p[1] * r.height];
export const toShare = (r: Rect, sx: number, sy: number): Pt => [(sx - r.left) / r.width, (sy - r.top) / r.height];

/** Zoom by `factor` keeping the point under (px, py) where it is. */
export function zoomAt(view: CoachView, stageW: number, stageH: number, aspect: number, px: number, py: number, factor: number): CoachView {
  const rect = frameRect(stageW, stageH, aspect, view);
  const p = toShare(rect, px, py);
  const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, view.zoom * factor));
  const probe = frameRect(stageW, stageH, aspect, { ...view, zoom });
  const left = px - p[0] * probe.width;
  const top = py - p[1] * probe.height;
  const next: CoachView = { ...view, zoom, cx: (stageW / 2 - left) / probe.width, cy: (stageH / 2 - top) / probe.height };
  return viewOf(frameRect(stageW, stageH, aspect, next), stageW, stageH, zoom);
}

/** Move the view by a screen drag of (dx, dy). */
export function panBy(view: CoachView, stageW: number, stageH: number, aspect: number, dx: number, dy: number): CoachView {
  const rect = frameRect(stageW, stageH, aspect, view);
  const moved: Rect = { ...rect, left: rect.left + dx, top: rect.top + dy };
  const next = viewOf(moved, stageW, stageH, view.zoom);
  return viewOf(frameRect(stageW, stageH, aspect, { ...view, ...next }), stageW, stageH, view.zoom);
}

// ── Tracks ───────────────────────────────────────────────────────────────────

/** Tracks loaded so far: every player's boxes merged by time, and the stretches already asked for. */
export type TrackStore = {
  players: Map<string, CoachBox[]>;
  ball: CoachBall[];
  covered: Array<[number, number]>;
};

export const emptyTrackStore = (): TrackStore => ({ players: new Map(), ball: [], covered: [] });

function mergeSorted<T extends ReadonlyArray<number>>(a: T[], b: T[]): T[] {
  if (!a.length) return b;
  if (!b.length) return a;
  const out: T[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    const x = a[i];
    const y = b[j];
    const next = y === undefined || (x !== undefined && x[0] < y[0]) ? (i++, x) : (j++, y);
    const last = out[out.length - 1];
    if (last && Math.abs(last[0] - next[0]) < 1e-6) continue;
    out.push(next);
  }
  return out;
}

export function mergeTracks(store: TrackStore, add: CoachTracks): TrackStore {
  const players = new Map(store.players);
  for (const [id, boxes] of Object.entries(add.players)) players.set(id, mergeSorted(players.get(id) ?? [], boxes));
  const covered = [...store.covered, [add.from, add.to] as [number, number]].sort((x, y) => x[0] - y[0]);
  const merged: Array<[number, number]> = [];
  for (const span of covered) {
    const last = merged[merged.length - 1];
    if (last && span[0] <= last[1] + 0.01) last[1] = Math.max(last[1], span[1]);
    else merged.push([span[0], span[1]]);
  }
  return { players, ball: mergeSorted(store.ball, add.ball), covered: merged };
}

/** The next stretch to load so [t - behind, t + ahead] is covered, or null when it already is. */
export function missingWindow(store: TrackStore, t: number, behind = 5, ahead = 30, chunk = 60): [number, number] | null {
  const want: [number, number] = [Math.max(0, t - behind), t + ahead];
  const holding = store.covered.find((c) => c[0] <= want[0] + 1e-6 && c[1] >= want[0]);
  if (holding && holding[1] >= want[1]) return null;
  const from = holding ? holding[1] : want[0];
  return [Math.max(0, Math.floor(from * 10) / 10), Math.floor(from * 10) / 10 + chunk];
}

/** Each player's box at `t` (only those tracked there). */
export function boxesAt(store: TrackStore, t: number, only?: ReadonlySet<string>): Map<string, [number, number, number, number]> {
  const out = new Map<string, [number, number, number, number]>();
  for (const [id, boxes] of store.players) {
    if (only && !only.has(id)) continue;
    const b = coachBoxAt(boxes, t);
    if (b) out.set(id, b);
  }
  return out;
}

/**
 * The player under a tap, as a share of the frame: inside a box grown by half
 * its width (players are small on a panorama), nearest box centre first.
 */
export function hitPlayer(boxes: Map<string, [number, number, number, number]>, p: Pt): string | null {
  let best: string | null = null;
  let bestD = Infinity;
  for (const [id, [x, y, w, h]] of boxes) {
    const gx = w * 0.5;
    const gy = h * 0.2;
    if (p[0] < x - gx || p[0] > x + w + gx || p[1] < y - gy || p[1] > y + h + gy) continue;
    const d = Math.hypot(p[0] - (x + w / 2), (p[1] - (y + h / 2)) * 0.5);
    if (d < bestD) { bestD = d; best = id; }
  }
  return best;
}

/** Where the ball is at `t` (the nearest sighting within 0.3 s) and where it was over the last second. */
export function ballAt(ball: ReadonlyArray<CoachBall>, t: number): { at: Pt | null; trail: Pt[] } {
  if (!ball.length) return { at: null, trail: [] };
  let lo = 0;
  let hi = ball.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (ball[mid][0] < t) lo = mid + 1; else hi = mid; }
  let at: CoachBall | null = null;
  for (const i of [lo - 1, lo]) {
    const s = ball[i];
    if (s && Math.abs(s[0] - t) <= 0.3 && (!at || Math.abs(s[0] - t) < Math.abs(at[0] - t))) at = s;
  }
  const trail: Pt[] = [];
  for (let i = Math.min(lo, ball.length) - 1; i >= 0 && ball[i][0] >= t - 1; i--) trail.unshift([ball[i][1], ball[i][2]]);
  return { at: at ? [at[1], at[2]] : null, trail };
}

/** A centre that eases towards a target instead of jumping with every box (the follow camera). */
export function easeTowards(current: Pt, target: Pt, a = 0.12): Pt {
  return [current[0] + (target[0] - current[0]) * a, current[1] + (target[1] - current[1]) * a];
}

/** The two short strokes of an arrow head at `to`, in screen space. */
export function arrowHead(from: Pt, to: Pt, size: number): [Pt, Pt] {
  const ang = Math.atan2(to[1] - from[1], to[0] - from[0]);
  const spread = Math.PI / 7;
  return [
    [to[0] - size * Math.cos(ang - spread), to[1] - size * Math.sin(ang - spread)],
    [to[0] - size * Math.cos(ang + spread), to[1] - size * Math.sin(ang + spread)],
  ];
}

/** Thin a freehand stroke: drop points closer than `min` to the last kept one (screen px). */
export function thinStroke(points: Pt[], min: number): Pt[] {
  const out: Pt[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) >= min) out.push(p);
  }
  const end = points[points.length - 1];
  if (end && out[out.length - 1] !== end) out.push(end);
  return out;
}

// ── Drawing ──────────────────────────────────────────────────────────────────

export type PlayerLabel = (rosterId: string) => string;

export type DrawInput = {
  rect: Rect;
  dpr: number;
  /** video seconds */
  t: number;
  paused: boolean;
  board: CoachBoard;
  /** a shape being drawn right now */
  draft?: CoachShape | null;
  store: TrackStore;
  label: PlayerLabel;
  /** dim the picture around spotlighted players */
  dim?: boolean;
};

const rgba = (hex: string, a: number) => {
  const n = parseInt(hex.slice(1, 7), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};

function strokePath(ctx: CanvasRenderingContext2D, pts: Pt[], close = false) {
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
  if (close) ctx.closePath();
}

function drawShape(ctx: CanvasRenderingContext2D, s: CoachShape, rect: Rect, dpr: number, alpha = 1) {
  const S = (p: Pt): Pt => { const [x, y] = toScreen(rect, p); return [x * dpr, y * dpr]; };
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = s.color;
  ctx.fillStyle = s.color;
  ctx.shadowColor = "rgba(0,0,0,0.55)";
  ctx.shadowBlur = 6 * dpr;
  const w = ("width" in s ? s.width : 3) * dpr;
  ctx.lineWidth = w;
  if ((s.kind === "arrow" || s.kind === "line") && s.dashed) ctx.setLineDash([w * 2.5, w * 2]);
  switch (s.kind) {
    case "pen":
      strokePath(ctx, s.points.map(S));
      ctx.stroke();
      break;
    case "line":
      strokePath(ctx, [S(s.from), S(s.to)]);
      ctx.stroke();
      break;
    case "arrow": {
      const a = S(s.from);
      const b = S(s.to);
      strokePath(ctx, [a, b]);
      ctx.stroke();
      ctx.setLineDash([]);
      const [h1, h2] = arrowHead(a, b, Math.max(14 * dpr, w * 4));
      strokePath(ctx, [h1, b, h2]);
      ctx.stroke();
      break;
    }
    case "circle": {
      const a = S(s.from);
      const b = S(s.to);
      ctx.beginPath();
      ctx.ellipse((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, Math.max(2, Math.abs(b[0] - a[0]) / 2), Math.max(2, Math.abs(b[1] - a[1]) / 2), 0, 0, Math.PI * 2);
      ctx.stroke();
      break;
    }
    case "zone":
      strokePath(ctx, s.points.map(S), true);
      ctx.fillStyle = rgba(s.color, 0.22);
      ctx.fill();
      ctx.lineWidth = 2 * dpr;
      ctx.stroke();
      break;
    case "text": {
      const [x, y] = S(s.at);
      const size = (s.size ?? 20) * dpr;
      ctx.font = `700 ${size}px Inter, Cairo, system-ui, sans-serif`;
      ctx.textBaseline = "middle";
      ctx.textAlign = "center";
      ctx.direction = /[؀-ۿ]/.test(s.text) ? "rtl" : "ltr";
      const m = ctx.measureText(s.text);
      const pw = m.width + size * 0.9;
      const ph = size * 1.6;
      ctx.shadowBlur = 0;
      ctx.fillStyle = "rgba(11,15,26,0.82)";
      ctx.beginPath();
      ctx.roundRect(x - pw / 2, y - ph / 2, pw, ph, ph / 3);
      ctx.fill();
      ctx.fillStyle = s.color;
      ctx.fillText(s.text, x, y + size * 0.04);
      break;
    }
  }
  ctx.restore();
}

/** Draw the whole board over the video for time `t`. The canvas is the stage, in device pixels. */
export function drawBoard(ctx: CanvasRenderingContext2D, d: DrawInput) {
  const { rect, dpr, t, board, store } = d;
  const tMs = t * 1000;
  const S = (p: Pt): Pt => { const [x, y] = toScreen(rect, p); return [x * dpr, y * dpr]; };
  const spotIds = new Set(board.spotlights.map((s) => s.rosterId));
  const boxes = spotIds.size ? boxesAt(store, t, spotIds) : new Map<string, [number, number, number, number]>();

  // Spotlights: the picture dimmed around them, then a ring at each one's feet and his name.
  if (boxes.size && d.dim !== false) {
    ctx.save();
    ctx.fillStyle = "rgba(0,0,0,0.42)";
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.globalCompositeOperation = "destination-out";
    for (const [, b] of boxes) {
      const [cx, cy] = S([b[0] + b[2] / 2, b[1] + b[3] / 2]);
      const rx = Math.max(18 * dpr, b[2] * rect.width * dpr * 1.6);
      const ry = Math.max(30 * dpr, b[3] * rect.height * dpr * 0.85);
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(rx, ry));
      g.addColorStop(0, "rgba(0,0,0,1)");
      g.addColorStop(0.7, "rgba(0,0,0,0.9)");
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  // Lines between spotlighted players, in the order they were picked.
  if (board.connect && boxes.size >= 2) {
    const feet = board.spotlights.map((s) => boxes.get(s.rosterId)).filter((b): b is [number, number, number, number] => Boolean(b)).map((b) => S(coachFeet(b)));
    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.lineWidth = 2.5 * dpr;
    ctx.setLineDash([8 * dpr, 6 * dpr]);
    strokePath(ctx, feet, feet.length >= 3);
    if (feet.length >= 3) { ctx.fillStyle = "rgba(212,255,79,0.10)"; ctx.fill(); }
    ctx.stroke();
    ctx.restore();
  }

  for (const spot of board.spotlights) {
    const b = boxes.get(spot.rosterId);
    if (!b) continue;
    drawSpotlight(ctx, spot, b, S, rect, dpr, spot.label || d.label(spot.rosterId));
  }

  // The ball and its last second.
  if (board.ball) {
    const ball = ballAt(store.ball, t);
    if (ball.trail.length >= 2) {
      ctx.save();
      ctx.strokeStyle = "rgba(255,90,60,0.85)";
      ctx.lineWidth = 3 * dpr;
      ctx.lineCap = "round";
      strokePath(ctx, ball.trail.map(S));
      ctx.stroke();
      ctx.restore();
    }
    if (ball.at) {
      const [x, y] = S(ball.at);
      ctx.save();
      ctx.strokeStyle = "#FF5A3C";
      ctx.lineWidth = 2.5 * dpr;
      ctx.beginPath();
      ctx.arc(x, y, 9 * dpr, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  // Drawings: while paused near their moment they are solid; playing through they fade out.
  for (const s of board.shapes) {
    if (!coachShapeVisible(s, tMs)) continue;
    const away = Math.abs(tMs - s.atMs);
    drawShape(ctx, s, rect, dpr, d.paused ? 1 : Math.max(0.15, 1 - away / 900));
  }
  if (d.draft) drawShape(ctx, d.draft, rect, dpr, 0.9);
}

function drawSpotlight(
  ctx: CanvasRenderingContext2D,
  spot: CoachSpotlight,
  b: [number, number, number, number],
  S: (p: Pt) => Pt,
  rect: Rect,
  dpr: number,
  label: string,
) {
  const [fx, fy] = S(coachFeet(b));
  const [, top] = S([b[0], b[1]]);
  const rx = Math.max(16 * dpr, b[2] * rect.width * dpr * 1.1);
  const ry = rx * 0.32;
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.6)";
  ctx.shadowBlur = 8 * dpr;
  ctx.strokeStyle = spot.color;
  ctx.lineWidth = 3 * dpr;
  ctx.beginPath();
  ctx.ellipse(fx, fy, rx, ry, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = rgba(spot.color, 0.18);
  ctx.fill();
  // A marker over his head, then his name.
  const hx = fx;
  const hy = top - 10 * dpr;
  ctx.fillStyle = spot.color;
  ctx.beginPath();
  ctx.moveTo(hx, hy);
  ctx.lineTo(hx - 7 * dpr, hy - 11 * dpr);
  ctx.lineTo(hx + 7 * dpr, hy - 11 * dpr);
  ctx.closePath();
  ctx.fill();
  if (label) {
    const size = 13 * dpr;
    ctx.font = `800 ${size}px Inter, Cairo, system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.direction = /[؀-ۿ]/.test(label) ? "rtl" : "ltr";
    const w = ctx.measureText(label).width + size;
    const h = size * 1.7;
    const y = hy - 13 * dpr - h / 2;
    ctx.shadowBlur = 0;
    ctx.fillStyle = spot.color;
    ctx.beginPath();
    ctx.roundRect(hx - w / 2, y - h / 2, w, h, h / 2);
    ctx.fill();
    ctx.fillStyle = "#0B0F1A";
    ctx.fillText(label, hx, y + size * 0.05);
  }
  ctx.restore();
}

/** The first free spotlight colour (cycles once all are used). */
export function nextSpotColor(used: ReadonlyArray<string>, palette: ReadonlyArray<string>): string {
  return palette.find((c) => !used.includes(c)) ?? palette[used.length % palette.length];
}

/** "#7 Ali", "#7", "Ali", or the roster's own number. */
export function playerLabel(p: { number: string | null; name: string | null; shirtNumber: number | null }): string {
  const no = p.shirtNumber !== null ? String(p.shirtNumber) : p.number;
  const first = p.name?.trim().split(/\s+/)[0] ?? null;
  return [no ? `#${no}` : null, first].filter(Boolean).join(" ");
}

/**
 * Where a saved moment is: the playhead, unless the drawings were made at another moment and
 * none shows here (drawn, then played on): then the moment of the latest drawing, so the note
 * opens on what was drawn.
 */
export function noteMoment(board: Pick<CoachBoard, "shapes">, nowMs: number): number {
  if (!board.shapes.length || board.shapes.some((s) => coachShapeVisible(s, nowMs))) return nowMs;
  return Math.max(...board.shapes.map((s) => s.atMs));
}

