import type { BallSample, CameraPoint, GameSpan } from "./follow-ball";

type CachedPath = { signature: string; promise: Promise<CameraPoint[]> };
const pathCache = new Map<string, CachedPath>();
const PATH_CACHE_LIMIT = 8;
let nextRequestId = 1;

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

export function computeFollowBallPath(
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

  const id = nextRequestId++;
  const worker = new Worker(new URL("./follow-ball.worker.ts", import.meta.url), { type: "module" });
  const promise = new Promise<CameraPoint[]>((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<{ id: number; path?: CameraPoint[]; error?: string }>) => {
      if (event.data.id !== id) return;
      worker.terminate();
      if (event.data.error) reject(new Error(event.data.error));
      else if (event.data.path) resolve(event.data.path);
      else reject(new Error("Follow-ball worker returned no camera path"));
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message || "Follow-ball worker failed"));
    };
    worker.postMessage({ id, samples, spans, duration });
  });
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
