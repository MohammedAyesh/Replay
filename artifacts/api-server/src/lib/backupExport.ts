/**
 * Method B of the clip export: the backup renderer on vps1.
 *
 * Method A is this server's own pipeline (ffmpegExport.ts → Bunny Storage). It
 * runs on Replit, in this Node process, with Replit's FFmpeg and Replit's
 * Bunny Storage key. Method B shares none of that: it runs on vps1 (Contabo),
 * is written in Python, renders with its own crop implementation on Ubuntu's
 * FFmpeg, reads the source over the public HLS playlist, and keeps the MP4 on
 * vps1's disk, which the control API serves. The only thing the two have in
 * common is the recording on Bunny Stream, because that is the only place the
 * footage exists.
 *
 * A finished Method B export is recorded in `user_clips.exported_url` as
 * `vps1-export:<job>` — not a URL anyone can fetch, a reference only this
 * server can resolve (with the control key). Every reader of exported_url goes
 * through `fetchExportObject` so both kinds work everywhere.
 *
 * Why this exists: on 2026-09-29 five exports in a row failed because the
 * branding overlay returned 401 from Bunny Storage, and one failed dependency
 * inside Method A was enough to fail the whole export. See
 * claude/export-failover-two-independent-renderers-2026-09-29.md.
 */
import { logger } from "./logger";
import { BUNNY_STORAGE_API_KEY } from "./bunny";
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
  };
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
  // exported_url is only ever written by this server (Method A's upload), so
  // it is trusted the way the download route always trusted it: the storage
  // key goes with it. The control key never does.
  const headers: Record<string, string> = {};
  if (BUNNY_STORAGE_API_KEY) headers.AccessKey = BUNNY_STORAGE_API_KEY;
  if (opts.range) headers.Range = opts.range;
  return fetch(exportedUrl, { headers, signal: opts.signal });
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
