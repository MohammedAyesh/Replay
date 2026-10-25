import { describe, expect, it, vi } from "vitest";
import { EXPORT_PROBE_TIMEOUT_MS, probeExportObject } from "./backupExport";

const objectUrl = "https://storage.bunnycdn.com/galaxyfield/clips/c580-ea8f9685b3b65a45.mp4";

function response(status: number, headers: Record<string, string> = {}) {
  return new Response(status === 200 || status === 206 ? new Uint8Array([0]) : null, {
    status,
    headers,
  });
}

describe("probeExportObject", () => {
  it.each([
    [200, "exists"],
    [206, "exists"],
    [404, "missing"],
    [401, "unverified"],
    [503, "unverified"],
  ] as const)("classifies Storage HTTP %i as %s", async (status, state) => {
    const fetcher = vi.fn().mockResolvedValue(response(status, {
      "content-range": "bytes 0-0/2759998",
      "content-length": "1",
    }));
    const result = await probeExportObject(objectUrl, {
      fetcher: fetcher as typeof fetch,
      storageApiKey: "unit-test-key",
    });
    expect(result.state).toBe(state);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({
      Range: "bytes=0-0",
      AccessKey: "unit-test-key",
    });
    if (state === "exists") expect(result.bytes).toBe(2_759_998);
  });

  it("gives up on a hung vps1 export after the short probe timeout, not the download budget", async () => {
    expect(EXPORT_PROBE_TIMEOUT_MS).toBeLessThanOrEqual(15_000);
    const fileSignals: (AbortSignal | undefined)[] = [];
    const hungFetch = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      // The control API's status lookup answers at once; only the file hangs.
      if (!url.endsWith("/file")) return Promise.resolve(new Response(null, { status: 404 }));
      fileSignals.push(init?.signal ?? undefined);
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    });
    vi.stubGlobal("fetch", hungFetch);
    try {
      const started = Date.now();
      const result = await probeExportObject("vps1-export:c580-ea8f9685b3b65a45", {
        storageApiKey: "",
        probeTimeoutMs: 100,
      });
      expect(result.state).toBe("unverified");
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(fileSignals).toHaveLength(1);
      expect(fileSignals[0]).toBeInstanceOf(AbortSignal);
      expect(fileSignals[0]?.aborted).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("returns unverified and makes no request when the Storage key is absent", async () => {
    const fetcher = vi.fn();
    const result = await probeExportObject(objectUrl, {
      fetcher: fetcher as typeof fetch,
      storageApiKey: "",
    });
    expect(result).toMatchObject({ state: "unverified", bytes: null, url: objectUrl });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
