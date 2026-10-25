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

vi.mock("../lib/clerkUserBridge", () => ({
  getLocalUserRecord: vi.fn().mockResolvedValue({ id: 1, isAdmin: true, isGuest: false }),
}));

import router, { PROGRESSIVE_MP4_RESPONSE_MAX_BYTES } from "./hlsProxy";

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

const MP4_RANGE_BYTES = 4 * 1024 * 1024;
const MIN_MP4_RANGE_BYTES = 64 * 1024;

function mp4Range(start: number, end: number, total: number, fill: number) {
  return new Response(Buffer.alloc(end - start + 1, fill), {
    status: 206,
    headers: {
      "Content-Type": "video/mp4",
      "Content-Range": `bytes ${start}-${end}/${total}`,
      "Accept-Ranges": "bytes",
    },
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

  it("forwards byte ranges and partial-content headers for MP4 fallback playback", async () => {
    const url = "https://vz-test.b-cdn.net/abc/play_720p.mp4";
    fetchMock.mockResolvedValueOnce(new Response("data", {
      status: 206,
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": "4",
        "Content-Range": "bytes 0-3/100",
        "Accept-Ranges": "bytes",
      },
    }));

    const res = await request(app)
      .get("/api/hls-proxy/segment")
      .query({ url })
      .set("Range", "bytes=0-3");

    expect(res.status).toBe(206);
    expect(res.headers["content-range"]).toBe("bytes 0-3/100");
    expect(res.headers["accept-ranges"]).toBe("bytes");
    expect(res.headers["content-type"]).toContain("video/mp4");
    expect(fetchMock.mock.calls[0][1].headers).toMatchObject({
      Referer: "https://vz-test.b-cdn.net/",
      Range: "bytes=0-3",
    });
  });

  it("streams an open-ended MP4 range using bounded upstream requests", async () => {
    const url = "https://vz-test.b-cdn.net/abc/play_720p.mp4";
    const total = MP4_RANGE_BYTES + 7;
    fetchMock
      .mockResolvedValueOnce(mp4Range(0, MP4_RANGE_BYTES - 1, total, 17))
      .mockResolvedValueOnce(mp4Range(MP4_RANGE_BYTES, total - 1, total, 29));

    const res = await request(app)
      .get("/api/hls-proxy/segment")
      .query({ url })
      .set("Range", "bytes=0-");

    expect(res.status).toBe(206);
    expect(res.headers["accept-ranges"]).toBe("bytes");
    expect(res.headers["content-range"]).toBe(`bytes 0-${total - 1}/${total}`);
    expect(res.headers["content-length"]).toBe(String(total));
    expect(res.body).toHaveLength(total);
    expect(res.body[0]).toBe(17);
    expect(res.body[total - 1]).toBe(29);
    expect(fetchMock.mock.calls.map(([, init]) => new Headers(init?.headers).get("Range"))).toEqual([
      `bytes=0-${MP4_RANGE_BYTES - 1}`,
      `bytes=${MP4_RANGE_BYTES}-${MP4_RANGE_BYTES + MIN_MP4_RANGE_BYTES - 1}`,
    ]);
  });

  it("streams a no-Range MP4 request as a normal full response with range support", async () => {
    const url = "https://vz-test.b-cdn.net/abc/play_720p.mp4";
    const total = MP4_RANGE_BYTES + 3;
    fetchMock
      .mockResolvedValueOnce(mp4Range(0, MP4_RANGE_BYTES - 1, total, 41))
      .mockResolvedValueOnce(mp4Range(MP4_RANGE_BYTES, total - 1, total, 53));

    const res = await request(app)
      .get("/api/hls-proxy/segment")
      .query({ url });

    expect(res.status).toBe(200);
    expect(res.headers["accept-ranges"]).toBe("bytes");
    expect(res.headers["content-range"]).toBeUndefined();
    expect(res.headers["content-length"]).toBe(String(total));
    expect(res.body).toHaveLength(total);
    expect(res.body[0]).toBe(41);
    expect(res.body[total - 1]).toBe(53);
    expect(fetchMock.mock.calls.map(([, init]) => new Headers(init?.headers).get("Range"))).toEqual([
      `bytes=0-${MP4_RANGE_BYTES - 1}`,
      `bytes=${MP4_RANGE_BYTES}-${MP4_RANGE_BYTES + MIN_MP4_RANGE_BYTES - 1}`,
    ]);
  });

  /** Answers any bounded Range for a file of `total` bytes, like Bunny does. */
  function serveMp4Ranges(total: number) {
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      const match = new Headers(init?.headers).get("Range")?.match(/^bytes=(\d+)-(\d+)$/);
      if (!match) return new Response("unbounded range refused", { status: 400 });
      const start = Number(match[1]);
      if (start >= total) {
        return new Response("", { status: 416, headers: { "Content-Range": `bytes */${total}` } });
      }
      const end = Math.min(Number(match[2]), total - 1);
      return mp4Range(start, end, total, (start / MP4_RANGE_BYTES) & 0xff);
    });
  }

  it("caps an open-ended range on a whole-match MP4 to a bounded 206 under the host's 32 MiB limit", async () => {
    const url = "https://vz-test.b-cdn.net/abc/play_720p.mp4";
    const total = 1_200_000_000; // a whole match: well over 1 GB
    serveMp4Ranges(total);

    const res = await request(app)
      .get("/api/hls-proxy/segment")
      .query({ url })
      .set("Range", "bytes=0-");

    expect(res.status).toBe(206);
    expect(PROGRESSIVE_MP4_RESPONSE_MAX_BYTES).toBeLessThanOrEqual(30 * 1024 * 1024);
    expect(res.headers["content-length"]).toBe(String(PROGRESSIVE_MP4_RESPONSE_MAX_BYTES));
    expect(res.headers["content-range"]).toBe(`bytes 0-${PROGRESSIVE_MP4_RESPONSE_MAX_BYTES - 1}/${total}`);
    expect(res.body).toHaveLength(PROGRESSIVE_MP4_RESPONSE_MAX_BYTES);
    // Only the windows needed for this response were fetched, not the match.
    expect(fetchMock).toHaveBeenCalledTimes(PROGRESSIVE_MP4_RESPONSE_MAX_BYTES / MP4_RANGE_BYTES);
  });

  it("serves the next bounded window when the player continues from the middle of the file", async () => {
    const url = "https://vz-test.b-cdn.net/abc/play_720p.mp4";
    const total = 1_200_000_000;
    const start = 600_000_000;
    serveMp4Ranges(total);

    const res = await request(app)
      .get("/api/hls-proxy/segment")
      .query({ url })
      .set("Range", `bytes=${start}-`);

    expect(res.status).toBe(206);
    expect(res.headers["content-range"])
      .toBe(`bytes ${start}-${start + PROGRESSIVE_MP4_RESPONSE_MAX_BYTES - 1}/${total}`);
    expect(Number(res.headers["content-length"])).toBe(PROGRESSIVE_MP4_RESPONSE_MAX_BYTES);
    expect(res.body).toHaveLength(PROGRESSIVE_MP4_RESPONSE_MAX_BYTES);
  });

  it("caps an oversized bounded range and honours a final short range exactly", async () => {
    const url = "https://vz-test.b-cdn.net/abc/play_720p.mp4";
    const total = 1_200_000_000;
    serveMp4Ranges(total);

    const big = await request(app)
      .get("/api/hls-proxy/segment")
      .query({ url })
      .set("Range", "bytes=100-999999999");
    expect(big.status).toBe(206);
    expect(big.headers["content-range"])
      .toBe(`bytes 100-${100 + PROGRESSIVE_MP4_RESPONSE_MAX_BYTES - 1}/${total}`);
    expect(big.body).toHaveLength(PROGRESSIVE_MP4_RESPONSE_MAX_BYTES);

    fetchMock.mockClear();
    const tail = await request(app)
      .get("/api/hls-proxy/segment")
      .query({ url })
      .set("Range", `bytes=${total - 10}-`);
    expect(tail.status).toBe(206);
    expect(tail.headers["content-range"]).toBe(`bytes ${total - 10}-${total - 1}/${total}`);
    expect(tail.headers["content-length"]).toBe("10");
    expect(tail.body).toHaveLength(10);
  });

  it("streams a no-Range request for a file over the limit without a Content-Length", async () => {
    const url = "https://vz-test.b-cdn.net/abc/play_720p.mp4";
    const total = 40 * 1024 * 1024 + 5;
    serveMp4Ranges(total);

    const res = await request(app)
      .get("/api/hls-proxy/segment")
      .query({ url });

    expect(res.status).toBe(200);
    expect(res.headers["content-length"]).toBeUndefined();
    expect(res.headers["transfer-encoding"]).toBe("chunked");
    expect(res.body).toHaveLength(total);
  });

  it("answers 416 for an open-ended range past the end of the MP4", async () => {
    const url = "https://vz-test.b-cdn.net/abc/play_720p.mp4";
    serveMp4Ranges(1000);

    const res = await request(app)
      .get("/api/hls-proxy/segment")
      .query({ url })
      .set("Range", "bytes=5000-");

    expect(res.status).toBe(416);
    expect(res.headers["content-range"]).toBe("bytes */1000");
  });

  it("backs off to smaller bounded ranges when Bunny rejects the preferred chunk size", async () => {
    const url = "https://vz-test.b-cdn.net/abc/play_720p.mp4";
    const total = 2 * 1024 * 1024 + 1;
    fetchMock
      .mockResolvedValueOnce(new Response("range too large", { status: 500 }))
      .mockResolvedValueOnce(mp4Range(0, 2 * 1024 * 1024 - 1, total, 67))
      .mockResolvedValueOnce(mp4Range(2 * 1024 * 1024, total - 1, total, 79));

    const res = await request(app)
      .get("/api/hls-proxy/segment")
      .query({ url })
      .set("Range", "bytes=0-");

    expect(res.status).toBe(206);
    expect(res.body).toHaveLength(total);
    expect(res.body[total - 1]).toBe(79);
    expect(fetchMock.mock.calls.map(([, init]) => new Headers(init?.headers).get("Range"))).toEqual([
      `bytes=0-${MP4_RANGE_BYTES - 1}`,
      `bytes=0-${2 * 1024 * 1024 - 1}`,
      `bytes=${2 * 1024 * 1024}-${2 * 1024 * 1024 + MIN_MP4_RANGE_BYTES - 1}`,
    ]);
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
