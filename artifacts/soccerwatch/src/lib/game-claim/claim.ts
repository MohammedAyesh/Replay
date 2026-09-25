import { averageProfiles, dist, isWeakColour } from "./appearance";
import { groupProfileOf, reachOk } from "./build";
import type { AnyPiece, Appearance, Chunk, Game, Group, Junction, ManualPiece, OffRange, Piece, Point } from "./model";
import { L2G, OUT, overlapSeconds, union } from "./model";
import { toPitch } from "./pitch";

/**
 * The prototype's claim logic, function for function.
 *
 * State is plain data (it is what gets saved), and every rule reads it through
 * the same helpers the prototype had: Y() for one chunk's answers, mine() for
 * every piece claimed there, kept() for those not struck out, timeline() for
 * found / bridged / missing time, and so on. Names are kept so the two can be
 * read side by side.
 */

export const BRIDGE = 5;
export const TOL = 0.5;
export const DMAX = 1.6;

export type ChunkAnswers = {
  cid: string | null;
  out: string[];
  added: string[];
  dropped: string[];
  extra: string[];
  seen: string[];
  manual: ManualPiece[];
  skipped: boolean;
};

export type Step = "intro" | "kit" | "gallery" | "review" | "joins" | "gaps" | "next" | "done" | "stats";

export type ClaimState = {
  v: 1;
  step: Step;
  team: string | null;
  /** the chunk being worked on */
  k: number | null;
  order: number[];
  oi: number;
  you: Record<string, ChunkAnswers>;
  off: OffRange[];
  qi: number;
  taps: number;
  /** ms spent so far, for "time taken" */
  elapsed: number;
  mk: number;
  autoAdded: number;
  /** the two team shirt colours picked on the stats screen (OpenCV 8-bit Lab) */
  teams?: { a: [number, number, number]; b: [number, number, number] } | null;
};

export function newState(game: Game): ClaimState {
  return {
    v: 1,
    step: "intro",
    team: null,
    k: null,
    order: [],
    oi: 0,
    you: {},
    off: game.outOfPlay.map(([a, b]) => [a, b, "play"] as OffRange),
    qi: 0,
    taps: 0,
    elapsed: 0,
    mk: 0,
    autoAdded: 0,
  };
}

export type Ctx = { game: Game; CH: Record<number, Chunk>; S: ClaimState };

export function Y(ctx: Ctx, k: number): ChunkAnswers {
  const key = String(k);
  if (!ctx.S.you[key]) {
    ctx.S.you[key] = { cid: null, out: [], added: [], dropped: [], extra: [], seen: [], manual: [], skipped: false };
  }
  return ctx.S.you[key];
}

const has = (list: string[], id: string) => list.includes(id);

/** Every piece claimed in chunk k: the picked group, added groups, extras and taps. */
export function mine(ctx: Ctx, k: number): AnyPiece[] {
  const d = ctx.CH[k];
  const y = Y(ctx, k);
  if (!d || !y.cid || !d.byCid[y.cid]) return y.manual.slice().sort((a, b) => a.t0 - b.t0);
  const ids = new Set(d.byCid[y.cid].members);
  for (const c of y.added) d.byCid[c]?.members.forEach((m) => ids.add(m));
  for (const m of y.extra) ids.add(m);
  return [...ids]
    .filter((m) => !has(y.dropped, m) && d.pieces[m])
    .map((m) => d.pieces[m] as AnyPiece)
    .concat(y.manual)
    .sort((a, b) => a.t0 - b.t0);
}

export const kept = (ctx: Ctx, k: number) => mine(ctx, k).filter((p) => !has(Y(ctx, k).out, p.id));

export function reach(a: AnyPiece, b: AnyPiece): { ok: boolean; dm: number } {
  if (a.manual || b.manual) return { ok: true, dm: 0 };
  const r = reachOk(a, b);
  return { ok: r.ok, dm: r.dm };
}

export function chunkMeta(ctx: Ctx, k: number) {
  return ctx.game.chunks.find((c) => c.k === k)!;
}

export function offLocal(ctx: Ctx, k: number): OffRange[] {
  const c = chunkMeta(ctx, k);
  return ctx.S.off
    .map((r) => [r[0] - c.start, r[1] - c.start, r[2]] as OffRange)
    .filter((r) => r[1] > 0 && r[0] < c.dur);
}

export type Hole = { t0: number; t1: number; a: AnyPiece | null; b: AnyPiece | null };

