import crypto from "crypto";
import { BUNNY_STORAGE_API_KEY } from "./bunny";
import { POSTER_WIDTH, POSTER_HEIGHT } from "./posterFrame";

/**
 * The share card.
 *
 * A shared clip has to work for someone who has never heard of Replay, tapping a
 * WhatsApp message on a phone. That rules out a login wall, an app-install
 * interstitial and a "continue in browser" gate, and it rules out the SPA's own
 * index.html — a crawler does not run JavaScript, so a client-rendered page
 * gives every clip in the product the same generic card. This module renders the
 * card server-side.
 *
 * Four things decide whether WhatsApp draws the large card or the small square
 * thumbnail, and all four are here:
 *   - og:image, absolute, served over HTTPS;
 *   - og:image:width and og:image:height, stated explicitly — WhatsApp will not
 *     fetch the image to measure it before deciding, so an image without
 *     declared dimensions gets the small treatment;
 *   - an image at least 300px on its long edge (this one is 1200x630);
 *   - og:title and og:description that are about the clip, not the site.
 *
 * og:video is emitted for the platforms that honour it, but the page does not
 * depend on it: WhatsApp will not play third-party video inline under any
 * circumstances, so the video tag in the body — muted, autoplaying, above the
 * fold — is what actually plays the clip once the card is tapped.
 */

/**
 * Unguessable per-clip token.
 *
 * Share links are public by construction, so the id alone would let anyone walk
 * the whole library by counting. Keyed on CLIP_SHARE_URL_SECRET, falling back to
 * the storage key like the export path does, so it is deterministic and needs no
 * column of its own.
 */
export function shareToken(clipId: number): string {
  const secret =
    process.env.CLIP_SHARE_URL_SECRET ||
    process.env.CLIP_EXPORT_URL_SECRET ||
    BUNNY_STORAGE_API_KEY ||
    "replay-dev-share-secret";
  return crypto
    .createHmac("sha256", secret)
    .update(`clip-share:${clipId}`)
    .digest("hex")
    .slice(0, 20);
}

