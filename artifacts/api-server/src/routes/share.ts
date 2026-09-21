import { Router, type IRouter, type Request } from "express";
import crypto from "node:crypto";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { and, eq, gt, inArray } from "drizzle-orm";
import { db, fieldsTable, footageRequestsTable, userClipsTable, usersTable } from "@workspace/db";
import {
  BUNNY_STORAGE_API_KEY,
  BUNNY_STORAGE_HOSTNAME,
  BUNNY_STORAGE_ZONE,
  BUNNY_CDN_HOSTNAME,
  getBunnyVideoInfo,
  uploadBufferToBunnyStorage,
  isBunnyStorageConfigured,
  getBunnyPlaybackUrl,
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
const PUBLIC_STREAM_TTL_MS = 15 * 60 * 1000;
const publicStreamResources = new Map<string, { token: string; url: string; expiresAt: number }>();

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

function htmlEscape(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  }[character] ?? character));
}

type OwnerShareRow = typeof footageRequestsTable.$inferSelect;

async function resolveOwnerShare(token: string): Promise<(OwnerShareRow & { fieldName: string }) | null> {
  if (!/^[a-f0-9]{32}$/.test(token)) return null;
  const [row] = await db
    .select({ request: footageRequestsTable, fieldName: fieldsTable.name })
    .from(footageRequestsTable)
    .innerJoin(fieldsTable, eq(fieldsTable.id, footageRequestsTable.fieldId))
    .where(and(
      eq(footageRequestsTable.shareToken, token),
      inArray(footageRequestsTable.status, ["ready", "partial"]),
      eq(footageRequestsTable.shareRevoked, false),
      gt(footageRequestsTable.shareExpiresAt, new Date()),
    ));
  if (!row || !row.request.videoId) return null;
  return { ...row.request, fieldName: row.fieldName };
}

function streamResourceId(token: string, url: string): string {
  const id = crypto.randomBytes(12).toString("hex");
  publicStreamResources.set(id, { token, url, expiresAt: Date.now() + PUBLIC_STREAM_TTL_MS });
  return id;
}

function cleanStreamResources(): void {
  const now = Date.now();
  for (const [id, resource] of publicStreamResources) {
    if (resource.expiresAt <= now) publicStreamResources.delete(id);
  }
}

function publicResourcePath(token: string, id: string): string {
  return `/w/${encodeURIComponent(token)}/resource/${encodeURIComponent(id)}`;
}

function rewriteOwnerManifest(token: string, rawManifest: string, sourceUrl: string): string {
  const base = new URL(sourceUrl);
  return rawManifest.split("\n").map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return line;

    const rewriteUri = (raw: string): string => {
      let absolute: string;
      try {
        absolute = new URL(raw).href;
      } catch {
        absolute = new URL(raw, base).href;
      }
      return publicResourcePath(token, streamResourceId(token, absolute));
    };

    if (trimmed.startsWith("#")) {
      return line.replace(/URI="([^"]+)"/g, (_match, uri: string) => `URI="${rewriteUri(uri)}"`);
    }
    return rewriteUri(trimmed);
  }).join("\n");
}

