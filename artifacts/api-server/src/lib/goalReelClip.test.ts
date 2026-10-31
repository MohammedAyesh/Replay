import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

  it("remuxes the covering segments of the 720 rung into a playable MP4 that starts at the first segment", async () => {
    const clip = await reelClip(`${base}/playlist.m3u8`, 5, 11);
    expect(clip.offset).toBe(4);
    const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", clip.path]).toString());
    expect(probe.streams).toHaveLength(1);
    expect(probe.streams[0].height).toBe(720);
    // from 4 s (the segment start) to 11 s (the card's end)
    expect(Number(probe.format.duration)).toBeGreaterThan(6.5);
    expect(Number(probe.format.duration)).toBeLessThan(7.5);
    expect(Number(probe.format.start_time)).toBeLessThan(0.1);
    // the second ask is the file already on disk
    const again = await reelClip(`${base}/playlist.m3u8`, 5, 11);
    expect(again.path).toBe(clip.path);
    expect(referers.every((r) => r.startsWith("http"))).toBe(true);
  }, 60_000);
});
