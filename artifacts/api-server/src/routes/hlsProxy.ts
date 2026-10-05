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
import { canViewBunnyVideo, extractBunnyVideoId } from "../lib/publicFootage";

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

async function isAuthorizedMediaRequest(req: Parameters<typeof canViewBunnyVideo>[0], raw: string): Promise<boolean> {
  const videoId = extractBunnyVideoId(raw);
  return Boolean(videoId && await canViewBunnyVideo(req, videoId));
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

const PROGRESSIVE_MP4_RANGE_BYTES = 4 * 1024 * 1024;
const MIN_PROGRESSIVE_MP4_RANGE_BYTES = 64 * 1024;
type ProgressiveMp4RangePolicy = { maxBytes: number };

type ParsedContentRange = { start: number; end: number; total: number };

function isProgressiveMp4Fallback(raw: string): boolean {
  try {
    return new URL(raw).pathname.toLowerCase().endsWith("/play_720p.mp4");
  } catch {
    return false;
  }
}

function parseContentRange(value: string | null): ParsedContentRange | null {
  const match = value?.trim().match(/^bytes\s+(\d+)-(\d+)\/(\d+)$/i);
  if (!match) return null;
  const [, rawStart, rawEnd, rawTotal] = match;
  const start = Number(rawStart);
  const end = Number(rawEnd);
  const total = Number(rawTotal);
  if (
    !Number.isSafeInteger(start)
    || !Number.isSafeInteger(end)
    || !Number.isSafeInteger(total)
    || start < 0
    || end < start
    || total <= end
  ) {
    return null;
  }
  return { start, end, total };
}

async function fetchProgressiveMp4Range(
  raw: string,
  hostname: string,
  start: number,
  total: number | null,
  signal: AbortSignal,
  rangePolicy: ProgressiveMp4RangePolicy,
): Promise<Response> {
  const remaining = total == null ? rangePolicy.maxBytes : total - start;
  let byteCount = Math.min(rangePolicy.maxBytes, Math.max(MIN_PROGRESSIVE_MP4_RANGE_BYTES, remaining));
  while (byteCount > 0) {
    const end = start + byteCount - 1;
    const response = await fetch(raw, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      headers: {
        Referer: `https://${hostname}/`,
        Range: `bytes=${start}-${end}`,
      },
    });
    if (response.status === 416) {
      try {
        await response.body?.cancel();
      } catch {
        // The upstream may already have closed the body.
      }
      return response;
    }
    if (response.status === 206) {
      rangePolicy.maxBytes = byteCount;
      return response;
    }

    try {
      await response.body?.cancel();
    } catch {
      // The upstream may already have closed the body after rejecting the range.
    }
    if (byteCount <= MIN_PROGRESSIVE_MP4_RANGE_BYTES) {
      throw new Error(`Bunny rejected a bounded ${byteCount}-byte range with HTTP ${response.status}`);
    }
    byteCount = Math.max(MIN_PROGRESSIVE_MP4_RANGE_BYTES, Math.floor(byteCount / 2));
  }
  throw new Error("Requested MP4 range starts beyond the resource length");
}

