import type { BallSample, CameraPoint, GameSpan } from "./follow-ball";

type CachedPath = { signature: string; promise: Promise<CameraPoint[]> };
const pathCache = new Map<string, CachedPath>();
let nextRequestId = 1;

function signature(samples: BallSample[], duration: number): string {
  const first = samples[0];
  const last = samples[samples.length - 1];
  return `${duration}:${samples.length}:${first?.[0] ?? ""}:${last?.[0] ?? ""}`;
}

export function computeFollowBallPath(
  guid: string,
  samples: BallSample[],
  spans: GameSpan[],
  duration: number,
): Promise<CameraPoint[]> {
  const key = signature(samples, duration);
  const cached = pathCache.get(guid);
  if (cached?.signature === key) return cached.promise;

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
  void promise.catch(() => {
    if (pathCache.get(guid)?.promise === promise) pathCache.delete(guid);
  });
  return promise;
}