export function subtract(h: Hole, offs: OffRange[]): { open: Hole[]; off: OffRange[] } {
  let parts: Array<[number, number]> = [[h.t0, h.t1]];
  const off: OffRange[] = [];
  for (const [a, b, kind] of offs) {
    const nx: Array<[number, number]> = [];
    for (const [x, y] of parts) {
      if (b <= x || a >= y) { nx.push([x, y]); continue; }
      if (a > x) nx.push([x, a]);
      if (b < y) nx.push([b, y]);
      off.push([Math.max(a, x), Math.min(b, y), kind]);
    }
    parts = nx;
  }
  return {
    open: parts
      .filter(([x, y]) => y - x > 0.3)
      .map(([x, y]) => ({ t0: x, t1: y, a: x === h.t0 ? h.a : null, b: y === h.t1 ? h.b : null })),
    off,
  };
}

export type Timeline = {
  found: Array<[number, number]>;
  br: Array<[number, number]>;
  holes: Hole[];
  off: OffRange[];
  /** found / bridged seconds that count (in play) */
  fs: number;
  bs: number;
  /** off-camera seconds inside play */
  os: number;
  /** seconds of play in the chunk */
  inplay: number;
};

/**
 * Found, bridged and missing time for one chunk.
 *
 * One change from the prototype: out-of-play, bench and off-camera ranges are
 * unioned before they are taken off. The prototype subtracted each range on
 * its own, so two overlapping ranges took the same seconds off twice and the
 * last ten minutes of a claim could read 106%.
 */
export function timeline(ctx: Ctx, k: number): Timeline {
  const K = kept(ctx, k);
  const dur = chunkMeta(ctx, k).dur;
  const found: Array<[number, number]> = [];
  const br: Array<[number, number]> = [];
  const raw: Hole[] = [];
  let e: number | null = null;
  let last: AnyPiece | null = null;
  for (const p of K) {
    if (e !== null && p.t0 > e) {
      const g = p.t0 - e;
      if (g <= BRIDGE && last && reach(last, p).ok) br.push([e, p.t0]);
      else raw.push({ t0: e, t1: p.t0, a: last, b: p });
    }
    if (e === null || p.t1 > e) {
      found.push([Math.max(p.t0, e ?? p.t0), p.t1]);
      e = p.t1;
      last = p;
    }
  }
  if (!K.length) raw.push({ t0: 0, t1: dur, a: null, b: null });
  else {
    if (K[0].t0 > 0.3) raw.unshift({ t0: 0, t1: K[0].t0, a: null, b: K[0] });
    if (e !== null && dur - e > 0.3) raw.push({ t0: e, t1: dur, a: last, b: null });
  }
  const offs = offLocal(ctx, k);
  let holes: Hole[] = [];
  let off: OffRange[] = [];
  for (const h of raw) {
    const r = subtract(h, offs);
    holes = holes.concat(r.open);
    off = off.concat(r.off);
  }
  const outSpans = union(offs.filter((o) => OUT(o[2])).map((o) => [Math.max(0, o[0]), Math.min(dur, o[1])] as [number, number]));
  const camSpans = union(offs.filter((o) => o[2] === "cam").map((o) => [Math.max(0, o[0]), Math.min(dur, o[1])] as [number, number]));
  const counted = (arr: Array<[number, number]>) =>
    arr.reduce((s, [x, y]) => s + Math.max(0, y - x - overlapSeconds(x, y, outSpans)), 0);
  const playOff = outSpans.reduce((s, [a, b]) => s + (b - a), 0);
  // Off camera only counts where it is also in play.
  const os = camSpans.reduce((s, [a, b]) => s + Math.max(0, b - a - overlapSeconds(a, b, outSpans)), 0);
  return { found, br, holes, off, fs: counted(found), bs: counted(br), os, inplay: Math.max(0, dur - playOff) };
}

/** Found share of the chunk's on-camera play, never above 100%. */
export function chunkPercent(t: Timeline): number {
  return Math.min(100, Math.round((100 * (t.fs + t.bs)) / Math.max(t.inplay - t.os, 1)));
}

/** The profile of everything claimed so far, the prototype's profile(). */
export function profile(ctx: Ctx): Appearance | null {
  const items: Array<{ feat: Appearance; w: number }> = [];
  for (const key of Object.keys(ctx.S.you)) {
    const k = Number(key);
    if (!ctx.CH[k]) continue;
    for (const p of kept(ctx, k)) {
      if (!p.manual && p.feat) items.push({ feat: p.feat, w: Math.max(p.nr, 1) });
    }
  }
  return averageProfiles(items);
}

