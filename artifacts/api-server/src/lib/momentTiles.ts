/**
 * The match page's moment popup (2026-11-01): a moment on the Moments tab
 * plays in place, with -5 s / +5 s, instead of opening the watch page.
 *
 * The footage is cut into fixed tiles: ten seconds of one recording, on the
 * video's own clock (tile k is [10k, 10k + 10)). A tile is cut once, ever,
 * stored on Bunny and shared by every moment, every player and every visit
 * (lib/goalReelClip.ts does the cutting and the storing, as for the goal
 * reel's cards). Because tiles sit on a fixed grid, the five seconds either
 * side of a moment are almost always tiles somebody has already cut, and
 * -5 / +5 only ever needs the tile next door.
 *
 * Everything here is pure; routes/matchRooms.ts reads the recordings.
 */

/** seconds of video in one tile */
export const TILE_SECONDS = 10;

export const MOMENT_TILES = {
  /** a moment plays from this long before it, so -5 / +5 land on whole steps */
  lead: 5,
  /** seconds either side of a moment whose tiles the popup is told about (and whose ball path it gets) */
  reach: 15,
  /** moments one request may ask about */
  maxMoments: 200,
  /** the camera follows the ball from a point every this many seconds */
  focusStep: 0.5,
} as const;

/** a keyframe every second (20 fps): a -5 s step decodes at most a second to land */
export const TILE_RECIPE = { gop: 20 } as const;

/** One recording's share of a booking, and how its clock maps from the booking's. */
export type MomentPiece = {
  recordingId: number;
  srcW: number;
  srcH: number;
  /** booking seconds this recording covers */
  from: number;
  to: number;
  /** video seconds = booking seconds + shift */
  shift: number;
};

/**
 * A recording's share of the booking: booking seconds b = tracking t +
 * recordingOffsetSec, video seconds = t + videoStartSeconds. Clamped to the
 * booking (the footage the match's share link shows) and to the recording.
 */
export function momentPiece(input: {
  recordingId: number;
  srcW: number;
  srcH: number;
  /** tracking seconds of the recording */
  duration: number;
  recordingOffsetSec: number;
  videoStartSeconds: number;
  bookingSeconds: number;
}): MomentPiece | null {
  const fromT = Math.max(0, -input.recordingOffsetSec);
  const toT = Math.min(input.duration, input.bookingSeconds - input.recordingOffsetSec);
  if (!(toT > fromT)) return null;
  return {
    recordingId: input.recordingId,
    srcW: input.srcW,
    srcH: input.srcH,
    from: round3(fromT + input.recordingOffsetSec),
    to: round3(toT + input.recordingOffsetSec),
    shift: round3(input.videoStartSeconds - input.recordingOffsetSec),
  };
}

/** The piece a booking second plays from: the one holding it, else the nearest within 30 s. */
export function pieceAt(pieces: readonly MomentPiece[], at: number): MomentPiece | null {
  let best: MomentPiece | null = null;
  let gap = Infinity;
  for (const piece of pieces) {
    const d = at < piece.from ? piece.from - at : at > piece.to ? at - piece.to : 0;
    if (d < gap) { gap = d; best = piece; }
  }
  return gap <= 30 ? best : null;
}

export const tileOf = (videoSeconds: number) => Math.max(0, Math.floor(videoSeconds / TILE_SECONDS));
export const tileWindow = (k: number) => ({ start: k * TILE_SECONDS, end: (k + 1) * TILE_SECONDS });

/** The tiles a stretch of video needs, clamped to the piece's footage. */
export function tilesFor(piece: MomentPiece, fromVideo: number, toVideo: number): number[] {
  const lo = Math.max(fromVideo, piece.from + piece.shift);
  const hi = Math.min(toVideo, piece.to + piece.shift - 0.01);
  if (!(hi >= lo)) return [];
  const out: number[] = [];
  for (let k = tileOf(lo); k <= tileOf(hi); k++) out.push(k);
  return out;
}

/** Whether a tile overlaps the piece's footage (a tile a page may ask for). */
export function tileInPiece(piece: MomentPiece, k: number): boolean {
  const w = tileWindow(k);
  return k >= 0 && w.end > piece.from + piece.shift && w.start < piece.to + piece.shift;
}

/**
 * The tiles a moment opens on (the [lead] before it to as long after, cut
 * ahead of time) and the ones within reach either side (described to the
 * page, cut when asked for).
 */
export function momentTiles(piece: MomentPiece, at: number): { core: number[]; reach: number[] } {
  const v = at + piece.shift;
  return {
    core: tilesFor(piece, v - MOMENT_TILES.lead, v + MOMENT_TILES.lead),
    reach: tilesFor(piece, v - MOMENT_TILES.reach, v + MOMENT_TILES.reach),
  };
}

/** [video seconds, x, y] of the ball, x and y as fractions of the frame. */
export type BallPoint = [number, number, number];

type Ball = ReadonlyArray<readonly [number, number, number, ...number[]]>;

const sortedBall = new WeakMap<Ball, Ball>();
function sorted(ball: Ball): Ball {
  let hit = sortedBall.get(ball);
  if (!hit) {
    hit = [...ball].sort((a, b) => a[0] - b[0]);
    sortedBall.set(ball, hit);
  }
  return hit;
}

/**
 * Where the ball is through a tile, every focusStep, for the camera to follow
 * on the panorama. A gap with no ball holds the last place seen (or the next,
 * before the first); a tile with no ball at all has no points.
 */
export function tileFocus(
  ball: Ball,
  manifest: { frameRate: number; width: number; height: number },
  k: number,
  videoStartSeconds: number,
): BallPoint[] {
  const all = sorted(ball);
  if (!all.length || !(manifest.width > 0) || !(manifest.height > 0)) return [];
  const fps = manifest.frameRate > 0 ? manifest.frameRate : 20;
  const w = tileWindow(k);
  const out: BallPoint[] = [];
  let last: [number, number] | null = null;
  // the first ball sample at or after a frame (binary search)
  const firstAt = (frame: number) => {
    let lo = 0, hi = all.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (all[mid][0] < frame) lo = mid + 1; else hi = mid; }
    return lo;
  };
  for (let v = w.start; v <= w.end + 1e-6; v += MOMENT_TILES.focusStep) {
    const frame = (v - videoStartSeconds) * fps;
    const i = firstAt(frame);
    let best: readonly number[] | null = null;
    for (const j of [i - 1, i]) {
      const b = all[j];
      if (b && Math.abs(b[0] - frame) <= fps * 0.6 && (!best || Math.abs(b[0] - frame) < Math.abs(best[0] - frame))) best = b;
    }
    if (best) last = [round3(best[1] / manifest.width), round3(best[2] / manifest.height)];
    if (last) out.push([round3(v), last[0], last[1]]);
  }
  // before the first ball seen in the tile, hold where it is first seen
  if (out.length && out[0][0] > w.start + 1e-3) out.unshift([w.start, out[0][1], out[0][2]]);
  return out;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
