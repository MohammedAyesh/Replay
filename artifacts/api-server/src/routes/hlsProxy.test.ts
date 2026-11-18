import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express, { type Express } from "express";
import { getLocalUserRecord } from "../lib/clerkUserBridge";

vi.mock("../lib/clerkUserBridge", () => ({
  getLocalUserRecord: vi.fn().mockResolvedValue({ id: 1, isAdmin: true, isGuest: false }),
}));

import router from "./hlsProxy";

const UPSTREAM = "https://vz-test.b-cdn.net/abc/1080p/video.m3u8";
const PULL_ZONE = "https://fake-pullzone.local";
let app: Express;
let fetchMock: ReturnType<typeof vi.fn>;
let previousPullZone: string | undefined;
let guidSequence = 0;

function guid() {
  guidSequence += 1;
  return `00000000-0000-4000-8000-${String(guidSequence).padStart(12, "0")}`;
}

beforeEach(() => {
  previousPullZone = process.env.BUNNY_REEL_CDN_URL;
  process.env.BUNNY_REEL_CDN_URL = PULL_ZONE;
  app = express();
  app.use("/api", router);
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  if (previousPullZone === undefined) delete process.env.BUNNY_REEL_CDN_URL;
  else process.env.BUNNY_REEL_CDN_URL = previousPullZone;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("legacy playback URL redirects", () => {
  it("authorizes and redirects HLS manifests to the original CDN URL", async () => {
    const res = await request(app)
      .get("/api/hls-proxy/manifest")
      .query({ url: UPSTREAM });

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(UPSTREAM);
    expect(res.headers["cache-control"]).toBe("private, no-store");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("redirects video segments directly, preserving the player's range header", async () => {
    const segment = "https://vz-test.b-cdn.net/abc/1080p/segment-001.ts";
    const res = await request(app)
      .get("/api/hls-proxy/segment")
      .query({ url: segment })
      .set("Range", "bytes=0-3");

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(segment);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("redirects progressive MP4 directly regardless of legacy relay flags", async () => {
    const mp4 = "https://vz-test.b-cdn.net/abc/play_720p.mp4";
    const res = await request(app)
      .get("/api/hls-proxy/mp4")
      .query({ url: mp4, relay: "1" });

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(mp4);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects non-Bunny URLs and unauthorized viewers without contacting the CDN", async () => {
    const disallowed = await request(app)
      .get("/api/hls-proxy/manifest")
      .query({ url: "https://example.com/video.m3u8" });
    expect(disallowed.status).toBe(400);

    vi.mocked(getLocalUserRecord).mockResolvedValueOnce(null);
    const unauthorized = await request(app)
      .get("/api/hls-proxy/manifest")
      .query({ url: UPSTREAM });
    expect(unauthorized.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("direct Storage renditions", () => {
  it("redirects 4K only after confirming its direct playlist exists", async () => {
    const videoGuid = guid();
    fetchMock.mockResolvedValueOnce(new Response("#EXTM3U\n#EXTINF:2,\n4k.mp4\n"));

    const res = await request(app).get(`/api/hls-proxy/uhd/${videoGuid}.m3u8`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${PULL_ZONE}/vod/${videoGuid}/4k.m3u8`);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns 404 when the 4K playlist is missing", async () => {
    fetchMock.mockResolvedValueOnce(new Response("missing", { status: 404 }));
    const res = await request(app).get(`/api/hls-proxy/uhd/${guid()}.m3u8`);
    expect(res.status).toBe(404);
  });

  it("prefers H.264 and redirects to the direct Storage playlist", async () => {
    const videoGuid = guid();
    fetchMock.mockResolvedValueOnce(new Response("#EXTM3U\n#EXTINF:2,\nh264.mp4\n"));

    const res = await request(app).get(`/api/hls-proxy/storage/${videoGuid}/h264.m3u8`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${PULL_ZONE}/vod/${videoGuid}/h264.m3u8`);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses direct 4K when H.264 is missing, never 8K", async () => {
    const videoGuid = guid();
    fetchMock
      .mockResolvedValueOnce(new Response("missing", { status: 404 }))
      .mockResolvedValueOnce(new Response("#EXTM3U\n#EXTINF:2,\n4k.mp4\n"));

    const fallback = await request(app).get(`/api/hls-proxy/storage/${videoGuid}/h264.m3u8`);
    expect(fallback.status).toBe(302);
    expect(fallback.headers.location).toBe(`${PULL_ZONE}/vod/${videoGuid}/4k.m3u8`);

    const eightK = await request(app).get(`/api/hls-proxy/storage/${guid()}/8k.m3u8`);
    expect(eightK.status).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not create a Replit-trimmed playlist for legacy playback windows", async () => {
    const videoGuid = guid();
    fetchMock.mockResolvedValueOnce(new Response("#EXTM3U\n#EXTINF:2,\n4k.mp4\n"));

    const res = await request(app)
      .get(`/api/hls-proxy/storage/${videoGuid}/4k.m3u8?fromMs=10000&toMs=12000`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${PULL_ZONE}/vod/${videoGuid}/4k.m3u8`);
  });

  it("redirects legacy Storage thumbnails instead of streaming image bytes", async () => {
    const videoGuid = guid();
    const res = await request(app).get(`/api/hls-proxy/storage/${videoGuid}/thumb.jpg`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${PULL_ZONE}/vod/${videoGuid}/thumb.jpg`);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