export function candidates(ctx: Ctx, k: number, h: Hole): Piece[] {
  const d = ctx.CH[k];
  const y = Y(ctx, k);
  const K = kept(ctx, k);
  const ids = new Set(K.map((p) => p.id));
  const q = profile(ctx);
  const out: Array<{ c: Piece; d: number | null }> = [];
  for (const c of Object.values(d.pieces)) {
    if (ids.has(c.id) || has(y.out, c.id)) continue;
    if (c.t0 < h.t0 - TOL || c.t1 > h.t1 + TOL || c.t1 - c.t0 < 0.3) continue;
    const dd = q && c.feat ? dist(c.feat, q) : null;
    if (dd !== null && dd > DMAX) continue;
    if (h.a && !reach(h.a, c).ok) continue;
    if (h.b && !reach(c, h.b).ok) continue;
    out.push({ c, d: dd });
  }
  return out.sort((x, z) => (x.d ?? 1.4) - (z.d ?? 1.4)).slice(0, 3).map((x) => x.c);
}

export const hkey = (h: Hole) => `${h.a ? h.a.id : "s"}-${h.b ? h.b.id : "e"}-${Math.round(h.t0)}`;

export function nextHole(ctx: Ctx, k: number): Hole | null {
  const y = Y(ctx, k);
  for (const h of timeline(ctx, k).holes) if (!has(y.seen, hkey(h))) return h;
  return null;
}

/** Foot points by half-second, for "were these two ever side by side?". */
export function footsOf(ctx: Ctx, k: number, ids: string[]): Map<number, Point> {
  const m = new Map<number, Point>();
  if (!ctx.game.pitch) return m;
  for (const id of ids) {
    const a = ctx.CH[k].ov[id];
    if (!a) continue;
    for (const s of a) m.set(Math.round(s[0] * 2), toPitch(ctx.game, s[1] + s[3] / 2, s[2] + s[4]));
  }
  return m;
}

/** How far apart two sets of pieces are while both are on screen (metres), and for how long. */
export function coSep(ctx: Ctx, k: number, idsA: string[], idsB: string[]): { sec: number; med: number } | null {
  const A = footsOf(ctx, k, idsA);
  const B = footsOf(ctx, k, idsB);
  const d: number[] = [];
  for (const [t, p] of A) {
    const q = B.get(t);
    if (q) d.push(Math.hypot(p[0] - q[0], p[1] - q[1]));
  }
  if (!d.length) return null;
  d.sort((x, y) => x - y);
  return { sec: d.length / 2, med: d[d.length >> 1] };
}

/** The join questions left in chunk k. */
export function questions(ctx: Ctx, k: number): Junction[] {
  const d = ctx.CH[k];
  const y = Y(ctx, k);
  const keep = new Set(kept(ctx, k).map((p) => p.id));
  const qs: Junction[] = [];
  if (!y.cid || !d.byCid[y.cid]) return qs;
  for (const c of [y.cid, ...y.added]) {
    for (const j of d.byCid[c]?.junctions ?? []) {
      if (!j.ask || !keep.has(j.a) || !keep.has(j.b)) continue;
      const A = d.pieces[j.a];
      const B = d.pieces[j.b];
      if (A && B && B.t0 < A.t1 - 1) {
        const s = coSep(ctx, k, [j.a], [j.b]);
        if (s && s.med <= 2.5) continue; // overlapping and side by side: tracked twice
      }
      qs.push(j);
    }
  }
  return qs;
}

/** The track ids that are you in chunk k (taps resolve to the track they landed on). */
export function youIds(ctx: Ctx, k: number): Set<string> {
  const s = new Set<string>();
  for (const p of kept(ctx, k)) {
    const id = p.manual ? p.src : p.id;
    if (id) s.add(id);
  }
  return s;
}