/** Constant-time comparison, so the token cannot be recovered a byte at a time. */
export function verifyShareToken(clipId: number, presented: string): boolean {
  const expected = shareToken(clipId);
  const a = Buffer.from(expected);
  const b = Buffer.from(String(presented ?? ""));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Path prefix the share card is served under.
 *
 * `/s` is the right-looking link and is what the API mounts by default. But this
 * app and the API are served under one origin by a router in front of them
 * (Replit's `router = "application"`, API on 8080, SPA on 8081), and that router
 * decides by path prefix — so on a deployment where only `/api` reaches the API,
 * a bare `/s/...` link lands on the SPA and the crawler gets the generic card
 * with nothing to indicate anything went wrong.
 *
 * The router mounts the share routes at BOTH paths; this variable only decides
 * which form the emitted links take. Set `SHARE_PATH_PREFIX=/api/s` where the
 * front router does not pass `/s` through. Verify with a real request to
 * `https://<host>/s/<id>/<token>` before trusting the short form: the failure is
 * silent and shows up as share cards that never got better.
 */
export const SHARE_PATH_PREFIX = (process.env.SHARE_PATH_PREFIX || "/s").replace(/\/$/, "");

export function shareCardPath(clipId: number): string {
  return `${SHARE_PATH_PREFIX}/${clipId}/${shareToken(clipId)}`;
}

export function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface ShareCardOptions {
  clipId: number;
  title: string;
  /** Set where identity has resolved a player; otherwise the creator. */
  subjectName?: string | null;
  creatorName?: string | null;
  fieldName?: string | null;
  /** Absolute origin, e.g. https://replayjo.com */
  baseUrl: string;
  /** Absolute poster URL. Null renders the card without og:image. */
  posterUrl: string | null;
  /** Absolute MP4 URL, or null when the export is not ready yet. */
  videoUrl: string | null;
  /** Where "open in Replay" goes. */
  appUrl: string;
  posterWidth?: number;
  posterHeight?: number;
}

/**
 * og:title.
 *
 * The player's name leads when identity has resolved one, because a name is what
 * makes somebody tap a link in a group chat — "Yousef Haddad" outperforms
 * "Clip 4821" by a distance. Falls back to the clip title, then to a generic.
 */
export function buildShareTitle(options: ShareCardOptions): string {
  const parts = [options.subjectName, options.title].filter(
    (v): v is string => typeof v === "string" && v.trim().length > 0,
  );
  if (parts.length === 0) return "A moment on Replay";
  if (parts.length === 1) return parts[0]!.trim();
  return `${parts[0]!.trim()} — ${parts[1]!.trim()}`;
}

export function buildShareDescription(options: ShareCardOptions): string {
  const bits = [
    options.creatorName ? `Clipped by ${options.creatorName}` : null,
    options.fieldName,
  ].filter(Boolean);
  return bits.length ? `${bits.join(" · ")} · Watch on Replay` : "Watch on Replay";
}

export function buildShareCardHtml(options: ShareCardOptions): string {
  const title = buildShareTitle(options);
  const description = buildShareDescription(options);
  const pageUrl = `${options.baseUrl.replace(/\/$/, "")}${shareCardPath(options.clipId)}`;
  const pw = options.posterWidth ?? POSTER_WIDTH;
  const ph = options.posterHeight ?? POSTER_HEIGHT;

  const e = escapeHtml;
  const meta: string[] = [
    `<meta property="og:type" content="video.other" />`,
    `<meta property="og:site_name" content="Replay" />`,
    `<meta property="og:title" content="${e(title)}" />`,
    `<meta property="og:description" content="${e(description)}" />`,
    `<meta property="og:url" content="${e(pageUrl)}" />`,
  ];

  if (options.posterUrl) {
    meta.push(
      `<meta property="og:image" content="${e(options.posterUrl)}" />`,
      `<meta property="og:image:secure_url" content="${e(options.posterUrl)}" />`,
      `<meta property="og:image:type" content="image/jpeg" />`,
      // Explicit dimensions are what get the large card rather than the small
      // square thumbnail. Do not remove them because "the image says so".
      `<meta property="og:image:width" content="${pw}" />`,
      `<meta property="og:image:height" content="${ph}" />`,
      `<meta property="og:image:alt" content="${e(title)}" />`,
      `<meta name="twitter:card" content="summary_large_image" />`,
      `<meta name="twitter:image" content="${e(options.posterUrl)}" />`,
    );
  } else {
    meta.push(`<meta name="twitter:card" content="summary" />`);
  }

  if (options.videoUrl) {
    meta.push(
      `<meta property="og:video" content="${e(options.videoUrl)}" />`,
      `<meta property="og:video:secure_url" content="${e(options.videoUrl)}" />`,
      `<meta property="og:video:type" content="video/mp4" />`,
      `<meta property="og:video:width" content="${pw}" />`,
      `<meta property="og:video:height" content="${ph}" />`,
      `<meta name="twitter:player" content="${e(pageUrl)}" />`,
    );
  }

  meta.push(
    `<meta name="twitter:title" content="${e(title)}" />`,
    `<meta name="twitter:description" content="${e(description)}" />`,
  );

  const player = options.videoUrl
    ? `<video
        id="clip"
        playsinline
        autoplay
        muted
        loop
        controls
        preload="metadata"
        ${options.posterUrl ? `poster="${e(options.posterUrl)}"` : ""}
        src="${e(options.videoUrl)}"></video>`
    : options.posterUrl
      ? `<img src="${e(options.posterUrl)}" alt="${e(title)}" />`
      : `<div class="pending">This clip is still rendering.</div>`;

  // No login, no app-install interstitial, no cookie gate: the video is the
  // first element in the body and starts on its own.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>${e(title)} · Replay</title>
<meta name="description" content="${e(description)}" />
<link rel="canonical" href="${e(pageUrl)}" />
${meta.join("\n")}
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; background:#0b0f14; color:#e8eef5;
         font:15px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
  .stage { width:100%; background:#000; }
  video, img { display:block; width:100%; height:auto; max-height:78vh; object-fit:contain; background:#000; }
  .pending { padding:4rem 1rem; text-align:center; color:#8ba0b6; }
  .meta { padding:1rem 1.1rem 1.6rem; }
  h1 { margin:0 0 .3rem; font-size:1.15rem; font-weight:600; }
  p  { margin:0; color:#8ba0b6; font-size:.9rem; }
  .actions { display:flex; gap:.6rem; padding:0 1.1rem 2rem; }
  a.btn { flex:1; text-align:center; padding:.8rem 1rem; border-radius:.7rem;
          text-decoration:none; font-weight:600; }
  a.primary { background:#1fa463; color:#fff; }
  a.ghost { background:#182430; color:#cfe0f0; }
</style>
</head>
<body>
<div class="stage">${player}</div>
<div class="meta">
  <h1>${e(title)}</h1>
  <p>${e(description)}</p>
</div>
<div class="actions">
  ${options.videoUrl ? `<a class="btn primary" href="${e(options.videoUrl)}" download>Download</a>` : ""}
  <a class="btn ghost" href="${e(options.appUrl)}">Open in Replay</a>
</div>
</body>
</html>`;
}
