import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { academiesTable, db, fieldsTable, recordingsTable, userClipsTable, usersTable } from "@workspace/db";
import type { CreativeBrand, Scene } from "@workspace/api-zod";

/**
 * Picking a clip in the Creative hub must give that clip's footage — the
 * seconds the player cut — in the preview and the export, from camera 4K.
 * user_clips stores start/end as shares of the video; reading them as seconds
 * (the old bug) played the first second of the match instead.
 */

const fetched: Array<{ how: string; url: string; from: number; to: number }> = [];
const fixtures = vi.hoisted(() => ({ cameraPath: "", streamBase: "", streamUnavailable: false, unavailable: [] as string[] }));

vi.mock("../bunny", async (importOriginal) => {
  const real = await importOriginal<typeof import("../bunny")>();
  return {
    ...real,
    isBunnyConfigured: () => true,
    isBunnyStorageConfigured: () => false,
    getBunnyVideoInfo: vi.fn(async () => ({ duration: 5400 })),
    getBunnyPlaybackUrl: (id: string) => `${fixtures.streamBase}/${id}/playlist.m3u8`,
    getBunnyProxiedThumbnailUrl: (id: string, t: number) => `https://thumb.test/${id}?t=${t}`,
  };
});

vi.mock("../clipExportSource", () => {
  class Camera4kNotReadyError extends Error {
    constructor(videoId: string, readonly waitedMs: number) { super(`4K unavailable for ${videoId}`); }
  }
  return {
    waitForCamera4kSource: vi.fn(async (id: string) => {
      if (fixtures.unavailable.includes(id)) throw new Camera4kNotReadyError(id, 3_000);
      return {
        kind: "camera-4k",
        url: `https://replayjo.b-cdn.net/vod/${id}/4k.m3u8`,
        playlist: "#EXTM3U",
        path: "camera-original-4K HLS",
        duration: 5400,
        renditionLabel: null,
      };
    }),
    Camera4kNotReadyError,
  };
});

vi.mock("../ffmpegExport", async (importOriginal) => {
  const real = await importOriginal<typeof import("../ffmpegExport")>();
  return {
    ...real,
    bufferCameraHlsClip: vi.fn(async (options: { remoteUrl: string; startSec: number; clipDuration: number }) => {
      fetched.push({
        how: "4k-window",
        url: options.remoteUrl,
        from: options.startSec,
        to: options.startSec + options.clipDuration,
      });
      return {
        bufferPath: fixtures.cameraPath,
        bufferedDuration: options.clipDuration,
        adjustedOffsetSec: 0,
        sourceDimensions: { width: 4096, height: 1152 },
        sourceTimeOffsetSec: 0,
        downloadedBytes: 1024,
      };
    }),
  };
});

import { browserMedia, creativeVideoResolver, CreativeRenderError } from "./renderMedia";
import { clearClipSpanCache } from "./clipSpan";
import { waitForCamera4kSource } from "../clipExportSource";
import { renderSceneMp4 } from "./renderVideo";
import { creativeClipStillUrl } from "./library";
import type { AcademyOwnerAccess } from "../academyOwner";

const tag = Date.now();
let venueId: number;
let clipId: number;
let oldClipId: number;
let streamClipId: number;
const videoId = `pick-${tag}`;
let server: Server;
let exportUrl: string;
let fixtureDir: string;
let exportBytes: Buffer;
let streamBytes: Buffer;
const BRAND: CreativeBrand = { primary: "#F4CF1F", accent: "#D4FF4F", ink: "#0B0F1A", paper: "#FFFFFF", muted: "#8A93A6", nameEn: "FIELD", nameAr: null };