/** Stretches where a track sat still beyond the pitch edge for 45 s or more (the bench). */
export function benchSpans(ctx: Ctx, k: number, ps?: AnyPiece[]): Array<[number, number]> {
  const pitch = ctx.game.pitch;
  if (!pitch) return [];
  const pts: Array<{ t: number; X: number; Y: number; off: boolean }> = [];
  for (const p of ps ?? kept(ctx, k)) {
    const src = p.manual ? p.src : p.id;
    const a = src ? ctx.CH[k].ov[src] : null;
    if (!a) continue;
    for (const s of a) {
      if (s[0] < p.t0 - 0.01 || s[0] > p.t1 + 0.01) continue;
      const [X, Yp] = toPitch(ctx.game, s[1] + s[3] / 2, s[2] + s[4]);
      pts.push({ t: s[0], X, Y: Yp, off: X < 0.8 || X > pitch.w - 0.8 || Yp < 0.3 || Yp > pitch.h - 0.3 });
    }
  }
  pts.sort((a, b) => a.t - b.t);
  const out: Array<[number, number]> = [];
  let run: typeof pts = [];
  const close = () => {
    if (run.length > 4) {
      const t0 = run[0].t;
      const t1 = run[run.length - 1].t;
      if (t1 - t0 >= 10) out.push([L2G(ctx.game, k, t0), L2G(ctx.game, k, t1)]);
    }
    run = [];
  };
  for (const p of pts) {
    if (!p.off) { close(); continue; }
    if (run.length && (p.t - run[run.length - 1].t > 8 || Math.hypot(p.X - run[0].X, p.Y - run[0].Y) > 3.5)) close();
    run.push(p);
  }
  close();
  const mg: Array<[number, number]> = [];
  for (const r of out) {
    const l = mg[mg.length - 1];
    if (l && r[0] - l[1] <= 20) l[1] = r[1];
    else mg.push(r.slice() as [number, number]);
  }
  return mg.filter(([a, b]) => b - a >= 45 && !ctx.S.off.some((r) => r[2] === "bench" && r[0] <= a + 1 && r[1] >= b - 1));
}

/** Someone who looks like you on the bench during a hole. */
export function benchInHole(ctx: Ctx, k: number, h: Hole): { g: Group; a: number; b: number } | null {
  const d = ctx.CH[k];
  const q = profile(ctx);
  if (!q || !ctx.game.pitch) return null;
  const H0 = L2G(ctx.game, k, h.t0);
  const H1 = L2G(ctx.game, k, h.t1);
  for (const g of d.groups) {
    const gp = groupProfileOf(d, g.members);
    if (!gp || dist(gp, q) > 4) continue;
    for (const [a, b] of benchSpans(ctx, k, g.members.map((m) => d.pieces[m]))) {
      if (b > H0 && a < H1) return { g, a: Math.max(a, H0), b: Math.min(b, H1) };
    }
  }
  return null;
}

export const weakColour = (ctx: Ctx) => isWeakColour(profile(ctx));

export const TWIN_SEP = 2.5;

/** Other groups that look like you and were never on screen far from you: usually you, tracked twice. */
export function twins(ctx: Ctx, k: number): Array<{ g: Group; d: number; sep: { sec: number; med: number } | null }> {
  const d = ctx.CH[k];
  const y = Y(ctx, k);
  const q = profile(ctx);
  if (!y.cid || !q) return [];
  const mineIds = [...youIds(ctx, k)];
  const weak = isWeakColour(q);
  const out: Array<{ g: Group; d: number; sep: { sec: number; med: number } | null }> = [];
  for (const g of d.groups) {
    if (g.cid === y.cid || has(y.added, g.cid)) continue;
    const gp = groupProfileOf(d, g.members);
    if (!gp) continue;
    const dd = dist(gp, q);
    if (dd > (weak ? 1.5 : 2.5)) continue;
    const s = ctx.game.pitch ? coSep(ctx, k, mineIds, g.members) : null;
    // On screen together for 20 s or more and not on top of each other: someone
    // else. The prototype allowed 4 m here; a double track of one person sits
    // within a stride, and 2.5 m is the same bound questions() uses for
    // "tracked twice". At 4 m a teammate shadowing you got added as you.
    if (s && s.sec >= 20 && s.med > TWIN_SEP) continue;
    if (!s && overlapSecondsOf(d, mineIds, g.members) >= 20) continue; // no pitch model: any long overlap
    if (weak && !(s && s.sec >= 3 && s.med <= 3)) continue;
    out.push({ g, d: dd, sep: s });
  }
  return out.sort((a, b) => a.d - b.d);
}

function overlapSecondsOf(d: Chunk, a: string[], b: string[]): number {
  let total = 0;
  for (const x of a) {
    const p = d.pieces[x];
    if (!p) continue;
    for (const z of b) {
      const q = d.pieces[z];
      if (q) total += Math.max(0, Math.min(p.t1, q.t1) - Math.max(p.t0, q.t0));
    }
  }
  return total;
}

