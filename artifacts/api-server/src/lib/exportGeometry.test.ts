import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

process.env.BUNNY_CDN_HOSTNAME ??= "vz-test.b-cdn.net";

const { probeVideoDimensions, assertExportSourceGeometry } = await import("./ffmpegExport");

/**
 * These tests run real FFmpeg against real files rather than mocking ffprobe.
 * The whole point of the geometry gate is that it measures decoded pixels, and
 * a mocked probe would only prove that the mock returns what the mock returns.
 */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "geom-test-"));

function makeVideo(name: string, size: string): string {
  const out = path.join(tmp, name);
  execFileSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", `testsrc=size=${size}:rate=25:duration=1`,
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    "-y", out,
  ]);
  return out;
}

let correct: string;
let halfScale: string;

beforeAll(() => {
  // 3840x1080 — the real top rendition on this content.
  correct = makeVideo("correct-3840x1080.mp4", "3840x1080");
  // 1920x540 — what Bunny labels "1080p" on a video that also has a 2160p rung,
  // and what FFmpeg's default stream selection picks off that master playlist.
  halfScale = makeVideo("wrong-1920x540.mp4", "1920x540");
});

afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe("probeVideoDimensions", () => {
  it("reads real decoded dimensions off a 3840x1080 file", async () => {
    await expect(probeVideoDimensions(correct)).resolves.toEqual({ width: 3840, height: 1080 });
  });

  it("reads real decoded dimensions off a 1920x540 file", async () => {
    await expect(probeVideoDimensions(halfScale)).resolves.toEqual({ width: 1920, height: 540 });
  });

  it("propagates rather than guessing when the file is not a video", async () => {
    const junk = path.join(tmp, "junk.mp4");
    fs.writeFileSync(junk, "not a video");
    await expect(probeVideoDimensions(junk)).rejects.toThrow();
  });
});

describe("assertExportSourceGeometry", () => {
  it("passes the correct geometry through", async () => {
    const dims = await probeVideoDimensions(correct);
    expect(() => assertExportSourceGeometry(dims, "test")).not.toThrow();
  });

  it("THROWS on the half-scale rendition instead of rendering a mis-framed clip", async () => {
    const dims = await probeVideoDimensions(halfScale);
    expect(() => assertExportSourceGeometry(dims, "test source")).toThrowError(
      /decoded frame is 1920x540, expected 3840x1080/,
    );
  });

  it("names the source in the error so the log says which clip was refused", async () => {
    const dims = await probeVideoDimensions(halfScale);
    expect(() => assertExportSourceGeometry(dims, "buffered source https://cdn/x/1080p/video.m3u8"))
      .toThrowError(/buffered source https:\/\/cdn\/x\/1080p\/video\.m3u8/);
  });
});
