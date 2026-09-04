import { Router, type IRouter, type Request } from "express";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { eq } from "drizzle-orm";
import { db, userClipsTable, usersTable } from "@workspace/db";
import {
  BUNNY_STORAGE_API_KEY,
  BUNNY_STORAGE_HOSTNAME,
  BUNNY_STORAGE_ZONE,
  BUNNY_CDN_HOSTNAME,
  getBunnyVideoInfo,
  uploadBufferToBunnyStorage,
  isBunnyStorageConfigured,
} from "../lib/bunny";
import { selectExportSource } from "../lib/exportSource";
import {
  generatePosterFrame,
  posterCropForClip,
  posterStoragePath,
  probeDuration,
  POSTER_WIDTH,
  POSTER_HEIGHT,
} from "../lib/posterFrame";
import { buildShareCardHtml, shareCardPath, shareToken, verifyShareToken } from "../lib/shareCard";
import { logger } from "../lib/logger";

const router: IRouter = Router();

/**
 * Public origin the share links are built against.
 *
 * Open Graph consumers reject relative URLs outright, so this has to resolve to
 * something absolute. The env var wins because behind a CDN or a proxy the
 * request's own Host header is not necessarily the name people were given.
 */
function publicBaseUrl(req: Request): string {
  const configured = process.env.PUBLIC_SHARE_BASE_URL || process.env.PUBLIC_BASE_URL;
  if (configured) return configured.replace(/\/$/, "");
  const proto = (req.headers["x-forwarded-proto"] as string)?.split(",")[0] || req.protocol || "https";
  const host = (req.headers["x-forwarded-host"] as string)?.split(",")[0] || req.get("host") || "";
  return `${proto}://${host}`;
}

function appClipUrl(req: Request, clipId: number): string {
  const configured = process.env.PUBLIC_APP_BASE_URL;
  const base = (configured || publicBaseUrl(req)).replace(/\/$/, "");
  return `${base}/watch?clip=${clipId}`;
}

type ClipRow = typeof userClipsTable.$inferSelect;

/** Resolve `:id`/`:token`, or null. Every failure is a 404: a wrong token must
 *  not be distinguishable from a missing clip, or the ids become enumerable. */
async function resolveSharedClip(req: Request): Promise<ClipRow | null> {
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const clipId = Number.parseInt(String(rawId), 10);
  if (!Number.isFinite(clipId)) return null;
  const token = String(Array.isArray(req.params.token) ? req.params.token[0] : req.params.token ?? "");
  if (!verifyShareToken(clipId, token)) return null;

  const [clip] = await db.select().from(userClipsTable).where(eq(userClipsTable.id, clipId));
  if (!clip || clip.isHidden) return null;
  return clip;
}

/**
 * Make sure the clip has a poster, generating one if not.
 *
 * Lazy on purpose: most clips are never shared, and a poster costs a seek
 * against an hour-long source. Generating at export time would pay that for
 * every clip in the product to serve the few that get sent to somebody.
 *
 * The rendered export is the preferred source when it exists — it is already
 * cropped, branded and small, so the poster is both cheaper and a truthful
 * preview of what the viewer will actually watch. The panorama is the fallback,
 * and there the clip's own crop has to be applied or the card advertises the
 * wrong part of the pitch.
 */
export async function ensureClipPoster(clip: ClipRow): Promise<string | null> {
  if (clip.posterPath) return clip.posterPath;
  if (!isBunnyStorageConfigured()) return null;

  try {
    let result;
    if (clip.exportedUrl) {
      const duration = await probeDuration(clip.exportedUrl);
      result = await generatePosterFrame({
        sourceUrl: clip.exportedUrl,
        startSec: 0,
        endSec: duration,
        crop: null,
        sourceAspect: clip.aspectRatio === "9:16" ? 9 / 16 : 16 / 9,
      });
    } else {
      const { duration, hasMP4Fallback, availableResolutions } = await getBunnyVideoInfo(clip.videoId);
      const referer = `https://${BUNNY_CDN_HOSTNAME}/`;
      const source = await selectExportSource({
        videoId: clip.videoId,
        hasMP4Fallback,
        availableResolutions,
        referer,
      });
      const startSec = Math.max(0, Number.parseFloat(clip.startTime) * duration);
      const endSec = Math.min(duration, Number.parseFloat(clip.endTime) * duration);
      result = await generatePosterFrame({
        sourceUrl: source.url,
        referer,
        startSec,
        endSec,
        crop: posterCropForClip(clip.cropPath ?? [], clip.aspectRatio),
      });
    }

    const path = posterStoragePath(clip.id, shareToken(clip.id));
    await uploadBufferToBunnyStorage(result.buffer, path, "image/jpeg");
    await db
      .update(userClipsTable)
      .set({ posterPath: path, posterAtSec: String(result.atSec.toFixed(3)) })
      .where(eq(userClipsTable.id, clip.id));

    logger.info(
      { clipId: clip.id, path, atSec: result.atSec, degraded: result.degraded,
        from: clip.exportedUrl ? "export" : "source" },
      "Generated clip poster",
    );
    return path;
  } catch (err) {
    // A missing poster costs a small share card. It must never cost the share.
    logger.error({ err, clipId: clip.id }, "Poster generation failed");
    return null;
  }
}

