/**
 * Coach board pitch geometry: frame shares <-> pitch metres through the camera's
 * pitch model.
 *
 * The model is the pipeline's own (the grid the analysis exports for a camera,
 * stored on cameras.pitch_model and used by every metric in the app): a
 * rows x cols grid of pitch positions in metres sampled evenly over the image,
 * read with bilinear interpolation, exactly as lib/pitchModel.ts
 * interpolatePitchPosition and the pipeline's build_clip_job.py to_pitch do.
 * It is not a homography: the camera is a stitched panorama, straight pitch
 * lines are curves in the picture, so a line on the pitch is drawn by sampling
 * it in metres and mapping each sample into the picture.
 *
 * Shares: x and y of the camera frame in 0..1 (the coach board's coordinates).
 */

export type CoachPitch = {
  calibrationId: string;
  /** metres along the pitch (X) and across it (Y) */
  width: number;
  height: number;
  rows: number;
  cols: number;
  /** grid metres, row-major (rows * cols), row 0 at the top of the frame */
  x: number[];
  y: number[];
};

/** What the analysis says about one tracked player, for the coach tools. */
export type CoachPlayerAnalysis = {
  /** 0 or 1 by shirt (0 = ours when the line-up tells us), null when it cannot be told */
  side: 0 | 1 | null;
  /** the shirt colour the analysis measured, #rrggbb */
  kit: string | null;
  /** training: the analysis' group for this player (most of his tracked time) */
  group: string | null;
  /** training: the analysis flagged him as an adult (a coach) */
  adult: boolean | null;
};

/** GET …/coach/analysis */
export type CoachAnalysis = {
  pitch: CoachPitch | null;
  /** the two sides' shirt colours, #rrggbb ([0] is ours when known) */
  kits: [string, string] | null;
  /** whether side 0 is the academy's own players */
  oursKnown: boolean;
  /**
   * which side attacks the goal at X = pitch width, through the video:
   * [video seconds from, side] samples, sorted (halves swap ends)
   */
  attackHigh: Array<[number, 0 | 1 | null]>;
  players: Record<string, CoachPlayerAnalysis>;
  /** training groups present, most-seen first */
  groups: string[];
  /** Named training groups, with a hex swatch derived from the group's torso Lab colour. */
  groupDetails: Array<{ id: string; name: string; color: string | null }>;
  /** True only when people/match.json contains a training block. */
  isTraining: boolean;
  hasAdults: boolean;
};

export type Metres = [number, number];
export type Share = [number, number];

export type PitchMapper = {
  pitch: CoachPitch;
  /** metres at a frame point (clamped to the frame) */
  toPitch: (u: number, v: number) => Metres;
  /** the frame point that shows a pitch position, or null when the model cannot place it */
  toImage: (X: number, Y: number, guess?: Share | null) => Share | null;
};

const BUCKET_M = 2;

