import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import type { Request, Response } from "express";
import type { AcademyCreativeProject } from "@workspace/db";
import { fetchExportObject } from "../backupExport";
import { BUNNY_STORAGE_ZONE, bunnyStorageUrlFor, deleteBunnyStoragePath, isBunnyStorageConfigured, uploadFileToBunnyStoragePath } from "../bunny";
import { logger } from "../logger";

export const CREATIVE_RENDER_VERSION_PATH = "camera4k-v1";

/**
 * Creative hub engine: where rendered PNGs and MP4s live.
 *
 * As the academy's ad videos and highlight reels: Bunny Storage, an
 * authenticated origin only this server can read, under
 * creative/<academyId>/<projectId>-<uuid>.<ext>. output_path holds the Storage
 * (origin) URL and the API streams it (…/projects/:id/output); the browser is
 * never handed a Storage URL. Without Storage (development) the file stays on
 * this machine and output_path is its absolute path. Publish (publishMedia.ts)
 * reads both forms.
 */

export function localOutputDir(): string {
  return process.env.CREATIVE_OUTPUT_DIR || path.join(os.tmpdir(), "replay-creative");
}

/** Keep the file; returns the output_path to store. The local file is moved or left for the caller to delete. */
export async function storeOutput(academyId: number, projectId: number, file: string, ext: "png" | "mp4"): Promise<string> {
  const name = `${projectId}-${randomUUID()}.${ext}`;
  if (isBunnyStorageConfigured()) {
    return uploadFileToBunnyStoragePath(file, `creative/${academyId}/${CREATIVE_RENDER_VERSION_PATH}/${name}`);
  }
  const dir = path.join(localOutputDir(), String(academyId), CREATIVE_RENDER_VERSION_PATH);
  await fs.promises.mkdir(dir, { recursive: true });
  const dest = path.join(dir, name);
  await fs.promises.copyFile(file, dest);
  return dest;
}

/** The Storage path (zone-relative) of a stored output, if it is one of ours for this academy. */
function storagePathOf(outputPath: string, academyId: number): string | null {
  try {
    const parts = new URL(outputPath).pathname.split("/").filter(Boolean);
    const rel = parts[0] === BUNNY_STORAGE_ZONE ? parts.slice(1).join("/") : null;
    return rel && rel.startsWith(`creative/${academyId}/`) ? rel : null;
  } catch {
    return null;
  }
}

const isLocal = (outputPath: string) => path.isAbsolute(outputPath) && path.resolve(outputPath).startsWith(path.resolve(localOutputDir()) + path.sep);

/** Best effort: a replaced output goes. */
export async function deleteOutput(outputPath: string | null, academyId: number): Promise<void> {
  if (!outputPath) return;
  try {
    if (isLocal(outputPath)) { await fs.promises.rm(outputPath, { force: true }); return; }
    const rel = storagePathOf(outputPath, academyId);
    if (rel) await deleteBunnyStoragePath(rel);
  } catch (err) {
    logger.warn({ err, academyId }, "Creative hub: deleting an old render failed");
  }
}

function attachmentName(row: AcademyCreativeProject): string {
  const base = (row.title || row.templateKey || "replay").replace(/[^a-z0-9_-]+/gi, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "replay";
  const ext = row.outputMime?.startsWith("video/") ? "mp4" : "png";
  return `${base}-${row.id}.${ext}`;
}

/** Stream a project's output: the right type, Range for video, ?download=1 as an attachment. */
export async function sendOutput(req: Request, res: Response, row: AcademyCreativeProject): Promise<void> {
  const outputPath = row.outputPath;
  if (!outputPath) { res.status(404).json({ error: "Nothing rendered yet" }); return; }
  const type = row.outputMime ?? (row.kind === "video" ? "video/mp4" : "image/png");
  const download = req.query.download === "1" || req.query.download === "true";
  res.setHeader("Cache-Control", "private, no-store");
  if (download) res.setHeader("Content-Disposition", `attachment; filename="${attachmentName(row)}"`);

  if (path.isAbsolute(outputPath)) {
    if (!isLocal(outputPath) || !fs.existsSync(outputPath)) { res.status(404).json({ error: "The rendered file is gone. Render it again." }); return; }
    // sendFile answers Range requests itself.
    res.sendFile(outputPath, { headers: { "Content-Type": type }, cacheControl: false }, (err) => {
      if (err && !res.headersSent) res.status(500).json({ error: "Couldn't send the file" });
    });
    return;
  }

  const url = /^https?:\/\//i.test(outputPath) ? outputPath : bunnyStorageUrlFor(outputPath.replace(/^\/+/, ""));
  const range = typeof req.headers.range === "string" ? req.headers.range : undefined;
  const abort = new AbortController();
  res.once("close", () => { if (!res.writableEnded) abort.abort(); });
  const upstream = await fetchExportObject(url, { range, signal: abort.signal }).catch(() => null);
  if (!upstream || (!upstream.ok && upstream.status !== 416) || !upstream.body) {
    await upstream?.body?.cancel().catch(() => {});
    res.status(upstream?.status === 404 ? 404 : 502).json({ error: upstream?.status === 404 ? "The rendered file is gone. Render it again." : "The file isn't reachable right now. Try again in a minute." });
    return;
  }
  res.status(upstream.status);
  res.setHeader("Content-Type", type);
  for (const header of ["content-length", "content-range", "accept-ranges"]) {
    const value = upstream.headers.get(header);
    if (value) res.setHeader(header, value);
  }
  if (!upstream.headers.get("accept-ranges")) res.setHeader("Accept-Ranges", "bytes");
  const stream = Readable.fromWeb(upstream.body as never);
  stream.on("error", (err) => {
    if (!abort.signal.aborted) logger.warn({ err, projectId: row.id }, "Creative hub: streaming an output failed");
    res.destroy();
  });
  stream.pipe(res);
}
