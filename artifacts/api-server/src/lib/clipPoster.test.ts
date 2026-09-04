import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generatePosterBuffer, POSTER_HEIGHT, POSTER_WIDTH } from "./clipPoster";
import { type CropKeyframe } from "./ffmpegExport";

function runBinary(binary: string, args: string[], input?: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args);
    const stdout: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    if (input) {
      child.stdin.end(input);
    } else {
      child.stdin.end();
    }
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`${binary} exited with ${code}: ${stderr.slice(-2000)}`));
        return;
      }
      resolve(Buffer.concat(stdout));
    });
  });
}

async function createArchiveStyleClip(filePath: string): Promise<void> {
  // A real archive-like opening: several seconds of black before the match
  // feed starts. The black lead-in is deliberately not a synthetic still.
  await runBinary("ffmpeg", [
    "-v", "error",
    "-f", "lavfi", "-i", "color=c=black:s=320x180:r=30:d=2.4",
    "-f", "lavfi", "-i", "testsrc2=s=320x180:r=30:d=3.6",
    "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0,format=yuv420p",
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-pix_fmt", "yuv420p",
    "-y", filePath,
  ]);
}

async function imageMean(buffer: Buffer): Promise<number> {
  const raw = await runBinary("ffmpeg", [
    "-v", "error",
    "-i", "pipe:0",
    "-frames:v", "1",
    "-vf", "scale=160:84,format=gray",
    "-f", "rawvideo",
    "pipe:1",
  ], buffer);
  return raw.reduce((sum, value) => sum + value, 0) / raw.length;
}

const clip = (videoPath: string, cropPath: CropKeyframe[] = []) => ({
  id: 901,
  videoId: "poster-test",
  startTime: "0",
  endTime: "0.75",
  cropPath,
  aspectRatio: "16:9",
  exportedUrl: null,
  posterStoragePath: null,
});

describe("share poster generation", () => {
  let tmpDir: string;
  let archivePath: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "soccerwatch-poster-test-"));
    archivePath = path.join(tmpDir, "archive.mp4");
    await createArchiveStyleClip(archivePath);
  });

  afterAll(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it("walks outward from a black midpoint and chooses later real content", async () => {
    const result = await generatePosterBuffer({
      clip: clip(archivePath),
      sourceUrl: archivePath,
      sourceDuration: 6,
      sourceWidth: 320,
      sourceHeight: 180,
    });

    expect(result.candidates[0]?.rejected).toBe(true);
    expect(result.posterTime).toBeGreaterThan(2.4);
    expect(result.candidates.length).toBeGreaterThan(1);

    // The temporary image exercises the actual JPEG decoder path.
    const posterPath = path.join(tmpDir, "poster.jpg");
    await fs.promises.writeFile(posterPath, result.buffer);
    const size = (await runBinary("ffprobe", [
      "-v", "error",
      "-show_entries", "stream=width,height",
      "-of", "csv=p=0:s=x",
      posterPath,
    ])).toString().trim();
    expect(size).toBe(`${POSTER_WIDTH}x${POSTER_HEIGHT}`);
    expect(await imageMean(result.buffer)).toBeGreaterThan(15);
  });

  it("changes the poster when the saved crop changes", async () => {
    const leftCrop: CropKeyframe[] = [{ t: 0, x: 0, y: 0, w: 0.5, h: 1 }];
    const rightCrop: CropKeyframe[] = [{ t: 0, x: 0.5, y: 0, w: 0.5, h: 1 }];
    const [left, right] = await Promise.all([
      generatePosterBuffer({
        clip: clip(archivePath, leftCrop),
        sourceUrl: archivePath,
        sourceDuration: 6,
        sourceWidth: 320,
        sourceHeight: 180,
      }),
      generatePosterBuffer({
        clip: clip(archivePath, rightCrop),
        sourceUrl: archivePath,
        sourceDuration: 6,
        sourceWidth: 320,
        sourceHeight: 180,
      }),
    ]);
    expect(Buffer.compare(left.buffer, right.buffer)).not.toBe(0);
  });
});