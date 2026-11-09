/**
 * The red ball trail: which stretch of the ball path to draw behind the ball
 * at a moment, and how to draw it.
 *
 * Shared by the match player (a canvas over the <video>) and the server's
 * exports (frames drawn with @napi-rs/canvas and overlaid by ffmpeg), so a
 * trail looks the same wherever it is seen.
 *
 * Input is the app's ball path (`GET /api/videos/:guid/ball-path`):
 * `[videoSeconds, x, y]` with x and y as fractions of the full panorama.
 *
 * The trail is honest about gaps. It is drawn only back to the first break:
 * a time gap longer than `maxGap`, or a step faster than a ball can travel
 * (the path's restarts can jump onto a keeper's boots; lib/ballTrust.ts on
 * the server has the full story). It is never drawn across a hole, and a ball
 * that is not moving gets no trail at all.
 */

/** [video seconds, x fraction, y fraction] */
export type BallTrailSample = readonly [number, number, number, ...number[]];
export type BallTrailPoint = { t: number; x: number; y: number };

export const BALL_TRAIL = {
  /** how far back the trail reaches, seconds */
  seconds: 0.9,
  /** a longer gap between two path points breaks the trail, seconds */
  maxGap: 0.6,
  /** fastest a ball moves between two path points (frame widths per second; ~35 m/s on the Duo 3 panorama) */
  maxSpeed: 0.8,
  /** measurement slack on every step (frame widths) */
  slack: 0.012,
  /** keep drawing up to the last point for this long after it when no next point is in reach, seconds */
  headHold: 0.2,
  /** a trail shorter than this (frame widths) is a ball at rest: nothing is drawn */
  minLength: 0.006,
  /** source width / height (3840×1080 and 4096×1152 alike) */
  srcAspect: 3840 / 1080,
  /** densify to at most this spacing (seconds) so sparse paths still draw a curve */
  step: 1 / 30,
} as const;

/** Distance between two points, in frame widths. */
function widths(a: { x: number; y: number }, b: { x: number; y: number }, aspect: number): number {
  return Math.hypot(b.x - a.x, (b.y - a.y) / aspect);
}

function linked(a: BallTrailSample, b: BallTrailSample, aspect: number): boolean {
  const dt = b[0] - a[0];
  if (!(dt > 0) || dt > BALL_TRAIL.maxGap) return false;
  return widths({ x: a[1], y: a[2] }, { x: b[1], y: b[2] }, aspect) <= BALL_TRAIL.maxSpeed * dt + BALL_TRAIL.slack;
}

/** Index of the last sample at or before `time` (-1 if none). Samples are sorted by time. */
export function sampleIndexAt(samples: ReadonlyArray<BallTrailSample>, time: number): number {
  let lo = 0;
  let hi = samples.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (samples[mid][0] <= time) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found;
}

function catmull(p0: number, p1: number, p2: number, p3: number, u: number): number {
  const u2 = u * u;
  const u3 = u2 * u;
  return 0.5 * (2 * p1 + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u2 + (-p0 + 3 * p1 - 3 * p2 + p3) * u3);
}

/**
 * The trail at `time`, oldest point first, ending at the ball. Null when
 * there is nothing to draw: no ball near this moment, or a ball at rest.
 */
