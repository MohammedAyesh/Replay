import { afterEach, describe, expect, it, vi } from "vitest";
import { computeFollowBallPath } from "./follow-ball-compute";
import { smoothPath, targetSeries } from "./follow-ball";

afterEach(() => vi.unstubAllGlobals());

describe("follow-ball worker fallback", () => {
  it("matches worker output when fallback processes a path longer than one former chunk", async () => {
    const samples = Array.from({ length: 81 }, (_, i): [number, number, number] => [
      i / 2,
      i < 32 ? .25 : i < 48 ? .72 + Math.sin(i) * .015 : .38,
      .5,
    ]);
    const spans: [number, number][] = [[0, 40]];
    const duration = 40;
    vi.stubGlobal("Worker", class {
      onmessage: ((event: MessageEvent<{ id: number; path: ReturnType<typeof smoothPath> }>) => void) | null = null;
      onerror: ((event: ErrorEvent) => void) | null = null;
      postMessage(request: { id: number }) {
        const path = smoothPath(targetSeries(samples, spans, duration));
        queueMicrotask(() => this.onmessage?.({ data: { id: request.id, path } } as MessageEvent));
      }
      terminate() {}
    });
    const workerPath = await computeFollowBallPath("worker-long-series", samples, spans, duration);

    vi.stubGlobal("Worker", class {
      constructor() { throw new Error("worker-src blocked"); }
    });
    const fallbackPath = await computeFollowBallPath("fallback-long-series", samples, spans, duration);
    expect(fallbackPath).toEqual(workerPath);
  });
});
