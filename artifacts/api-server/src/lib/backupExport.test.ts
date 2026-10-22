import { describe, expect, it, vi } from "vitest";
import { probeExportObject } from "./backupExport";

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
