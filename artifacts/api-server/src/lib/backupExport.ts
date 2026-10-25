/**
 * Method B of the clip export: the backup renderer on vps1.
 *
 * Method A is this server's own pipeline (ffmpegExport.ts → Bunny Storage). It
 * runs on Replit, in this Node process, with Replit's FFmpeg and Replit's
 * Bunny Storage key. Method B shares none of that: it runs on vps1 (Contabo),
 * is written in Python and renders with its own crop implementation on
 * Ubuntu's FFmpeg. It serves the local MP4 while working and can expose its
 * verified Bunny Storage copy after upload.
 *
 * A finished Method B export is recorded in `user_clips.exported_url` as
 * `vps1-export:<job>` — not a URL anyone can fetch, a reference only this
 * server can resolve (with the control key). Once the storage copy is reported,
 * the reference is upgraded to its Bunny URL; both formats remain readable
 * during migration through `fetchExportObject`.
 *
 * Why this exists: on 2026-09-29 five exports in a row failed because the
 * branding overlay returned 401 from Bunny Storage, and one failed dependency
 * inside Method A was enough to fail the whole export. See
 * claude/export-failover-two-independent-renderers-2026-09-29.md.
 */
import { logger } from "./logger";
import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";
import {
  BUNNY_STORAGE_API_KEY,
  BUNNY_STORAGE_HOSTNAME,
  BUNNY_STORAGE_ZONE,
  isBunnyStorageUrl,
} from "./bunny";
import type { Response as ExpressResponse } from "express";

export const BACKUP_EXPORT_PREFIX = "vps1-export:";
export const CHUNKED_EXPORT_LENGTH_THRESHOLD_BYTES = 30 * 1024 * 1024;

/**
 * Forward an upstream length unless a full, non-range export is large enough
 * to exceed the platform's fixed-length HTTP response limit. Leaving the
 * outgoing length unset lets Node stream the body with chunked encoding.
 */
export function forwardExportContentLength(
  res: Pick<ExpressResponse, "setHeader" | "removeHeader">,
  upstream: Response,
  rangeRequested: boolean,
): void {
  const contentLength = upstream.headers.get("content-length");
  if (!contentLength) return;

  const bytes = Number(contentLength);
  if (
    !rangeRequested
    && upstream.status === 200
    && Number.isFinite(bytes)
    && bytes > CHUNKED_EXPORT_LENGTH_THRESHOLD_BYTES
  ) {
    res.removeHeader("Content-Length");
    return;
  }

  res.setHeader("Content-Length", contentLength);
}

const JOB_RE = /^c\d{1,12}-[0-9a-f]{16}$/;

export type BackupExportStatus = {
  job: string;
  clipId: number;
  status: "queued" | "fetching" | "encoding" | "ready" | "failed";
  stage: string | null;
  progress: number;
  error: string | null;
  /** "source_gone" | "permanent" | "transient" | "disk" | "lost" */
  errorKind: string | null;
  running: boolean;
  output: { bytes: number; duration: number; width: number; height: number } | null;
  /** Bunny Storage copy, when vps1 has verified and published one. */
  storageUrl?: string | null;
};

export type BackupExportSpec = {
  clipId: number;
  videoId: string;
  /** Fractions of the recording, exactly as stored on the clip. */
  startTime: number;
  endTime: number;
  cropPath: unknown[];
  aspectRatio: string;
  title: string;
  overlayUrl?: string | null;
  /** Makes an intentional re-clip a distinct, permanent vps1 export object. */
  exportRevision?: string;
  /**
   * The drawn end screen (Admin → Branding): a card video in Bunny Storage plus
   * its timing. vps1 composites it like an export here; older vps1 code ignores it.
   */
  endScreen?: { cardUrl: string; seconds: number; blur: number; dim: number; kind: string } | null;
};

