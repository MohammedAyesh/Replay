import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyClipBranding,
  buildClipEndCardFromStill,
  createUnbrandedRenderCacheKey,
  resolveClipBrandingAssets,
  type UnbrandedRenderCacheInput,
} from "./clipBranding";
import {
  CLIP_RENDER_ENCODER,
  clipAudioEncoderArgs,
  clipVideoEncoderArgs,
} from "./ffmpegRenderSpec";

function runBinary(
  binary: string,
  args: string[],
): Promise<{ stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args);
    const stdout: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`${binary} exited with ${code}: ${stderr.slice(-2000)}`));
        return;
      }
      resolve({ stdout: Buffer.concat(stdout), stderr });
    });
  });
}

async function createSolidPng(filePath: string, color: string): Promise<void> {
  await runBinary("ffmpeg", [
    "-v", "error",
    "-f", "lavfi",
    "-i", `color=c=${color}:s=320x180`,
    "-frames:v", "1",
    "-y", filePath,
  ]);
}

async function createBaseVideo(filePath: string): Promise<void> {
  await runBinary("ffmpeg", [
    "-v", "error",
    "-f", "lavfi",
    "-i", "color=c=blue:s=320x180:r=30",
    "-f", "lavfi",
    "-i", "sine=frequency=440:sample_rate=44100",
    "-t", "1",
    ...clipVideoEncoderArgs(),
    ...clipAudioEncoderArgs(),
    "-shortest",
    "-movflags", "+faststart",
    "-y", filePath,
  ]);
}

async function mediaDuration(filePath: string): Promise<number> {
  const { stdout } = await runBinary("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=nw=1:nk=1",
    filePath,
  ]);
  return Number.parseFloat(stdout.toString().trim());
}

async function hasAudio(filePath: string): Promise<boolean> {
  const { stdout } = await runBinary("ffprobe", [
    "-v", "error",
    "-select_streams", "a:0",
    "-show_entries", "stream=codec_type",
    "-of", "csv=p=0",
    filePath,
  ]);
  return stdout.toString().trim() === "audio";
}

async function topLeftRgb(filePath: string): Promise<[number, number, number]> {
  const { stdout } = await runBinary("ffmpeg", [
    "-v", "error",
    "-ss", "0.4",
    "-i", filePath,
    "-frames:v", "1",
    "-vf", "crop=1:1:0:0,format=rgb24",
    "-f", "rawvideo",
    "pipe:1",
  ]);
  return [stdout[0] ?? 0, stdout[1] ?? 0, stdout[2] ?? 0];
}

