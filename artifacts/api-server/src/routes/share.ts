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

export async function resolveOwnerShare(token: string): Promise<(OwnerShareRow & { fieldName: string }) | null> {
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
  const upstream = new URL(url);
  const upstreamPath = `${upstream.pathname}${upstream.search}`;
  const encodedPath = Buffer.from(upstreamPath, "utf8").toString("base64url");
  const signature = crypto
    .createHmac(
      "sha256",
      process.env.CLIP_SHARE_URL_SECRET ||
        process.env.CLIP_EXPORT_URL_SECRET ||
        BUNNY_STORAGE_API_KEY ||
        "replay-dev-share-secret",
    )
    .update(`${token}\n${upstreamPath}`)
    .digest("hex")
    .slice(0, 32);
  return `${encodedPath}.${signature}`;
}

function verifyStreamResourceId(token: string, resourceId: string): string | null {
  const separator = resourceId.lastIndexOf(".");
  if (separator <= 0 || separator === resourceId.length - 1) return null;

  const encodedPath = resourceId.slice(0, separator);
  const presentedSignature = resourceId.slice(separator + 1);
  if (!/^[0-9a-f]{32}$/.test(presentedSignature)) return null;

  let upstreamPath: string;
  try {
    upstreamPath = Buffer.from(encodedPath, "base64url").toString("utf8");
  } catch {
    return null;
  }
  if (!upstreamPath.startsWith("/") || upstreamPath.includes("\0")) return null;

  const expectedSignature = crypto
    .createHmac(
      "sha256",
      process.env.CLIP_SHARE_URL_SECRET ||
        process.env.CLIP_EXPORT_URL_SECRET ||
        BUNNY_STORAGE_API_KEY ||
        "replay-dev-share-secret",
    )
    .update(`${token}\n${upstreamPath}`)
    .digest("hex")
    .slice(0, 32);
  const expected = Buffer.from(expectedSignature, "hex");
  const presented = Buffer.from(presentedSignature, "hex");
  if (expected.length !== presented.length || !crypto.timingSafeEqual(expected, presented)) {
    return null;
  }
  return upstreamPath;
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

const ENGLISH_MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const ARABIC_MONTHS = [
  "يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو",
  "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر",
];
const ENGLISH_WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const ARABIC_WEEKDAYS = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];

function localCalendarDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return null;
  const [, year, month, day] = match;
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), 12));
}

function localDateLabel(value: string, language: "en" | "ar"): string {
  const date = localCalendarDate(value);
  if (!date) return value;
  const day = date.getUTCDate();
  const month = language === "ar" ? ARABIC_MONTHS[date.getUTCMonth()] : ENGLISH_MONTHS[date.getUTCMonth()];
  const weekday = language === "ar" ? ARABIC_WEEKDAYS[date.getUTCDay()] : ENGLISH_WEEKDAYS[date.getUTCDay()];
  return `${weekday} ${day} ${month}`;
}

function ownerWindowLabel(
  startLocal: string,
  endLocal: string,
  language: "en" | "ar",
): string {
  const startDate = localDateLabel(startLocal, language);
  const endDate = localDateLabel(endLocal, language);
  const startTime = startLocal.slice(11, 16);
  const endTime = endLocal.slice(11, 16);
  return startDate === endDate
    ? `${startDate} · ${startTime}–${endTime}`
    : `${startDate} · ${startTime}–${endDate} · ${endTime}`;
}

function expiryDateLabel(value: Date, language: "en" | "ar"): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Amman",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value).map((part) => [part.type, part.value]));
  const monthIndex = Number(parts.month) - 1;
  const month = language === "ar" ? ARABIC_MONTHS[monthIndex] : ENGLISH_MONTHS[monthIndex];
  return `${Number(parts.day)} ${month}`;
}

