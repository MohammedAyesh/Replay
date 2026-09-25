import { BRIDGE, kept, timeline, type Ctx } from "./claim";
import type { OffRange } from "./model";
import { L2G, OUT } from "./model";
import { toPitch } from "./pitch";

/**
 * The stats screen's maths, as the prototype computes it in the browser from
 * the claim: one track of you through the game, then distance, speeds, runs,
 * sprints, zones, distance per ten minutes and a heat map.
 */

export type TrackPoint = {
  t: number;
  X: number;
  Y: number;
  k: number;
  pid: string;
  /** source-pixel box, for the reel's framing */
  b: [number, number, number, number];
  /** near a track end or a box jump: kept out of speeds */
  edge: boolean;
};

const TRIM0 = 0.5;
const TRIM1 = 1.0;

function inPlayAt(off: OffRange[], t: number): boolean {
  return !off.some(([a, b, kind]) => OUT(kind) && t >= a && t < b);
}

/** Segments of time-ordered samples, each from ONE piece; duplicate pieces never interleave. */
export function trackOfYou(ctx: Ctx): TrackPoint[][] {
  const pitch = ctx.game.pitch;
  if (!pitch) return [];
  const segs: TrackPoint[][] = [];
  const covered: Array<[number, number]> = [];
  for (const key of Object.keys(ctx.S.you)) {
    const kk = Number(key);
    if (!ctx.CH[kk] || ctx.S.you[key].skipped) continue;
    const ps = kept(ctx, kk)
      .map((p) => {
        const pid = p.manual ? p.src : p.id;
        const a = pid == null ? null : ctx.CH[kk].ov[pid];
        if (!a || !pid) return null;
        const smp = a.filter((s) => s[0] >= p.t0 - 0.01 && s[0] <= p.t1 + 0.01);
        return smp.length ? { pid, smp } : null;
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .sort((x, y) => x.smp[0][0] - y.smp[0][0] || y.smp.length - x.smp.length);
    for (const { pid, smp } of ps) {
      let cur: TrackPoint[] = [];
      const t0 = smp[0][0];
      const t1 = smp[smp.length - 1][0];
      const flush = () => { if (cur.length) segs.push(cur); cur = []; };
      for (let si = 0; si < smp.length; si++) {
        const s = smp[si];
        const t = L2G(ctx.game, kk, s[0]);
        if (!inPlayAt(ctx.S.off, t) || covered.some(([a, b]) => t >= a - 0.01 && t <= b + 0.01)) { flush(); continue; }
        const [X, Yp] = toPitch(ctx.game, s[1] + s[3] / 2, s[2] + s[4]);
        if (X < -3 || X > pitch.w + 3 || Yp < -3 || Yp > pitch.h + 3) { flush(); continue; }
        if (cur.length && t - cur[cur.length - 1].t > 1.01) flush();
        const pv = si ? smp[si - 1] : null;
        const jump = !!pv && s[0] - pv[0] <= 0.6 && Math.abs(s[4] - pv[4]) > 0.25 * Math.max(s[4], pv[4]);
        if (jump && cur.length) cur[cur.length - 1].edge = true;
        cur.push({
          t, X, Y: Yp, k: kk, pid, b: [s[1], s[2], s[3], s[4]],
          edge: s[0] < t0 + TRIM0 || s[0] > t1 - TRIM1 || jump || s[2] + s[4] > ctx.game.srcH - 14,
        });
      }
      flush();
      covered.push([L2G(ctx.game, kk, t0), L2G(ctx.game, kk, t1)]);
    }
  }
  return segs.sort((a, b) => a[0].t - b[0].t);
}

export function median3(a: TrackPoint[], key: "X" | "Y"): number[] {
  return a.map((p, i) => {
    if (i === 0 || i === a.length - 1) return p[key];
    return [a[i - 1][key], p[key], a[i + 1][key]].sort((x, y) => x - y)[1];
  });
}

/** Speeds (m/s) along one segment; null where the sample is not trustworthy. */
export function speedsOf(r: TrackPoint[]): Array<number | null> {
  const X = median3(r, "X");
  const Yv = median3(r, "Y");
  return r.map((p, i) => {
    if (i === 0 || i === r.length - 1 || p.edge || r[i - 1].edge || r[i + 1].edge) return null;
    const dt = r[i + 1].t - r[i - 1].t;
    if (dt <= 0 || dt > 1.1) return null;
    const s = Math.hypot(X[i + 1] - X[i - 1], Yv[i + 1] - Yv[i - 1]) / dt;
    return s > 9 ? null : s;
  });
}

export type ZoneKey = "walk" | "jog" | "run" | "sprint";

export type GameStats = {
  dist: number;
  time: number;
  avg: number;
  top: number;
  zones: Record<ZoneKey, [number, number]>;
  runsN: number;
  sprintsN: number;
  heat: Float32Array;
  perK: Record<number, number>;
  dropped: number;
  found: number;
  /** distance scaled from clean-track time up to found time */
  km: number;
};

export function computeStats(ctx: Ctx): GameStats {
  const segs = trackOfYou(ctx);
  const pitch = ctx.game.pitch;
  const VCAP = 9;
  const heat = new Float32Array(40 * 20);
  const perK: Record<number, number> = {};
  let dist = 0;
  let time = 0;
  let dropped = 0;
  let top = 0;
  const zones: Record<ZoneKey, [number, number]> = { walk: [0, 0], jog: [0, 0], run: [0, 0], sprint: [0, 0] };
  const zoneOf = (v: number): ZoneKey => (v < 2 ? "walk" : v < 4 ? "jog" : v < 5.5 ? "run" : "sprint");
  let runsN = 0;
  let sprintsN = 0;
  let prev: TrackPoint[] | null = null;
  for (const r of segs) {
    if (prev) {
      const a = prev[prev.length - 1];
      const b = r[0];
      const dt = b.t - a.t;
      const d = Math.hypot(b.X - a.X, b.Y - a.Y);
      if (dt > 0 && dt <= BRIDGE && d <= Math.max(2, 4 * dt)) {
        dist += d;
        time += dt;
        perK[b.k] = (perK[b.k] || 0) + d;
      }
    }
    prev = r;
    if (pitch) {
      for (const p of r) {
        const cx = Math.min(39, Math.max(0, Math.floor((p.X / pitch.w) * 40)));
        const cy = Math.min(19, Math.max(0, Math.floor((p.Y / pitch.h) * 20)));
        heat[cy * 40 + cx] += 0.5;
      }
    }
    if (r.length < 2) continue;
    const X = median3(r, "X");
    const Yv = median3(r, "Y");
    time += r[r.length - 1].t - r[0].t;
    for (let i = 1; i < r.length; i++) {
      const dt = r[i].t - r[i - 1].t;
      if (dt <= 0) continue;
      const d = Math.hypot(X[i] - X[i - 1], Yv[i] - Yv[i - 1]);
      if (d / dt > VCAP) { dropped++; continue; }
      dist += d;
      perK[r[i].k] = (perK[r[i].k] || 0) + d;
    }
    const v = speedsOf(r);
    let hiRun = 0;
    let spRun = 0;
    for (let i = 0; i < v.length; i++) {
      const s = v[i];
      if (s == null) { hiRun = spRun = 0; continue; }
      const z = zoneOf(s);
      zones[z][0] += 0.5;
      zones[z][1] += s * 0.5;
      if (i >= 2 && v[i - 1] != null && v[i - 2] != null) top = Math.max(top, Math.min(s, v[i - 1]!, v[i - 2]!));
      hiRun = s >= 4 ? hiRun + 1 : 0;
      spRun = s >= 5.5 ? spRun + 1 : 0;
      if (hiRun === 3) runsN++;
      if (spRun === 3) sprintsN++;
    }
  }
  let found = 0;
  for (const key of Object.keys(ctx.S.you)) {
    const kk = Number(key);
    const y = ctx.S.you[key];
    if (ctx.CH[kk] && !y.skipped && (y.cid || y.manual.length)) {
      const t = timeline(ctx, kk);
      found += t.fs + t.bs;
    }
  }
  const km = (dist / 1000) * Math.max(1, time ? found / time : 1);
  return { dist, time, avg: time ? dist / time : 0, top, zones, runsN, sprintsN, heat, perK, dropped, found, km };
}

/** Everyone on the pitch at time t: [pieceId, X, Y] in metres, for the map from above. */
export function peopleAt(ctx: Ctx, k: number, lt: number): Array<[string, number, number]> {
  const d = ctx.CH[k];
  if (!d || !ctx.game.pitch) return [];
  const out: Array<[string, number, number]> = [];
  for (const [id, a] of Object.entries(d.ov)) {
    const b = d.ovb[id];
    if (lt < b[0] - 0.3 || lt > b[1] + 0.3) continue;
    let i = 0;
    while (i < a.length - 1 && a[i + 1][0] < lt) i++;
    const p = a[i];
    const q = a[Math.min(i + 1, a.length - 1)];
    if (q[0] - p[0] > 1.2 && lt > p[0] && lt < q[0]) continue;
    const f = q[0] > p[0] ? Math.max(0, Math.min(1, (lt - p[0]) / (q[0] - p[0]))) : 0;
    const x = p[1] + (q[1] - p[1]) * f + (p[3] + (q[3] - p[3]) * f) / 2;
    const y = p[2] + (q[2] - p[2]) * f + (p[4] + (q[4] - p[4]) * f);
    const [X, Yp] = toPitch(ctx.game, x, y);
    out.push([id, X, Yp]);
  }
  return out;
}