export function pitchMapper(pitch: CoachPitch): PitchMapper | null {
  const { rows, cols, x: gx, y: gy } = pitch;
  if (!(rows >= 2 && cols >= 2) || gx.length !== rows * cols || gy.length !== rows * cols) return null;

  const toPitch = (u: number, v: number): Metres => {
    const fu = Math.min(1, Math.max(0, u)) * (cols - 1);
    const fv = Math.min(1, Math.max(0, v)) * (rows - 1);
    const c0 = Math.min(cols - 2, Math.floor(fu));
    const r0 = Math.min(rows - 2, Math.floor(fv));
    const tx = fu - c0;
    const ty = fv - r0;
    const i00 = r0 * cols + c0;
    const i01 = i00 + 1;
    const i10 = i00 + cols;
    const i11 = i10 + 1;
    const top = (a: number[]) => a[i00] + (a[i01] - a[i00]) * tx;
    const bot = (a: number[]) => a[i10] + (a[i11] - a[i10]) * tx;
    return [top(gx) + (bot(gx) - top(gx)) * ty, top(gy) + (bot(gy) - top(gy)) * ty];
  };

  // Nodes near the pitch, bucketed by metres, for a first guess at the inverse.
  const span = Math.max(pitch.width, pitch.height);
  const buckets = new Map<string, number[]>();
  for (let i = 0; i < gx.length; i++) {
    const X = gx[i];
    const Y = gy[i];
    if (!Number.isFinite(X) || !Number.isFinite(Y)) continue;
    if (X < -span * 0.5 || X > pitch.width + span * 0.5 || Y < -span * 0.5 || Y > pitch.height + span * 0.5) continue;
    const key = `${Math.floor(X / BUCKET_M)},${Math.floor(Y / BUCKET_M)}`;
    const list = buckets.get(key);
    if (list) list.push(i); else buckets.set(key, [i]);
  }
  const nearestNode = (X: number, Y: number): Share | null => {
    const bx = Math.floor(X / BUCKET_M);
    const by = Math.floor(Y / BUCKET_M);
    let best = -1;
    let bestD = Infinity;
    for (let ring = 0; ring <= 3 && best < 0; ring++) {
      for (let dx = -ring; dx <= ring; dx++) {
        for (let dy = -ring; dy <= ring; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
          for (const i of buckets.get(`${bx + dx},${by + dy}`) ?? []) {
            const d = (gx[i] - X) ** 2 + (gy[i] - Y) ** 2;
            if (d < bestD) { bestD = d; best = i; }
          }
        }
      }
    }
    if (best < 0) return null;
    return [(best % cols) / (cols - 1), Math.floor(best / cols) / (rows - 1)];
  };

  const toImage = (X: number, Y: number, guess?: Share | null): Share | null => {
    if (!Number.isFinite(X) || !Number.isFinite(Y)) return null;
    let start = guess ?? null;
    if (start) {
      const p = toPitch(start[0], start[1]);
      if (Math.hypot(p[0] - X, p[1] - Y) > 4) start = null;
    }
    start ??= nearestNode(X, Y);
    if (!start) return null;
    let [u, v] = start;
    const h = 1e-4;
    for (let k = 0; k < 12; k++) {
      const p = toPitch(u, v);
      const ex = X - p[0];
      const ey = Y - p[1];
      if (Math.abs(ex) < 1e-3 && Math.abs(ey) < 1e-3) break;
      const uu = u + h <= 1 ? u + h : u - h;
      const vv = v + h <= 1 ? v + h : v - h;
      const pu = toPitch(uu, v);
      const pv = toPitch(u, vv);
      const a = (pu[0] - p[0]) / (uu - u);
      const c = (pu[1] - p[1]) / (uu - u);
      const b = (pv[0] - p[0]) / (vv - v);
      const d = (pv[1] - p[1]) / (vv - v);
      const det = a * d - b * c;
      if (!Number.isFinite(det) || Math.abs(det) < 1e-9) break;
      let du = (d * ex - b * ey) / det;
      let dv = (-c * ex + a * ey) / det;
      const step = Math.hypot(du, dv);
      if (step > 0.05) { du *= 0.05 / step; dv *= 0.05 / step; }
      u = Math.min(1, Math.max(0, u + du));
      v = Math.min(1, Math.max(0, v + dv));
    }
    const p = toPitch(u, v);
    return Math.hypot(p[0] - X, p[1] - Y) <= 0.25 ? [u, v] : null;
  };

  return { pitch, toPitch, toImage };
}

/** Distance in metres between two frame points. */
export function shareDistance(map: PitchMapper, a: Share, b: Share): number {
  const p = map.toPitch(a[0], a[1]);
  const q = map.toPitch(b[0], b[1]);
  return Math.hypot(p[0] - q[0], p[1] - q[1]);
}

/**
 * A straight pitch line from `a` to `b` (metres) as frame points, sampled about
 * every `stepM` metres so its curve on the panorama is followed. Points the
 * model cannot place are left out.
 */
export function pitchSegment(map: PitchMapper, a: Metres, b: Metres, stepM = 1): Share[] {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const n = Math.max(2, Math.min(80, Math.ceil(len / stepM) + 1));
  const out: Share[] = [];
  let guess: Share | null = null;
  for (let i = 0; i < n; i++) {
    const f = i / (n - 1);
    const p = map.toImage(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, guess);
    if (p) { out.push(p); guess = p; }
  }
  return out;
}

/** A closed pitch polygon (metres) as frame points, each side sampled as pitchSegment. */
export function pitchPolygon(map: PitchMapper, corners: Metres[], stepM = 1): Share[] {
  const out: Share[] = [];
  corners.forEach((c, i) => {
    const seg = pitchSegment(map, c, corners[(i + 1) % corners.length], stepM);
    out.push(...(out.length ? seg.slice(1) : seg));
  });
  return out;
}

/** The offside line through X: across the whole pitch at that distance along it. */
export function offsideLine(map: PitchMapper, X: number): Share[] {
  return pitchSegment(map, [X, 0], [X, map.pitch.height], 1);
}

/**
 * How big things look at a pitch spot relative to another: frame distance of a
 * one-metre step there over the same step here. Used to draw a moved player's
 * ghost at the size he would have at his new spot.
 */
export function perspectiveScale(map: PitchMapper, from: Share, to: Share, aspect: number): number {
  const size = (s: Share) => {
    const p = map.toPitch(s[0], s[1]);
    const ax = map.toImage(p[0] + 1, p[1], s);
    const ay = map.toImage(p[0], p[1] + 1, s);
    if (!ax || !ay) return null;
    const dx = Math.hypot((ax[0] - s[0]) * aspect, ax[1] - s[1]);
    const dy = Math.hypot((ay[0] - s[0]) * aspect, ay[1] - s[1]);
    return (dx + dy) / 2;
  };
  const a = size(from);
  const b = size(to);
  if (!a || !b) return 1;
  return Math.min(3, Math.max(1 / 3, b / a));
}

