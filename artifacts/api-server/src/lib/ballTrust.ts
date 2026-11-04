/**
 * Which points of the ball path are the real ball around a moment.
 *
 * The analysis's ball path can jump: ball_path.py links detections under a
 * speed ceiling, but "the chain may break and restart anywhere, for a price"
 * (its RESTART), and a restart has no speed check. Rec 410 (job 34), the 35'
 * shot (key 20980): a ball-like object stands still at (692, 428), by the far
 * goal, at detector confidence 0.5-0.67 for the whole 9 s. Pass 1 of the path
 * sat on it throughout and never saw the shot. The final pass (colour and shoe
 * gates; the gate scores that object 0.59-0.99 "shoe") follows the shot at
 * x 2,560-2,900 in two stretches and breaks back onto the still object at
 * frames 5880, 5909 and 5960 -- 2,000 px in a quarter of a second. The goal
 * reel followed it and drew "In?" on the other keeper.
 *
 * Here the path is cut into runs wherever two consecutive points are further
 * apart than a ball can go in the time between them. The run at the moment
 * is kept. A run before or after it is kept only if the ball could have got
 * there from the last kept point; a run that hardly moves (a parked ball, a
 * boot, a post) must be reachable at a rolling ball's speed. Everything else
 * is dropped, and callers hold the last good position across the hole.
 *
 * Speeds are in frame widths per second, so they work for 3840- and
 * 4096-wide tracking alike. On the Duo 3 panorama the pitch's ~40 m spans
 * most of the width: 0.8 width/s is about a 35 m/s shot, 0.25 width/s about
 * 12 m/s -- the two ceilings ball_path.py uses for a hop and a bridge.
 */
export type BallRow = readonly [number, number, number, ...number[]];

export const BALL_TRUST = {
  /** fastest a ball moves between two path points (frame widths per second) */
  maxSpeed: 0.8,
  /** fastest a ball reaches a spot it then sits still at */
  stillSpeed: 0.25,
  /** a run whose points all stay this close to its middle (frame widths) sits still */
  stillSpread: 0.008,
  /** a run must last this long to count as sitting still, seconds */
  stillSeconds: 0.75,
  /** measurement slack on every step (frame widths) */
  slack: 0.012,
  /** a moving run this close to the moment is the ball the moment is about, seconds */
  homeSeconds: 1.5,
};

type Run = { rows: BallRow[]; still: boolean };

function dist(a: BallRow, b: BallRow, width: number): number {
  return Math.hypot(a[1] - b[1], a[2] - b[2]) / width;
}

function reachable(from: BallRow, to: BallRow, speed: number, width: number, fps: number): boolean {
  const dt = Math.max(1, Math.abs(to[0] - from[0])) / fps;
  return dist(from, to, width) <= speed * dt + BALL_TRUST.slack;
}

function isStill(rows: BallRow[], width: number, fps: number): boolean {
  if (rows.length < 2 || (rows[rows.length - 1][0] - rows[0][0]) / fps < BALL_TRUST.stillSeconds) return false;
  const xs = rows.map((r) => r[1]).sort((a, b) => a - b);
  const ys = rows.map((r) => r[2]).sort((a, b) => a - b);
  const mid: BallRow = [0, xs[xs.length >> 1], ys[ys.length >> 1]];
  return rows.every((r) => dist(r, mid, width) <= BALL_TRUST.stillSpread);
}

/**
 * The ball path's points between `fromFrame` and `toFrame` that belong to the
 * ball at `anchorFrame` (the moment the card or clip is about), in frame
 * order. Rows are [frame, x, y, ...] in tracking pixels.
 */
export function trustedBall(
  rows: ReadonlyArray<BallRow>,
  manifest: { frameRate: number; width: number },
  fromFrame: number,
  toFrame: number,
  anchorFrame: number,
): BallRow[] {
  const fps = manifest.frameRate > 0 ? manifest.frameRate : 20;
  const width = manifest.width > 0 ? manifest.width : 3840;
  const near = rows.filter((r) => r[0] >= fromFrame && r[0] <= toFrame).slice().sort((a, b) => a[0] - b[0]);
  if (!near.length) return [];

  const runs: Run[] = [];
  let cur: BallRow[] = [near[0]];
  for (let i = 1; i < near.length; i++) {
    if (reachable(near[i - 1], near[i], BALL_TRUST.maxSpeed, width, fps)) cur.push(near[i]);
    else { runs.push({ rows: cur, still: false }); cur = [near[i]]; }
  }
  runs.push({ rows: cur, still: false });
  for (const run of runs) run.still = isStill(run.rows, width, fps);

  // The run at the moment. A shot, pass or dribble is a moving ball, so a
  // moving run within BALL_TRUST.homeSeconds of the moment beats a still one
  // that happens to hold the exact frame: on rec 410 the shot's frame (5960)
  // is the very frame the path broke back onto the still object.
  const gapTo = (run: Run) => {
    const a = run.rows[0][0], b = run.rows[run.rows.length - 1][0];
    return anchorFrame < a ? a - anchorFrame : anchorFrame > b ? anchorFrame - b : 0;
  };
  let home = -1;
  for (let i = 0; i < runs.length; i++) {
    if (runs[i].still || gapTo(runs[i]) > BALL_TRUST.homeSeconds * fps) continue;
    if (home < 0 || gapTo(runs[i]) < gapTo(runs[home])) home = i;
  }
  if (home < 0) {
    home = 0;
    for (let i = 1; i < runs.length; i++) if (gapTo(runs[i]) < gapTo(runs[home])) home = i;
  }

  const keep = new Set<number>([home]);
  const join = (edge: BallRow, run: Run, entry: BallRow) =>
    reachable(edge, entry, run.still ? BALL_TRUST.stillSpeed : BALL_TRUST.maxSpeed, width, fps);
  // After the moment: each run must be reachable from the last kept point.
  let edge = runs[home].rows[runs[home].rows.length - 1];
  for (let i = home + 1; i < runs.length; i++) {
    if (!join(edge, runs[i], runs[i].rows[0])) continue;
    keep.add(i);
    edge = runs[i].rows[runs[i].rows.length - 1];
  }
  // Before it, walking back in time.
  edge = runs[home].rows[0];
  for (let i = home - 1; i >= 0; i--) {
    if (!join(edge, runs[i], runs[i].rows[runs[i].rows.length - 1])) continue;
    keep.add(i);
    edge = runs[i].rows[0];
  }
  return runs.flatMap((run, i) => (keep.has(i) ? run.rows : []));
}