function controlBase(): string {
  let url = process.env.CONTABO_CONTROL_URL?.trim() ?? "";
  if (url && !/^https?:\/\//i.test(url)) url = `http://${url}`;
  return url.replace(/\/+$/, "");
}

function controlKey(): string {
  return process.env.CONTABO_CONTROL_KEY ?? "";
}

export function isBackupExportConfigured(): boolean {
  if (process.env.BACKUP_EXPORT_DISABLED === "1") return false;
  return !!controlBase() && !!controlKey();
}

export function isBackupExportRef(exportedUrl: unknown): boolean {
  return typeof exportedUrl === "string" && exportedUrl.startsWith(BACKUP_EXPORT_PREFIX);
}

export function backupExportRef(job: string): string {
  return `${BACKUP_EXPORT_PREFIX}${job}`;
}

export function backupJobFromRef(exportedUrl: string): string | null {
  if (!isBackupExportRef(exportedUrl)) return null;
  const job = String(exportedUrl).slice(BACKUP_EXPORT_PREFIX.length);
  return JOB_RE.test(job) ? job : null;
}

async function control(
  path: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  const { timeoutMs = 15_000, ...rest } = init;
  return fetch(`${controlBase()}${path}`, {
    ...rest,
    headers: {
      "Content-Type": "application/json",
      "X-Api-Key": controlKey(),
      ...((rest.headers as Record<string, string>) ?? {}),
    },
    signal: rest.signal ?? AbortSignal.timeout(timeoutMs),
  });
}

function parseStatus(body: unknown): BackupExportStatus | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (typeof b.job !== "string" || !JOB_RE.test(b.job)) return null;
  const status = String(b.status ?? "");
  if (!["queued", "fetching", "encoding", "ready", "failed"].includes(status)) return null;
  return {
    job: b.job,
    clipId: Number(b.clipId),
    status: status as BackupExportStatus["status"],
    stage: typeof b.stage === "string" ? b.stage : null,
    progress: Number.isFinite(Number(b.progress)) ? Number(b.progress) : 0,
    error: typeof b.error === "string" ? b.error : null,
    errorKind: typeof b.errorKind === "string" ? b.errorKind : null,
    running: b.running === true,
    output: b.output && typeof b.output === "object"
      ? (b.output as BackupExportStatus["output"])
      : null,
    storageUrl: typeof b.storageUrl === "string" ? b.storageUrl : null,
  };
}

/**
 * Accept a vps1 storage URL only when it points at this job's expected object
 * in the configured zone. The old vps1 reference remains the serving path if
 * the control service returns an unexpected URL or an older status response.
 */
export function validatedBackupStorageUrl(status: BackupExportStatus): string | null {
  const candidate = status.storageUrl?.trim();
  if (!candidate || !isBunnyStorageUrl(candidate)) return null;

  try {
    const url = new URL(candidate);
    if (url.protocol !== "https:" || url.search || url.hash) return null;
    const zone = BUNNY_STORAGE_ZONE.replace(/^\/+|\/+$/g, "");
    const pathname = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    const expectedPath = `${zone}/clips/${status.job}.mp4`;
    if (
      !Number.isInteger(status.clipId)
      || status.clipId <= 0
      || !status.job.startsWith(`c${status.clipId}-`)
      || pathname !== expectedPath
    ) {
      return null;
    }
    return candidate;
  } catch {
    return null;
  }
}

/**
 * Submit (or look up) the Method B job for a clip. Idempotent on the vps1 side:
 * the job id is derived from the clip id and its render parameters, so calling
 * this again returns the same job — whether it is queued, rendering, ready or
 * failed. `retry: true` relaunches a failed job.
 */
export async function submitBackupExport(
  spec: BackupExportSpec,
  opts: { retry?: boolean } = {},
): Promise<BackupExportStatus> {
  if (!isBackupExportConfigured()) throw new Error("Backup export is not configured");
  const res = await control("/export/clip", {
    method: "POST",
    body: JSON.stringify({ ...spec, retry: opts.retry === true }),
    timeoutMs: 20_000,
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`Backup export submit failed: HTTP ${res.status} ${JSON.stringify(body)?.slice(0, 200)}`);
  }
  const parsed = parseStatus(body);
  if (!parsed) throw new Error(`Backup export submit returned an unreadable body: ${JSON.stringify(body)?.slice(0, 200)}`);
  return parsed;
}

