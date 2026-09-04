import { createHash, randomUUID } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { logger } from "./logger";
import { runFfmpeg } from "./ffmpegExport";
import {
  CLIP_RENDER_ENCODER,
  clipAudioEncoderArgs,
  clipVideoEncoderArgs,
} from "./ffmpegRenderSpec";

export type ClipDownloadTier = "free" | "paid";

export interface ClipBrandingAssets {
  logoPath: string | null;
  watermarkPath: string | null;
  endCardPath: string | null;
}

export interface ResolveClipBrandingAssetsOptions {
  fieldId: number | string;
  language: string;
  outputWidth: number;
  outputHeight: number;
  tier: ClipDownloadTier;
  /** Test/integration override; production defaults to CLIP_BRANDING_ROOT. */
  rootDir?: string;
}

const DEFAULT_BRANDING_ROOT = path.join(process.cwd(), "branding");
const ASSET_NAMES = {
  logoPath: "logo.png",
  watermarkPath: "watermark.png",
  endCardPath: "end-card.mp4",
} as const;

function safeSegment(value: string | number): string {
  return String(value).trim().replace(/[^a-zA-Z0-9_-]/g, "_") || "_";
}

function normalizedLanguage(language: string): string {
  return safeSegment(language.toLowerCase());
}

function assetExists(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function configuredBrandingRoot(rootDir?: string): string {
  return rootDir || process.env.CLIP_BRANDING_ROOT || DEFAULT_BRANDING_ROOT;
}

/**
 * Resolve each free-tier branding asset independently through:
 * field/requested-language, field/English, shared/requested-language,
 * shared/English. The dimensions are part of every path because overlays are
 * authored at the exact output size.
 */
export function resolveClipBrandingAssets(
  options: ResolveClipBrandingAssetsOptions,
): ClipBrandingAssets | null {
  if (options.tier === "paid") return null;

  const width = Math.round(options.outputWidth);
  const height = Math.round(options.outputHeight);
  const language = normalizedLanguage(options.language);
  const rootDir = configuredBrandingRoot(options.rootDir);
  const size = `${width}x${height}`;
  const field = safeSegment(options.fieldId);
  const languageCandidates = [...new Set([language, "en"])];

  function resolveAsset(assetName: string): string | null {
    const candidates = [
      ...languageCandidates.map((candidate) =>
        path.join(rootDir, field, candidate, size, assetName)),
      ...languageCandidates.map((candidate) =>
        path.join(rootDir, "default", candidate, size, assetName)),
    ];
    return candidates.find(assetExists) ?? null;
  }

  const assets: ClipBrandingAssets = {
    logoPath: resolveAsset(ASSET_NAMES.logoPath),
    watermarkPath: resolveAsset(ASSET_NAMES.watermarkPath),
    endCardPath: resolveAsset(ASSET_NAMES.endCardPath),
  };

  if (!assets.logoPath && !assets.watermarkPath && !assets.endCardPath) {
    logger.warn(
      { fieldId: options.fieldId, language, width, height, rootDir },
      "No clip branding assets resolved",
    );
    return null;
  }

  return assets;
}

function generatedPath(prefix: string, extension: string): string {
  return path.join(os.tmpdir(), `soccerwatch-${prefix}-${randomUUID()}${extension}`);
}

async function removeIfPresent(filePath: string): Promise<void> {
  try {
    await fs.promises.unlink(filePath);
  } catch {
    // Cleanup is best effort; the render result is already decided.
  }
}

/**
 * Apply logo first and watermark second in one filter graph and one video
 * encode. PNGs are full-frame transparent canvases, so their authored
 * positions are preserved by overlaying each at 0:0.
 */
async function compositeBrandingLayers(
  inputPath: string,
  layerPaths: string[],
): Promise<string> {
  const outputPath = generatedPath("branded", ".mp4");
  const filterParts: string[] = [];
  let currentVideo = "[0:v]";

  layerPaths.forEach((_, index) => {
    const nextVideo = `[branding${index}]`;
    filterParts.push(
      `${currentVideo}[${index + 1}:v]` +
      `overlay=0:0:eof_action=repeat${nextVideo}`,
    );
    currentVideo = nextVideo;
  });
  filterParts.push(`${currentVideo}format=yuv420p[branded]`);

  const args = [
    "-i", inputPath,
    // A single PNG frame is held by eof_action=repeat in each overlay. Do not
    // loop the image demuxer: a corrupt image must fail promptly and fall back
    // to the clean render rather than leaving FFmpeg waiting on an input.
    ...layerPaths.flatMap((layerPath) => ["-i", layerPath]),
    "-filter_complex", filterParts.join(";"),
    "-map", "[branded]",
    "-map", "0:a?",
    // Branding changes video only. Keep the source audio bit-for-bit intact.
    ...clipVideoEncoderArgs(),
    "-c:a", "copy",
    "-shortest",
    "-movflags", "+faststart",
    "-y", outputPath,
  ];

  try {
    await runFfmpeg("ffmpeg", args);
    return outputPath;
  } catch (err) {
    await removeIfPresent(outputPath);
    logger.warn({ err, inputPath }, "Clip branding composite failed — using clean render");
    return inputPath;
  }
}

function concatFileLine(filePath: string): string {
  return `file '${filePath.replace(/'/g, "'\\''")}'`;
}

/**
 * Append a pre-encoded end card with stream copy. The end-card builder below
 * uses the same shared encoder spec as the main render and intro normalization.
 */
async function appendEndCard(inputPath: string, endCardPath: string): Promise<string> {
  const listPath = generatedPath("branding-concat", ".txt");
  const outputPath = generatedPath("branded-end-card", ".mp4");
  try {
    await fs.promises.writeFile(
      listPath,
      `${concatFileLine(inputPath)}\n${concatFileLine(endCardPath)}\n`,
      "utf8",
    );
    await runFfmpeg("ffmpeg", [
      "-f", "concat",
      "-safe", "0",
      "-i", listPath,
      "-c", "copy",
      "-movflags", "+faststart",
      "-y", outputPath,
    ]);
    return outputPath;
  } catch (err) {
    await removeIfPresent(outputPath);
    logger.warn({ err, inputPath, endCardPath }, "Clip end-card append failed — using clean render");
    return inputPath;
  } finally {
    await removeIfPresent(listPath);
  }
}

/**
 * Brand a rendered clip for a free download.
 *
 * The return value may be exactly inputPath: callers must only delete a
 * returned file when it differs from the input they supplied. Any composite
 * or append failure falls back to that original unbranded render.
 */
export async function applyClipBranding(options: {
  inputPath: string;
  assets: ClipBrandingAssets | null | undefined;
}): Promise<string> {
  const { inputPath, assets } = options;
  if (!assets) return inputPath;

  const layerPaths = [assets.logoPath, assets.watermarkPath]
    .filter((assetPath): assetPath is string => !!assetPath);
  if (layerPaths.length === 0 && !assets.endCardPath) return inputPath;

  let workingPath = inputPath;
  if (layerPaths.length > 0) {
    workingPath = await compositeBrandingLayers(inputPath, layerPaths);
    // A failed composite already returned the clean input. Do not append an
    // end card to a partially branded or otherwise uncertain result.
    if (workingPath === inputPath) return inputPath;
  }

  if (!assets.endCardPath) return workingPath;

  const finalPath = await appendEndCard(workingPath, assets.endCardPath);
  if (finalPath === workingPath) {
    if (workingPath !== inputPath) await removeIfPresent(workingPath);
    return inputPath;
  }
  if (workingPath !== inputPath) await removeIfPresent(workingPath);
  return finalPath;
}

function endCardScaleFilter(width: number, height: number): string {
  return (
    `scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black,` +
    `fps=${CLIP_RENDER_ENCODER.frameRate},setsar=1`
  );
}

/**
 * Build a two-second silent end card from a still image. All visible text
 * belongs in the supplied image; this helper never invokes a text filter.
 */
export async function buildClipEndCardFromStill(options: {
  stillPath: string;
  outputPath: string;
  width: number;
  height: number;
  durationSeconds?: number;
}): Promise<string> {
  const durationSeconds = options.durationSeconds ?? 2;
  if (!(durationSeconds > 0)) {
    throw new Error("End-card duration must be greater than zero");
  }

  try {
    await runFfmpeg("ffmpeg", [
      "-loop", "1",
      "-i", options.stillPath,
      "-f", "lavfi",
      "-i", `anullsrc=channel_layout=stereo:sample_rate=${CLIP_RENDER_ENCODER.audioSampleRate}`,
      "-t", String(durationSeconds),
      "-vf", endCardScaleFilter(options.width, options.height),
      ...clipVideoEncoderArgs(),
      ...clipAudioEncoderArgs(),
      "-map", "0:v:0",
      "-map", "1:a:0",
      "-shortest",
      "-movflags", "+faststart",
      "-y", options.outputPath,
    ]);
    return options.outputPath;
  } catch (err) {
    await removeIfPresent(options.outputPath);
    throw err;
  }
}

function roundedCacheTime(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export interface UnbrandedRenderCacheInput {
  clipId: number | string;
  cropPath: unknown;
  aspectRatio: string;
  startTime: number;
  endTime: number;
  sourceUrl: string;
  introUrl?: string | null;
}

/**
 * Stable identity for the expensive unbranded render.
 *
 * Branding is intentionally absent: changing a logo or CTA must not invalidate
 * the crop render, and an upgraded user should receive a clean clip by
 * reusing the same cached pixels rather than rendering again.
 */
export function createUnbrandedRenderCacheKey(
  input: UnbrandedRenderCacheInput,
): string {
  const canonicalInput = {
    clipId: input.clipId,
    cropPath: input.cropPath,
    aspectRatio: input.aspectRatio,
    startTime: roundedCacheTime(input.startTime),
    endTime: roundedCacheTime(input.endTime),
    sourceUrl: input.sourceUrl,
    introUrl: input.introUrl ?? null,
  };
  return createHash("sha256")
    .update(JSON.stringify(canonicalInput))
    .digest("hex");
}