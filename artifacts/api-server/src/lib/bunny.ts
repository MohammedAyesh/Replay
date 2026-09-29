import fs from "fs";
import crypto from "crypto";
import { Readable } from "stream";

export const BUNNY_CDN_HOSTNAME = process.env.BUNNY_CDN_HOSTNAME ?? "";
export const BUNNY_API_KEY = process.env.BUNNY_API_KEY ?? "";
export const BUNNY_LIBRARY_ID = process.env.BUNNY_LIBRARY_ID ?? "";

// Strip full URL prefix if user accidentally set the full endpoint URL instead of just the zone name
const _rawStorageZone = process.env.BUNNY_STORAGE_ZONE ?? "";
export const BUNNY_STORAGE_ZONE = _rawStorageZone.replace(/^https?:\/\/[^/]+\//, "").replace(/\/$/, "");
export const BUNNY_STORAGE_API_KEY = process.env.BUNNY_STORAGE_API_KEY ?? "";
export const BUNNY_STORAGE_CDN_URL = process.env.BUNNY_STORAGE_CDN_URL ?? "";
export const BUNNY_STORAGE_HOSTNAME = process.env.BUNNY_STORAGE_HOSTNAME ?? "storage.bunnycdn.com";

/** Videos with this title prefix are transient live clips, not library footage. */
export function isExcludedBunnyVideoTitle(title: string | null | undefined): boolean {
  return typeof title === "string" && title.toLowerCase().startsWith("liveclip_");
}

export function isBunnyVideoPlayable(video: {
  status?: number;
  availableResolutions?: string;
}): boolean {
  return video.status === undefined
    || video.status === 4
    || (video.status === 3
      && typeof video.availableResolutions === "string"
      && video.availableResolutions.trim().length > 0);
}

/**
 * Check whether a Stream source has finished processing and has at least one
 * playable rendition. A missing video is represented by
 * BunnyVideoNotFoundError; transport/API failures remain errors so callers do
 * not mistake a temporary Bunny outage for an expired source.
 */
export async function getBunnyVideoReadiness(videoId: string): Promise<{
  ready: boolean;
  status: number | null;
}> {
  const url = `https://video.bunnycdn.com/library/${BUNNY_LIBRARY_ID}/videos/${videoId}`;
  const response = await fetch(url, {
    headers: { AccessKey: BUNNY_API_KEY },
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status === 404) throw new BunnyVideoNotFoundError(videoId);
  if (!response.ok) {
    throw new Error(`Bunny API error ${response.status} checking video readiness for ${videoId}`);
  }
  const data = await response.json() as {
    status?: number;
    availableResolutions?: string;
  };
  const status = typeof data.status === "number" ? data.status : null;
  return {
    // An absent status is not proof that the video is playable. Require an
    // explicit finished status here, while keeping the existing helper's
    // backwards-compatible behavior for callers that lack a status field.
    ready: status === 4
      || (status === 3
        && typeof data.availableResolutions === "string"
        && data.availableResolutions.trim().length > 0),
    status,
  };
}

export function getBunnyPlaybackUrl(videoId: string): string {
  return `https://${BUNNY_CDN_HOSTNAME}/${videoId}/playlist.m3u8`;
}

export function getBunnyThumbnailUrl(videoId: string, time?: number | null): string {
  const base = `https://${BUNNY_CDN_HOSTNAME}/${videoId}/thumbnail.jpg`;
  return time != null ? `${base}?time=${Math.floor(time)}` : base;
}

/**
 * Playback URL routed through the server-side HLS proxy.
 * Bunny CDN blocks direct browser requests (403) unless the Referer matches
 * the CDN hostname — a constraint the browser cannot satisfy on its own.
 * The HLS proxy (/api/hls-proxy/manifest) adds the correct Referer and
 * rewrites every segment URL so the entire stream stays proxied.
 * Use this for any URL that will be handed to a browser <video> element.
 * Use getBunnyPlaybackUrl() (raw CDN URL) only for server-side FFmpeg calls.
 */
export function getBunnyProxiedPlaybackUrl(videoId: string): string {
  return `/api/hls-proxy/manifest?url=${encodeURIComponent(getBunnyPlaybackUrl(videoId))}`;
}

/**
 * Thumbnail URL routed through the server-side HLS proxy (segment endpoint).
 * Same Referer issue as HLS manifests — the segment proxy handles any Bunny
 * CDN URL, not just video segments, so thumbnails work through it too.
 * Use this for any URL that will be used as an <img src> in the browser.
 */
export function getBunnyProxiedThumbnailUrl(videoId: string, time?: number | null): string {
  return `/api/hls-proxy/segment?url=${encodeURIComponent(getBunnyThumbnailUrl(videoId, time))}`;
}

/**
 * Does this URL point at our Bunny Storage content, by either of the two names
 * it goes by?
 *
 * Storage objects are reachable two ways: the origin at BUNNY_STORAGE_HOSTNAME,
 * and the pull zone at BUNNY_STORAGE_CDN_URL — and everything we *write* returns
 * the pull-zone form, so that is the one that actually shows up in
 * `exportedUrl`, in an academy's `introVideoUrl`, and in a poster path.
 *
 * The check used to match only the origin hostname. That silently withheld the
 * AccessKey from every fetch of a rendered export or a branding intro, which is
 * exactly the set of URLs that has it. `/user-clips/:id/download` sends the key
 * to the pull zone and works, so the two paths disagreed about whether the zone
 * needs authenticating — this makes them agree, in the direction that works. If
 * the zone turns out to be public the extra header is inert; if it is not, this
 * is the difference between a poster and no poster.
 */
export function isBunnyStorageUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).host.toLowerCase();
  } catch {
    return false;
  }
  if (BUNNY_STORAGE_HOSTNAME && host === BUNNY_STORAGE_HOSTNAME.toLowerCase()) return true;
  if (!BUNNY_STORAGE_CDN_URL) return false;
  try {
    return host === new URL(BUNNY_STORAGE_CDN_URL).host.toLowerCase();
  } catch {
    return false;
  }
}

