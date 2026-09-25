/**
 * The whole-game claim, as the 19 Sep prototype (replayjo.b-cdn.net/proto/game)
 * does it, rebuilt on Replay's own tracking bundle.
 *
 * The prototype reads files a separate pipeline wrote for one game: people
 * already grouped, join questions already chosen, colour profiles already
 * measured. A Replay bundle has none of that -- tracks, crossings, in-play
 * spans and crop strips -- so this module turns a bundle segment into the same
 * shape (a "chunk" of pieces, overlays and groups) and the claim logic runs on
 * that unchanged. Everything that needs a decision is a pure function so it can
 * be tested without a video.
 *
 * CLOCKS. Three, as everywhere in the claim code:
 *   tracking  0..duration, frames / frameRate. Chunks start at the segment's
 *             startSeconds, so "global" time in this module IS tracking time.
 *   local     seconds from the start of one chunk (the prototype's `t`).
 *   video     tracking + videoStartSeconds. Only the player uses it.
 *   display   tracking + matchOffset. Only labels use it.
 */

/** One sampled box on a piece's track: [local seconds, x, y, w, h] in source pixels. */
export type Sample = [number, number, number, number, number];

/** A foot point in source pixels. */
export type Point = [number, number];

export type Appearance = {
  /** torso colour, OpenCV-style 8-bit Lab (L 0-255, a/b centred on 128) */
  to: [number, number, number];
  /** shorts colour, same space */
  sh: [number, number, number];
  /** 32-bin torso histogram (8 hues x 2 saturations x 2 values), sums to 1 */
  hi: number[];
  /** body height relative to other players at the same image row */
  hr: number;
};

export type Piece = {
  /** track id for a bundle piece; "m<n>" for a span the claimant tapped */
  id: string;
  t0: number;
  t1: number;
  a: Point;
  b: Point;
  h0: number;
  h1: number;
  /** crop keys (into Chunk.crops): middle, first, last */
  img: string | null;
  s: string | null;
  e: string | null;
  /** how many crops fed the appearance: the prototype's weight */
  nr: number;
  feat: Appearance | null;
  manual?: false;
};

/** A stretch the claimant tapped in the video: a slice of someone's track. */
export type ManualPiece = {
  id: string;
  manual: true;
  t0: number;
  t1: number;
  a: Point;
  b: Point;
  h0: number;
  h1: number;
  img: string | null;
  s?: string | null;
  e?: string | null;
  /** the track the tap landed on, or null for a tap on empty grass */
  src: string | null;
};

export type AnyPiece = Piece | ManualPiece;

export type Junction = {
  a: string;
  b: string;
  /** seconds between A's end and B's start (0 when they overlap) */
  gap: number;
  /** estimated metres between A's last and B's first foot point */
  dm: number;
  /** appearance distance between A and B */
  d: number;
  /** worth asking the claimant about */
  ask: boolean;
};

export type Group = {
  cid: string;
  /** on-camera seconds */
  dur: number;
  /** kit key from the colour split, or null when the kits did not separate */
  team: string | null;
  members: string[];
  junctions: Junction[];
  /** look-alikes that were never on screen with this group: [distance, cid] */
  nb: Array<[number, string]>;
};

export type Chunk = {
  k: number;
  /** tracking seconds where this chunk starts */
  start: number;
  dur: number;
  pieces: Record<string, Piece>;
  /** 0.5 s box samples per piece id */
  ov: Record<string, Sample[]>;
  /** first and last sample time per piece id */
  ovb: Record<string, [number, number]>;
  /** crop key -> base64 JPEG */
  crops: Record<string, string>;
  groups: Group[];
  byCid: Record<string, Group>;
  /** piece id -> group cid */
  gOf: Record<string, string>;
  /** from the bundle: tracking-time crossings, used to decide which joins to ask */
  crossings: Array<{ t: number; a: string; b: string }>;
};

export type PitchGrid = {
  w: number;
  h: number;
  /** rows top-to-bottom of the image, columns left-to-right, metres */
  grid: Array<Array<[number, number]>>;
};

export type Game = {
  chunks: Array<{ k: number; start: number; dur: number }>;
  /** tracking seconds covered */
  total: number;
  /** source pixel size the boxes are in */
  srcW: number;
  srcH: number;
  frameRate: number;
  videoStartSeconds: number;
  matchOffset: number;
  /** pre-marked out-of-play ranges, tracking seconds */
  outOfPlay: Array<[number, number]>;
  inplay: Array<[number, number]>;
  pitch: PitchGrid | null;
};

export type OffKind = "play" | "cam" | "bench";
export type OffRange = [number, number, OffKind];

/** 'play' and 'bench' take time out of the game; 'cam' only says you could not be seen. */
export const OUT = (kind: OffKind) => kind === "play" || kind === "bench";

export function mmss(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const x = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${x}` : `${m}:${x}`;
}

export function spread<T>(items: T[], count: number): T[] {
  if (items.length <= count) return items.slice();
  if (count <= 0) return [];
  if (count === 1) return [items[Math.floor(items.length / 2)]];
  const out: T[] = [];
  for (let i = 0; i < count; i++) out.push(items[Math.round((i * (items.length - 1)) / (count - 1))]);
  return out;
}

export function chunkAt(game: Game, t: number): number {
  let k = game.chunks[0]?.k ?? 0;
  for (const c of game.chunks) if (t >= c.start) k = c.k;
  return k;
}

export const G2L = (game: Game, k: number, t: number) => t - (game.chunks.find((c) => c.k === k)?.start ?? 0);
export const L2G = (game: Game, k: number, t: number) => (game.chunks.find((c) => c.k === k)?.start ?? 0) + t;

/** Complement of a set of spans inside [0, total]. */
export function complement(spans: Array<[number, number]>, total: number): Array<[number, number]> {
  const sorted = spans
    .map(([a, b]) => [Math.max(0, a), Math.min(total, b)] as [number, number])
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0]);
  const out: Array<[number, number]> = [];
  let at = 0;
  for (const [a, b] of sorted) {
    if (a > at) out.push([at, a]);
    at = Math.max(at, b);
  }
  if (at < total) out.push([at, total]);
  return out;
}

/** Union of possibly-overlapping spans, sorted. */
export function union(spans: Array<[number, number]>): Array<[number, number]> {
  const sorted = spans.filter(([a, b]) => b > a).map((s) => [s[0], s[1]] as [number, number]).sort((x, y) => x[0] - y[0]);
  const out: Array<[number, number]> = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]);
    else out.push(s);
  }
  return out;
}

/** Seconds of [x, y] covered by a set of spans (overlaps counted once). */
export function overlapSeconds(x: number, y: number, spans: Array<[number, number]>): number {
  let total = 0;
  for (const [a, b] of union(spans)) total += Math.max(0, Math.min(y, b) - Math.max(x, a));
  return total;
}
