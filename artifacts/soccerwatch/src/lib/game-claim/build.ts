import { averageProfiles, combineFeatures, dist, type CropFeature } from "./appearance";
import type { Appearance, Chunk, Group, Junction, Piece, Point, Sample } from "./model";
import { spread } from "./model";

/**
 * A bundle segment, turned into the prototype's chunk.
 *
 * PIECES are tracks. The prototype's pieces came out of a tracker whose
 * fragments were then grouped into people offline; here the bundle's tracks
 * are the fragments and the grouping is done below, in the browser, by the
 * same two rules the offline "persons" step used: a track can only continue as
 * one that starts where a human could have got to, and it has to look like
 * the same person.
 */

export type BundleTrack = {
  id: string;
  boxes: Array<{ frame: number; x: number; y: number; w: number; h: number }>;
};

export type BundleChunkInput = {
  k: number;
  start: number;
  dur: number;
  frameRate: number;
  tracks: BundleTrack[];
  crossings: Array<{ frame: number; trackId: string; otherTrackId: string }>;
  /** crop strips for this segment: {trackId: [{f: frame, j: base64 jpeg}]} */
  sprites: Record<string, Array<{ f: number; j: string }>>;
};

/** Sample spacing of the overlays, as the prototype's ov files. */
export const SAMPLE_STEP = 0.5;
/** Crops per piece fed to the appearance profile. */
export const PROFILE_CROPS = 6;

const foot = (s: Sample): Point => [s[1] + s[3] / 2, s[2] + s[4]];

export function buildChunk(input: BundleChunkInput): Chunk {
  const { k, start, dur, frameRate } = input;
  const fps = frameRate > 0 ? frameRate : 20;
  const pieces: Record<string, Piece> = {};
  const ov: Record<string, Sample[]> = {};
  const ovb: Record<string, [number, number]> = {};
  const crops: Record<string, string> = {};

  for (const track of input.tracks) {
    const boxes = track.boxes.slice().sort((a, b) => a.frame - b.frame);
    const samples: Sample[] = [];
    let last = -Infinity;
    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i];
      const t = box.frame / fps - start;
      if (t < -0.01 || t > dur + 0.01) continue;
      const isLast = i === boxes.length - 1;
      if (t - last >= SAMPLE_STEP - 0.01 || (isLast && t > last)) {
        samples.push([Math.round(t * 100) / 100, box.x, box.y, box.w, box.h]);
        last = t;
      }
    }
    if (samples.length < 2) continue;
    const first = samples[0];
    const end = samples[samples.length - 1];
    const keys = (input.sprites[track.id] ?? [])
      .filter((sprite) => sprite.j && sprite.f / fps - start >= first[0] - 0.5 && sprite.f / fps - start <= end[0] + 0.5)
      .sort((a, b) => a.f - b.f)
      .map((sprite) => {
        const key = `${track.id}#${sprite.f}`;
        crops[key] = sprite.j;
        return key;
      });
    ov[track.id] = samples;
    ovb[track.id] = [first[0], end[0]];
    pieces[track.id] = {
      id: track.id,
      t0: first[0],
      t1: end[0],
      a: foot(first),
      b: foot(end),
      h0: first[4],
      h1: end[4],
      img: keys.length ? keys[Math.floor(keys.length / 2)] : null,
      s: keys[0] ?? null,
      e: keys[keys.length - 1] ?? null,
      nr: keys.length,
      feat: null,
    };
  }

  const crossings = input.crossings.map((c) => ({ t: c.frame / fps - start, a: c.trackId, b: c.otherTrackId }));
  return { k, start, dur, pieces, ov, ovb, crops, groups: [], byCid: {}, gOf: {}, crossings };
}

/** Crop keys of a piece, spread across its time on camera. */
export function pieceCropKeys(chunk: Chunk, id: string, count = PROFILE_CROPS): string[] {
  const prefix = `${id}#`;
  return spread(Object.keys(chunk.crops).filter((key) => key.startsWith(prefix)), count);
}

/**
 * Height against the other players at the same image row: a tall player
 * reads above 1 everywhere on the pitch, which the colour cannot tell.
 */