export function isBunnyConfigured(): boolean {
  return !!BUNNY_CDN_HOSTNAME && !!BUNNY_API_KEY && !!BUNNY_LIBRARY_ID;
}

export function isBunnyStorageConfigured(): boolean {
  return !!BUNNY_STORAGE_ZONE && !!BUNNY_STORAGE_API_KEY && !!BUNNY_STORAGE_CDN_URL;
}

export class BunnyVideoNotFoundError extends Error {
  constructor(videoId: string) {
    super(`Bunny video not found: ${videoId}`);
    this.name = "BunnyVideoNotFoundError";
  }
}
/**
 * Fetch video metadata from the Bunny Stream Management API.
 * Returns duration in seconds (from the `length` field).
 * This is reliable from server-to-server and doesn't depend on CDN access.
 */
export async function getBunnyVideoInfo(videoId: string): Promise<{
  duration: number;
  hasMP4Fallback: boolean;
  availableResolutions: string;
}> {
  const url = `https://video.bunnycdn.com/library/${BUNNY_LIBRARY_ID}/videos/${videoId}`;
  // Bounded: an API that accepts the connection and never answers used to hold
  // a render slot (and the clip) indefinitely.
  const response = await fetch(url, {
    headers: { AccessKey: BUNNY_API_KEY },
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status === 404) {
    throw new BunnyVideoNotFoundError(videoId);
  }
  if (!response.ok) {
    throw new Error(`Bunny API error ${response.status} fetching video info for ${videoId}`);
  }
  const data = await response.json() as {
    length?: number;
    hasMP4Fallback?: boolean;
    availableResolutions?: string;
  };
  const duration = typeof data.length === "number" ? data.length : 0;
  if (!isFinite(duration) || duration <= 0) {
    throw new Error(`Could not determine duration for video ${videoId}: length=${data.length}`);
  }
  return {
    duration,
    hasMP4Fallback: data.hasMP4Fallback === true,
    availableResolutions: typeof data.availableResolutions === "string"
      ? data.availableResolutions
      : "",
  };
}

/**
 * Returns a direct MP4 URL for a specific rendition folder.
 * The folder is taken from the matching HLS variant rather than inferred from
 * the variant's declared pixel dimensions.
 */
export function getBunnyDirectMp4Url(videoId: string, folder: string | number = "1080p"): string {
  const renditionFolder = typeof folder === "number" ? `${folder}p` : folder;
  if (!/^[^/]+p$/i.test(renditionFolder)) {
    throw new Error(`Invalid Bunny rendition folder for direct MP4: ${folder}`);
  }
  return `https://${BUNNY_CDN_HOSTNAME}/${videoId}/play_${renditionFolder}.mp4`;
}

/**
 * Storage path for a rendered clip export.
 *
 * The path carries an unguessable suffix derived from the clip id, because the
 * export bucket is served by a public pull zone: a bare `clips/<id>.mp4` can be
 * enumerated by counting upwards, which hands out every user's rendered clip
 * regardless of the ownership check on the download route.
 *
 * The suffix is an HMAC of the clip id keyed on CLIP_EXPORT_URL_SECRET (falling
 * back to the storage API key, which is always present wherever exports run) so
 * it is deterministic — no extra column, and re-deriving the URL for an existing
 * clip still works — but not derivable by a client.
 */
function exportPathToken(clipId: number): string {
  const secret = process.env.CLIP_EXPORT_URL_SECRET || BUNNY_STORAGE_API_KEY;
  return crypto
    .createHmac("sha256", secret)
    .update(`clip-export:${clipId}`)
    .digest("hex")
    .slice(0, 24);
}

/** Storage-zone-relative path for a rendered clip export. */
export function getBunnyExportPath(clipId: number, revision?: string): string {
  if (revision !== undefined && !/^[A-Za-z0-9_-]{1,80}$/.test(revision)) {
    throw new Error("Invalid clip export revision");
  }
  const suffix = revision ? `-${revision}` : "";
  return `clips/${clipId}-${exportPathToken(clipId)}${suffix}.mp4`;
}

/** Returns the public CDN URL for a rendered clip export. */
export function getBunnyExportUrl(clipId: number, revision?: string): string {
  const base = BUNNY_STORAGE_CDN_URL.replace(/\/$/, "");
  return `${base}/${getBunnyExportPath(clipId, revision)}`;
}

/** Extracts and validates the storage-zone-relative path for one clip export. */
export function getPortfolioClipStoragePath(clipId: number, exportedUrl: string): string | null {
  if (!isBunnyStorageUrl(exportedUrl)) return null;

  let storagePath: string;
  try {
    storagePath = new URL(exportedUrl).pathname.replace(/^\/+/, "");
  } catch {
    return null;
  }

  const zonePrefix = `${BUNNY_STORAGE_ZONE.replace(/^\/+|\/+$/g, "")}/`;
  if (zonePrefix !== "/" && storagePath.startsWith(zonePrefix)) {
    storagePath = storagePath.slice(zonePrefix.length);
  }

  const expectedPath = new RegExp(`^clips/${clipId}(?:-[A-Za-z0-9_-]+)?\\.mp4$`);
  return expectedPath.test(storagePath) ? storagePath : null;
}
/**
 * Upload a rendered MP4 to Bunny Storage and return its public CDN URL.
 * Requires BUNNY_STORAGE_ZONE, BUNNY_STORAGE_API_KEY, BUNNY_STORAGE_CDN_URL.
 *
 * The file is streamed, never read into memory: a CRF-16 export of a long
 * selection runs to hundreds of megabytes, and buffering two of those at once
 * is enough to OOM the API process on the 6-vCPU VPS.
 */
export async function uploadToBunnyStorage(
  filePath: string,
  clipId: number,
  revision?: string,
): Promise<string> {
  const uploadUrl = `https://${BUNNY_STORAGE_HOSTNAME}/${BUNNY_STORAGE_ZONE}/${getBunnyExportPath(clipId, revision)}`;
  const { size } = await fs.promises.stat(filePath);
  const fileStream = Readable.toWeb(fs.createReadStream(filePath)) as ReadableStream;

  const response = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      AccessKey: BUNNY_STORAGE_API_KEY,
      "Content-Type": "video/mp4",
      "Content-Length": String(size),
    },
    body: fileStream,
    // Required by undici whenever the request body is a stream.
    duplex: "half",
    // Generous (a long 1080p clip is hundreds of MB) but finite: a stalled
    // upload must end in the backup renderer, not in a clip stuck at Step 3/3.
    signal: AbortSignal.timeout(Math.max(10 * 60_000, Number(process.env.EXPORT_UPLOAD_TIMEOUT_MS) || 0)),
  } as RequestInit & { duplex: "half" });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Bunny Storage upload failed: ${response.status} ${response.statusText} — ${text}`,
    );
  }

  return getBunnyExportUrl(clipId, revision);
}

/**
 * Delete a rendered clip export from Bunny Storage. Best-effort.
 *
 * Deletes the legacy `clips/<id>.mp4` path as well as the current
 * HMAC-suffixed one: clips exported before the suffix existed still live at the
 * old, enumerable location, and that is exactly the path worth removing.
 */
export async function deleteBunnyExport(clipId: number): Promise<void> {
  const paths = [getBunnyExportPath(clipId), `clips/${clipId}.mp4`];
  await Promise.allSettled(
    paths.map((p) =>
      fetch(`https://${BUNNY_STORAGE_HOSTNAME}/${BUNNY_STORAGE_ZONE}/${p}`, {
        method: "DELETE",
        headers: { AccessKey: BUNNY_STORAGE_API_KEY },
      }),
    ),
  );
}

