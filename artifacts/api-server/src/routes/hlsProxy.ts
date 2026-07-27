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

  try {
    const upstream = await fetch(raw, { signal: AbortSignal.timeout(10_000) });
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

    res.set("Content-Type", "application/vnd.apple.mpegurl");
    res.set("Cache-Control", "no-store");
    res.set("Access-Control-Allow-Origin", "*");
    res.send(rewritten);
  } catch {
    res.status(503).send("Proxy error");
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

  try {
    const upstream = await fetch(raw, { signal: AbortSignal.timeout(30_000) });
    if (!upstream.ok || !upstream.body) {
      res.status(upstream.status).send("Segment unavailable");
      return;
    }

    const ct = upstream.headers.get("content-type") ?? "video/mp2t";
    res.set("Content-Type", ct);
    res.set("Cache-Control", "public, max-age=300");
    res.set("Access-Control-Allow-Origin", "*");

    const cl = upstream.headers.get("content-length");
    if (cl) res.set("Content-Length", cl);

    const { Readable } = await import("stream");
    const nodeStream = Readable.fromWeb(upstream.body as import("stream/web").ReadableStream<Uint8Array>);
    nodeStream.pipe(res);
    nodeStream.on("error", () => {
      if (!res.headersSent) res.status(500).send("Stream error");
    });
  } catch {
    res.status(503).send("Proxy error");
  }
});

export default router;
