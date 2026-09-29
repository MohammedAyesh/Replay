/**
 * Fetch a branding asset (intro, overlay, end card) to a local temp file
 * BEFORE any FFmpeg process sees it.
 *
 * Until 2026-09-29 the overlay URL was handed straight to FFmpeg as a second
 * input of the main encode. When Bunny Storage answered 401 for it, FFmpeg
 * exited 8 and took the whole clip with it — five production exports in a row,
 * for a logo. Fetching here instead means:
 *
 *   - the failure is visible as an HTTP status in the log, not as FFmpeg stderr;
 *   - a missing asset is simply left out (the clip exports unbranded), because
 *     branding must never cost someone their clip;
 *   - FFmpeg only ever reads local files for branding, so there is no network
 *     step inside the encode that can fail it.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { logger } from "./logger";
import { BUNNY_STORAGE_API_KEY, isBunnyStorageUrl } from "./bunny";

const MAX_ASSET_BYTES = 200 * 1024 * 1024;

function extensionFor(url: string, fallback: string): string {
  try {
    const ext = path.extname(new URL(url).pathname).toLowerCase();
    return /^\.[a-z0-9]{1,5}$/.test(ext) ? ext : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Download `url` to a temp file. Returns the local path, or null when the
 * asset cannot be used — never throws. A local path is returned unchanged if it
 * exists (tests, and any future local asset).
 */
export async function fetchBrandingAsset(
  url: string | undefined | null,
  what: string,
  opts: { referer?: string; timeoutMs?: number } = {},
): Promise<string | null> {
  if (!url) return null;
  if (!/^https?:\/\//i.test(url)) {
    return fs.existsSync(url) ? url : null;
  }
  const dest = path.join(os.tmpdir(), `soccerwatch-asset-${randomUUID()}${extensionFor(url, ".bin")}`);
  const headers: Record<string, string> = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  };
  if (opts.referer) headers.Referer = opts.referer;
  if (isBunnyStorageUrl(url) && BUNNY_STORAGE_API_KEY) headers.AccessKey = BUNNY_STORAGE_API_KEY;
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000) });
    if (!res.ok || !res.body) {
      logger.error(
        { what, status: res.status, host: new URL(url).host, sentAccessKey: !!headers.AccessKey },
        `Branding ${what} unavailable (HTTP ${res.status}) — exporting without it`,
      );
      await res.body?.cancel().catch(() => {});
      return null;
    }
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > MAX_ASSET_BYTES) {
      logger.error({ what, declared }, `Branding ${what} is too large — exporting without it`);
      await res.body.cancel().catch(() => {});
      return null;
    }
    await pipeline(Readable.fromWeb(res.body as import("stream/web").ReadableStream<Uint8Array>), fs.createWriteStream(dest));
    if (fs.statSync(dest).size === 0) {
      fs.unlink(dest, () => {});
      logger.error({ what }, `Branding ${what} is empty — exporting without it`);
      return null;
    }
    return dest;
  } catch (err) {
    fs.unlink(dest, () => {});
    logger.error({ err, what }, `Branding ${what} could not be fetched — exporting without it`);
    return null;
  }
}