/**
 * Delete an arbitrary relative Bunny Storage object path.
 *
 * The path must be a clean object key rather than a URL or filesystem path.
 * Missing objects are already deleted; all other remote failures are surfaced
 * so account cleanup can log them without undoing the database transaction.
 */
export async function deleteBunnyStoragePath(path: string): Promise<void> {
  if (!isBunnyStorageConfigured()) {
    throw new Error("Bunny Storage is not configured");
  }

  const segments = path.split("/");
  if (
    !path
    || path.startsWith("/")
    || path.includes("\\")
    || segments.some((segment) => !segment || segment === "." || segment === ".." || !/^[A-Za-z0-9._-]+$/.test(segment))
  ) {
    throw new Error("Invalid Bunny Storage object path");
  }

  const encodedPath = segments.map(encodeURIComponent).join("/");
  const response = await fetch(
    `https://${BUNNY_STORAGE_HOSTNAME}/${BUNNY_STORAGE_ZONE}/${encodedPath}`,
    { method: "DELETE", headers: { AccessKey: BUNNY_STORAGE_API_KEY } },
  );
  if (!response.ok && response.status !== 404) {
    throw new Error(`Bunny Storage object deletion failed: ${response.status}`);
  }
}

/**
 * Remove all Bunny Storage derivatives owned by a user's clip.
 * The poster path is accepted only when it matches this clip's generated poster
 * namespace, so a database value can never be used to delete an arbitrary object.
 */
