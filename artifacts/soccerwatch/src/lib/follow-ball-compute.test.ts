import { afterEach, describe, expect, it, vi } from "vitest";
import { computeFollowBallPath } from "./follow-ball-compute";
import { smoothPath, targetSeries } from "./follow-ball";

afterEach(() => vi.unstubAllGlobals());

describe("follow-ball worker fallback", () => {
  it("uses the chunked main-thread path when Worker construction throws", async () => {
    vi.stubGlobal("Worker", class {
      constructor() { throw new Error("worker-src blocked"); }
    });
    const samples: [number, number, number][] = [[0, .25, .5], [10, .75, .5]];
    const expected = smoothPath(targetSeries(samples, [[0, 10]], 10));
    const actual = await computeFollowBallPath(`fallback-${Date.now()}`, samples, [[0, 10]], 10);
    expect(actual).toEqual(expected);
  });
});