function streamProgressiveMp4(
  initialResponse: Response,
  initialRange: ParsedContentRange,
  raw: string,
  hostname: string,
  signal: AbortSignal,
  rangePolicy: ProgressiveMp4RangePolicy,
): Readable {
  return Readable.from((async function* () {
    let response = initialResponse;
    let range = initialRange;
    while (true) {
      if (
        response.status !== 206
        || !response.body
        || range.total !== initialRange.total
      ) {
        throw new Error("Bunny returned an invalid partial MP4 response");
      }
      const body = Readable.fromWeb(
        response.body as import("stream/web").ReadableStream<Uint8Array>,
      );
      for await (const chunk of body) yield chunk;

      const nextStart = range.end + 1;
      if (nextStart >= range.total) return;

      response = await fetchProgressiveMp4Range(
        raw,
        hostname,
        nextStart,
        range.total,
        signal,
        rangePolicy,
      );
      const nextRange = parseContentRange(response.headers.get("content-range"));
      if (!nextRange || nextRange.start !== nextStart || nextRange.total !== initialRange.total) {
        try {
          await response.body?.cancel();
        } catch {
          // The invalid response is not streamed to the browser.
        }
        throw new Error("Bunny returned an inconsistent Content-Range for the MP4 stream");
      }
      range = nextRange;
    }
  })());
}

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
  if (!await isAuthorizedMediaRequest(req, raw)) {
    res.status(404).send("Media not found");
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
 * Streams an HLS segment or MP4 fallback from Bunny CDN, preserving byte ranges
 * so native video elements can seek in progressive MP4 playback.
 */
router.get("/hls-proxy/segment", async (req, res): Promise<void> => {
  const raw = req.query.url as string | undefined;
  if (!raw || !isBunnyUrl(raw)) {
    res.status(400).send("Missing or disallowed url");
    return;
  }
  if (!await isAuthorizedMediaRequest(req, raw)) {
    res.status(404).send("Media not found");
    return;
  }

  // Abort upstream when the client goes away — a player that seeks aggressively
  // otherwise leaves a Bunny response body draining into a detached stream for
  // every segment it abandoned.
  const abort = new AbortController();
  res.on("close", () => abort.abort());

  try {
    const { hostname } = new URL(raw);
    const isProgressiveMp4 = isProgressiveMp4Fallback(raw);
    const range = req.header("range");
    const openEndedRange = range?.trim().match(/^bytes=(\d+)-$/i) ?? null;
    const progressiveMp4Request = isProgressiveMp4 && (!range || openEndedRange)
      ? {
          start: openEndedRange ? Number(openEndedRange[1]) : 0,
          clientRequestedRange: Boolean(range),
        }
      : null;
    if (
      progressiveMp4Request
      && (!Number.isSafeInteger(progressiveMp4Request.start) || progressiveMp4Request.start < 0)
    ) {
      res.set("Accept-Ranges", "bytes").status(416).send("Invalid byte range");
      return;
    }

    const requestHeaders: Record<string, string> = { Referer: `https://${hostname}/` };
    const ifRange = req.header("if-range");
    const progressiveMp4RangePolicy: ProgressiveMp4RangePolicy = {
      maxBytes: PROGRESSIVE_MP4_RANGE_BYTES,
    };
    let upstream: Response;
    if (progressiveMp4Request) {
      // Bunny rejects unbounded and missing Range requests for these large
      // files. Fetch bounded windows and stream them as one client response.
      upstream = await fetchProgressiveMp4Range(
        raw,
        hostname,
        progressiveMp4Request.start,
        null,
        abort.signal,
        progressiveMp4RangePolicy,
      );
    } else {
      if (range) requestHeaders.Range = range;
      if (ifRange) requestHeaders["If-Range"] = ifRange;
      upstream = await fetch(raw, {
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)]),
        headers: requestHeaders,
      });
    }
    // `upstream.ok && !upstream.body` used to send 200 with the literal string
    // "Segment unavailable" as the payload, which the player then tried to demux.
    if (!upstream.ok) {
      try {
        await upstream.body?.cancel();
      } catch {
        // The upstream error response is not forwarded as a stream.
      }
      if (isProgressiveMp4) {
        res.set("Accept-Ranges", "bytes");
        const contentRange = upstream.headers.get("content-range");
        if (contentRange) res.set("Content-Range", contentRange);
      }
      res.status(upstream.status).send("Segment unavailable");
      return;
    }
    if (!upstream.body) {
      res.status(502).send("Segment unavailable");
      return;
    }

    const ct = upstream.headers.get("content-type") ?? "video/mp2t";
    if (progressiveMp4Request) {
      const firstRange = parseContentRange(upstream.headers.get("content-range"));
      if (
        upstream.status !== 206
        || !firstRange
        || firstRange.start !== progressiveMp4Request.start
      ) {
        try {
          await upstream.body.cancel();
        } catch {
          // The malformed or ignored range response will not be forwarded.
        }
        res.set("Accept-Ranges", "bytes").status(502).send("Upstream returned an invalid MP4 range");
        return;
      }

      res.set("Content-Type", ct);
      res.set("Cache-Control", "public, max-age=300");
      res.set("Access-Control-Allow-Origin", "*");
      res.set("Accept-Ranges", "bytes");
      res.set("Content-Length", String(firstRange.total - firstRange.start));
      if (progressiveMp4Request.clientRequestedRange) {
        res.set("Content-Range", `bytes ${firstRange.start}-${firstRange.total - 1}/${firstRange.total}`);
        res.status(206);
      } else {
        res.removeHeader("Content-Range");
        res.status(200);
      }
      await pipeline(
        streamProgressiveMp4(
          upstream,
          firstRange,
          raw,
          hostname,
          abort.signal,
          progressiveMp4RangePolicy,
        ),
        res,
      );
      return;
    }

    if (isProgressiveMp4 && range && upstream.status !== 206) {
      try {
        await upstream.body.cancel();
      } catch {
        // Avoid forwarding the entire file if Bunny ignores a bounded range.
      }
      res.set("Accept-Ranges", "bytes").status(502).send("Upstream ignored the MP4 byte range");
      return;
    }

    res.set("Content-Type", ct);
    res.set("Cache-Control", "public, max-age=300");
    res.set("Access-Control-Allow-Origin", "*");
    for (const header of ["accept-ranges", "content-range", "content-length", "etag", "last-modified"] as const) {
      const value = upstream.headers.get(header);
      if (value) res.set(header, value);
    }
    if (isProgressiveMp4) res.set("Accept-Ranges", "bytes");
    res.status(upstream.status);

    const nodeStream = Readable.fromWeb(upstream.body as import("stream/web").ReadableStream<Uint8Array>);
    await pipeline(nodeStream, res);
  } catch (error) {
    if (!abort.signal.aborted) {
      req.log?.warn({ err: error }, "Bunny media proxy streaming failed");
    }
    if (!res.headersSent) res.status(503).send("Proxy error");
  }
});

export default router;