export async function deleteBunnyClipAssets(clipId: number, posterPath: string | null): Promise<void> {
  await deleteBunnyExport(clipId);
  if (!posterPath || !isBunnyStorageConfigured()) return;

  const safePosterPattern = new RegExp(`^posters/${clipId}-[a-zA-Z0-9_-]+\\.jpg$`);
  if (!safePosterPattern.test(posterPath)) return;

  const encodedPath = posterPath.split("/").map(encodeURIComponent).join("/");
  const response = await fetch(
    `https://${BUNNY_STORAGE_HOSTNAME}/${BUNNY_STORAGE_ZONE}/${encodedPath}`,
    { method: "DELETE", headers: { AccessKey: BUNNY_STORAGE_API_KEY } },
  );
  if (!response.ok && response.status !== 404) {
    throw new Error(`Bunny Storage poster deletion failed: ${response.status}`);
  }
}

/**
 * Upload a buffer to Bunny Storage at a given path and return its public CDN URL.
 */
export async function uploadBufferToBunnyStorage(
  buffer: Buffer,
  remotePath: string,
  contentType: string,
): Promise<string> {
  const uploadUrl = `https://${BUNNY_STORAGE_HOSTNAME}/${BUNNY_STORAGE_ZONE}/${remotePath}`;

  const response = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      AccessKey: BUNNY_STORAGE_API_KEY,
      "Content-Type": contentType,
    },
    body: buffer,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Bunny Storage upload failed: ${response.status} ${response.statusText} — ${text}`,
    );
  }

  const base = BUNNY_STORAGE_CDN_URL.replace(/\/$/, "");
  return `${base}/${remotePath}`;
}

/** Upload the single admin-selected clip intro video. */
export async function uploadClipIntroToBunnyStorage(
  buffer: Buffer,
  contentType: string,
): Promise<string> {
  const remotePath = "clip-intro/intro.mp4";
  const uploadUrl = `https://${BUNNY_STORAGE_HOSTNAME}/${BUNNY_STORAGE_ZONE}/${remotePath}`;
  const response = await fetch(uploadUrl, {
    method: "PUT",
    headers: { AccessKey: BUNNY_STORAGE_API_KEY, "Content-Type": contentType },
    body: buffer,
  });
  if (!response.ok) {
    throw new Error(`Bunny Storage upload failed: ${response.status}`);
  }
  return `${BUNNY_STORAGE_CDN_URL.replace(/\/$/, "")}/${remotePath}`;
}