describe("clip branding", () => {
  let tmpDir: string;
  let basePath: string;
  let logoPath: string;
  let watermarkPath: string;
  let stillPath: string;
  const generatedOutputs: string[] = [];

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "soccerwatch-branding-test-"));
    basePath = path.join(tmpDir, "base.mp4");
    logoPath = path.join(tmpDir, "logo.png");
    watermarkPath = path.join(tmpDir, "watermark.png");
    stillPath = path.join(tmpDir, "end-card.png");
    await createBaseVideo(basePath);
    await createSolidPng(logoPath, "red");
    await createSolidPng(watermarkPath, "green");
    await createSolidPng(stillPath, "white");
  });

  afterAll(async () => {
    await Promise.all(generatedOutputs.map(async (filePath) => {
      try {
        await fs.promises.unlink(filePath);
      } catch {
        // The test may already have cleaned a fallback output.
      }
    }));
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it("resolves field, language, and shared fallback assets, and returns none for paid", async () => {
    const rootDir = path.join(tmpDir, "asset-root");
    const fieldArabicDir = path.join(rootDir, "42", "ar", "320x180");
    const fieldEnglishDir = path.join(rootDir, "42", "en", "320x180");
    const defaultArabicDir = path.join(rootDir, "default", "ar", "320x180");
    await fs.promises.mkdir(fieldArabicDir, { recursive: true });
    await fs.promises.mkdir(fieldEnglishDir, { recursive: true });
    await fs.promises.mkdir(defaultArabicDir, { recursive: true });
    await fs.promises.writeFile(path.join(fieldArabicDir, "logo.png"), "field-arabic-logo");
    await fs.promises.writeFile(path.join(fieldEnglishDir, "watermark.png"), "field-english-watermark");
    await fs.promises.writeFile(path.join(defaultArabicDir, "end-card.mp4"), "default-arabic-card");

    const assets = resolveClipBrandingAssets({
      fieldId: 42,
      language: "ar",
      outputWidth: 320,
      outputHeight: 180,
      tier: "free",
      rootDir,
    });
    expect(assets).toEqual({
      logoPath: path.join(fieldArabicDir, "logo.png"),
      watermarkPath: path.join(fieldEnglishDir, "watermark.png"),
      endCardPath: path.join(defaultArabicDir, "end-card.mp4"),
    });
    expect(resolveClipBrandingAssets({
      fieldId: 42,
      language: "ar",
      outputWidth: 320,
      outputHeight: 180,
      tier: "paid",
      rootDir,
    })).toBeNull();
  });

  it("composites logo then watermark in one pass and preserves audio", async () => {
    const outputPath = await applyClipBranding({
      inputPath: basePath,
      assets: { logoPath, watermarkPath, endCardPath: null },
    });
    generatedOutputs.push(outputPath);

    expect(outputPath).not.toBe(basePath);
    const pixel = await topLeftRgb(outputPath);
    expect(pixel[1]).toBeGreaterThan(pixel[0]);
    expect(pixel[1]).toBeGreaterThan(pixel[2]);
    expect(await hasAudio(outputPath)).toBe(true);
  });

  it("builds and stream-copies a two-second end card with matching audio", async () => {
    const endCardPath = path.join(tmpDir, "built-end-card.mp4");
    await buildClipEndCardFromStill({
      stillPath,
      outputPath: endCardPath,
      width: 320,
      height: 180,
    });
    const outputPath = await applyClipBranding({
      inputPath: basePath,
      assets: { logoPath: null, watermarkPath: null, endCardPath },
    });
    generatedOutputs.push(outputPath);

    const addedDuration = (await mediaDuration(outputPath)) - (await mediaDuration(basePath));
    expect(addedDuration).toBeGreaterThan(1.7);
    expect(addedDuration).toBeLessThan(2.4);
    expect(await hasAudio(outputPath)).toBe(true);
    expect(CLIP_RENDER_ENCODER.audioChannels).toBe(2);
  });

  it("returns the input untouched when there is nothing to apply", async () => {
    await expect(applyClipBranding({ inputPath: basePath, assets: null }))
      .resolves.toBe(basePath);
    await expect(applyClipBranding({
      inputPath: basePath,
      assets: { logoPath: null, watermarkPath: null, endCardPath: null },
    })).resolves.toBe(basePath);
  });

  it("falls back to the clean render when an overlay is corrupt", async () => {
    const corruptPath = path.join(tmpDir, "corrupt.png");
    await fs.promises.writeFile(corruptPath, "not a png");
    await expect(applyClipBranding({
      inputPath: basePath,
      assets: { logoPath: corruptPath, watermarkPath: null, endCardPath: null },
    })).resolves.toBe(basePath);
  });

  it("keeps branding out of the unbranded render cache key", () => {
    const input: UnbrandedRenderCacheInput = {
      clipId: 42,
      cropPath: [{ t: 0, x: 0, y: 0, w: 1, h: 1 }],
      aspectRatio: "16:9",
      startTime: 0.123456,
      endTime: 0.987654,
      sourceUrl: "https://cdn.example/video.m3u8",
      introUrl: "https://cdn.example/intro.mp4",
    };
    const withBranding = {
      ...input,
      branding: {
        logoPath: "/branding/new-logo.png",
        watermarkPath: "/branding/new-watermark.png",
      },
    } as UnbrandedRenderCacheInput & { branding: unknown };

    expect(createUnbrandedRenderCacheKey(input))
      .toBe(createUnbrandedRenderCacheKey(withBranding));
    expect(createUnbrandedRenderCacheKey({
      ...input,
      startTime: 0.123499,
      endTime: 0.987501,
    })).toBe(createUnbrandedRenderCacheKey(input));
  });
});