beforeAll(async () => {
  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "creative-clip-pick-test-"));
  fixtures.cameraPath = path.join(fixtureDir, "camera-4k.mp4");
  execFileSync("ffmpeg", [
    "-nostdin", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "color=c=blue:s=4096x1152:r=30:d=12",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-an", "-movflags", "+faststart", "-y", fixtures.cameraPath,
  ]);
  exportBytes = fs.readFileSync(fixtures.cameraPath);
  const streamPath = path.join(fixtureDir, "stream.ts");
  execFileSync("ffmpeg", [
    "-nostdin", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "color=c=green:s=640x360:r=30:d=12",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-an", "-f", "mpegts", "-y", streamPath,
  ]);
  streamBytes = fs.readFileSync(streamPath);
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname.endsWith("/playlist.m3u8")) {
      if (fixtures.streamUnavailable) { res.writeHead(404).end(); return; }
      res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" });
      res.end("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=400000,RESOLUTION=640x360\nmedia.m3u8\n");
      return;
    }
    if (url.pathname.endsWith("/media.m3u8")) {
      if (fixtures.streamUnavailable) { res.writeHead(404).end(); return; }
      res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" });
      res.end("#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:12\n#EXTINF:12.000,\nsegment.ts\n#EXT-X-ENDLIST\n");
      return;
    }
    if (url.pathname.endsWith("/segment.ts")) {
      res.setHeader("Content-Type", "video/mp2t");
      res.setHeader("Accept-Ranges", "bytes");
      const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? "");
      if (range) {
        const start = Number(range[1]);
        const end = range[2] ? Math.min(Number(range[2]), streamBytes.length - 1) : streamBytes.length - 1;
        res.writeHead(206, { "Content-Length": String(end - start + 1), "Content-Range": `bytes ${start}-${end}/${streamBytes.length}` });
        res.end(streamBytes.subarray(start, end + 1));
      } else {
        res.writeHead(200, { "Content-Length": String(streamBytes.length) });
        res.end(streamBytes);
      }
      return;
    }
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Accept-Ranges", "bytes");
    if (req.headers.range === "bytes=0-0") {
      res.writeHead(206, { "Content-Length": "1", "Content-Range": `bytes 0-0/${exportBytes.length}` });
      res.end(exportBytes.subarray(0, 1));
      return;
    }
    res.writeHead(200, { "Content-Length": String(exportBytes.length) });
    res.end(exportBytes);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  fixtures.streamBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  exportUrl = `${fixtures.streamBase}/old-clip.mp4`;
  clearClipSpanCache();
  const [user] = await db.insert(usersTable).values({ name: `Pick ${tag}`, email: `pick-${tag}@test.local` }).returning({ id: usersTable.id });
  const [field] = await db.insert(fieldsTable).values({ name: `Pick field ${tag}`, cameraId: `pick-cam-${tag}` }).returning({ id: fieldsTable.id });
  const [venue] = await db.insert(academiesTable).values({ name: `Pick venue ${tag}`, kind: "venue", fieldId: field.id }).returning({ id: academiesTable.id });
  venueId = venue.id;
  const [rec] = await db.insert(recordingsTable).values({
    fieldId: field.id, court: "1", date: "2026-11-02", timeSlot: "20:00", duration: "90 min", videoUrl: `https://vz.test/${videoId}/playlist.m3u8`,
  } as typeof recordingsTable.$inferInsert).returning({ id: recordingsTable.id });
  // 40%–41% of a 90-minute match: 36:00 to 36:54.
  const [row] = await db.insert(userClipsTable).values({
    userId: user.id, videoId, title: "Top corner", startTime: "0.40", endTime: "0.41", thumbnailTime: "2170", sourceRecordingId: rec.id,
  }).returning({ id: userClipsTable.id });
  clipId = row.id;
  const [old] = await db.insert(userClipsTable).values({
    userId: user.id, videoId, title: "Older saved export", startTime: "0.40", endTime: "0.41",
    thumbnailTime: "2161", sourceRecordingId: rec.id, exportStatus: "done", exportedUrl: exportUrl,
  }).returning({ id: userClipsTable.id });
  oldClipId = old.id;
  const [streamClip] = await db.insert(userClipsTable).values({
    userId: user.id, videoId, title: "Stream fallback", startTime: "0", endTime: "0.001",
    thumbnailTime: "1", sourceRecordingId: rec.id,
  }).returning({ id: userClipsTable.id });
  streamClipId = streamClip.id;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(fixtureDir, { recursive: true, force: true });
});