/** Sign a single validated rendered-export URL with Bunny Advanced Token Authentication. */
export function signBunnyPortfolioUrl(
  baseUrl: string,
  objectPath: string,
  securityKey: string,
  expiresAt: number,
): string {
  if (!/^clips\/\d+(?:-[A-Za-z0-9_-]+)?\.mp4$/.test(objectPath)) {
    throw new Error("Invalid portfolio export path");
  }
  if (!securityKey || !Number.isSafeInteger(expiresAt)) {
    throw new Error("Invalid portfolio signing configuration");
  }

  const base = new URL(baseUrl);
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) {
    throw new Error("Portfolio CDN URL must be a plain HTTPS origin/path");
  }

  const basePath = base.pathname.replace(/\/+$/, "");
  const url = new URL(base.origin);
  url.pathname = `${basePath}/${objectPath}`;
  const signature = crypto
    .createHmac("sha256", securityKey)
    .update(`${url.pathname}${expiresAt}`)
    .digest("base64url");
  url.searchParams.set("token", `HS256-${signature}`);
  url.searchParams.set("expires", String(expiresAt));
  return url.toString();
}

/**
 * Returns a short-lived direct CDN URL for a rendered clip, when an isolated
 * portfolio Pull Zone and its Advanced Token Authentication key are configured.
 */
export function getBunnyPortfolioPlaybackUrl(
  clipId: number,
  exportedUrl: string,
): string | null {
  const cdnUrl = process.env.BUNNY_PORTFOLIO_CDN_URL?.trim();
  const securityKey = process.env.BUNNY_PORTFOLIO_CDN_TOKEN_KEY;
  const objectPath = getPortfolioClipStoragePath(clipId, exportedUrl);
  if (!cdnUrl || !securityKey || !objectPath) return null;

  return signBunnyPortfolioUrl(
    cdnUrl,
    objectPath,
    securityKey,
    Math.floor(Date.now() / 1000) + 300,
  );
}
