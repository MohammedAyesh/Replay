import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { parseMediaPlaylist, reelClip, segmentsFor } from "./goalReelClip";

const PLAYLIST = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:4
#EXTINF:4.000,
video0.ts
#EXTINF:4.000,
video1.ts

#EXTINF:4.000,
video2.ts
#EXTINF:2.500,
video3.ts?token=a
#EXT-X-ENDLIST
`;

describe("goal reel clip: playlists", () => {
  it("reads segment start times and absolute URLs", () => {
    const p = parseMediaPlaylist(PLAYLIST, "https://cdn.example/abc/720p/video.m3u8");
    expect(p.init).toBeNull();
    expect(p.segments.map((s) => s.start)).toEqual([0, 4, 8, 12]);
    expect(p.segments[3].url).toBe("https://cdn.example/abc/720p/video3.ts?token=a");
  });

  it("takes only the segments a card covers, and says where the first starts", () => {
    const p = parseMediaPlaylist(PLAYLIST, "https://cdn.example/a/b.m3u8");
    expect(segmentsFor(p, 5, 9)).toMatchObject({ offset: 4, segments: [{ start: 4 }, { start: 8 }] });
    expect(segmentsFor(p, 8, 12).segments.map((s) => s.start)).toEqual([8]);
    expect(segmentsFor(p, 99, 100).segments).toHaveLength(0);
  });

  it("finds an fMP4 init segment", () => {
    const p = parseMediaPlaylist(`#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:4,\nseg0.m4s\n`, "https://cdn.example/x/v.m3u8");
    expect(p.init).toBe("https://cdn.example/x/init.mp4");
  });
});

// An HLS ladder like Bunny's (TS segments, a keyframe at every segment), served locally.
describe("goal reel clip: cut from a real HLS", () => {
  let dir = "";
  let server: http.Server;
  let base = "";
  const referers: string[] = [];
  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "reelclip-"));
    for (const [name, size] of [["360p", "640x180"], ["720p", "1280x720"]] as const) {
      fs.mkdirSync(path.join(dir, name));
      execFileSync("ffmpeg", ["-loglevel", "error", "-f", "lavfi", "-i", `testsrc2=size=${size}:rate=20:duration=20`,
        "-c:v", "libx264", "-preset", "ultrafast", "-g", "80", "-keyint_min", "80", "-sc_threshold", "0",
        "-f", "hls", "-hls_time", "4", "-hls_playlist_type", "vod", "-hls_segment_filename", path.join(dir, name, "video%d.ts"),
        path.join(dir, name, "video.m3u8")]);
    }
    fs.writeFileSync(path.join(dir, "playlist.m3u8"),
      "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x180\n360p/video.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1280x720\n720p/video.m3u8\n");
    server = http.createServer((req, res) => {
      referers.push(String(req.headers.referer ?? ""));
      const file = path.join(dir, decodeURIComponent((req.url ?? "/").split("?")[0]!));
      if (!file.startsWith(dir) || !fs.existsSync(file)) { res.statusCode = 404; res.end(); return; }
      res.end(fs.readFileSync(file));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 60_000);
  afterAll(() => { server?.close(); if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

  it("stores a card on Bunny once and hands out the CDN address after that", async () => {
    vi.stubEnv("BUNNY_STORAGE_ZONE", "zone");
    vi.stubEnv("BUNNY_STORAGE_API_KEY", "key");
    vi.stubEnv("BUNNY_STORAGE_CDN_URL", "https://cdn.example/");
    vi.stubEnv("BUNNY_STORAGE_HOSTNAME", "storage.example");
    vi.resetModules();
    const realFetch = globalThis.fetch;
    const stored = new Map<string, number>();
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (!url.startsWith("https://storage.example/")) return realFetch(input, init);
      calls.push(`${init?.method ?? "GET"} ${url}`);
      expect((init?.headers as Record<string, string>).AccessKey).toBe("key");
      if (init?.method === "PUT") {
        const chunks: Buffer[] = [];
        for await (const c of (init.body as unknown as AsyncIterable<Uint8Array>)) chunks.push(Buffer.from(c));
        stored.set(url.replace("https://storage.example/zone/", ""), Buffer.concat(chunks).length);
        return new Response("", { status: 201 });
      }
      const dir = url.replace("https://storage.example/zone/", "");
      const names = [...stored.keys()].filter((k) => k.startsWith(dir)).map((k) => ({ ObjectName: k.slice(dir.length), IsDirectory: false }));
      return names.length ? Response.json(names) : new Response("", { status: 404 });
    });
    try {
      const mod = await import("./goalReelClip");
      const first = await mod.reelClipOnBunny(77, `${base}/playlist.m3u8`, 9, 15);
      expect(first?.url).toMatch(/^https:\/\/cdn\.example\/reel\/77\/[0-9a-f]{32}\.mp4$/);
      expect(first?.offset).toBe(9);
      expect([...stored.values()][0]).toBeGreaterThan(10_000);
      // the same card again: no second cut, no second upload
      const again = await mod.reelClipOnBunny(77, `${base}/playlist.m3u8`, 9, 15);
      expect(again?.url).toBe(first?.url);
      expect(calls.filter((c) => c.startsWith("PUT"))).toHaveLength(1);
      // and a fresh server (new listing) finds it on Bunny without cutting
      vi.resetModules();
      const fresh = await import("./goalReelClip");
      expect(await fresh.storedReelClip(77, `${base}/playlist.m3u8`, 9, 15)).toEqual(first);
      expect(await fresh.storedReelClip(77, `${base}/playlist.m3u8`, 20, 25)).toBeNull();
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  }, 60_000);

  it("encodes exactly the card from the 720 rung into a 1920-wide MP4", async () => {
    const clip = await reelClip(`${base}/playlist.m3u8`, 5, 11);
    expect(clip.offset).toBe(5);
    const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", clip.path]).toString());
    expect(probe.streams).toHaveLength(1);
    expect(probe.streams[0].width).toBe(1920);
    expect(probe.streams[0].codec_name).toBe("h264");
    // exactly the card: 5 s to 11 s
    expect(Number(probe.format.duration)).toBeGreaterThan(5.8);
    expect(Number(probe.format.duration)).toBeLessThan(6.2);
    expect(Number(probe.format.start_time)).toBeLessThan(0.1);
    // the second ask is the file already on disk
    const again = await reelClip(`${base}/playlist.m3u8`, 5, 11);
    expect(again.path).toBe(clip.path);
    expect(referers.every((r) => r.startsWith("http"))).toBe(true);
  }, 60_000);
});
