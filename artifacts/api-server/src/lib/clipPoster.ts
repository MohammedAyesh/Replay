import fs from "fs";
import os from "os";
import path from "path";
import { createHash, randomUUID } from "crypto";
import { db, userClipsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import {
  BUNNY_STORAGE_API_KEY,
  BUNNY_STORAGE_HOSTNAME,
  BUNNY_STORAGE_ZONE,
  isBunnyStorageConfigured,
  uploadBufferToBunnyStorage,
} from "./bunny";
import { getBunnyVideoInfo } from "./bunny";
import { selectExportSource } from "./exportSource";
import {
  defaultCropFrameForAspect,
  interpolateCropFrame,
  normalizeCropPathForAspect,
  runFfmpeg,
  type CropKeyframe,
} from "./ffmpegExport";
import { logger } from "./logger";

export const POSTER_WIDTH = 1200;
export const POSTER_HEIGHT = 630;
const SCORE_WIDTH = 160;
const SCORE_HEIGHT = 84;
const BLACK_MEAN_FLOOR = 12;
const DETAIL_GOOD_ENOUGH = 8;
const CANDIDATE_FRACTIONS = [0.5, 0.35, 0.65, 0.2];

type PosterClip = Pick<
  typeof userClipsTable.$inferSelect,
  "id" | "videoId" | "startTime" | "endTime" | "cropPath" | "aspectRatio" | "exportedUrl" | "posterStoragePath"
>;

export type PosterCandidateScore = {
  time: number;
  mean: number;
  standardDeviation: number;
  detail: number;
  rejected: boolean;
};

export type GeneratedPoster = {
  buffer: Buffer;
  posterTime: number;
  candidates: PosterCandidateScore[];
};

function tempPath(prefix: string, extension: string): string {
  return path.join(os.tmpdir(), `soccerwatch-${prefix}-${randomUUID()}${extension}`);
}

async function cleanup(filePath: string | null): Promise<void> {
  if (!filePath) return;
  await fs.promises.unlink(filePath).catch(() => {});
}

function ffmpegHeaders(url: string, referer?: string): string | null {
  if (!/^https?:\/\//i.test(url)) return null;
  const headers = [
    referer ? `Referer: ${referer}` : null,
    (() => {
      try {
        return new URL(url).host.toLowerCase() === BUNNY_STORAGE_HOSTNAME.toLowerCase()
          && BUNNY_STORAGE_API_KEY
          ? `AccessKey: ${BUNNY_STORAGE_API_KEY}`
          : null;
      } catch {
        return null;
      }
    })(),
    "User-Agent: Mozilla/5.0",
  ].filter((value): value is string => !!value);
  return headers.length > 0 ? `${headers.join("\r\n")}\r\n` : null;
}

function sourceArgs(url: string, referer?: string): string[] {
  const headers = ffmpegHeaders(url, referer);
  return headers ? ["-headers", headers] : [];
}

function parseRawFrame(buffer: Buffer): PosterCandidateScore | null {
  if (buffer.length < SCORE_WIDTH * SCORE_HEIGHT) return null;
  let sum = 0;
  for (const value of buffer) sum += value;
  const mean = sum / buffer.length;
  let variance = 0;
  for (const value of buffer) variance += (value - mean) ** 2;
  const standardDeviation = Math.sqrt(variance / buffer.length);

  let detailSum = 0;
  for (let y = 0; y < SCORE_HEIGHT; y++) {
    for (let x = 0; x < SCORE_WIDTH; x++) {
      const index = y * SCORE_WIDTH + x;
      if (x + 1 < SCORE_WIDTH) detailSum += Math.abs(buffer[index] - buffer[index + 1]);
      if (y + 1 < SCORE_HEIGHT) {
        detailSum += Math.abs(buffer[index] - buffer[index + SCORE_WIDTH]);
      }
    }
  }
  const detail = detailSum / (SCORE_WIDTH * SCORE_HEIGHT * 2);
  return {
    time: 0,
    mean,
    standardDeviation,
    detail,
    rejected: mean < BLACK_MEAN_FLOOR || standardDeviation < 4,
  };
}

async function scoreFrame(
  sourceUrl: string,
  time: number,
  referer: string | undefined,
  cropFrame: CropKeyframe | null,
  sourceWidth: number,
  sourceHeight: number,
): Promise<PosterCandidateScore> {
  const scorePath = tempPath("poster-score", ".gray");
  try {
    const filterParts = [];
    if (cropFrame) {
      const crop = clampCropFrame(cropFrame, sourceWidth, sourceHeight);
      filterParts.push(`crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}`);
    }
    filterParts.push(
      `scale=${SCORE_WIDTH}:${SCORE_HEIGHT}:force_original_aspect_ratio=decrease`,
      `pad=${SCORE_WIDTH}:${SCORE_HEIGHT}:(ow-iw)/2:(oh-ih)/2:black`,
      "format=gray",
    );
    await runFfmpeg("ffmpeg", [
      ...sourceArgs(sourceUrl, referer),
      "-ss", String(Math.max(0, time)),
      "-i", sourceUrl,
      "-frames:v", "1",
      "-vf", filterParts.join(","),
      "-f", "rawvideo",
      "-y", scorePath,
    ]);
    const score = parseRawFrame(await fs.promises.readFile(scorePath));
    return {
      ...(score ?? {
        time: 0,
        mean: 0,
        standardDeviation: 0,
        detail: 0,
        rejected: true,
      }),
      time,
    };
  } catch (err) {
    logger.warn({ err, sourceUrl, time }, "Could not score poster candidate");
    return { time, mean: 0, standardDeviation: 0, detail: 0, rejected: true };
  } finally {
    await cleanup(scorePath);
  }
}

function clampCropFrame(frame: CropKeyframe, sourceWidth: number, sourceHeight: number): {
  width: number;
  height: number;
  x: number;
  y: number;
} {
  const width = Math.max(2, Math.min(sourceWidth, Math.round(frame.w * sourceWidth)));
  const height = Math.max(2, Math.min(sourceHeight, Math.round(frame.h * sourceHeight)));
  const x = Math.max(0, Math.min(sourceWidth - width, Math.round(frame.x * sourceWidth)));
  const y = Math.max(0, Math.min(sourceHeight - height, Math.round(frame.y * sourceHeight)));
  return {
    width: width % 2 === 0 ? width : width - 1,
    height: height % 2 === 0 ? height : height - 1,
    x: x % 2 === 0 ? x : Math.max(0, x - 1),
    y: y % 2 === 0 ? y : Math.max(0, y - 1),
  };
}

function cardFilter(aspectRatio: string, input = "[0:v]"): string {
  if (aspectRatio === "9:16") {
    return (
      `${input}scale=${POSTER_WIDTH}:${POSTER_HEIGHT}:force_original_aspect_ratio=increase,` +
      `crop=${POSTER_WIDTH}:${POSTER_HEIGHT},boxblur=24:12,eq=brightness=-0.22[poster-bg];` +
      `${input}scale=${POSTER_WIDTH}:${POSTER_HEIGHT}:force_original_aspect_ratio=decrease[poster-fg];` +
      `[poster-bg][poster-fg]overlay=(W-w)/2:(H-h)/2,format=yuvj420p`
    );
  }
  return (
    `scale=${POSTER_WIDTH}:${POSTER_HEIGHT}:force_original_aspect_ratio=increase,` +
    `crop=${POSTER_WIDTH}:${POSTER_HEIGHT},format=yuvj420p`
  );
}

async function encodePoster(
  sourceUrl: string,
  time: number,
  referer: string | undefined,
  aspectRatio: string,
  cropFrame: CropKeyframe | null,
  sourceWidth: number,
  sourceHeight: number,
): Promise<Buffer> {
  const outputPath = tempPath("poster", ".jpg");
  try {
    let filterGraph: string;
    if (cropFrame) {
      const crop = clampCropFrame(cropFrame, sourceWidth, sourceHeight);
      if (aspectRatio === "9:16") {
        filterGraph = `crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}[poster-source];` +
          cardFilter(aspectRatio, "[poster-source]");
      } else {
        filterGraph = `crop=${crop.width}:${crop.height}:${crop.x}:${crop.y},` +
          cardFilter(aspectRatio);
      }
    } else {
      filterGraph = cardFilter(aspectRatio);
    }
    await runFfmpeg("ffmpeg", [
      ...sourceArgs(sourceUrl, referer),
      "-ss", String(Math.max(0, time)),
      "-i", sourceUrl,
      "-frames:v", "1",
      aspectRatio === "9:16" ? "-filter_complex" : "-vf",
      filterGraph,
      "-q:v", "2",
      "-y", outputPath,
    ]);
    return await fs.promises.readFile(outputPath);
  } finally {
    await cleanup(outputPath);
  }
}

function clipSourceWindow(clip: PosterClip, totalDuration: number): {
  start: number;
  end: number;
} {
  const start = Math.max(0, Math.min(totalDuration, Number(clip.startTime) * totalDuration));
  const end = Math.max(start, Math.min(totalDuration, Number(clip.endTime) * totalDuration));
  return { start, end: end > start ? end : Math.min(totalDuration, start + 0.1) };
}

export async function generatePosterBuffer(options: {
  clip: PosterClip;
  sourceUrl?: string;
  sourceDuration?: number;
  sourceReferer?: string;
  sourceWidth?: number;
  sourceHeight?: number;
}): Promise<GeneratedPoster> {
  const { clip } = options;
  const usingRenderedExport = !!clip.exportedUrl && !options.sourceUrl;
  let sourceUrl = options.sourceUrl ?? clip.exportedUrl ?? "";
  let sourceDuration = options.sourceDuration ?? 0;
  let sourceReferer = options.sourceReferer;
  let sourceWidth = options.sourceWidth ?? 3840;
  let sourceHeight = options.sourceHeight ?? 1080;

  if (!sourceUrl) {
    const info = await getBunnyVideoInfo(clip.videoId);
    sourceDuration = info.duration;
    const source = await selectExportSource({
      videoId: clip.videoId,
      hasMP4Fallback: info.hasMP4Fallback,
      referer: `https://${process.env.BUNNY_CDN_HOSTNAME}/`,
    });
    sourceUrl = source.url;
    sourceReferer = `${new URL(source.url).origin}/`;
    sourceWidth = source.variant.width;
    sourceHeight = source.variant.height;
  }

  if (!sourceDuration) {
    const durationPath = tempPath("poster-duration", ".txt");
    try {
      await runFfmpeg("ffprobe", [
        ...sourceArgs(sourceUrl, sourceReferer),
        "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=nw=1:nk=1",
        sourceUrl,
      ]).then((value) => {
        sourceDuration = Number.parseFloat(value);
      });
    } finally {
      await cleanup(durationPath);
    }
  }
  if (!(sourceDuration > 0)) throw new Error("Could not determine poster source duration");

  const window = usingRenderedExport
    ? { start: 0, end: sourceDuration }
    : clipSourceWindow(clip, sourceDuration);
  const duration = Math.max(0.1, window.end - window.start);
  const normalizedCrop = usingRenderedExport
    ? []
    : normalizeCropPathForAspect((clip.cropPath ?? []) as CropKeyframe[], clip.aspectRatio);
  const candidates: PosterCandidateScore[] = [];
  let best: PosterCandidateScore | null = null;
  for (const fraction of CANDIDATE_FRACTIONS) {
    const candidateTime = window.start + duration * fraction;
    const candidateCrop = usingRenderedExport
      ? null
      : interpolateCropFrame(
        normalizedCrop.length > 0
          ? normalizedCrop
          : [defaultCropFrameForAspect(clip.aspectRatio)],
        fraction,
      );
    const candidate = await scoreFrame(
      sourceUrl,
      candidateTime,
      sourceReferer,
      candidateCrop,
      sourceWidth,
      sourceHeight,
    );
    candidates.push(candidate);
    if (!candidate.rejected && (!best || candidate.detail > best.detail)) best = candidate;
    if (best && best.detail >= DETAIL_GOOD_ENOUGH) break;
  }
  if (!best) {
    best = candidates.find((candidate) => !candidate.rejected) ?? candidates[0];
  }
  if (!best) throw new Error("No poster candidates were decoded");

  const selectedFraction = Math.max(0, Math.min(1, (best.time - window.start) / duration));
  const selectedCrop = usingRenderedExport
    ? null
    : interpolateCropFrame(
      normalizedCrop.length > 0
        ? normalizedCrop
        : [defaultCropFrameForAspect(clip.aspectRatio)],
      selectedFraction,
    );
  const posterBuffer = await encodePoster(
    sourceUrl,
    best.time,
    sourceReferer,
    clip.aspectRatio,
    selectedCrop,
    sourceWidth,
    sourceHeight,
  );
  return { buffer: posterBuffer, posterTime: best.time, candidates };
}

export async function ensureClipPoster(clip: PosterClip): Promise<void> {
  if (clip.posterStoragePath || !isBunnyStorageConfigured()) return;
  try {
    const generated = await generatePosterBuffer({ clip });
    const signature = createHash("sha256")
      .update(JSON.stringify({
        id: clip.id,
        startTime: clip.startTime,
        endTime: clip.endTime,
        cropPath: clip.cropPath,
        aspectRatio: clip.aspectRatio,
      }))
      .digest("hex")
      .slice(0, 24);
    const storagePath = `clip-posters/${clip.id}-${signature}.jpg`;
    await uploadBufferToBunnyStorage(generated.buffer, storagePath, "image/jpeg");
    await db
      .update(userClipsTable)
      .set({ posterStoragePath: storagePath, posterTime: String(generated.posterTime) })
      .where(eq(userClipsTable.id, clip.id));
    logger.info({ clipId: clip.id, storagePath, posterTime: generated.posterTime }, "Clip poster generated");
  } catch (err) {
    logger.warn({ err, clipId: clip.id }, "Clip poster generation failed");
  }
}

export function storageFetchHeaders(target: URL): Record<string, string> {
  return target.host.toLowerCase() === BUNNY_STORAGE_HOSTNAME.toLowerCase() && BUNNY_STORAGE_API_KEY
    ? { AccessKey: BUNNY_STORAGE_API_KEY }
    : {};
}

export function bunnyStorageObjectUrl(storagePath: string): string {
  return `https://${BUNNY_STORAGE_HOSTNAME}/${BUNNY_STORAGE_ZONE}/${storagePath}`;
}

export async function fetchStorageObject(url: string, requestHeaders: Record<string, string>): Promise<Response> {
  const target = new URL(url);
  return fetch(target, {
    headers: {
      ...storageFetchHeaders(target),
      ...requestHeaders,
    },
  });
}