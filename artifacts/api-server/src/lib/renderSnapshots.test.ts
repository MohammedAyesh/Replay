import { describe, expect, it, vi } from "vitest";
import { saveRenderSnapshotBestEffort } from "./renderSnapshots";

describe("render snapshot persistence", () => {
  it("returns before a failed save and reports the error without throwing", async () => {
    const failure = new Error("database unavailable");
    const save = vi.fn(async () => { throw failure; });
    const reportError = vi.fn();

    expect(saveRenderSnapshotBestEffort(save, reportError)).toBeUndefined();
    expect(save).not.toHaveBeenCalled();

    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(save).toHaveBeenCalledOnce();
    expect(reportError).toHaveBeenCalledWith(failure);
  });
});
