/**
 * Playback proxy for branding intro videos.
 *
 * Intros are uploaded to Bunny Storage, and BUNNY_STORAGE_CDN_URL on this
 * deployment points at storage.bunnycdn.com — an authenticated origin that
 * returns 401 without an AccessKey. Handing that URL to a <video> element
 * therefore gives the viewer a media error, and since clip playback runs the
 * intro before the clip, the result is a black player.
 *
 * So clients never receive the storage URL. They get a path on this server,
 * which resolves the intro itself and streams it back with the key attached.
 * The client passes a scope ("global" or an academy id), never a URL, so this
 * cannot be turned into an open redirector or an SSRF primitive.
 */
import { Router, type IRouter } from "express";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { eq } from "drizzle-orm";
import { db, academiesTable, clipSettingsTable } from "@workspace/db";
import {
  BUNNY_STORAGE_API_KEY,
  BUNNY_STORAGE_HOSTNAME,
} from "../lib/bunny";
import { logger } from "../lib/logger";

const router: IRouter = Router();

/** Path a client should use to play the intro that applies to a given clip. */
export function introPlaybackPath(academyId: number | null, hasIntro: boolean): string | null {
  if (!hasIntro) return null;
  return `/api/clip-intro/${academyId != null ? academyId : "global"}`;
}

async function resolveIntroUrl(scope: string): Promise<string | null> {
  if (scope !== "global") {
    const academyId = parseInt(scope, 10);
    if (!Number.isInteger(academyId) || academyId <= 0) return null;
    const [academy] = await db
      .select({ introVideoUrl: academiesTable.introVideoUrl })
      .from(academiesTable)
      .where(eq(academiesTable.id, academyId));
    if (academy?.introVideoUrl) return academy.introVideoUrl;
  }
  const [settings] = await db.select().from(clipSettingsTable).limit(1);
  return settings?.introVideoUrl ?? null;
}

/**
 * GET /clip-intro/:scope
 * :scope is "global" or an academy id. Deliberately not a URL.
 */
router.get("/clip-intro/:scope", async (req, res): Promise<void> => {
  const scope = String(req.params.scope ?? "");
  if (!/^(global|\d{1,10})$/.test(scope)) {
    res.status(400).json({ error: "Invalid intro scope" });
    return;
  }

  const introUrl = await resolveIntroUrl(scope);
  if (!introUrl) {
    res.status(404).json({ error: "No intro configured" });
    return;
  }

  let target: URL;
  try {
    target = new URL(introUrl);
  } catch {
    logger.warn({ scope, introUrl }, "Stored intro URL is not absolute");
    res.status(502).json({ error: "Intro is not playable" });
    return;
  }

  // The AccessKey goes only to the storage host, never to whatever else an
  // admin might have put in the field.
  const headers: Record<string, string> = {};
  if (
    BUNNY_STORAGE_API_KEY &&
    target.host.toLowerCase() === BUNNY_STORAGE_HOSTNAME.toLowerCase()
  ) {
    headers.AccessKey = BUNNY_STORAGE_API_KEY;
  }
  // Forward Range so the browser can seek and, on iOS, start playback at all.
  const range = req.headers.range;
  if (typeof range === "string") headers.Range = range;

  const abort = new AbortController();
  res.on("close", () => abort.abort());

  let upstream: Response;
  try {
    upstream = await fetch(target.toString(), {
      headers,
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15_000)]),
    });
  } catch (err) {
    if (!res.headersSent) res.status(502).json({ error: "Intro unavailable" });
    return;
  }

  if (!upstream.ok || !upstream.body) {
    res.status(upstream.status === 404 ? 404 : 502).json({ error: "Intro unavailable" });
    return;
  }

  res.status(upstream.status === 206 ? 206 : 200);
  res.setHeader("Content-Type", upstream.headers.get("content-type") ?? "video/mp4");
  res.setHeader("Accept-Ranges", "bytes");
  // Intros change rarely and are played before every clip.
  res.setHeader("Cache-Control", "public, max-age=3600");
  for (const h of ["content-length", "content-range"]) {
    const v = upstream.headers.get(h);
    if (v) res.setHeader(h, v);
  }

  const nodeStream = Readable.fromWeb(upstream.body as import("stream/web").ReadableStream<Uint8Array>);
  try {
    await pipeline(nodeStream, res);
  } catch (err) {
    if (!abort.signal.aborted) logger.warn({ err, scope }, "Error proxying clip intro");
    if (!res.headersSent) res.status(502).end();
  }
});

export default router;
