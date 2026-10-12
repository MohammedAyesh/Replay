import { describe, expect, it, vi } from "vitest";
import { loadResumeChunks } from "./resume";

describe("loadResumeChunks", () => {
  it("waits for the active chunk but not the other saved chunks", async () => {
    let finishCurrent!: () => void;
    const ensure = vi.fn((chunk: number) => chunk === 4
      ? new Promise<void>((resolve) => { finishCurrent = resolve; })
      : new Promise<void>(() => {}));

    let resumed = false;
    const loading = loadResumeChunks(4, [1, 4, 7], ensure).then(() => { resumed = true; });
    await Promise.resolve();
    expect(resumed).toBe(false);
    finishCurrent();
    await loading;

    expect(resumed).toBe(true);
    expect(ensure.mock.calls.map(([chunk]) => chunk)).toEqual([4, 1, 7]);
  });

  it("starts other chunks even when one background load rejects", async () => {
    const ensure = vi.fn((chunk: number) => chunk === 2
      ? Promise.resolve()
      : Promise.reject(new Error("chunk unavailable")));

    await expect(loadResumeChunks(2, [2, 3, 5], ensure)).resolves.toBeUndefined();
    await Promise.resolve();
    expect(ensure.mock.calls.map(([chunk]) => chunk)).toEqual([2, 3, 5]);
  });
});