describe("picking a clip in the Creative hub", () => {
  const access = () => ({ academyId: venueId }) as AcademyOwnerAccess;

  it("previews the selected camera-4K window, from 36:00", async () => {
    fetched.length = 0;
    const res = await browserMedia(access(), { type: "clip", clipId }, "video", []);
    expect(res).toMatchObject({ type: "video/mp4" });
    expect(fetched).toEqual([{
      how: "4k-window",
      url: `https://replayjo.b-cdn.net/vod/${videoId}/4k.m3u8`,
      from: 2160,
      to: 2214,
    }]);
  });

  it("renders a 4K-backed clip to completion using its source window", async () => {
    fetched.length = 0;
    const resolve = creativeVideoResolver(venueId, "/tmp", []);
    const result = await resolve({} as never, { type: "clip", clipId }, { fromMs: 0, toMs: 54_000 });
    expect(result).toMatchObject({
      path: fixtures.cameraPath,
      zeroAtSec: -0,
      durationMs: 54_000,
      sourceDimensions: { width: 4096, height: 1152 },
    });
    expect(fetched).toHaveLength(1);
    expect(fetched[0]).toEqual({
      how: "4k-window",
      url: `https://replayjo.b-cdn.net/vod/${videoId}/4k.m3u8`,
      from: 2160,
      to: 2214,
    });
    await renderFixture(clipId);
  });

  it("previews the older saved clip without asking for 4K", async () => {
    const before = vi.mocked(waitForCamera4kSource).mock.calls.length;
    const temps: string[] = [];
    const media = await browserMedia(access(), { type: "clip", clipId: oldClipId }, "still", temps);
    expect(media).toMatchObject({ type: "image/png" });
    expect(vi.mocked(waitForCamera4kSource).mock.calls.length).toBe(before);
    expect(creativeClipStillUrl(venueId, oldClipId)).toContain("want=still");
    for (const temp of temps) fs.rmSync(temp, { force: true });
  });

  it("renders an older clip from its own saved file when 4K is missing", async () => {
    fixtures.unavailable.push(videoId);
    try {
      const resolve = creativeVideoResolver(venueId, "/tmp", []);
      const result = await resolve({} as never, { type: "clip", clipId: oldClipId }, { fromMs: 0, toMs: 54_000 });
      expect(result).toMatchObject({ durationMs: 12_000 });
      expect(result?.path).not.toBe(fixtures.cameraPath);
      await renderFixture(oldClipId);
    } finally {
      fixtures.unavailable = fixtures.unavailable.filter((id) => id !== videoId);
    }
  });

  it("uses Stream only after 4K and the saved file are unavailable", async () => {
    fixtures.unavailable.push(videoId);
    const temps: string[] = [];
    try {
      const before = vi.mocked(waitForCamera4kSource).mock.calls.length;
      const still = await browserMedia(access(), { type: "clip", clipId: streamClipId }, "still", temps);
      expect(still).toMatchObject({ redirect: expect.stringContaining("thumb.test") });
      expect(vi.mocked(waitForCamera4kSource).mock.calls.length).toBe(before);

      const resolved = await creativeVideoResolver(venueId, "/tmp", [])(
        {} as never, { type: "clip", clipId: streamClipId }, { fromMs: 0, toMs: 2_000 },
      );
      expect(resolved?.path).not.toBe(fixtures.cameraPath);
      await renderFixture(streamClipId);
    } finally {
      fixtures.unavailable = fixtures.unavailable.filter((id) => id !== videoId);
      for (const temp of temps) fs.rmSync(temp, { force: true });
    }
  });

  it("returns a clear conflict when neither 4K, saved file, nor Stream can load", async () => {
    fixtures.unavailable.push(videoId);
    fixtures.streamUnavailable = true;
    try {
      await expect(creativeVideoResolver(venueId, "/tmp", [])(
        {} as never, { type: "clip", clipId: streamClipId }, { fromMs: 0, toMs: 2_000 },
      )).rejects.toMatchObject({ status: 409, message: expect.stringContaining("unavailable right now") });
    } finally {
      fixtures.unavailable = fixtures.unavailable.filter((id) => id !== videoId);
      fixtures.streamUnavailable = false;
    }
  });
});

async function renderFixture(id: number): Promise<void> {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "creative-clip-render-"));
  const out = path.join(workDir, "out.mp4");
  const scene: Scene = {
    v: 1,
    format: "square",
    durationMs: 2_000,
    background: "#000000",
    locale: "en",
    layers: [{
      id: "clip",
      kind: "video",
      src: { type: "clip", clipId: id },
      x: 0, y: 0, w: 1080, h: 1080,
      fit: "cover", trimInMs: 0, speed: 1, muted: true,
    }],
  };
  try {
    await renderSceneMp4({
      scene,
      brand: BRAND,
      data: {},
      videos: creativeVideoResolver(venueId, workDir, [], 50),
      images: async () => null,
      workDir,
      out,
    });
    expect(fs.statSync(out).size).toBeGreaterThan(0);
    const duration = Number(execFileSync("ffprobe", [
      "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", out,
    ]).toString());
    expect(duration).toBeGreaterThan(1.5);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}
