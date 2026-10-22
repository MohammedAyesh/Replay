import { afterEach, describe, expect, it, vi } from "vitest";
import { cachedExportFallback, checkInitialExportStatus } from "./exportStatusCheck";

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as Response;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("initial export-status check", () => {
  it("falls back after a non-OK response", async () => {
    const status = await checkInitialExportStatus(async () => jsonResponse({}, false));
    expect(status).toBeNull();
    expect(cachedExportFallback("done", "https://cdn.test/clip.mp4")).toBe("ready");
    expect(cachedExportFallback("error", "https://cdn.test/clip.mp4")).toBe("idle");
  });

  it("falls back after a network error", async () => {
    const status = await checkInitialExportStatus(async () => {
      throw new Error("offline");
    });
    expect(status).toBeNull();
    expect(cachedExportFallback(null, "https://cdn.test/clip.mp4")).toBe("idle");
  });

  it("falls back when the response does not arrive within ten seconds", async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    const pending = checkInitialExportStatus((signal) => {
      requestSignal = signal;
      return new Promise<Response>(() => {});
    });

    await vi.advanceTimersByTimeAsync(10_000);

    await expect(pending).resolves.toBeNull();
    expect(requestSignal?.aborted).toBe(true);
    expect(cachedExportFallback("expired", "https://cdn.test/clip.mp4")).toBe("idle");
  });

  it("falls back after unreadable JSON", async () => {
    const status = await checkInitialExportStatus(async () => ({
      ok: true,
      json: async () => { throw new SyntaxError("invalid JSON"); },
    } as Response));
    expect(status).toBeNull();
    expect(cachedExportFallback("done", null)).toBe("idle");
  });

  it("returns a normal server response", async () => {
    const status = await checkInitialExportStatus(async () =>
      jsonResponse({ status: "done", url: "https://cdn.test/clip.mp4" }));
    expect(status).toEqual({ status: "done", url: "https://cdn.test/clip.mp4" });
  });
});