export function heightRatios(chunk: Chunk): Record<string, number> {
  const bins = 24;
  const byBin: number[][] = Array.from({ length: bins }, () => []);
  let maxY = 1;
  for (const samples of Object.values(chunk.ov)) for (const s of samples) maxY = Math.max(maxY, s[2] + s[4]);
  const binOf = (y: number) => Math.max(0, Math.min(bins - 1, Math.floor((y / maxY) * bins)));
  for (const samples of Object.values(chunk.ov)) for (const s of samples) byBin[binOf(s[2] + s[4])].push(s[4]);
  const median = (xs: number[]) => {
    if (!xs.length) return 0;
    const sorted = xs.slice().sort((a, b) => a - b);
    return sorted[sorted.length >> 1];
  };
  const expected = byBin.map(median);
  const out: Record<string, number> = {};
  for (const [id, samples] of Object.entries(chunk.ov)) {
    const ratios = samples
      .map((s) => {
        const e = expected[binOf(s[2] + s[4])];
        return e > 0 ? s[4] / e : 0;
      })
      .filter((r) => r > 0);
    out[id] = ratios.length ? median(ratios) : 1;
  }
  return out;
}

/** Fill every piece's appearance from its crops, using a caller-supplied measurer. */
export async function measureChunk(
  chunk: Chunk,
  measure: (jpegBase64: string) => Promise<CropFeature | null>,
): Promise<void> {
  const hr = heightRatios(chunk);
  for (const piece of Object.values(chunk.pieces)) {
    const keys = pieceCropKeys(chunk, piece.id);
    const features: Array<CropFeature | null> = [];
    for (const key of keys) features.push(await measure(chunk.crops[key]));
    piece.feat = combineFeatures(features, hr[piece.id] ?? 1);
    piece.nr = keys.length;
  }
}

/* ----------------------------------------------------------------- grouping */

/** Human reach, the prototype's reach(): a slack plus a running speed. */
export const SLACK = 4;
export const VMAX = 8;

export function metresPerPixel(hA: number, hB: number): number {
  return 1.75 / Math.max((hA + hB) / 2, 1);
}

export function reachOk(a: { b: Point; t1: number; h1: number }, b: { a: Point; t0: number; h0: number }) {
  const gap = Math.max(b.t0 - a.t1, 0);
  const dm = Math.hypot(b.a[0] - a.b[0], b.a[1] - a.b[1]) * metresPerPixel(a.h1, b.h0);
  return { ok: dm <= SLACK + VMAX * gap, dm, gap };
}

export type LinkParams = {
  /** longest hole a track may continue across */
  linkGap: number;
  /** most two pieces may differ and still be linked */
  linkD: number;
  /** above this a link is asked about */
  askD: number;
  /** second pass: whole chains that look alike and were never on screen together */
  poolD: number;
  poolGap: number;
  /** look-alikes offered as "might these be you too?" */
  nbD: number;
};

export const LINK: LinkParams = {
  linkGap: 6,
  linkD: 2.2,
  askD: 1.2,
  poolD: 1.4,
  poolGap: 240,
  nbD: 2.5,
};

function coOccurSeconds(chunk: Chunk, a: string[], b: string[]): number {
  const spans = (ids: string[]) => ids.map((id) => chunk.pieces[id]).filter(Boolean).map((p) => [p.t0, p.t1] as [number, number]);
  let total = 0;
  for (const [x0, x1] of spans(a)) for (const [y0, y1] of spans(b)) total += Math.max(0, Math.min(x1, y1) - Math.max(x0, y0));
  return total;
}

export function groupProfileOf(chunk: Chunk, members: string[]): Appearance | null {
  return averageProfiles(
    members
      .map((id) => chunk.pieces[id])
      .filter((p): p is Piece => Boolean(p?.feat))
      .map((p) => ({ feat: p.feat!, w: Math.max(p.nr, 1) })),
  );
}

function crossingNear(chunk: Chunk, a: Piece, b: Piece): boolean {
  const lo = a.t1 - 1;
  const hi = b.t0 + 1;
  return chunk.crossings.some((c) => c.t >= lo && c.t <= hi && (c.a === a.id || c.b === a.id || c.a === b.id || c.b === b.id));
}

