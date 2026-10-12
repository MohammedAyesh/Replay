import { afterEach, describe, expect, it, vi } from "vitest";
import { featureFromJpeg } from "./appearance";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("featureFromJpeg", () => {
  it("returns null when image decoding takes longer than three seconds", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("document", { visibilityState: "visible" });
    vi.stubGlobal("Image", class {
      src = "";
      decode() { return new Promise<void>(() => {}); }
    });

    const result = featureFromJpeg("jpeg");
    await vi.advanceTimersByTimeAsync(3000);
    await expect(result).resolves.toBeNull();
  });

  it("waits for a hidden tab to become visible before decoding", async () => {
    vi.useFakeTimers();
    let visibilityListener: (() => void) | undefined;
    const doc = {
      visibilityState: "hidden",
      addEventListener: vi.fn((_event: string, listener: () => void) => { visibilityListener = listener; }),
      removeEventListener: vi.fn(),
    };
    let decodeCalled = false;
    vi.stubGlobal("document", doc);
    vi.stubGlobal("Image", class {
      src = "";
      decode() {
        decodeCalled = true;
        return new Promise<void>(() => {});
      }
    });

    const result = featureFromJpeg("jpeg");
    await Promise.resolve();
    expect(decodeCalled).toBe(false);
    doc.visibilityState = "visible";
    visibilityListener?.();
    await vi.advanceTimersByTimeAsync(3000);
    await expect(result).resolves.toBeNull();
    expect(decodeCalled).toBe(true);
    expect(doc.removeEventListener).toHaveBeenCalledOnce();
  });
});
