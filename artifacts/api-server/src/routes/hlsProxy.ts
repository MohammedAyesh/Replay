/**
 * GET /api/hls-proxy/manifest?url=<encoded>
 * GET /api/hls-proxy/segment?url=<encoded>
 *
 * Server-side proxy for Bunny Stream HLS so the browser never hits the CDN
 * directly. This keeps the canvas un-tainted during client-side clip export,
 * regardless of whether the production domain is whitelisted in Bunny CORS.
 *
 * Security: only Bunny CDN hostnames (*.b-cdn.net and video.bunnycdn.com)
 * are forwarded — arbitrary URL proxying is rejected with 400.
 */
import { Router, type IRouter } from "express";
import { Readable } from "stream";
import { pipeline } from "stream/promises";

const router: IRouter = Router();

const ALLOWED_HOSTNAME_RE = /^[a-zA-Z0-9-]+\.b-cdn\.net$|^video\.bunnycdn\.com$/;

function isBunnyUrl(raw: string): boolean {
  try {
    const { hostname } = new URL(raw);
    return ALLOWED_HOSTNAME_RE.test(hostname);
  } catch {
    return false;
  }
}

/**
 * Upstream timeout for a MANIFEST fetch.
 *
 * Was 10 s, which a media playlist for a long recording lands right on top of
 * in slower environments. Measured 2026-09-06 for the same 54 KB playlist:
 *
 *   vps1 -> Bunny, curl                 0.20 s
 *   replayjo.com  (deployed)            1.06 s
 *   kirk.replit.dev preview             7.6 s ... and sometimes past 10 s
 *
 * When it goes past, the fetch aborts, this route answers 503, hls.js retries
 * up to five times, and each retry starts another slow upstream fetch — so the
 * failure feeds itself and the player never gets a fragment. The symptom is a
 * completely black video with no error text, because ClaimStage's decode
 * watchdog only armed once a fragment had buffered.
 *
 * A segment fetch keeps its own, longer budget; this is only the playlist.
 */
const MANIFEST_TIMEOUT_MS = Number(process.env.HLS_PROXY_MANIFEST_TIMEOUT_MS ?? 30_000);

/**
 * Rewritten-manifest cache.
 *
 * A VOD playlist is immutable, and the rewrite is not cheap: every segment
 * line becomes `/api/hls-proxy/segment?url=<fully encoded absolute URL>`, which
 * turned a 54 KB upstream playlist into 264 KB. Doing that again for every
 * hls.js retry, every seek that reloads the level, and every viewer is pure
 * waste on exactly the environments where it is already slow.
 *
 * ONLY VOD is cached. A live playlist changes every few seconds, so caching it
 * would freeze the stream — entries are stored only when the response is
 * explicitly finished (`#EXT-X-ENDLIST`) or declared VOD.
 */
const MANIFEST_CACHE_TTL_MS = 5 * 60_000;
const MANIFEST_CACHE_MAX = 64;
const manifestCache = new Map<string, { body: string; expires: number }>();

function cachedManifest(key: string): string | null {
  const hit = manifestCache.get(key);
  if (!hit) return null;
  if (hit.expires < Date.now()) {
    manifestCache.delete(key);
    return null;
  }
  // Refresh recency for the crude LRU below.
  manifestCache.delete(key);
  manifestCache.set(key, hit);
  return hit.body;
}