/**
 * Group the chunk's pieces into probable people.
 *
 * `seed` pre-groups tracks the identity board (or an earlier claim) already
 * put together; everything else is linked here.
 */
export function groupChunk(chunk: Chunk, seed: string[][] = [], params: LinkParams = LINK): void {
  const pieces = Object.values(chunk.pieces).sort((a, b) => a.t0 - b.t0);
  const next = new Map<string, { to: string; j: Junction }>();
  const prev = new Set<string>();
  const seeded = new Map<string, number>();
  seed.forEach((ids, gi) => ids.forEach((id) => { if (chunk.pieces[id]) seeded.set(id, gi); }));

  // Pass 1: short handovers, best first.
  const links: Array<{ a: Piece; b: Piece; score: number; j: Junction }> = [];
  for (const a of pieces) {
    for (const b of pieces) {
      if (a === b || b.t0 < a.t1 - 1 || b.t0 - a.t1 > params.linkGap) continue;
      if (b.t1 <= a.t1) continue;
      const sa = seeded.get(a.id);
      const sb = seeded.get(b.id);
      if (sa !== undefined && sb !== undefined && sa !== sb) continue;
      const r = reachOk(a, b);
      if (!r.ok) continue;
      if (b.t0 < a.t1 && r.dm > 1.5) continue;
      const d = a.feat && b.feat ? dist(a.feat, b.feat) : 1.4;
      if (d > params.linkD) continue;
      const ask = d > params.askD || r.gap > 2 || r.dm > 4 || crossingNear(chunk, a, b);
      links.push({ a, b, score: d + r.gap * 0.15 + r.dm * 0.1, j: { a: a.id, b: b.id, gap: Math.round(r.gap * 10) / 10, dm: Math.round(r.dm * 10) / 10, d: Math.round(d * 100) / 100, ask } });
    }
  }
  links.sort((x, y) => x.score - y.score);
  for (const link of links) {
    if (next.has(link.a.id) || prev.has(link.b.id)) continue;
    next.set(link.a.id, { to: link.b.id, j: link.j });
    prev.add(link.b.id);
  }

  let chains: Array<{ members: string[]; junctions: Junction[] }> = [];
  for (const p of pieces) {
    if (prev.has(p.id)) continue;
    const members = [p.id];
    const junctions: Junction[] = [];
    let at = p.id;
    while (next.has(at)) {
      const n = next.get(at)!;
      junctions.push(n.j);
      members.push(n.to);
      at = n.to;
    }
    chains.push(...splitAtColourJumps(chunk, { members, junctions }, params.linkD));
  }

  // Seeded tracks belong together even when no handover linked them.
  if (seed.length) {
    const bySeed = new Map<number, Array<{ members: string[]; junctions: Junction[] }>>();
    const rest: typeof chains = [];
    for (const c of chains) {
      const s = seeded.get(c.members[0]);
      if (s === undefined) rest.push(c);
      else bySeed.set(s, [...(bySeed.get(s) ?? []), c]);
    }
    for (const parts of bySeed.values()) rest.push(joinChains(chunk, parts, true));
    chains = rest;
  }

  // Pass 2: chains that look alike and never shared the screen are one person
  // the tracker lost for longer than a handover.
  for (let changed = true; changed; ) {
    changed = false;
    const profiles = chains.map((c) => groupProfileOf(chunk, c.members));
    let best: { i: number; j: number; d: number } | null = null;
    for (let i = 0; i < chains.length; i++) {
      for (let j = 0; j < chains.length; j++) {
        if (i === j || !profiles[i] || !profiles[j]) continue;
        const A = chunk.pieces[chains[i].members[chains[i].members.length - 1]];
        const B = chunk.pieces[chains[j].members[0]];
        if (!A || !B || B.t0 < A.t1 || B.t0 - A.t1 > params.poolGap) continue;
        if (coOccurSeconds(chunk, chains[i].members, chains[j].members) > 0) continue;
        const d = dist(profiles[i]!, profiles[j]!);
        if (d <= params.poolD && (!best || d < best.d)) best = { i, j, d };
      }
    }
    if (best) {
      const merged = joinChains(chunk, [chains[best.i], chains[best.j]], true);
      chains = chains.filter((_, idx) => idx !== best!.i && idx !== best!.j).concat([merged]);
      changed = true;
    }
  }

  const groups: Group[] = chains.map((c) => {
    const spans = c.members.map((id) => chunk.pieces[id]).map((p) => [p.t0, p.t1] as [number, number]);
    let dur = 0;
    let end = -Infinity;
    for (const [a, b] of spans.sort((x, y) => x[0] - y[0])) {
      dur += Math.max(0, b - Math.max(a, end));
      end = Math.max(end, b);
    }
    return { cid: c.members[0], dur: Math.round(dur * 10) / 10, team: null, members: c.members, junctions: c.junctions, nb: [] };
  });

  const profiles = new Map(groups.map((g) => [g.cid, groupProfileOf(chunk, g.members)]));
  for (const g of groups) {
    const pg = profiles.get(g.cid);
    if (!pg) continue;
    g.nb = groups
      .filter((h) => h !== g)
      .map((h) => {
        const ph = profiles.get(h.cid);
        return ph ? ([Math.round(dist(pg, ph) * 100) / 100, h.cid] as [number, string]) : null;
      })
      .filter((x): x is [number, string] => x !== null && x[0] <= params.nbD)
      .filter(([, cid]) => coOccurSeconds(chunk, g.members, chunk.byCid[cid]?.members ?? groups.find((h) => h.cid === cid)!.members) < 3)
      .sort((a, b) => a[0] - b[0])
      .slice(0, 5);
  }

  groups.sort((a, b) => b.dur - a.dur);
  chunk.groups = groups;
  chunk.byCid = Object.fromEntries(groups.map((g) => [g.cid, g]));
  chunk.gOf = {};
  for (const g of groups) for (const m of g.members) chunk.gOf[m] = g.cid;
}

