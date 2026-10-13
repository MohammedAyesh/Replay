import { cleanSamples, smoothPath, targetSeriesRange, type BallSample, type CameraPoint, type GameSpan } from "./follow-ball";

type CachedPath = { signature: string; promise: Promise<CameraPoint[]> };
const pathCache = new Map<string, CachedPath>();
const PATH_CACHE_LIMIT = 8;

function signature(samples: BallSample[], spans: GameSpan[], duration: number): string {
  let hash = 2166136261;
  const mix = (value: number) => {
    const scaled = Math.round(value * 1_000_000);
    hash = Math.imul(hash ^ scaled, 16777619);
  };
  for (const [t, x, y] of samples) {
    mix(t);
    mix(x);
    mix(y);
  }
  for (const [start, end] of spans) {
    mix(start);
    mix(end);
  }
  return `${duration}:${samples.length}:${spans.length}:${hash >>> 0}`;
}

function idleTurn(): Promise<void> {
  return new Promise((resolve) => {
    const ric = (globalThis as typeof globalThis & { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }).requestIdleCallback;
    if (ric) ric(() => resolve(), { timeout: 50 });
    else setTimeout(resolve, 0);
  });
}

async function computeOnMainThread(samples: BallSample[], spans: GameSpan[], duration: number): Promise<CameraPoint[]> {
  const clean = cleanSamples(samples);
  const targetCount = Math.ceil(Math.max(0, duration) / 0.1) + 1;
  const targets: CameraPoint[] = [];
  const coreSize = 160;
  for (let start = 0; start < targetCount; start += coreSize) {
    const chunk = targetSeriesRange(clean, spans, duration, start, Math.min(targetCount, start + coreSize));
    for (const point of chunk) targets.push(point);
    await idleTurn();
  }
  const result: CameraPoint[] = [];
  const overlap = 48;
  for (let start = 0; start < targets.length; start += coreSize) {
    const end = Math.min(targets.length, start + coreSize);
    const from = Math.max(0, start - overlap);
    const to = Math.min(targets.length, end + overlap);
    const chunk = smoothPath(targets.slice(from, to));
    for (let i = start; i < end; i++) result.push(chunk[i - from]);
    await idleTurn();
  }
  return result;
}

async function computeWithWorker(samples: BallSample[], spans: GameSpan[], duration: number): Promise<CameraPoint[]> {
  let worker: Worker;
  try {
    worker = new Worker(new URL("./follow-ball.worker.ts", import.meta.url), { type: "module" });
  } catch (error) {
    return computeOnMainThread(samples, spans, duration);
  }
  return new Promise<CameraPoint[]>((resolve, reject) => {
    const timeout = setTimeout(() => {
      worker.terminate();
      reject(new Error("Follow-ball worker timed out"));
    }, 10_000);
    const finish = (callback: () => void) => {
      clearTimeout(timeout);
      worker.terminate();
      callback();
    };
    worker.onmessage = (event: MessageEvent<{ id: number; path?: CameraPoint[]; error?: string }>) => {
      if (event.data.id !== 1) return;
      if (event.data.error) finish(() => reject(new Error(event.data.error)));
      else if (event.data.path) finish(() => resolve(event.data.path!));
      else finish(() => reject(new Error("Follow-ball worker returned no camera path")));
    };
    worker.onerror = (event) => finish(() => reject(new Error(event.message || "Follow-ball worker failed")));
    worker.postMessage({ id: 1, samples, spans, duration });
  });
}

export async function computeFollowBallPath(
  guid: string,
  samples: BallSample[],
  spans: GameSpan[],
  duration: number,
): Promise<CameraPoint[]> {
  const key = signature(samples, spans, duration);
  const cached = pathCache.get(guid);
  if (cached?.signature === key) {
    pathCache.delete(guid);
    pathCache.set(guid, cached);
    return cached.promise;
  }

  const promise = computeWithWorker(samples, spans, duration).catch(() =>
    computeOnMainThread(samples, spans, duration));
  pathCache.set(guid, { signature: key, promise });
  while (pathCache.size > PATH_CACHE_LIMIT) {
    const oldest = pathCache.keys().next().value;
    if (oldest === undefined) break;
    pathCache.delete(oldest);
  }
  void promise.catch(() => {
    if (pathCache.get(guid)?.promise === promise) pathCache.delete(guid);
  });
  return promise;
}
