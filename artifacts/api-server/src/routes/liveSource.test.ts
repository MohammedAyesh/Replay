/**
 * `GET /api/live/:camera/source` — where to play, and whether there is anything
 * to play.
 *
 * The second half is the whole reason this endpoint exists. When no camera is
 * pushing, the origin keeps serving the playlist it last wrote: the fetch
 * succeeds, the player attaches, and the viewer watches a spinner. cam1 sat in
 * that state for four days and the app said nothing. A 200 is not evidence of a
 * live stream, and these tests are what stops that regressing.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import express, { type Express } from "express";
import http from "http";

let origin: http.Server;
let playlist = "";
let originHits = 0;

process.env.LIVE_CAMERAS = "camera1:cam1,camera2:cam2";

let app: Express;

beforeAll(async () => {
  origin = http.createServer((req, res) => {
    originHits++;
    if (!req.url?.endsWith("/live.m3u8")) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" });
    res.end(playlist);
  });
  await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve));
  const port = (origin.address() as { port: number }).port;

  // Both point at the local stand-in; the CDN base is only ever interpolated
  // into the URL handed back, so a fake host is enough to assert on it.
  process.env.LIVE_ORIGIN_BASE = `http://127.0.0.1:${port}`;
  process.env.LIVE_CDN_BASE = "https://live-cdn.test";

  const { default: liveRouter } = await import("./live");
  app = express();
  app.use("/api", liveRouter);
});

afterAll(async () => {
  await new Promise<void>((resolve) => origin.close(() => resolve()));
});

/** A playlist whose live edge is `agoSeconds` in the past. */
function playlistEndingAt(agoSeconds: number): string {
  const edge = new Date(Date.now() - agoSeconds * 1000);
  const firstPdt = new Date(edge.getTime() - 8000);
  return [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    "#EXT-X-TARGETDURATION:5",
    "#EXT-X-MEDIA-SEQUENCE:950",
    `#EXT-X-PROGRAM-DATE-TIME:${firstPdt.toISOString()}`,
    "#EXTINF:4.000,", "s_000958.ts",
    "#EXTINF:4.000,", "s_000959.ts",
    "",
  ].join("\n");
}

describe("where to play from", () => {
  it("hands back a CDN url, not the origin", async () => {
    // The point of the change: the app is not in the byte path.
    playlist = playlistEndingAt(2);
    const res = await request(app).get("/api/live/camera1/source").expect(200);
    expect(res.body.url).toBe("https://live-cdn.test/cam1/hls/live.m3u8");
    expect(res.body.url).not.toContain("169.58.73.17");
    expect(res.body.proxyUrl).toBe("/api/live/camera1/index.m3u8?variant=hls");
  });

  it("serves the hevc stream-copy rendition when asked", async () => {
    playlist = playlistEndingAt(2);
    const res = await request(app).get("/api/live/camera1/source?variant=hevc").expect(200);
    expect(res.body.url).toBe("https://live-cdn.test/cam1/hevc/live.m3u8");
    expect(res.body.variant).toBe("hevc");
  });

  it("falls back to hls for an unknown variant rather than 404ing the viewer", async () => {
    playlist = playlistEndingAt(2);
    const res = await request(app).get("/api/live/camera1/source?variant=../../etc").expect(200);
    expect(res.body.variant).toBe("hls");
    expect(res.body.url).toBe("https://live-cdn.test/cam1/hls/live.m3u8");
  });

  it("refuses a camera it does not know", async () => {
    await request(app).get("/api/live/camera9/source").expect(404);
  });
});

describe("whether there is anything to play", () => {
  it("says live when frames are arriving", async () => {
    playlist = playlistEndingAt(3);
    const res = await request(app).get("/api/live/camera1/source").expect(200);
    expect(res.body.status.live).toBe(true);
    expect(res.body.message).toBeNull();
    expect(res.body.status.dvrSeconds).toBe(8);
  });

  it("says how long ago the last frame arrived, instead of nothing", async () => {
    // The four-day case, which is what the app used to render as a spinner.
    playlist = playlistEndingAt(4 * 86400);
    const res = await request(app).get("/api/live/camera1/source").expect(200);
    expect(res.body.status.live).toBe(false);
    expect(res.body.status.reason).toBe("stale");
    expect(res.body.message).toBe("No live feed — the last frame arrived 4 d ago.");
  });

  it("still hands back the url when the stream is stale", async () => {
    // The client decides what to do about it. Withholding the url would mean a
    // stream that recovers needs a page reload to be noticed.
    playlist = playlistEndingAt(4 * 86400);
    const res = await request(app).get("/api/live/camera1/source").expect(200);
    expect(res.body.url).toBe("https://live-cdn.test/cam1/hls/live.m3u8");
  });

  it("reports an empty playlist as no feed yet", async () => {
    playlist = "#EXTM3U\n#EXT-X-TARGETDURATION:4\n";
    const res = await request(app).get("/api/live/camera1/source").expect(200);
    expect(res.body.status.reason).toBe("empty");
    expect(res.body.message).toContain("has not pushed anything yet");
  });

  it("reports 'unreachable' rather than 'not live' when the origin is down", async () => {
    // The CDN may still be serving cached segments perfectly well, so this is
    // "cannot tell", not "there is nothing there".
    const saved = process.env.LIVE_ORIGIN_BASE;
    process.env.LIVE_ORIGIN_BASE = "http://127.0.0.1:1";
    try {
      // ORIGIN_BASE is read once at module load, so the module has to be
      // re-evaluated rather than re-imported from cache.
      vi.resetModules();
      const { default: freshRouter } = await import("./live");
      const isolated = express();
      isolated.use("/api", freshRouter);
      const res = await request(isolated).get("/api/live/camera1/source").expect(200);
      expect(res.body.status.reason).toBe("unreachable");
      expect(res.body.url).toBe("https://live-cdn.test/cam1/hls/live.m3u8");
    } finally {
      process.env.LIVE_ORIGIN_BASE = saved;
      vi.resetModules();
    }
  });

  it("reads freshness from the origin, never the edge", async () => {
    // A max-age=1 playlist read through a CDN can be a second stale, which is
    // irrelevant for playback and misleading in a health check.
    const before = originHits;
    playlist = playlistEndingAt(2);
    await request(app).get("/api/live/camera1/source").expect(200);
    expect(originHits).toBeGreaterThan(before);
  });
});