/**
 * A piece with no crops links on movement alone, so a chain can run red →
 * (no picture) → blue and hand one person's timeline to another. The
 * prototype never had this case (every piece had a profile); here a chain is
 * cut wherever the next piece with a picture looks nothing like the last one.
 */
export function splitAtColourJumps(
  chunk: Chunk,
  chain: { members: string[]; junctions: Junction[] },
  maxD: number,
): Array<{ members: string[]; junctions: Junction[] }> {
  const out: Array<{ members: string[]; junctions: Junction[] }> = [];
  let cur: { members: string[]; junctions: Junction[] } = { members: [], junctions: [] };
  let lastFeat: Piece["feat"] = null;
  for (let i = 0; i < chain.members.length; i++) {
    const p = chunk.pieces[chain.members[i]];
    if (i > 0 && p?.feat && lastFeat && dist(lastFeat, p.feat) > maxD) {
      out.push(cur);
      cur = { members: [], junctions: [] };
    } else if (i > 0) {
      const j = chain.junctions.find((x) => x.a === chain.members[i - 1] && x.b === chain.members[i]);
      if (j) cur.junctions.push(j);
    }
    cur.members.push(chain.members[i]);
    if (p?.feat) lastFeat = p.feat;
  }
  out.push(cur);
  return out;
}

/** Join chains in time order, asking about every seam between them. */
function joinChains(
  chunk: Chunk,
  parts: Array<{ members: string[]; junctions: Junction[] }>,
  ask: boolean,
): { members: string[]; junctions: Junction[] } {
  const ordered = parts.slice().sort((a, b) => chunk.pieces[a.members[0]].t0 - chunk.pieces[b.members[0]].t0);
  const members: string[] = [];
  const junctions: Junction[] = [];
  for (const part of ordered) {
    if (members.length) {
      const A = chunk.pieces[members[members.length - 1]];
      const B = chunk.pieces[part.members[0]];
      const r = reachOk(A, B);
      const d = A.feat && B.feat ? dist(A.feat, B.feat) : 1.4;
      junctions.push({ a: A.id, b: B.id, gap: Math.round(r.gap * 10) / 10, dm: Math.round(r.dm * 10) / 10, d: Math.round(d * 100) / 100, ask });
    }
    members.push(...part.members);
    junctions.push(...part.junctions);
  }
  return { members, junctions };
}