function ownerShareHtml(
  req: Request,
  share: OwnerShareRow & { fieldName: string },
): string {
  const token = share.shareToken!;
  const base = publicBaseUrl(req);
  const pageUrl = `${base}/w/${token}`;
  const manifestUrl = `${pageUrl}/manifest.m3u8`;
  const title = `${share.fieldName} · Replay`;
  const description = `Owner footage from ${share.fieldName}, ${share.startLocal}–${share.endLocal}.`;
  const e = htmlEscape;
  return `<!doctype html>
<html lang="en" dir="ltr">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>${e(title)}</title>
<meta name="description" content="${e(description)}" />
<link rel="canonical" href="${e(pageUrl)}" />
<meta property="og:type" content="video.other" />
<meta property="og:site_name" content="Replay" />
<meta property="og:title" content="${e(title)}" />
<meta property="og:description" content="${e(description)}" />
<meta property="og:url" content="${e(pageUrl)}" />
<meta name="twitter:card" content="summary" />
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; background: #080b10; color: #eef4f8;
    font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  main { width: min(100%, 980px); margin: 0 auto; padding: 0 0 2rem; }
  .stage { background: #000; }
  video { display: block; width: 100%; max-height: 78vh; background: #000; }
  .content { padding: 1.1rem 1rem; }
  h1 { margin: 0 0 .35rem; font-size: 1.2rem; }
  p { margin: 0; color: #a7b4c2; }
  .ar { display: none; direction: rtl; }
  .language { display: flex; gap: .45rem; margin: 1rem 0 0; }
  button, a { border: 0; border-radius: .65rem; padding: .65rem .9rem;
    background: #17212c; color: #d9e6f0; text-decoration: none; font: inherit; cursor: pointer; }
  button.active { background: #20a566; color: white; }
  .home { display: inline-block; margin-top: 1.2rem; background: #20a566; color: white; font-weight: 700; }
</style>
</head>
<body>
<main>
  <div class="stage">
    <video id="owner-video" controls controlsList="nodownload noplaybackrate" playsinline preload="metadata"></video>
  </div>
  <div class="content">
    <div class="en">
      <h1>${e(title)}</h1>
      <p>${e(description)}</p>
      <a class="home" href="${e(base)}">Open Replay</a>
    </div>
    <div class="ar">
      <h1>${e(share.fieldName)} · Replay</h1>
      <p>لقطات الملعب من ${e(share.startLocal)} إلى ${e(share.endLocal)}.</p>
      <a class="home" href="${e(base)}">فتح Replay</a>
    </div>
    <div class="language" aria-label="Language">
      <button id="en-button" type="button">English</button>
      <button id="ar-button" type="button">العربية</button>
    </div>
  </div>
</main>
<script src="https://cdn.jsdelivr.net/npm/hls.js@1.6.16/dist/hls.min.js"></script>
<script>
(() => {
  const token = ${JSON.stringify(token)};
  const manifest = ${JSON.stringify(manifestUrl)};
  const video = document.getElementById("owner-video");
  const en = document.querySelector(".en");
  const ar = document.querySelector(".ar");
  const enButton = document.getElementById("en-button");
  const arButton = document.getElementById("ar-button");
  const setLanguage = (language) => {
    const arabic = language === "ar";
    document.documentElement.lang = language;
    document.documentElement.dir = arabic ? "rtl" : "ltr";
    en.style.display = arabic ? "none" : "block";
    ar.style.display = arabic ? "block" : "none";
    enButton.classList.toggle("active", !arabic);
    arButton.classList.toggle("active", arabic);
  };
  enButton.addEventListener("click", () => setLanguage("en"));
  arButton.addEventListener("click", () => setLanguage("ar"));
  setLanguage(new URLSearchParams(location.search).get("lang") === "ar"
    || navigator.language.toLowerCase().startsWith("ar") ? "ar" : "en");
  if (window.Hls && window.Hls.isSupported()) {
    const hls = new window.Hls({ enableWorker: false });
    hls.loadSource(manifest);
    hls.attachMedia(video);
    hls.on(window.Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => {}));
  } else {
    video.src = manifest;
    video.addEventListener("loadedmetadata", () => video.play().catch(() => {}), { once: true });
  }
})();
</script>
</body>
</html>`;
}

router.get("/w/:token", async (req, res): Promise<void> => {
  const token = String(req.params.token ?? "");
  const share = await resolveOwnerShare(token);
  if (!share) {
    res.status(404).type("text/plain").send("Not found");
    return;
  }
  res.setHeader("Cache-Control", "public, max-age=60");
  res.removeHeader("Vary");
  res.type("text/html").send(ownerShareHtml(req, share));
});

router.get("/w/:token/manifest.m3u8", async (req, res): Promise<void> => {
  const token = String(req.params.token ?? "");
  const share = await resolveOwnerShare(token);
  if (!share) {
    res.status(404).type("text/plain").send("Not found");
    return;
  }
  cleanStreamResources();
  const rawUrl = getBunnyPlaybackUrl(share.videoId!);
  const response = await fetch(rawUrl, {
    headers: { Referer: `https://${new URL(rawUrl).hostname}/` },
    signal: AbortSignal.timeout(30_000),
  }).catch(() => null);
  if (!response?.ok) {
    res.status(404).type("text/plain").send("Not found");
    return;
  }
  const manifest = await response.text();
  res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
  res.setHeader("Cache-Control", "no-store");
  res.send(rewriteOwnerManifest(token, manifest, rawUrl));
});

router.get("/w/:token/resource/:resourceId", async (req, res): Promise<void> => {
  const token = String(req.params.token ?? "");
  const share = await resolveOwnerShare(token);
  if (!share) {
    res.status(404).type("text/plain").send("Not found");
    return;
  }
  cleanStreamResources();
  const resource = publicStreamResources.get(String(req.params.resourceId ?? ""));
  if (!resource || resource.token !== token || resource.expiresAt <= Date.now()) {
    res.status(404).type("text/plain").send("Not found");
    return;
  }

  const abort = new AbortController();
  res.on("close", () => abort.abort());
  const response = await fetch(resource.url, {
    headers: { Referer: `https://${new URL(resource.url).hostname}/` },
    signal: AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)]),
  }).catch(() => null);
  if (!response?.ok || !response.body) {
    res.status(404).type("text/plain").send("Not found");
    return;
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (resource.url.includes(".m3u8") || contentType.includes("mpegurl")) {
    const manifest = await response.text();
    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.setHeader("Cache-Control", "no-store");
    res.send(rewriteOwnerManifest(token, manifest, resource.url));
    return;
  }

  res.status(response.status);
  res.setHeader("Content-Type", contentType || "video/mp2t");
  res.setHeader("Cache-Control", "public, max-age=300");
  const contentLength = response.headers.get("content-length");
  if (contentLength) res.setHeader("Content-Length", contentLength);
  const nodeStream = Readable.fromWeb(response.body as import("stream/web").ReadableStream<Uint8Array>);
  try {
    await pipeline(nodeStream, res);
  } catch {
    if (!res.headersSent) res.status(503).end();
  }
});

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