export async function getBackupExportStatus(job: string): Promise<BackupExportStatus | null> {
  if (!JOB_RE.test(job)) return null;
  const res = await control(`/export/clip/${job}`, { timeoutMs: 10_000 });
  if (res.status === 404) return null;
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`Backup export status failed: HTTP ${res.status}`);
  return parseStatus(body);
}

/**
 * Open the bytes of a finished export, whichever method produced it.
 *
 * Returns the upstream Response untouched (status, Content-Length,
 * Content-Range) so callers keep streaming it exactly as before. Never throws
 * for an HTTP error; throws only when the upstream cannot be reached.
 */
export async function fetchExportObject(
  exportedUrl: string,
  opts: { range?: string; signal?: AbortSignal } = {},
): Promise<Response> {
  const job = backupJobFromRef(exportedUrl);
  if (job) {
    return control(`/export/clip/${job}/file`, {
      headers: opts.range ? { Range: opts.range } : {},
      signal: opts.signal ?? AbortSignal.timeout(10 * 60_000),
    });
  }
  // A loopback server is an allowed Storage stand-in in tests; never send the
  // production AccessKey to an arbitrary remote URL from a database row.
  let localTestStorage = false;
  if (process.env.NODE_ENV === "test") {
    try {
      const host = new URL(exportedUrl).hostname;
      localTestStorage = host === "localhost" || host === "127.0.0.1" || host === "::1";
    } catch {
      localTestStorage = false;
    }
  }
  const trustedStorage = isBunnyStorageUrl(exportedUrl) || localTestStorage;
  if (!trustedStorage) {
    return fetch(exportedUrl, { headers: opts.range ? { Range: opts.range } : {}, signal: opts.signal });
  }
  const headers: Record<string, string> = {};
  if (BUNNY_STORAGE_API_KEY) headers.AccessKey = BUNNY_STORAGE_API_KEY;
  if (opts.range) headers.Range = opts.range;
  const mockedFetch = globalThis.fetch as typeof fetch & { mock?: unknown };
  if (process.env.NODE_ENV === "test" && mockedFetch.mock) {
    return mockedFetch(exportedUrl, { headers, signal: opts.signal });
  }
  const target = new URL(exportedUrl);
  const transport = target.protocol === "https:" ? https : target.protocol === "http:" ? http : null;
  if (!transport) throw new Error("Export URL must use HTTP or HTTPS");
  return new Promise<Response>((resolve, reject) => {
    let upstreamResponse: http.IncomingMessage | null = null;
    const request = transport.request(target, { method: "GET", headers, signal: opts.signal }, (upstream) => {
      upstreamResponse = upstream;
      upstream.once("close", () => opts.signal?.removeEventListener("abort", destroyOnAbort));
      const responseHeaders = new Headers();
      for (const [name, value] of Object.entries(upstream.headers)) {
        if (value != null) responseHeaders.set(name, Array.isArray(value) ? value.join(", ") : String(value));
      }
      const status = upstream.statusCode ?? 502;
      const body = status === 204 || status === 304 ? null : Readable.toWeb(upstream);
      resolve(new Response(body, { status, headers: responseHeaders }));
    });
    const destroyOnAbort = () => {
      upstreamResponse?.destroy();
      request.destroy(new Error("Export fetch aborted"));
    };
    opts.signal?.addEventListener("abort", destroyOnAbort, { once: true });
    request.once("error", reject);
    request.end();
  });
}

export type ExportProbe = {
  state: "exists" | "missing" | "unverified";
  bytes: number | null;
  url: string;
};

/**
 * How long one probe request may take. Probes run in front of export-status,
 * /download and /playback, so a hung vps1 must turn into "unverified" in
 * seconds, not after fetchExportObject's ten-minute download budget.
 */
export const EXPORT_PROBE_TIMEOUT_MS = 12_000;

/** Verify an existing export without downloading its body. 404 is definitive;
 * auth errors, outages, and missing credentials are deliberately unverified. */
