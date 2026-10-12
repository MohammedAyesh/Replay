import { describe, expect, it, vi } from "vitest";
import { sendClaimSave } from "./save";

describe("sendClaimSave", () => {
  it("sends a state-only keepalive immediately when claimed chunks are missing", async () => {
    const loadChunk = vi.fn(() => new Promise<void>(() => {}));
    const send = vi.fn(async (includeParts: boolean) => includeParts);

    const result = sendClaimSave([3], true, loadChunk, send);

    expect(loadChunk).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(false);
    await expect(result).resolves.toBe(false);
  });

  it("sends full parts immediately when all claimed chunks are loaded", async () => {
    const loadChunk = vi.fn(async () => undefined);
    const send = vi.fn(async (includeParts: boolean) => includeParts);

    const result = sendClaimSave([], true, loadChunk, send);

    expect(loadChunk).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(true);
    await expect(result).resolves.toBe(true);
  });

  it("waits for missing chunks on ordinary saves before sending full parts", async () => {
    let finishLoading!: () => void;
    const loadChunk = vi.fn(() => new Promise<void>((resolve) => {
      finishLoading = resolve;
    }));
    const send = vi.fn(async (includeParts: boolean) => includeParts);

    const doneSave = sendClaimSave([1], false, loadChunk, send);

    expect(loadChunk).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
    finishLoading();
    await expect(doneSave).resolves.toBe(true);
    expect(send).toHaveBeenCalledWith(true);
  });
});