/** Stream a Bunny Storage object through this server, honouring Range.
 *
 *  Range is not optional: Safari will not start an inline <video> against an
 *  origin that answers 200 to a ranged request, which is every iPhone opening
 *  the share card. */
async function proxyStorageObject(
  req: Request,
  res: import("express").Response,
  storagePath: string,
  contentType: string,
  cacheSeconds: number,
): Promise<void> {
  const upstreamUrl = `https://${BUNNY_STORAGE_HOSTNAME}/${BUNNY_STORAGE_ZONE}/${storagePath}`;
  const abort = new AbortController();
  res.on("close", () => abort.abort());

  const headers: Record<string, string> = { AccessKey: BUNNY_STORAGE_API_KEY };
  const range = req.headers.range;
  if (typeof range === "string") headers.Range = range;

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, { headers, signal: abort.signal });
  } catch {
    if (!res.headersSent) res.status(502).end();
    return;
  }
  if (!upstream.ok || !upstream.body) {
    res.status(upstream.status === 404 ? 404 : 502).end();
    return;
  }

  res.status(upstream.status);
  res.setHeader("Content-Type", contentType);
  res.setHeader("Accept-Ranges", "bytes");
  // Share assets are immutable per token and are fetched by crawlers that will
  // not come back. The /api no-store default above is wrong for them.
  res.setHeader("Cache-Control", `public, max-age=${cacheSeconds}, immutable`);
  res.removeHeader("Vary");
  for (const h of ["content-length", "content-range", "etag", "last-modified"]) {
    const v = upstream.headers.get(h);
    if (v) res.setHeader(h, v);
  }

  const node = Readable.fromWeb(upstream.body as import("stream/web").ReadableStream<Uint8Array>);
  try {
    await pipeline(node, res);
  } catch (err) {
    if (!abort.signal.aborted) logger.error({ err, storagePath }, "Error proxying share asset");
    if (!res.headersSent) res.status(500).end();
  }
}

/** The share card itself. No auth, no interstitial, no JavaScript required. */
router.get(["/s/:id/:token", "/api/s/:id/:token"], async (req, res): Promise<void> => {
  const clip = await resolveSharedClip(req);
  if (!clip) { res.status(404).type("text/plain").send("Not found"); return; }

  const posterPath = await ensureClipPoster(clip);
  const [creator] = clip.userId
    ? await db.select({ name: usersTable.name }).from(usersTable).where(eq(usersTable.id, clip.userId))
    : [];

  const base = publicBaseUrl(req);
  const cardPath = shareCardPath(clip.id);
  const html = buildShareCardHtml({
    clipId: clip.id,
    title: clip.title,
    creatorName: creator?.name ?? null,
    fieldName: null,
    baseUrl: base,
    posterUrl: posterPath ? `${base}${cardPath}/poster.jpg` : null,
    videoUrl: clip.exportedUrl ? `${base}${cardPath}/clip.mp4` : null,
    appUrl: appClipUrl(req, clip.id),
    posterWidth: POSTER_WIDTH,
    posterHeight: POSTER_HEIGHT,
  });

  res.setHeader("Cache-Control", "public, max-age=300");
  res.removeHeader("Vary");
  res.type("text/html").send(html);
});

router.get(["/s/:id/:token/poster.jpg", "/api/s/:id/:token/poster.jpg"], async (req, res): Promise<void> => {
  const clip = await resolveSharedClip(req);
  if (!clip) { res.status(404).end(); return; }
  const posterPath = await ensureClipPoster(clip);
  if (!posterPath) { res.status(404).end(); return; }
  await proxyStorageObject(req, res, posterPath, "image/jpeg", 31536000);
});

router.get(["/s/:id/:token/clip.mp4", "/api/s/:id/:token/clip.mp4"], async (req, res): Promise<void> => {
  const clip = await resolveSharedClip(req);
  if (!clip || !clip.exportedUrl) { res.status(404).end(); return; }
  // exportedUrl is a CDN URL over the same storage zone; the storage path is
  // everything after the zone root.
  const storagePath = clip.exportedUrl.replace(/^https?:\/\/[^/]+\//, "");
  await proxyStorageObject(req, res, storagePath, "video/mp4", 86400);
});

export default router;