// ── Team shape ──────────────────────────────────────────────────────────────

export type TeamShapeInput = { id: string; at: Metres };
export type TeamShape = {
  /** which end the side defends: "low" (X = 0) or "high" (X = pitch width); null when not known */
  defends: "low" | "high" | null;
  keeper: string | null;
  /** outfield players by line, deepest line first; each line sorted across the pitch (Y) */
  lines: string[][];
  /** across the pitch, outfield, metres */
  width: number;
  /** along the pitch, deepest outfield player to the most advanced, metres */
  depth: number;
};

/** A gap along the pitch this big splits two lines, metres. */
export const TEAM_LINE_GAP_M = 3;
/** A keeper is this near his goal line... */
const KEEPER_MAX_FROM_GOAL_M = 9;
/** ...and this much deeper than the next player of his side. */
const KEEPER_MIN_GAP_M = 4;

/**
 * One side's shape at a moment: its keeper (left out), its back, middle and
 * front lines (split at the widest gaps along the pitch), and its width and
 * depth. `defends` comes from the analysis' attacking direction when known;
 * otherwise the keeper's end is used, and with no keeper the lines are only
 * ordered along the pitch.
 */
export function teamShape(players: TeamShapeInput[], pitchLength: number, defends: "low" | "high" | null, opts: { keeper?: boolean } = {}): TeamShape | null {
  const pts = players.filter((p) => Number.isFinite(p.at[0]) && Number.isFinite(p.at[1]));
  if (!pts.length) return null;
  const fromGoal = (p: TeamShapeInput, end: "low" | "high") => (end === "low" ? p.at[0] : pitchLength - p.at[0]);
  const keeperAt = (end: "low" | "high"): { id: string; gap: number } | null => {
    if (pts.length < 3) return null;
    const sorted = [...pts].sort((a, b) => fromGoal(a, end) - fromGoal(b, end));
    const [first, second] = sorted;
    const gap = fromGoal(second, end) - fromGoal(first, end);
    return fromGoal(first, end) <= KEEPER_MAX_FROM_GOAL_M && gap >= KEEPER_MIN_GAP_M ? { id: first.id, gap } : null;
  };
  let end = defends;
  let keeper: string | null = null;
  if (end) {
    keeper = keeperAt(end)?.id ?? null;
  } else {
    const low = keeperAt("low");
    const high = keeperAt("high");
    const pick = low && high ? (low.gap >= high.gap ? "low" : "high") : low ? "low" : high ? "high" : null;
    if (pick) { end = pick; keeper = (pick === "low" ? low : high)!.id; }
  }
  const outfield = opts.keeper === false || !keeper ? pts : pts.filter((p) => p.id !== keeper);
  const depthOf = (p: TeamShapeInput) => (end ? fromGoal(p, end) : p.at[0]);
  const sorted = [...outfield].sort((a, b) => depthOf(a) - depthOf(b));
  // Split at the two widest gaps that are wide enough: at most three lines.
  const gaps = sorted.slice(1).map((p, i) => ({ i: i + 1, gap: depthOf(p) - depthOf(sorted[i]) }))
    .filter((g) => g.gap >= TEAM_LINE_GAP_M)
    .sort((a, b) => b.gap - a.gap)
    .slice(0, 2)
    .map((g) => g.i)
    .sort((a, b) => a - b);
  const cuts = [0, ...gaps, sorted.length];
  const lines = cuts.slice(1).map((to, k) => sorted.slice(cuts[k], to).sort((a, b) => a.at[1] - b.at[1]).map((p) => p.id));
  const ys = outfield.map((p) => p.at[1]);
  const ds = outfield.map(depthOf);
  return {
    defends: end,
    keeper: opts.keeper === false ? null : keeper,
    lines,
    width: ys.length ? Math.max(...ys) - Math.min(...ys) : 0,
    depth: ds.length ? Math.max(...ds) - Math.min(...ds) : 0,
  };
}

/** The side attacking X = pitch width at video second t, from the analysis' samples. */
export function attackingHighAt(samples: ReadonlyArray<readonly [number, 0 | 1 | null]>, t: number): 0 | 1 | null {
  let out: 0 | 1 | null = null;
  for (const [from, side] of samples) {
    if (from > t) break;
    out = side;
  }
  return out;
}

/** Which end a side defends at t: the one opposite the goal it attacks. */
export function defendsAt(samples: ReadonlyArray<readonly [number, 0 | 1 | null]>, side: 0 | 1, t: number): "low" | "high" | null {
  const high = attackingHighAt(samples, t);
  if (high === null) return null;
  return high === side ? "low" : "high";
}