export function ballTrailAt(
  samples: ReadonlyArray<BallTrailSample>,
  time: number,
  opts: { seconds?: number; aspect?: number } = {},
): BallTrailPoint[] | null {
  const seconds = opts.seconds ?? BALL_TRAIL.seconds;
  const aspect = opts.aspect ?? BALL_TRAIL.srcAspect;
  if (!samples.length || !Number.isFinite(time)) return null;
  const i = sampleIndexAt(samples, time);
  if (i < 0) return null;
  const last = samples[i];
  const next = samples[i + 1];

  // The ball now: between the last point and the next, or held briefly on the last.
  let head: BallTrailPoint;
  if (next && linked(last, next, aspect)) {
    const u = (time - last[0]) / (next[0] - last[0]);
    head = { t: time, x: last[1] + (next[1] - last[1]) * u, y: last[2] + (next[2] - last[2]) * u };
  } else if (time - last[0] <= BALL_TRAIL.headHold) {
    head = { t: last[0], x: last[1], y: last[2] };
  } else {
    return null;
  }

  // Walk back to the first break or the trail's length.
  const from = head.t - seconds;
  const kept: BallTrailSample[] = [last];
  for (let j = i - 1; j >= 0; j--) {
    const a = samples[j];
    if (!linked(a, kept[kept.length - 1], aspect)) break;
    kept.push(a);
    if (a[0] <= from) break;
  }
  kept.reverse();

  // Knots: the kept samples (the oldest cut at `from`) and the head.
  const knots: BallTrailPoint[] = kept.map((s) => ({ t: s[0], x: s[1], y: s[2] }));
  if (knots.length > 1 && knots[0].t < from) {
    const a = knots[0];
    const b = knots[1];
    const u = (from - a.t) / (b.t - a.t);
    knots[0] = { t: from, x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
  }
  if (head.t > knots[knots.length - 1].t + 1e-6) knots.push(head);
  if (knots.length < 2) return null;
  // Detections wobble by a few pixels; soften the inside knots (never the ball's own position).
  if (knots.length > 2) {
    const soft = knots.map((k, j) => (j === 0 || j === knots.length - 1 ? k : {
      t: k.t,
      x: 0.25 * knots[j - 1].x + 0.5 * k.x + 0.25 * knots[j + 1].x,
      y: 0.25 * knots[j - 1].y + 0.5 * k.y + 0.25 * knots[j + 1].y,
    }));
    knots.splice(0, knots.length, ...soft);
  }

  // Densify with Catmull-Rom so a 4-per-second path still draws a curve.
  const out: BallTrailPoint[] = [knots[0]];
  for (let k = 0; k < knots.length - 1; k++) {
    const p0 = knots[Math.max(0, k - 1)];
    const p1 = knots[k];
    const p2 = knots[k + 1];
    const p3 = knots[Math.min(knots.length - 1, k + 2)];
    const n = Math.max(1, Math.min(24, Math.ceil((p2.t - p1.t) / BALL_TRAIL.step)));
    for (let s = 1; s <= n; s++) {
      const u = s / n;
      out.push({
        t: p1.t + (p2.t - p1.t) * u,
        x: catmull(p0.x, p1.x, p2.x, p3.x, u),
        y: catmull(p0.y, p1.y, p2.y, p3.y, u),
      });
    }
  }
  let length = 0;
  for (let k = 1; k < out.length; k++) length += widths(out[k - 1], out[k], aspect);
  if (length < BALL_TRAIL.minLength) return null;
  return out;
}

/** The part of the 2D canvas API the trail uses (browser and @napi-rs/canvas alike). */
export type TrailContext = {
  lineCap: string;
  lineJoin: string;
  lineWidth: number;
  strokeStyle: unknown;
  globalCompositeOperation: string;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  stroke(): void;
  save(): void;
  restore(): void;
};

export const TRAIL_COLOUR = { r: 255, g: 38, b: 38 };

/**
 * Draw a trail: a red streak, thin and faint at its tail and full width at
 * the ball, over a soft wider glow. `toPx` maps panorama fractions to canvas
 * pixels; `width` is the streak's width at the ball, in canvas pixels
 * (about a ball's diameter reads best).
 */
export function drawBallTrail(
  ctx: TrailContext,
  points: ReadonlyArray<BallTrailPoint>,
  toPx: (x: number, y: number) => [number, number],
  width: number,
): void {
  if (points.length < 2 || !(width > 0)) return;
  const px = points.map((p) => toPx(p.x, p.y));
  const n = px.length - 1;
  const { r, g, b } = TRAIL_COLOUR;
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.globalCompositeOperation = "source-over";
  // Glow first, then the streak over it.
  for (const pass of [{ w: 2.4, a: 0.22 }, { w: 1, a: 0.95 }]) {
    for (let k = 1; k <= n; k++) {
      const f = k / n; // 0 at the tail, 1 at the ball
      const ease = f * f * (3 - 2 * f);
      ctx.lineWidth = Math.max(1, width * pass.w * (0.25 + 0.75 * ease));
      ctx.strokeStyle = `rgba(${r},${g},${b},${(pass.a * (0.08 + 0.92 * ease)).toFixed(3)})`;
      ctx.beginPath();
      ctx.moveTo(px[k - 1][0], px[k - 1][1]);
      ctx.lineTo(px[k][0], px[k][1]);
      ctx.stroke();
    }
  }
  ctx.restore();
}

/** A streak about a ball's width: the ball is ~1% of the panorama's height. */
export function trailWidthFor(sourceHeightPx: number): number {
  return Math.max(2, sourceHeightPx * 0.011);
}