function ownerShareUnavailableHtml(req: Request): string {
  const base = publicBaseUrl(req);
  const e = htmlEscape;
  return `<!doctype html>
<html lang="en" dir="ltr">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>This link is no longer available. · Replay</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Cairo:wght@500;600;700&family=Rajdhani:wght@500;600;700&display=swap');
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; background: #0B0F1A; color: #eef4f8;
    font: 15px/1.5 "Rajdhani", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  main { width: min(100%, 560px); min-height: 100vh; display: grid; place-content: center;
    margin: 0 auto; padding: 2rem 1.25rem; text-align: center; }
  .brand { margin-bottom: 2rem; color: #D4FF4F; font-size: .8rem; font-weight: 700; letter-spacing: .28em; }
  .card { border: 1px solid rgba(255,255,255,.1); border-radius: 1.5rem; padding: 2rem 1.25rem;
    background: rgba(20,27,43,.78); box-shadow: 0 24px 80px rgba(0,0,0,.28); }
  h1 { margin: 0; color: #f5f8fb; font-size: clamp(1.8rem, 7vw, 2.6rem); line-height: 1; }
  p { margin: .75rem 0 0; color: #a7b4c2; font-family: "Cairo", sans-serif; }
  .ar { display: none; direction: rtl; }
  .language { display: flex; justify-content: center; gap: .45rem; margin-top: 1.5rem; }
  button, a { border: 0; border-radius: .7rem; padding: .65rem .9rem; background: #17212c;
    color: #d9e6f0; text-decoration: none; font: inherit; cursor: pointer; }
  button.active, .home { background: #D4FF4F; color: #0B0F1A; font-weight: 700; }
  .home { display: inline-block; margin-top: 1.5rem; }
</style>
</head>
<body>
<main>
  <div class="brand">REPLAY</div>
  <div class="card">
    <div class="en">
      <h1>This link is no longer available.</h1>
      <a class="home" href="${e(base)}">Open Replay</a>
    </div>
    <div class="ar">
      <h1>هذا الرابط لم يعد متاحاً.</h1>
      <a class="home" href="${e(base)}">فتح Replay</a>
    </div>
    <div class="language" aria-label="Language">
      <button id="en-button" type="button">English</button>
      <button id="ar-button" type="button">العربية</button>
    </div>
  </div>
</main>
<script>
(() => {
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
})();
</script>
</body>
</html>`;
}