export async function probeExportObject(
  exportedUrl: string,
  options: { fetcher?: typeof fetch; storageApiKey?: string; probeTimeoutMs?: number } = {},
): Promise<ExportProbe> {
  const fetcher = options.fetcher ?? fetch;
  const storageKey = options.storageApiKey ?? BUNNY_STORAGE_API_KEY;
  const probeTimeoutMs = options.probeTimeoutMs ?? EXPORT_PROBE_TIMEOUT_MS;
  const inspect = async (url: string): Promise<ExportProbe> => {
    if (isBunnyStorageUrl(url) && !storageKey) {
      return { state: "unverified", bytes: null, url };
    }
    try {
      const headers: Record<string, string> = { Range: "bytes=0-0" };
      if (isBunnyStorageUrl(url) && storageKey) headers.AccessKey = storageKey;
      const res = await fetcher(url, { headers, signal: AbortSignal.timeout(probeTimeoutMs) });
      const range = res.headers.get("content-range")?.match(/\/(\d+)$/);
      const length = res.headers.get("content-length");
      const bytes = range ? Number(range[1]) : length && res.status === 200 ? Number(length) : null;
      await res.body?.cancel().catch(() => {});
      if (res.status === 200 || res.status === 206) return { state: "exists", bytes, url };
      if (res.status === 404) return { state: "missing", bytes: null, url };
      return { state: "unverified", bytes: null, url };
    } catch {
      return { state: "unverified", bytes: null, url };
    }
  };

  const job = backupJobFromRef(exportedUrl);
  if (!job) return inspect(exportedUrl);

  // Prefer the permanent Storage object, even if an older vps1 status response
  // omitted storageUrl. The object path is deterministic from the validated job.
  let storageUrl: string | null = null;
  try {
    const status = await getBackupExportStatus(job);
    if (status?.status === "ready") storageUrl = validatedBackupStorageUrl(status);
  } catch {
    // The deterministic object path can still be checked during a control API outage.
  }
  if (!storageUrl && BUNNY_STORAGE_ZONE) {
    storageUrl = `https://${BUNNY_STORAGE_HOSTNAME}/${BUNNY_STORAGE_ZONE}/clips/${job}.mp4`;
  }

  const storageResult = storageUrl ? await inspect(storageUrl) : { state: "missing" as const, bytes: null, url: exportedUrl };
  if (storageResult.state === "exists") return storageResult;

  // The vps1 endpoint remains a valid serving path while Storage is unavailable
  // or before its copy finishes. It must be verified separately before expiry.
  try {
    const res = await fetchExportObject(exportedUrl, {
      range: "bytes=0-0",
      signal: AbortSignal.timeout(probeTimeoutMs),
    });
    const range = res.headers.get("content-range")?.match(/\/(\d+)$/);
    const length = res.headers.get("content-length");
    const bytes = range ? Number(range[1]) : length && res.status === 200 ? Number(length) : null;
    await res.body?.cancel().catch(() => {});
    if (res.status === 200 || res.status === 206) return { state: "exists", bytes, url: exportedUrl };
    if (res.status === 404 && storageResult.state === "missing") return { state: "missing", bytes: null, url: exportedUrl };
  } catch {
    // Keep the Storage result below; a failed backup request is not a 404.
  }
  return { state: "unverified", bytes: null, url: exportedUrl };
}

/**
 * Whether a finished export can still be served. Used right before handing the
 * file to a user, so a deleted object turns into a re-render instead of a
 * broken download. Cheap: a one-byte range request.
 */
export async function isExportReachable(exportedUrl: string): Promise<boolean> {
  try {
    const res = await fetchExportObject(exportedUrl, { range: "bytes=0-0", signal: AbortSignal.timeout(15_000) });
    await res.body?.cancel().catch(() => {});
    return res.status === 200 || res.status === 206;
  } catch (err) {
    logger.warn({ err, exportedUrl: isBackupExportRef(exportedUrl) ? exportedUrl : "[storage]" }, "Export reachability check failed");
    return false;
  }
}