function cacheManifest(key: string, body: string): void {
  if (!/#EXT-X-ENDLIST/.test(body) && !/#EXT-X-PLAYLIST-TYPE:\s*VOD/i.test(body)) return;
  manifestCache.set(key, { body, expires: Date.now() + MANIFEST_CACHE_TTL_MS });
  while (manifestCache.size > MANIFEST_CACHE_MAX) {
    const oldest = manifestCache.keys().next().value;
    if (oldest === undefined) break;
    manifestCache.delete(oldest);
  }
}

/**
 * GET /api/hls-proxy/manifest?url=<encoded>
 * Fetches the HLS manifest and rewrites all segment/sub-manifest URLs so they
 * also route through this proxy.
 */
router.get("/hls-proxy/manifest", async (req, res): Promise<void> => {
  const raw = req.query.url as string | undefined;
  if (!raw || !isBunnyUrl(raw)) {
    res.status(400).send("Missing or disallowed url");
    return;
  }

  const cached = cachedManifest(raw);
  if (cached !== null) {
    res.set("Content-Type", "application/vnd.apple.mpegurl");
    res.set("Cache-Control", "no-store");
    res.set("Access-Control-Allow-Origin", "*");
    res.send(cached);
    return;
  }

  try {
    const { hostname } = new URL(raw);
    const upstream = await fetch(raw, {
      signal: AbortSignal.timeout(MANIFEST_TIMEOUT_MS),
      headers: { Referer: `https://${hostname}/` },
    });
    if (!upstream.ok) {
      res.status(upstream.status).send("Upstream error");
      return;
    }

    const text = await upstream.text();
    const base = new URL(raw);

    // Rewrite every non-comment, non-empty line that looks like a URL or a
    // relative path so it is fetched via this proxy instead of directly.
    const rewritten = text
      .split("\n")
      .map((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) return line;

        let absolute: string;
        try {
          absolute = new URL(trimmed).href; // already absolute
        } catch {
          absolute = new URL(trimmed, base).href; // resolve relative to manifest
        }

        if (!isBunnyUrl(absolute)) return line; // don't proxy unknown hosts

        if (absolute.endsWith(".m3u8") || absolute.includes(".m3u8?")) {
          return `/api/hls-proxy/manifest?url=${encodeURIComponent(absolute)}`;
        }
        return `/api/hls-proxy/segment?url=${encodeURIComponent(absolute)}`;
      })
      .join("\n");

    cacheManifest(raw, rewritten);
    res.set("Content-Type", "application/vnd.apple.mpegurl");
    res.set("Cache-Control", "no-store");
    res.set("Access-Control-Allow-Origin", "*");
    res.send(rewritten);
  } catch (error) {
    // This used to swallow the reason entirely, so a timeout and a DNS failure
    // were indistinguishable in the logs and invisible to the client.
    const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    console.error("[hls-proxy] manifest fetch failed", { url: raw, reason });
    res.status(504).send(`Upstream manifest fetch failed (${reason})`);
  }
});

/**
 * GET /api/hls-proxy/segment?url=<encoded>
 * Streams a single .ts or .m4s segment from Bunny CDN.
 */
router.get("/hls-proxy/segment", async (req, res): Promise<void> => {
  const raw = req.query.url as string | undefined;
  if (!raw || !isBunnyUrl(raw)) {
    res.status(400).send("Missing or disallowed url");
    return;
  }

  // Abort upstream when the client goes away — a player that seeks aggressively
  // otherwise leaves a Bunny response body draining into a detached stream for
  // every segment it abandoned.
  const abort = new AbortController();
  res.on("close", () => abort.abort());

  try {
    const { hostname } = new URL(raw);
    const upstream = await fetch(raw, {
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)]),
      headers: { Referer: `https://${hostname}/` },
    });
    // `upstream.ok && !upstream.body` used to send 200 with the literal string
    // "Segment unavailable" as the payload, which the player then tried to demux.
    if (!upstream.ok) {
      res.status(upstream.status).send("Segment unavailable");
      return;
    }
    if (!upstream.body) {
      res.status(502).send("Segment unavailable");
      return;
    }

    const ct = upstream.headers.get("content-type") ?? "video/mp2t";
    res.set("Content-Type", ct);
    res.set("Cache-Control", "public, max-age=300");
    res.set("Access-Control-Allow-Origin", "*");

    const cl = upstream.headers.get("content-length");
    if (cl) res.set("Content-Length", cl);

    const nodeStream = Readable.fromWeb(upstream.body as import("stream/web").ReadableStream<Uint8Array>);
    await pipeline(nodeStream, res);
  } catch {
    if (!res.headersSent) res.status(503).send("Proxy error");
  }
});

export default router;
