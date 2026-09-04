import { Router, type IRouter } from "express";
import { and, eq } from "drizzle-orm";
import { db, userClipsTable, usersTable } from "@workspace/db";
import {
  BUNNY_STORAGE_HOSTNAME,
  getBunnyProxiedThumbnailUrl,
  isBunnyConfigured,
} from "../lib/bunny";
import {
  bunnyStorageObjectUrl,
  storageFetchHeaders,
} from "../lib/clipPoster";
import { logger } from "../lib/logger";
import {
  absoluteClipShareUrl,
  clipSharePath,
  isValidClipShareToken,
  publicOrigin,
} from "../lib/shareLinks";

const router: IRouter = Router();
const PUBLIC_MEDIA_CACHE = "public, max-age=31536000, immutable";

function parseClipId(value: string | string[]): number | null {
  const raw = Array.isArray(value) ? value[0] : value;
  const id = Number.parseInt(raw ?? "", 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

async function findShareableClip(clipId: number, token: string) {
  if (!isValidClipShareToken(clipId, token)) return null;
  const [clip] = await db
    .select({
      id: userClipsTable.id,
      userId: userClipsTable.userId,
      videoId: userClipsTable.videoId,
      title: userClipsTable.title,
      visibility: userClipsTable.visibility,
      isHidden: userClipsTable.isHidden,
      thumbnailTime: userClipsTable.thumbnailTime,
      aspectRatio: userClipsTable.aspectRatio,
      exportStatus: userClipsTable.exportStatus,
      exportedUrl: userClipsTable.exportedUrl,
      posterStoragePath: userClipsTable.posterStoragePath,
      creatorName: usersTable.name,
    })
    .from(userClipsTable)
    .innerJoin(usersTable, eq(usersTable.id, userClipsTable.userId))
    .where(and(
      eq(userClipsTable.id, clipId),
      eq(userClipsTable.isHidden, false),
    ));
  return clip ?? null;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function outputDimensions(aspectRatio: string): { width: number; height: number } {
  return aspectRatio === "9:16"
    ? { width: 608, height: 1080 }
    : { width: 1920, height: 1080 };
}

function publicPosterUrl(
  req: { protocol: string; headers: Record<string, string | string[] | undefined> },
  clipId: number,
): string {
  return `${publicOrigin(req)}${clipSharePath(clipId)}/poster`;
}

function publicVideoUrl(
  req: { protocol: string; headers: Record<string, string | string[] | undefined> },
  clipId: number,
): string {
  return `${publicOrigin(req)}${clipSharePath(clipId)}/video`;
}

function fallbackImageUrl(
  req: { protocol: string; headers: Record<string, string | string[] | undefined> },
  clip: { videoId: string; thumbnailTime: string | null },
): string | null {
  if (!isBunnyConfigured() || clip.videoId.startsWith("live:")) return null;
  return `${publicOrigin(req)}${getBunnyProxiedThumbnailUrl(
    clip.videoId,
    clip.thumbnailTime == null ? null : Number(clip.thumbnailTime),
  )}`;
}

function renderSharePage(
  req: { protocol: string; headers: Record<string, string | string[] | undefined> },
  clip: Awaited<ReturnType<typeof findShareableClip>>,
  subjectName?: string | null,
): string {
  if (!clip) return "";
  const playerName = subjectName?.trim() || "";
  const title = playerName ? `${playerName} — ${clip.title}` : clip.title;
  const description = clip.creatorName
    ? `${clip.title} by ${clip.creatorName}`
    : clip.title;
  const posterUrl = clip.posterStoragePath
    ? publicPosterUrl(req, clip.id)
    : fallbackImageUrl(req, clip);
  const hasVideo = clip.exportStatus === "done" && !!clip.exportedUrl;
  const videoDimensions = outputDimensions(clip.aspectRatio);
  const escapedTitle = escapeHtml(title);
  const escapedDescription = escapeHtml(description);
  const escapedPageUrl = escapeHtml(absoluteClipShareUrl(req, clip.id));
  const escapedPosterUrl = posterUrl ? escapeHtml(posterUrl) : null;
  const escapedVideoUrl = hasVideo ? escapeHtml(publicVideoUrl(req, clip.id)) : null;

  const metaImage = escapedPosterUrl
    ? `
    <meta property="og:image" content="${escapedPosterUrl}">
    <!-- Explicit poster dimensions make WhatsApp choose the large card before it fetches the image. -->
    <meta property="og:image:width" content="1200">
    <meta property="og:image:height" content="630">`
    : "";
  const metaVideo = escapedVideoUrl
    ? `
    <meta property="og:video" content="${escapedVideoUrl}">
    <meta property="og:video:type" content="video/mp4">
    <meta property="og:video:width" content="${videoDimensions.width}">
    <meta property="og:video:height" content="${videoDimensions.height}">`
    : "";
  const videoAttrs = escapedVideoUrl ? ` src="${escapedVideoUrl}"` : "";
  const posterAttr = escapedPosterUrl ? ` poster="${escapedPosterUrl}"` : "";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapedTitle}</title>
    <meta property="og:type" content="video.other">
    <meta property="og:url" content="${escapedPageUrl}">
    <meta property="og:title" content="${escapedTitle}">
    <meta property="og:description" content="${escapedDescription}">
    ${metaImage}
    ${metaVideo}
  </head>
  <body>
    <video autoplay muted playsinline${posterAttr}${videoAttrs} controls></video>
    <h1>${escapedTitle}</h1>
    <p>${escapedDescription}</p>
  </body>
</html>`;
}

async function proxyShareMedia(
  req: {
    headers: Record<string, string | string[] | undefined>;
    params: Record<string, string | string[] | undefined>;
  },
  res: import("express").Response,
  kind: "poster" | "video",
): Promise<void> {
  const clipId = parseClipId(req.params.id ?? "");
  const token = String(req.params.token ?? "");
  if (!clipId) {
    res.status(404).end();
    return;
  }
  const clip = await findShareableClip(clipId, token);
  if (!clip) {
    res.status(404).end();
    return;
  }
  const targetUrl = kind === "poster"
    ? clip.posterStoragePath
      ? bunnyStorageObjectUrl(clip.posterStoragePath)
      : null
    : clip.exportStatus === "done" && clip.exportedUrl
      ? clip.exportedUrl
      : null;
  if (!targetUrl) {
    res.status(404).end();
    return;
  }

  const abort = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) abort.abort();
  });
  const range = req.headers.range;
  const requestHeaders: Record<string, string> = { ...storageFetchHeaders(new URL(targetUrl)) };
  if (typeof range === "string") requestHeaders.Range = range;

  let upstream: Response;
  try {
    upstream = await fetch(targetUrl, {
      headers: requestHeaders,
      signal: abort.signal,
    });
  } catch (err) {
    if (!res.headersSent) res.status(502).end();
    return;
  }
  if (!upstream.ok || !upstream.body) {
    res.status(upstream.status === 404 ? 404 : 502).end();
    return;
  }

  res.status(upstream.status === 206 ? 206 : 200);
  res.setHeader("Content-Type", upstream.headers.get("content-type")
    ?? (kind === "poster" ? "image/jpeg" : "video/mp4"));
  res.setHeader("Cache-Control", PUBLIC_MEDIA_CACHE);
  res.setHeader("Accept-Ranges", "bytes");
  for (const header of ["content-length", "content-range"]) {
    const value = upstream.headers.get(header);
    if (value) res.setHeader(header, value);
  }

  try {
    const { Readable } = await import("stream");
    const { pipeline } = await import("stream/promises");
    await pipeline(
      Readable.fromWeb(upstream.body as import("stream/web").ReadableStream<Uint8Array>),
      res,
    );
  } catch (err) {
    if (!abort.signal.aborted) logger.warn({ err, clipId, kind }, "Error proxying public clip media");
  }
}

router.get("/share/clips/:id/:token/poster", async (req, res): Promise<void> => {
  await proxyShareMedia(req, res, "poster");
});

router.get("/share/clips/:id/:token/video", async (req, res): Promise<void> => {
  await proxyShareMedia(req, res, "video");
});

router.get("/share/clips/:id/:token", async (req, res): Promise<void> => {
  const clipId = parseClipId(req.params.id);
  const token = String(req.params.token ?? "");
  if (!clipId) {
    res.status(404).end();
    return;
  }
  const clip = await findShareableClip(clipId, token);
  if (!clip) {
    res.status(404).end();
    return;
  }
  res.setHeader("Cache-Control", "public, max-age=60");
  res.type("html").send(renderSharePage(req, clip));
});

export { findShareableClip, renderSharePage };
export default router;