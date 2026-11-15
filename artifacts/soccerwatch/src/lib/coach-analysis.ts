import {
  coachFeet,
  defendsAt,
  offsideLine,
  perspectiveScale,
  pitchPolygon,
  pitchSegment,
  teamShape,
  type CoachAnalysis,
  type CoachBoard,
  type CoachShape,
  type CoachUnit,
  type Metres,
  type PitchMapper,
  type Share,
  type TeamShape,
} from "@workspace/api-zod";

/**
 * The coach board's analysis layer (components/coach-board): offside lines,
 * units (triangles and passing lanes), a side's lines with its width and depth,
 * moved players and drill areas. Everything that is a length or a straight line
 * on the pitch goes through the camera's pitch model (PitchMapper), so lines
 * follow the panorama's curves and every number is in metres. Without a model
 * the tools that need one are off, and units and moves fall back to straight
 * screen lines with no numbers.
 */

export type Rect = { left: number; top: number; width: number; height: number };
type Box = [number, number, number, number];

export const LINE_COLORS = { back: "#2FD8C4", mid: "#D4FF4F", front: "#FF5A3C" } as const;

const rgba = (hex: string, a: number) => {
  const n = parseInt(hex.slice(1, 7), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};

export const metresLabel = (m: number, unit = "m") => `${m < 10 ? m.toFixed(1) : Math.round(m)} ${unit}`;
const ARABIC = /[؀-ۿ]/;
/** Keep a label's "#7" in reading order when it sits inside Arabic text on the canvas. */
const ltrIn = (s: string, context: string) => (ARABIC.test(context) && !ARABIC.test(s) ? `\u2066${s}\u2069` : s);

/** Whether a frame point lands on (or just off) the pitch. */
export function onPitch(map: PitchMapper, at: Metres, margin = 2): boolean {
  return at[0] >= -margin && at[0] <= map.pitch.width + margin && at[1] >= -margin && at[1] <= map.pitch.height + margin;
}

/** Players' feet on the pitch, metres, for those tracked at this moment. */
export function feetMetres(map: PitchMapper, boxes: Map<string, Box>, ids: Iterable<string>): Array<{ id: string; at: Metres; feet: Share }> {
  const out: Array<{ id: string; at: Metres; feet: Share }> = [];
  for (const id of ids) {
    const b = boxes.get(id);
    if (!b) continue;
    const feet = coachFeet(b);
    out.push({ id, at: map.toPitch(feet[0], feet[1]), feet });
  }
  return out;
}

/** Order three or more points around their middle, so a shape never crosses itself. */
export function aroundCentre<T extends { at: Metres }>(pts: T[]): T[] {
  if (pts.length < 4) return pts;
  const cx = pts.reduce((s, p) => s + p.at[0], 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p.at[1], 0) / pts.length;
  return [...pts].sort((a, b) => Math.atan2(a.at[1] - cy, a.at[0] - cx) - Math.atan2(b.at[1] - cy, b.at[0] - cx));
}

/** The edges a unit draws: closed round a shape, or from the first player to each other one. */
export function unitEdges<T>(kind: CoachUnit["kind"], pts: T[]): Array<[T, T]> {
  if (pts.length < 2) return [];
  if (kind === "lanes" || pts.length === 2) return pts.slice(1).map((p) => [pts[0], p] as [T, T]);
  return pts.map((p, i) => [p, pts[(i + 1) % pts.length]] as [T, T]);
}

/** Which players a side's lines are about at this moment. */
export function sidePlayers(analysis: CoachAnalysis, lines: NonNullable<CoachBoard["teamLines"]>, visible: (id: string) => boolean): string[] {
  return Object.entries(analysis.players)
    .filter(([id, p]) => visible(id) && (lines.group !== undefined ? p.group === lines.group : lines.side !== undefined && p.side === lines.side))
    .map(([id]) => id);
}

/** A side's shape at video second t, with the end it defends from the analysis when it knows. */
export function sideShapeAt(
  map: PitchMapper,
  analysis: CoachAnalysis,
  lines: NonNullable<CoachBoard["teamLines"]>,
  boxes: Map<string, Box>,
  t: number,
  visible: (id: string) => boolean,
): (TeamShape & { at: Map<string, Metres> }) | null {
  const pts = feetMetres(map, boxes, sidePlayers(analysis, lines, visible)).filter((p) => onPitch(map, p.at));
  if (!pts.length) return null;
  const defends = lines.side !== undefined ? defendsAt(analysis.attackHigh, lines.side, t) : null;
  const shape = teamShape(pts, map.pitch.width, defends, { keeper: lines.keeper !== false });
  return shape ? { ...shape, at: new Map(pts.map((p) => [p.id, p.at])) } : null;
}

/** "3-2-1": players per line, deepest first. */
export const formationOf = (shape: Pick<TeamShape, "lines">) => shape.lines.map((l) => l.length).join("-");

// ── Drawing ──────────────────────────────────────────────────────────────────

export type AnalysisDrawInput = {
  rect: Rect;
  dpr: number;
  t: number;
  board: CoachBoard;
  boxes: Map<string, Box>;
  map: PitchMapper | null;
  analysis: CoachAnalysis | null;
  visible: (id: string) => boolean;
  label: (id: string) => string;
  /** players picked for a unit not yet finished */
  pending?: { ids: string[]; kind: CoachUnit["kind"]; color: string } | null;
  copy: { offside: string; width: string; depth: string; keeper: string; lines: { back: string; mid: string; front: string }; unit?: string };
};

function screen(rect: Rect, dpr: number) {
  return (p: Share): [number, number] => [(rect.left + p[0] * rect.width) * dpr, (rect.top + p[1] * rect.height) * dpr];
}

function poly(ctx: CanvasRenderingContext2D, pts: Array<[number, number]>, close = false) {
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
  if (close) ctx.closePath();
}

export function pill(ctx: CanvasRenderingContext2D, x: number, y: number, text: string, bg: string, fg: string, dpr: number, size = 12) {
  const s = size * dpr;
  ctx.save();
  ctx.font = `800 ${s}px Inter, Cairo, system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.direction = /[؀-ۿ]/.test(text) ? "rtl" : "ltr";
  const w = ctx.measureText(text).width + s;
  const h = s * 1.6;
  ctx.shadowColor = "rgba(0,0,0,0.5)";
  ctx.shadowBlur = 6 * dpr;
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.roundRect(x - w / 2, y - h / 2, w, h, h / 2);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.fillStyle = fg;
  ctx.fillText(text, x, y + s * 0.05);
  ctx.restore();
}

/** A straight pitch line between two frame points, curved as the camera sees it (screen line without a model). */
function pitchPath(map: PitchMapper | null, a: Share, b: Share): Share[] {
  if (!map) return [a, b];
  const p = map.toPitch(a[0], a[1]);
  const q = map.toPitch(b[0], b[1]);
  const seg = pitchSegment(map, p, q, 0.75);
  return seg.length >= 2 ? seg : [a, b];
}

/** Offside lines, units and a side's lines over the video at t. Spotlights and drawings are drawn by coach-board. */
export function drawAnalysis(ctx: CanvasRenderingContext2D, d: AnalysisDrawInput): { shape: (TeamShape & { formation: string }) | null } {
  const S = screen(d.rect, d.dpr);
  const { map, board } = d;
  let result: (TeamShape & { formation: string }) | null = null;

  // A side's lines: each line through its players across the pitch, the keeper ringed.
  if (map && d.analysis && board.teamLines) {
    const shape = sideShapeAt(map, d.analysis, board.teamLines, d.boxes, d.t, d.visible);
    if (shape) {
      result = { ...shape, formation: formationOf(shape) };
      const names = shape.lines.length === 3 ? (["back", "mid", "front"] as const) : shape.lines.length === 2 ? (["back", "front"] as const) : (["mid"] as const);
      ctx.save();
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      shape.lines.forEach((ids, i) => {
        const color = LINE_COLORS[names[i]];
        const pts = ids.map((id) => shape.at.get(id)!).filter(Boolean);
        const path: Share[] = [];
        if (pts.length === 1) {
          const [X, Y] = pts[0];
          path.push(...pitchSegment(map, [X, Y - 2.5], [X, Y + 2.5], 0.75));
        } else {
          for (let k = 1; k < pts.length; k++) {
            const seg = pitchSegment(map, pts[k - 1], pts[k], 0.75);
            path.push(...(path.length ? seg.slice(1) : seg));
          }
        }
        if (path.length < 2) return;
        ctx.strokeStyle = color;
        ctx.lineWidth = 3.5 * d.dpr;
        ctx.shadowColor = "rgba(0,0,0,0.55)";
        ctx.shadowBlur = 6 * d.dpr;
        poly(ctx, path.map(S));
        ctx.stroke();
        for (const p of pts) {
          const s = map.toImage(p[0], p[1]);
          if (!s) continue;
          const [x, y] = S(s);
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(x, y, 4.5 * d.dpr, 0, Math.PI * 2);
          ctx.fill();
        }
        const end = S(path[path.length - 1]);
        pill(ctx, end[0], end[1] + 16 * d.dpr, d.copy.lines[names[i]], color, "#0B0F1A", d.dpr, 11);
      });
      if (shape.keeper) {
        const b = d.boxes.get(shape.keeper);
        if (b) {
          const [x, y] = S(coachFeet(b));
          pill(ctx, x, y + 14 * d.dpr, d.copy.keeper, "rgba(11,15,26,0.85)", "#FFFFFF", d.dpr, 10);
        }
      }
      ctx.restore();
    }
  }

  // Offside lines: across the whole pitch at the player's distance along it.
  if (map) {
    for (const o of board.offside ?? []) {
      if (!d.visible(o.rosterId)) continue;
      const b = d.boxes.get(o.rosterId);
      if (!b) continue;
      const feet = coachFeet(b);
      const [X] = map.toPitch(feet[0], feet[1]);
      const line = offsideLine(map, X);
      if (line.length < 2) continue;
      ctx.save();
      ctx.strokeStyle = o.color;
      ctx.lineWidth = 3 * d.dpr;
      ctx.setLineDash([12 * d.dpr, 8 * d.dpr]);
      ctx.shadowColor = "rgba(0,0,0,0.6)";
      ctx.shadowBlur = 6 * d.dpr;
      poly(ctx, line.map(S));
      ctx.stroke();
      ctx.setLineDash([]);
      const near = S(line[line.length - 1]);
      const name = d.label(o.rosterId);
      pill(ctx, near[0], near[1] - 14 * d.dpr, name ? `${d.copy.offside} · ${ltrIn(name, d.copy.offside)}` : d.copy.offside, o.color, "#0B0F1A", d.dpr, 11);
      ctx.restore();
    }
  }

  // Units: shapes and passing lanes, with every side's length.
  const units: Array<{ kind: CoachUnit["kind"]; ids: string[]; color: string; pending?: boolean }> = (board.units ?? []).map((u) => ({ kind: u.kind, ids: u.rosterIds, color: u.color }));
  if (d.pending && d.pending.ids.length) units.push({ ...d.pending, pending: true });
  for (const u of units) {
    const pts = u.ids.filter(d.visible).map((id) => d.boxes.get(id)).filter((b): b is Box => Boolean(b)).map((b) => {
      const feet = coachFeet(b);
      return { feet, at: (map ? map.toPitch(feet[0], feet[1]) : feet) as Metres };
    });
    if (!pts.length) continue;
    const ordered = u.kind === "shape" ? aroundCentre(pts) : pts;
    const edges = unitEdges(u.kind, ordered);
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    if (u.kind === "shape" && ordered.length >= 3) {
      const ring: Share[] = [];
      for (const [a, b] of edges) { const seg = pitchPath(map, a.feet, b.feet); ring.push(...(ring.length ? seg.slice(1) : seg)); }
      ctx.fillStyle = rgba(u.color, 0.13);
      poly(ctx, ring.map(S), true);
      ctx.fill();
    }
    ctx.strokeStyle = u.color;
    ctx.lineWidth = 2.5 * d.dpr;
    ctx.shadowColor = "rgba(0,0,0,0.55)";
    ctx.shadowBlur = 6 * d.dpr;
    if (u.pending) ctx.setLineDash([6 * d.dpr, 5 * d.dpr]);
    for (const [a, b] of edges) {
      const path = pitchPath(map, a.feet, b.feet);
      poly(ctx, path.map(S));
      ctx.stroke();
    }
    ctx.setLineDash([]);
    for (const p of ordered) {
      const [x, y] = S(p.feet);
      ctx.fillStyle = u.color;
      ctx.beginPath();
      ctx.arc(x, y, 4 * d.dpr, 0, Math.PI * 2);
      ctx.fill();
    }
    if (map) {
      for (const [a, b] of edges) {
        const path = pitchPath(map, a.feet, b.feet);
        const mid = S(path[Math.floor(path.length / 2)]);
        pill(ctx, mid[0], mid[1], metresLabel(Math.hypot(a.at[0] - b.at[0], a.at[1] - b.at[1]), d.copy.unit), "rgba(11,15,26,0.85)", u.color, d.dpr, 11);
      }
    }
    ctx.restore();
  }
  return { shape: result };
}

/** A moved player: where he was, an arrow along the pitch to where he should have been, and his ghost there. */
export function drawMove(ctx: CanvasRenderingContext2D, s: Extract<CoachShape, { kind: "move" }>, rect: Rect, dpr: number, map: PitchMapper | null, label: string, unit = "m") {
  const S = screen(rect, dpr);
  const path = pitchPath(map, s.from, s.to);
  const pts = path.map(S);
  const size: [number, number] = s.size ?? [0.012, 0.09];
  const scale = map ? perspectiveScale(map, s.from, s.to, rect.width / rect.height) : 1;
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.shadowColor = "rgba(0,0,0,0.55)";
  ctx.shadowBlur = 6 * dpr;
  // where he was
  const [fx, fy] = S(s.from);
  const r0 = Math.max(12 * dpr, size[0] * rect.width * dpr * 1.1);
  ctx.strokeStyle = rgba(s.color, 0.8);
  ctx.lineWidth = 2 * dpr;
  ctx.setLineDash([4 * dpr, 4 * dpr]);
  ctx.beginPath();
  ctx.ellipse(fx, fy, r0, r0 * 0.32, 0, 0, Math.PI * 2);
  ctx.stroke();
  // the run he should have made
  ctx.strokeStyle = s.color;
  ctx.lineWidth = 3 * dpr;
  ctx.setLineDash([10 * dpr, 7 * dpr]);
  poly(ctx, pts);
  ctx.stroke();
  ctx.setLineDash([]);
  if (pts.length >= 2) {
    const tip = pts[pts.length - 1];
    const back = pts[Math.max(0, pts.length - 3)];
    const ang = Math.atan2(tip[1] - back[1], tip[0] - back[0]);
    const h = 14 * dpr;
    poly(ctx, [[tip[0] - h * Math.cos(ang - 0.45), tip[1] - h * Math.sin(ang - 0.45)], tip, [tip[0] - h * Math.cos(ang + 0.45), tip[1] - h * Math.sin(ang + 0.45)]]);
    ctx.stroke();
  }
  // his ghost where he should have been, at the size he would have there
  const [tx, ty] = S(s.to);
  const gw = size[0] * rect.width * dpr * scale;
  const gh = size[1] * rect.height * dpr * scale;
  ctx.fillStyle = rgba(s.color, 0.28);
  ctx.strokeStyle = s.color;
  ctx.lineWidth = 2 * dpr;
  ctx.beginPath();
  ctx.roundRect(tx - gw / 2, ty - gh, gw, gh, Math.min(gw, gh) / 2);
  ctx.fill();
  ctx.stroke();
  const r1 = Math.max(12 * dpr, gw * 1.1);
  ctx.beginPath();
  ctx.ellipse(tx, ty, r1, r1 * 0.32, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
  const metres = map ? Math.hypot(...((): [number, number] => { const a = map.toPitch(s.from[0], s.from[1]); const b = map.toPitch(s.to[0], s.to[1]); return [a[0] - b[0], a[1] - b[1]]; })()) : null;
  const text = [label ? ltrIn(label, unit) : null, metres !== null ? metresLabel(metres, unit) : null].filter(Boolean).join(" · ");
  if (text) pill(ctx, tx, ty - gh - 14 * dpr, text, s.color, "#0B0F1A", dpr, 11);
}

/** A drill area: its rectangle on the pitch in perspective, filled, with its size in metres. */
export function drawArea(ctx: CanvasRenderingContext2D, s: Extract<CoachShape, { kind: "area" }>, rect: Rect, dpr: number, map: PitchMapper | null, unit = "m") {
  if (!map) return;
  const S = screen(rect, dpr);
  const [x0, x1] = [Math.min(s.a[0], s.b[0]), Math.max(s.a[0], s.b[0])];
  const [y0, y1] = [Math.min(s.a[1], s.b[1]), Math.max(s.a[1], s.b[1])];
  const ring = pitchPolygon(map, [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], 0.75);
  if (ring.length < 3) return;
  ctx.save();
  ctx.fillStyle = rgba(s.color, 0.14);
  poly(ctx, ring.map(S), true);
  ctx.fill();
  ctx.strokeStyle = s.color;
  ctx.lineWidth = 2.5 * dpr;
  ctx.setLineDash([9 * dpr, 6 * dpr]);
  ctx.shadowColor = "rgba(0,0,0,0.5)";
  ctx.shadowBlur = 5 * dpr;
  ctx.stroke();
  ctx.restore();
  const centre = map.toImage((x0 + x1) / 2, (y0 + y1) / 2);
  if (centre) {
    const [cx, cy] = S(centre);
    const size = `${metresLabel(x1 - x0, "").trim()} × ${metresLabel(y1 - y0, unit)}`;
    pill(ctx, cx, cy, s.label ? `${s.label} · ${size}` : size, s.color, "#0B0F1A", dpr, 12);
  }
}