function ownerShareHtml(
  req: Request,
  share: OwnerShareRow & { fieldName: string },
): string {
  const token = share.shareToken!;
  const base = publicBaseUrl(req);
  const pageUrl = `${base}/w/${token}`;
  const manifestUrl = `${pageUrl}/manifest.m3u8`;
  const title = share.fieldName;
  const windowEnglish = ownerWindowLabel(share.startLocal, share.endLocal, "en");
  const windowArabic = ownerWindowLabel(share.startLocal, share.endLocal, "ar");
  const expiryEnglish = `Available until ${expiryDateLabel(share.shareExpiresAt!, "en")}`;
  const expiryArabic = `متاح حتى ${expiryDateLabel(share.shareExpiresAt!, "ar")}`;
  const e = htmlEscape;
  return `<!doctype html>
<html lang="en" dir="ltr">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>${e(title)} · Replay</title>
<meta name="description" content="${e(windowEnglish)}" />
<link rel="canonical" href="${e(pageUrl)}" />
<meta property="og:type" content="video.other" />
<meta property="og:site_name" content="Replay" />
<meta property="og:title" content="${e(title)}" />
<meta property="og:description" content="${e(windowEnglish)}" />
<meta property="og:url" content="${e(pageUrl)}" />
<meta name="twitter:card" content="summary" />
<style>
  @import url('https://fonts.googleapis.com/css2?family=Cairo:wght@500;600;700&family=Rajdhani:wght@500;600;700&display=swap');
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; background: #0B0F1A; color: #eef4f8;
    font: 15px/1.5 "Rajdhani", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  main { width: min(100%, 980px); margin: 0 auto; padding: 0 0 2rem; }
  .stage { background: #000; }
  video { display: block; width: 100%; max-height: 78vh; background: #000; }
  .content { padding: 1.1rem 1rem; }
  .brand { padding: 1rem 1rem .65rem; color: #D4FF4F; font-size: .75rem; font-weight: 700;
    letter-spacing: .28em; }
  h1 { margin: 0 0 .35rem; font-size: clamp(1.45rem, 5vw, 2rem); line-height: 1; }
  p { margin: 0; color: #a7b4c2; }
  .window { font-size: 1rem; font-weight: 600; }
  .ar { display: none; direction: rtl; font-family: "Cairo", sans-serif; }
  .ar h1, .ar p, .ar a, .ar button { font-family: "Cairo", sans-serif; }
  .expiry { display: inline-block; margin-top: .75rem; border: 1px solid rgba(212,255,79,.25);
    border-radius: 999px; padding: .25rem .65rem; color: #D4FF4F; font-size: .78rem; font-weight: 600; }
  .language { display: flex; gap: .45rem; margin: 1rem 0 0; }
  button, a { border: 0; border-radius: .65rem; padding: .65rem .9rem;
    background: #17212c; color: #d9e6f0; text-decoration: none; font: inherit; cursor: pointer; }
  button.active { background: #D4FF4F; color: #0B0F1A; }
  .cta { display: flex; align-items: center; justify-content: space-between; gap: 1rem;
    margin-top: 1.25rem; border: 1px solid rgba(255,255,255,.1); border-radius: 1rem;
    padding: .85rem 1rem; background: rgba(20,27,43,.78); }
  .cta p { color: #eef4f8; font-weight: 600; }
  .home { display: inline-block; flex-shrink: 0; background: #D4FF4F; color: #0B0F1A; font-weight: 700; }
</style>
</head>
<body>
<main>
  <div class="brand">REPLAY</div>
  <div class="stage">
    <video id="owner-video" controls controlsList="nodownload noplaybackrate" playsinline preload="metadata"></video>
  </div>
  <div class="content">
    <div class="en">
      <h1>${e(title)}</h1>
      <p class="window">${e(windowEnglish)}</p>
      <span class="expiry">${e(expiryEnglish)}</span>
      <div class="cta"><p>Want your own clips?</p><a class="home" href="${e(base)}">Open Replay</a></div>
    </div>
    <div class="ar">
      <h1>${e(title)}</h1>
      <p class="window">${e(windowArabic)}</p>
      <span class="expiry">${e(expiryArabic)}</span>
      <div class="cta"><p>بدك مقاطعك الخاصة؟</p><a class="home" href="${e(base)}">افتح Replay</a></div>
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

router.get(["/w/:token", "/api/w/:token"], async (req, res): Promise<void> => {
  const token = String(req.params.token ?? "");
  const share = await resolveOwnerShare(token);
  if (!share) {
    res.setHeader("Cache-Control", "no-store");
    res.removeHeader("Vary");
    res.status(404).type("text/html").send(ownerShareUnavailableHtml(req));
    return;
  }
  res.setHeader("Cache-Control", "no-store");
  res.removeHeader("Vary");
  res.type("text/html").send(ownerShareHtml(req, share));
});

router.get(["/w/:token/manifest.m3u8", "/api/w/:token/manifest.m3u8"], async (req, res): Promise<void> => {
  const token = String(req.params.token ?? "");
  const share = await resolveOwnerShare(token);
  if (!share) {
    res.status(404).type("text/plain").send("Not found");
    return;
  }
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

router.get(["/w/:token/resource/:resourceId", "/api/w/:token/resource/:resourceId"], async (req, res): Promise<void> => {
  const token = String(req.params.token ?? "");
  const upstreamPath = verifyStreamResourceId(token, String(req.params.resourceId ?? ""));
  if (!upstreamPath) {
    res.status(404).type("text/plain").send("Not found");
    return;
  }
  const share = await resolveOwnerShare(token);
  if (!share) {
    res.status(404).type("text/plain").send("Not found");
    return;
  }
  const upstreamUrl = `https://${BUNNY_CDN_HOSTNAME}${upstreamPath}`;

  const abort = new AbortController();
  res.on("close", () => abort.abort());
  const response = await fetch(upstreamUrl, {
    headers: { Referer: `https://${BUNNY_CDN_HOSTNAME}/` },
    signal: AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)]),
  }).catch(() => null);
  if (!response?.ok || !response.body) {
    res.status(404).type("text/plain").send("Not found");
    return;
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (upstreamPath.includes(".m3u8") || contentType.includes("mpegurl")) {
    const manifest = await response.text();
    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.setHeader("Cache-Control", "no-store");
    res.send(rewriteOwnerManifest(token, manifest, upstreamUrl));
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
