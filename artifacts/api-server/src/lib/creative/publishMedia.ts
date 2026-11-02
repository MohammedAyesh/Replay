import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { and, eq } from "drizzle-orm";
import { academyAdMediaTable, db, type AcademyAdMedia, type AcademyCreativeProject } from "@workspace/db";
import { fetchExportObject } from "../backupExport";
import { bunnyStorageUrlFor } from "../bunny";
import { logger } from "../logger";
import { metaConfig } from "../meta/config";
import { connectionToken, getConnection } from "../meta/connections";
import { MAX_IMAGE_BYTES, MAX_VIDEO_SECONDS, preloadVideo, probeVideo, storeVideo, videoStill } from "../meta/media";
import { mediaIdForRender, readTargets } from "./publish";

/**
 * Creative hub → Publish: the rendered file as an item of the academy's media
 * library (academy_ad_media). Instagram, Facebook and ads all publish from that
 * library through signed public links, and WhatsApp sends one of those links,
 * so one copy per render serves every channel.
 */

export class PublishMediaError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

/**
 * Where the render engine left the file. project.output_path is a Storage
 * path served through the API: a full Storage/export URL, a zone-relative
 * Storage path, or (local renders) an absolute path on this machine.
 */
async function openOutput(outputPath: string): Promise<Readable> {
  if (path.isAbsolute(outputPath) && fs.existsSync(outputPath)) return fs.createReadStream(outputPath);
  const url = /^https?:\/\//i.test(outputPath) || outputPath.startsWith("vps1-export:")
    ? outputPath
    : bunnyStorageUrlFor(outputPath.replace(/^\/+/, ""));
  const response = await fetchExportObject(url);
  if (!response.ok || !response.body) throw new PublishMediaError(`Couldn't read the rendered file (${response.status}). Render it again.`, 502);
  return Readable.fromWeb(response.body as never);
}

async function outputToTemp(outputPath: string, suffix: string): Promise<string> {
  const file = path.join(os.tmpdir(), `creative-publish-${randomUUID()}${suffix}`);
  await pipeline(await openOutput(outputPath), fs.createWriteStream(file));
  return file;
}

function imageMime(row: AcademyCreativeProject, bytes: Buffer): string {
  if (row.outputMime && /^image\/(png|jpe?g|webp)$/.test(row.outputMime)) return row.outputMime === "image/jpg" ? "image/jpeg" : row.outputMime;
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return "image/png";
}

export function isVideoOutput(row: Pick<AcademyCreativeProject, "kind" | "outputMime">): boolean {
  return row.outputMime ? row.outputMime.startsWith("video/") : row.kind === "video";
}

/** Ready for any channel: a finished render with a file. */
export function renderIsDone(row: Pick<AcademyCreativeProject, "renderStatus" | "outputPath">): boolean {
  return row.renderStatus === "done" && Boolean(row.outputPath);
}

/** Start uploading a video to the ad account its ads would run from (as Ads → Media does). */
async function preloadForAds(media: AcademyAdMedia): Promise<void> {
  if (media.kind !== "video") return;
  const connection = await getConnection(media.academyId).catch(() => null);
  if (connection?.mode === "own" && connection.status === "connected") preloadVideo(media, connection.adAccountId, connectionToken(connection));
  else preloadVideo(media, metaConfig().adAccountId, undefined);
}

/**
 * The library copy of this project's current render: the one made before for
 * the same render if it still exists, otherwise a new one.
 */
export async function ensureCreativeMedia(
  row: AcademyCreativeProject,
  userId: number,
  opts: { forAds?: boolean } = {},
): Promise<{ media: AcademyAdMedia; created: boolean }> {
  if (!renderIsDone(row)) throw new PublishMediaError("Render it first", 409);
  const known = mediaIdForRender(readTargets(row.publishTargets), row.renderedAt);
  if (known) {
    const [existing] = await db.select().from(academyAdMediaTable)
      .where(and(eq(academyAdMediaTable.id, known), eq(academyAdMediaTable.academyId, row.academyId)));
    if (existing && existing.status === "ready") {
      if (opts.forAds) void preloadForAds(existing);
      return { media: existing, created: false };
    }
  }
  const name = (row.title || `Creative ${row.id}`).slice(0, 120);
  if (!isVideoOutput(row)) {
    const file = await outputToTemp(row.outputPath!, ".img");
    try {
      const bytes = await fs.promises.readFile(file);
      if (bytes.length === 0) throw new PublishMediaError("The rendered file is empty. Render it again.", 409);
      if (bytes.length > MAX_IMAGE_BYTES) throw new PublishMediaError("The rendered picture is too big to post. Render it again.", 413);
      const [media] = await db.insert(academyAdMediaTable).values({
        academyId: row.academyId,
        kind: "image",
        name,
        source: "studio_post",
        imageData: `data:${imageMime(row, bytes)};base64,${bytes.toString("base64")}`,
        bytes: bytes.length,
        width: sceneWidth(row),
        height: sceneHeight(row),
        status: "ready",
        createdBy: userId,
      }).returning();
      return { media, created: true };
    } finally {
      await fs.promises.rm(file, { force: true });
    }
  }
  const file = await outputToTemp(row.outputPath!, ".mp4");
  try {
    const facts = await probeVideo(file).catch(() => null);
    if (!facts) throw new PublishMediaError("The rendered video can't be read. Render it again.", 409);
    if (facts.durationSec && facts.durationSec > MAX_VIDEO_SECONDS) throw new PublishMediaError("Videos can be at most 10 minutes long.", 400);
    const still = await videoStill(file, facts.durationSec);
    const { size } = await fs.promises.stat(file);
    const storageUrl = await storeVideo(row.academyId, file);
    const [media] = await db.insert(academyAdMediaTable).values({
      academyId: row.academyId,
      kind: "video",
      name,
      source: "studio_clip",
      imageData: still,
      storageUrl,
      bytes: size,
      width: facts.width,
      height: facts.height,
      durationSec: facts.durationSec,
      status: "ready",
      createdBy: userId,
    }).returning();
    if (opts.forAds) void preloadForAds(media).catch((error) => logger.warn({ mediaId: media.id, error: (error as Error).message }, "Preloading a Creative video for ads failed"));
    return { media, created: true };
  } finally {
    await fs.promises.rm(file, { force: true });
  }
}

const FORMAT_SIZE: Record<string, [number, number]> = { post: [1080, 1350], square: [1080, 1080], story: [1080, 1920] };
const sceneWidth = (row: AcademyCreativeProject) => FORMAT_SIZE[row.format]?.[0] ?? null;
const sceneHeight = (row: AcademyCreativeProject) => FORMAT_SIZE[row.format]?.[1] ?? null;
