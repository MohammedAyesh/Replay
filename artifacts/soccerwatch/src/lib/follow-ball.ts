export type BallSample = [number, number, number];
export type GameSpan = [number, number];
export type CameraPoint = [number, number, number];

export const FOLLOW_GRID_SECONDS = 0.1;
export const FOLLOW_SIGMA_SECONDS = 0.7;
export const FOLLOW_MAX_SPEED = 0.22;
export const FOLLOW_VERTICAL_MAX_SPEED = FOLLOW_MAX_SPEED / 2;
export const FOLLOW_DEAD_ZONE = 0.06;
export const FOLLOW_MAX_JUMP = 0.09;
export const FOLLOW_JUMP_WINDOW = 0.25;
export const FOLLOW_PITCH_TOP = 0.15;
export const FOLLOW_PITCH_BOTTOM = 0.75;

export function cleanSamples(samples: BallSample[]): BallSample[] {
  const sorted = samples.filter((p) => p.every(Number.isFinite)).slice().sort((a, b) => a[0] - b[0]);
  const out: BallSample[] = [];
  let rejected = 0;
  for (const point of sorted) {
    const last = out[out.length - 1];
    if (last) {
      const dt = Math.max(0.05, point[0] - last[0]);
      if (point[0] - last[0] <= FOLLOW_JUMP_WINDOW
        && Math.abs(point[1] - last[1]) > FOLLOW_MAX_JUMP && rejected < 6) {
        rejected += 1;
        continue;
      }
    }
    rejected = 0;
    out.push(point);
  }
  return out;
}

function at(samples: BallSample[], t: number): [number, number] | null {
  if (!samples.length) return null;
  let lo = 0, hi = samples.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (samples[mid][0] < t) lo = mid + 1; else hi = mid;
  }
  const b = samples[Math.min(lo, samples.length - 1)];
  const a = samples[Math.max(0, lo - 1)];
  const f = b[0] > a[0] ? Math.max(0, Math.min(1, (t - a[0]) / (b[0] - a[0]))) : 0;
  return [a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

export function targetSeries(samples: BallSample[], gameSpans: GameSpan[], duration: number): CameraPoint[] {
  const clean = cleanSamples(samples);
  const points: CameraPoint[] = [];
  const count = Math.ceil(Math.max(0, duration) / FOLLOW_GRID_SECONDS);
  for (let i = 0; i <= count; i++) {
    const t = Math.min(duration, i * FOLLOW_GRID_SECONDS);
    const inGame = gameSpans.some(([start, end]) => t >= start && t <= end);
    const ball = inGame ? at(clean, t) : null;
    points.push([t, ball?.[0] ?? 0.5, ball?.[1] ?? 0.5]);
  }
  return points;
}

function smoothAxis(values: number[], sigma: number, speed: number, deadZone: number): number[] {
  const radius = Math.ceil(sigma * 3 / FOLLOW_GRID_SECONDS);
  const gaussian = values.map((_, i) => {
    let total = 0, weight = 0;
    for (let j = Math.max(0, i - radius); j <= Math.min(values.length - 1, i + radius); j++) {
      const d = (j - i) * FOLLOW_GRID_SECONDS;
      const w = Math.exp(-(d * d) / (2 * sigma * sigma));
      total += values[j] * w;
      weight += w;
    }
    return total / weight;
  });
  let centered = gaussian;
  if (deadZone > 0 && gaussian.length) {
    const forward = new Array<number>(gaussian.length);
    const backward = new Array<number>(gaussian.length);
    forward[0] = gaussian[0];
    for (let i = 1; i < gaussian.length; i++) {
      const previous = forward[i - 1];
      const delta = gaussian[i] - previous;
      forward[i] = Math.abs(delta) <= deadZone ? previous : gaussian[i] - Math.sign(delta) * deadZone;
    }
    const last = gaussian.length - 1;
    backward[last] = gaussian[last];
    for (let i = last - 1; i >= 0; i--) {
      const next = backward[i + 1];
      const delta = gaussian[i] - next;
      backward[i] = Math.abs(delta) <= deadZone ? next : gaussian[i] - Math.sign(delta) * deadZone;
    }
    centered = new Array<number>(gaussian.length);
    for (let i = 0; i < gaussian.length; i++) centered[i] = (forward[i] + backward[i]) / 2;
  }
  let limited = new Array<number>(centered.length);
  for (let i = 0; i < centered.length; i++) limited[i] = centered[i];
  for (let pass = 0; pass < 8; pass++) {
    const forward = new Array<number>(limited.length);
    const backward = new Array<number>(limited.length);
    for (let i = 0; i < limited.length; i++) {
      forward[i] = limited[i];
      backward[i] = limited[i];
    }
    for (let i = 1; i < forward.length; i++) {
      forward[i] = Math.max(forward[i - 1] - speed * FOLLOW_GRID_SECONDS, Math.min(forward[i - 1] + speed * FOLLOW_GRID_SECONDS, forward[i]));
    }
    for (let i = backward.length - 2; i >= 0; i--) {
      backward[i] = Math.max(backward[i + 1] - speed * FOLLOW_GRID_SECONDS, Math.min(backward[i + 1] + speed * FOLLOW_GRID_SECONDS, backward[i]));
    }
    limited = new Array<number>(forward.length);
    for (let i = 0; i < forward.length; i++) limited[i] = (forward[i] + backward[i]) / 2;
  }
  return limited;
}

export function smoothPath(target: CameraPoint[]): CameraPoint[] {
  if (!target.length) return [];
  const x = smoothAxis(target.map((p) => p[1]), FOLLOW_SIGMA_SECONDS, FOLLOW_MAX_SPEED, FOLLOW_DEAD_ZONE);
  const y = smoothAxis(target.map((p) => p[2]), FOLLOW_SIGMA_SECONDS, FOLLOW_VERTICAL_MAX_SPEED, 0);
  return target.map(([t], i) => [t, x[i], Math.max(FOLLOW_PITCH_TOP, Math.min(FOLLOW_PITCH_BOTTOM, y[i]))]);
}

export function cameraAt(path: CameraPoint[], t: number): number {
  return cameraPointAt(path, t)[0];
}

export function cameraYAt(path: CameraPoint[], t: number): number {
  return cameraPointAt(path, t)[1];
}

function cameraPointAt(path: CameraPoint[], t: number): [number, number] {
  if (!path.length) return [0.5, 0.5];
  let lo = 0, hi = path.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (path[mid][0] < t) lo = mid + 1; else hi = mid;
  }
  const b = path[lo], a = path[Math.max(0, lo - 1)];
  const f = b[0] > a[0] ? Math.max(0, Math.min(1, (t - a[0]) / (b[0] - a[0]))) : 0;
  return [a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}
