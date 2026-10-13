import { smoothPath, targetSeries, type BallSample, type CameraPoint, type GameSpan } from "./follow-ball";

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

function computeOnMainThread(samples: BallSample[], spans: GameSpan[], duration: number): Promise<CameraPoint[]> {
  return new Promise((resolve, reject) => {
    const compute = () => {
      try {
        resolve(smoothPath(targetSeries(samples, spans, duration)));
      } catch (error) {
        reject(error);
      }
    };
    const ric = (globalThis as typeof globalThis & {
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
    }).requestIdleCallback;
    if (ric) ric(compute, { timeout: 50 });
    else setTimeout(compute, 0);
  });
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
