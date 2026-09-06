/**
 * The manifest cache added 2026-09-06, and the one way it could do real harm.
 *
 * A VOD playlist is immutable and expensive to rewrite — every segment line
 * becomes `/api/hls-proxy/segment?url=<fully encoded absolute URL>`, which took
 * a 54 KB upstream playlist to 264 KB. Caching it stops every hls.js retry and
 * every viewer paying for that again.
 *
 * A LIVE playlist is the opposite: it changes every few seconds, and serving a
 * cached copy would freeze the stream at whatever segment it held. These tests
 * exist for that second case.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express, { type Express } from "express";

import router from "./hlsProxy";

const UPSTREAM = "https://vz-test.b-cdn.net/abc/1080p/video.m3u8";
const LIVE_UPSTREAM = "https://replayjo.b-cdn.net/camera1/index.m3u8";

function vodPlaylist(tag: string) {
  return [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    "#EXT-X-TARGETDURATION:4",
    "#EXT-X-PLAYLIST-TYPE:VOD",
    "#EXTINF:4.000,",
    `${tag}.ts`,
    "#EXT-X-ENDLIST",
    "",
  ].join("\n");
}

function livePlaylist(tag: string) {
  // No ENDLIST, no PLAYLIST-TYPE — a sliding window.
  return [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    "#EXT-X-TARGETDURATION:4",
    "#EXT-X-MEDIA-SEQUENCE:100",
    "#EXTINF:4.000,",
    `${tag}.ts`,
    "",
  ].join("\n");
}

let app: Express;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  app = express();
  app.use("/api", router);
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function upstreamOnce(body: string) {
  fetchMock.mockResolvedValueOnce({
    ok: true,
    status: 200,
    text: async () => body,
  });
}

describe("hls-proxy manifest cache", () => {
  it("serves a VOD playlist from cache on the second request", async () => {
    const url = `${UPSTREAM}?vod-${Date.now()}`;
    upstreamOnce(vodPlaylist("first"));

    const a = await request(app).get("/api/hls-proxy/manifest").query({ url });
    expect(a.status).toBe(200);
    expect(a.text).toContain("first.ts");

    // If the cache misses, this second call has no queued upstream response and
    // would fail — so reaching 200 with the same body IS the assertion.
    const b = await request(app).get("/api/hls-proxy/manifest").query({ url });
    expect(b.status).toBe(200);
    expect(b.text).toBe(a.text);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("NEVER caches a live playlist — a frozen live stream is worse than a slow one", async () => {
    const url = `${LIVE_UPSTREAM}?live-${Date.now()}`;
    upstreamOnce(livePlaylist("seg100"));
    upstreamOnce(livePlaylist("seg101"));

    const a = await request(app).get("/api/hls-proxy/manifest").query({ url });
    const b = await request(app).get("/api/hls-proxy/manifest").query({ url });

    expect(a.text).toContain("seg100.ts");
    expect(b.text).toContain("seg101.ts");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rewrites segment URIs through the proxy", async () => {
    const url = `${UPSTREAM}?rewrite-${Date.now()}`;
    upstreamOnce(vodPlaylist("chunk"));
    const res = await request(app).get("/api/hls-proxy/manifest").query({ url });
    expect(res.text).toContain("/api/hls-proxy/segment?url=");
    expect(res.text).toContain(encodeURIComponent("chunk.ts"));
  });

  it("reports WHY an upstream fetch failed instead of a bare 503", async () => {
    const url = `${UPSTREAM}?boom-${Date.now()}`;
    const err = new Error("The operation was aborted due to timeout");
    err.name = "TimeoutError";
    fetchMock.mockRejectedValueOnce(err);
    vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await request(app).get("/api/hls-proxy/manifest").query({ url });
    // 504 not 503: this is an upstream timeout, and the old bare 503 made a
    // timeout indistinguishable from a DNS failure in the logs.
    expect(res.status).toBe(504);
    expect(res.text).toContain("TimeoutError");
  });

  it("still refuses a non-Bunny host", async () => {
    const res = await request(app)
      .get("/api/hls-proxy/manifest")
      .query({ url: "https://evil.example.com/x.m3u8" });
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