export function ovPos(ctx: Ctx, k: number, pid: string, t: number): { foot: Point; h: number; t: number } | null {
  const a = ctx.CH[k]?.ov[pid];
  if (!a || !a.length) return null;
  let b = a[0];
  for (const s of a) if (Math.abs(s[0] - t) < Math.abs(b[0] - t)) b = s;
  return { foot: [b[1] + b[3] / 2, b[2] + b[4]], h: b[4], t: b[0] };
}

export const TAPBASE = 2.0;
export const TAPMPS = 4.0;

/**
 * How much of a tapped track is physically one person: walk out from the tap
 * and stop at the first step no body could have made. Without a pitch model
 * the same budget is applied in metres estimated from body height.
 */
export function tapSpan(ctx: Ctx, k: number, id: string, lt: number, h: Hole): [number, number] {
  const a = ctx.CH[k].ov[id];
  if (!a || !a.length) return [Math.max(h.t0, lt - 5), Math.min(h.t1, lt + 5)];
  const P = a.map((s) => {
    if (ctx.game.pitch) {
      const g = toPitch(ctx.game, s[1] + s[3] / 2, s[2] + s[4]);
      return { t: s[0], X: g[0], Y: g[1] };
    }
    const mpp = 1.75 / Math.max(s[4], 1);
    return { t: s[0], X: (s[1] + s[3] / 2) * mpp, Y: (s[2] + s[4]) * mpp };
  });
  let i = 0;
  for (let j = 1; j < P.length; j++) if (Math.abs(P[j].t - lt) < Math.abs(P[i].t - lt)) i = j;
  const ok = (u: (typeof P)[number], v: (typeof P)[number]) => {
    const dt = v.t - u.t;
    return dt > 0 && Math.hypot(v.X - u.X, v.Y - u.Y) <= TAPBASE + TAPMPS * dt;
  };
  let lo = i;
  let hi = i;
  while (lo > 0 && ok(P[lo - 1], P[lo])) lo--;
  while (hi < P.length - 1 && ok(P[hi], P[hi + 1])) hi++;
  return [Math.max(h.t0, P[lo].t), Math.min(h.t1, P[hi].t)];
}

export function addTap(
  ctx: Ctx,
  k: number,
  h: Hole,
  lt: number,
  box: { id: string } | null,
  pt: Point | null,
): void {
  const y = Y(ctx, k);
  ctx.S.mk++;
  if (box) {
    const p = ctx.CH[k].pieces[box.id];
    const [t0, t1] = tapSpan(ctx, k, box.id, lt, h);
    const A = ovPos(ctx, k, box.id, t0);
    const B = ovPos(ctx, k, box.id, t1);
    y.manual.push({
      id: `m${ctx.S.mk}`,
      manual: true,
      t0,
      t1,
      a: A?.foot ?? [0, 0],
      b: B?.foot ?? [0, 0],
      h0: A?.h ?? 120,
      h1: B?.h ?? 120,
      img: p?.img ?? null,
      s: p?.s ?? null,
      e: p?.e ?? null,
      src: box.id,
    });
  } else if (pt) {
    y.manual.push({ id: `m${ctx.S.mk}`, manual: true, t0: lt - 0.25, t1: lt + 0.25, a: pt, b: pt, h0: 120, h1: 120, img: null, src: null });
  }
}

/** The first ten minutes with at least three minutes of play: where the claim starts. */
export function inPlaySec(ctx: Ctx, k: number): number {
  const c = chunkMeta(ctx, k);
  const out = union(ctx.S.off.filter((r) => OUT(r[2])).map((r) => [r[0], r[1]] as [number, number]));
  return Math.max(0, c.dur - overlapSeconds(c.start, c.start + c.dur, out));
}

export function firstChunk(ctx: Ctx): number {
  for (const c of ctx.game.chunks) if (inPlaySec(ctx, c.k) >= 180) return c.k;
  return ctx.game.chunks[0]?.k ?? 0;
}

/** Calibrated on two hand-labelled players over nine chunks (see the project doc). */
export const RANK_DW = 1.0;
export const SURE_MARGIN = 0.9;
export const SURE_TOP = 0;

