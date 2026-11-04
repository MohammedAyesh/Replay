import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EARLY_MAX_AGE_MS, fetchEarly, takeEarly, type EarlyStore } from "./early-fetch";

describe("early match requests from index.html", () => {
  // the tests run in node: a bare window object to hold the store
  beforeEach(() => {
    vi.stubGlobal("window", {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("hands each early response over once", () => {
    const response = Promise.resolve(new Response("{}"));
    const store: EarlyStore = { "/api/m/PYHMDZ": { at: 1_000, response } };
    expect(takeEarly("/api/m/PYHMDZ", 2_000, store)).toBe(response);
    expect(takeEarly("/api/m/PYHMDZ", 2_000, store)).toBeNull();
  });

  it("does not use one that is too old, or for another URL", () => {
    const store: EarlyStore = {
      "/api/m/PYHMDZ": { at: 0, response: Promise.resolve(new Response("{}")) },
      "/api/m/PYHMDZ/replay": { at: 0, response: Promise.resolve(new Response("{}")) },
    };
    expect(takeEarly("/api/m/PYHMDZ", EARLY_MAX_AGE_MS + 1, store)).toBeNull();
    expect(takeEarly("/api/m/OTHER/replay", 1, store)).toBeNull();
  });

  it("answers the app's first read from it, and later reads from the network", async () => {
    const network = vi.fn(async () => new Response(JSON.stringify({ from: "network" })));
    vi.stubGlobal("fetch", network);
    window.__replayEarly = { "/api/m/PYHMDZ/stats": { at: Date.now(), response: Promise.resolve(new Response(JSON.stringify({ from: "early" }))) } };
    expect(await (await fetchEarly("/api/m/PYHMDZ/stats", { credentials: "include" })).json()).toEqual({ from: "early" });
    expect(network).not.toHaveBeenCalled();
    expect(await (await fetchEarly("/api/m/PYHMDZ/stats", { credentials: "include" })).json()).toEqual({ from: "network" });
    expect(network).toHaveBeenCalledTimes(1);
  });

  it("never answers a write from it", async () => {
    const network = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", network);
    window.__replayEarly = { "/api/m/PYHMDZ": { at: Date.now(), response: Promise.resolve(new Response("{}")) } };
    await fetchEarly("/api/m/PYHMDZ", { method: "PATCH", body: "{}" });
    expect(network).toHaveBeenCalledTimes(1);
    expect(window.__replayEarly["/api/m/PYHMDZ"]).toBeDefined();
  });

  it("falls back to the network when the early request failed", async () => {
    const network = vi.fn(async () => new Response(JSON.stringify({ ok: true })));
    vi.stubGlobal("fetch", network);
    const failed = Promise.reject(new TypeError("offline"));
    failed.catch(() => undefined);
    window.__replayEarly = { "/api/m/PYHMDZ/clips": { at: Date.now(), response: failed } };
    expect(await (await fetchEarly("/api/m/PYHMDZ/clips")).json()).toEqual({ ok: true });
    expect(network).toHaveBeenCalledTimes(1);
  });
});