/** "Is this you?" for the next ten minutes: look distance plus a continuity bonus. */
export function rankNext(ctx: Ctx, k: number): Array<{ g: Group; d: number | null }> {
  const d = ctx.CH[k];
  const q = profile(ctx);
  if (!q) return d.groups.slice(0, 3).map((g) => ({ g, d: null }));
  const prevK = ctx.S.order[ctx.S.oi - 1];
  const prevKept = prevK !== undefined && ctx.CH[prevK] ? kept(ctx, prevK) : [];
  const prevEnd = prevKept[prevKept.length - 1] ?? null;
  const prevDur = prevK !== undefined ? chunkMeta(ctx, prevK).dur : 0;
  return d.groups
    .map((g) => {
      const gp = groupProfileOf(d, g.members);
      // Duration weight (calibrated on the truth set, not in the prototype):
      // Replay's linker leaves more short fragments than the prototype's
      // offline pipeline, and a 20-second fragment that happens to match
      // colour is rarely the answer. Long groups get a head start.
      let dd = gp ? dist(gp, q) - RANK_DW * Math.log(Math.max(g.dur, 5) / 60) : 9;
      if (prevEnd && prevEnd.t1 > prevDur - 15) {
        const first = g.members.map((m) => d.pieces[m]).sort((a, b) => a.t0 - b.t0)[0];
        if (first && first.t0 < 15) {
          const mpp = 1.75 / Math.max((prevEnd.h1 + first.h0) / 2, 1);
          const dm = Math.hypot(first.a[0] - prevEnd.b[0], first.a[1] - prevEnd.b[1]) * mpp;
          if (dm < 3) dd -= 1.2;
        }
      }
      return { g, d: dd };
    })
    .sort((a, b) => (a.d ?? 9) - (b.d ?? 9))
    .slice(0, 3);
}

/**
 * The one-tap "Yes, that's me — keep going". The prototype's thresholds were
 * set on its own distances; on the bundle (with the duration weight) the only
 * safe signal was the margin: every chunk where the best guess led the
 * runner-up by 0.9 or more was right, and some with a 0.6 lead were wrong.
 */
export function isSure(r: Array<{ d: number | null }>): boolean {
  const a = r[0];
  const b = r[1];
  if (!a || a.d == null || a.d > SURE_TOP) return false;
  return !b || b.d == null || b.d - a.d >= SURE_MARGIN;
}

/** Pick a group as you in chunk k: resets the chunk and auto-adds your twins. */
export function pick(ctx: Ctx, k: number, cid: string): void {
  const y = Y(ctx, k);
  Object.assign(y, { cid, skipped: false, out: [], added: [], dropped: [], extra: [], seen: [], manual: [] });
  ctx.S.qi = 0;
  const tw = weakColour(ctx) ? [] : twins(ctx, k);
  for (const x of tw) y.added.push(x.g.cid);
  ctx.S.autoAdded = tw.length;
}

/** Advance to the next chunk with play in it; 'done' after the last. */
export function afterChunk(ctx: Ctx): "next" | "done" {
  ctx.S.oi++;
  while (ctx.S.oi < ctx.S.order.length && inPlaySec(ctx, ctx.S.order[ctx.S.oi]) < 30) ctx.S.oi++;
  if (ctx.S.oi >= ctx.S.order.length) {
    ctx.S.step = "done";
    return "done";
  }
  ctx.S.k = ctx.S.order[ctx.S.oi];
  ctx.S.step = "next";
  return "next";
}

export function startClaim(ctx: Ctx, from?: number): void {
  const k = from ?? firstChunk(ctx);
  ctx.S.k = k;
  ctx.S.order = ctx.game.chunks.map((c) => c.k).filter((x) => x >= k);
  ctx.S.oi = 0;
  ctx.S.step = "kit";
}

/** Every chunk's timeline summed, for the done screen. */
export function totals(ctx: Ctx): { fs: number; ip: number; os: number; miss: number } {
  let fs = 0;
  let ip = 0;
  let os = 0;
  let miss = 0;
  for (const c of ctx.game.chunks) {
    const y = ctx.S.you[String(c.k)];
    const sk = y?.skipped;
    if (!ctx.CH[c.k] || !y || sk || (!y.cid && !y.manual.length)) {
      ip += sk ? 0 : inPlaySec(ctx, c.k);
      continue;
    }
    const t = timeline(ctx, c.k);
    fs += t.fs + t.bs;
    ip += t.inplay;
    os += t.os;
    miss += t.holes.reduce((s, h) => s + h.t1 - h.t0, 0);
  }
  return { fs: Math.min(fs, Math.max(ip - os, 0)), ip, os, miss };
}
