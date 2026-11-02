import fs from "node:fs";
import os from "node:os";
import { Readable } from "node:stream";
import { and, desc, eq, getTableColumns, inArray, sql } from "drizzle-orm";
import { Router, type IRouter, type Request, type Response } from "express";
import multer from "multer";
import { z } from "zod";
import { academyAdMediaTable, academyAdRequestsTable, db, userClipsTable, type AcademyAdMedia } from "@workspace/db";
import { fetchExportObject } from "../lib/backupExport";
import { BUNNY_STORAGE_ZONE, deleteBunnyStoragePath } from "../lib/bunny";
import { logger } from "../lib/logger";
import { metaConfig } from "../lib/meta/config";
import { connectionToken, getConnection } from "../lib/meta/connections";
import { MAX_IMAGE_BYTES, MAX_VIDEO_BYTES, MAX_VIDEO_SECONDS, downloadToTemp, preloadVideo, probeVideo, storeVideo, videoStill } from "../lib/meta/media";
import { adminAccess, intParam, ownerAccess, sendFailure } from "../lib/meta/routeAccess";

/**
 * Academy console → Ads → Media: the photos and videos an academy's ads use. Uploaded from the
 * phone (already edited there), or sent from the Studio (a post or a branded clip).
 */
const router: IRouter = Router();
const upload = multer({ dest: os.tmpdir(), limits: { fileSize: MAX_VIDEO_BYTES, files: 1 } });
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const VIDEO_TYPES = new Set(["video/mp4", "video/quicktime", "video/x-m4v", "video/webm", "video/3gpp"]);

const base = "/academy/console/academies/:academyId/ads/media";

export function mediaView(m: AcademyAdMedia, prefix: string) {
  return {
    id: m.id,
    kind: m.kind,
    name: m.name,
    source: m.source,
    status: m.status,
    error: m.error,
    width: m.width,
    height: m.height,
    durationSec: m.durationSec,
    bytes: m.bytes,
    thumbUrl: m.imageData ? `${prefix}/${m.id}/thumb` : null,
    fileUrl: m.kind === "video" && m.storageUrl ? `${prefix}/${m.id}/file` : null,
    userClipId: m.userClipId,
    createdAt: m.createdAt,
  };
}

/** "https://host/zone/ad-media/3/x.mp4" → "ad-media/3/x.mp4". */
function storagePathOf(url: string): string | null {
  try {
    const parts = new URL(url).pathname.split("/").filter(Boolean);
    return parts[0] === BUNNY_STORAGE_ZONE ? parts.slice(1).join("/") : null;
  } catch {
    return null;
  }
}

const ownerPrefix = (academyId: number) => `/api/academy/console/academies/${academyId}/ads/media`;

/** Start the video's upload to the ad account the academy's ads currently run from. */
async function preload(media: AcademyAdMedia): Promise<void> {
  if (media.kind !== "video") return;
  const connection = await getConnection(media.academyId).catch(() => null);
  if (connection?.mode === "own" && connection.status === "connected") {
    preloadVideo(media, connection.adAccountId, connectionToken(connection));
  } else {
    preloadVideo(media, metaConfig().adAccountId, undefined);
  }
}

/** Probe, take a still, store it and file it: shared by phone uploads and Studio clips. */
async function addVideo(academyId: number, userId: number, file: string, name: string, source: string, userClipId: number | null): Promise<AcademyAdMedia> {
  const facts = await probeVideo(file).catch(() => null);
  if (!facts) throw Object.assign(new Error("That file isn't a video we can read. Export it from your phone as MP4 and try again."), { status: 400 });
  if (facts.durationSec && facts.durationSec > MAX_VIDEO_SECONDS) throw Object.assign(new Error("Videos can be at most 10 minutes long."), { status: 400 });
  const still = await videoStill(file, facts.durationSec);
  const { size } = await fs.promises.stat(file);
  const storageUrl = await storeVideo(academyId, file);
  const [row] = await db.insert(academyAdMediaTable).values({
    academyId,
    kind: "video",
    name: name.slice(0, 120),
    source,
    imageData: still,
    storageUrl,
    bytes: size,
    width: facts.width,
    height: facts.height,
    durationSec: facts.durationSec,
    userClipId,
    status: "ready",
    createdBy: userId,
  }).returning();
  void preload(row);
  return row;
}

function failWith(res: Response, error: unknown, what: string) {
  const status = (error as { status?: number })?.status;
  if (status === 400) {
    res.status(400).json({ error: (error as Error).message });
    return;
  }
  sendFailure(res, error, what);
}

router.get(base, async (req, res): Promise<void> => {
  const access = await ownerAccess(req, res);
  if (!access) return;
  try {
    // Everything but the image bytes (photos are megabytes each); the list only needs to know one exists.
    const { imageData: _bytes, ...columns } = getTableColumns(academyAdMediaTable);
    const rows = await db.select({ ...columns, hasImage: sql<boolean>`${academyAdMediaTable.imageData} is not null` })
      .from(academyAdMediaTable).where(eq(academyAdMediaTable.academyId, access.academyId))
      .orderBy(desc(academyAdMediaTable.createdAt)).limit(200);
    res.json(rows.map(({ hasImage, ...m }) => mediaView({ ...m, imageData: hasImage ? "1" : null }, ownerPrefix(access.academyId))));
  } catch (error) {
    sendFailure(res, error, "Listing ad media failed");
  }
});

router.post(base, async (req, res, next) => {
  // Who it is first: nothing is written to disk for someone who can't upload here.
  const access = await ownerAccess(req, res).catch((error) => { next(error); return null; });
  if (!access) return;
  res.locals.access = access;
  upload.single("file")(req, res, (error: unknown) => {
    if ((error as { code?: string })?.code === "LIMIT_FILE_SIZE") {
      res.status(413).json({ error: `Files can be at most ${MAX_VIDEO_BYTES / 1024 / 1024} MB` });
      return;
    }
    if (error) { next(error); return; }
    next();
  });
}, async (req, res): Promise<void> => {
  const file = req.file;
  const cleanup = () => (file ? fs.promises.rm(file.path, { force: true }) : Promise.resolve());
  try {
    const access = res.locals.access as { user: { id: number }; academyId: number };
    if (!file) {
      res.status(400).json({ error: "Choose a photo or a video" });
      return;
    }
    const name = typeof req.body?.name === "string" && req.body.name.trim() ? req.body.name.trim() : file.originalname || "";
    if (IMAGE_TYPES.has(file.mimetype)) {
      if (file.size > MAX_IMAGE_BYTES) {
        res.status(413).json({ error: `Photos can be at most ${MAX_IMAGE_BYTES / 1024 / 1024} MB` });
        return;
      }
      const bytes = await fs.promises.readFile(file.path);
      const width = Number(req.body?.width) || null;
      const height = Number(req.body?.height) || null;
      const [row] = await db.insert(academyAdMediaTable).values({
        academyId: access.academyId,
        kind: "image",
        name: name.slice(0, 120),
        source: "upload",
        imageData: `data:${file.mimetype};base64,${bytes.toString("base64")}`,
        bytes: file.size,
        width: width && width > 0 ? Math.round(width) : null,
        height: height && height > 0 ? Math.round(height) : null,
        status: "ready",
        createdBy: access.user.id,
      }).returning();
      res.status(201).json(mediaView(row, ownerPrefix(access.academyId)));
      return;
    }
    if (VIDEO_TYPES.has(file.mimetype) || /\.(mp4|mov|m4v|webm|3gp)$/i.test(file.originalname ?? "")) {
      const row = await addVideo(access.academyId, access.user.id, file.path, name, "upload", null);
      res.status(201).json(mediaView(row, ownerPrefix(access.academyId)));
      return;
    }
    res.status(400).json({ error: "Use a JPG or PNG photo, or an MP4 or MOV video" });
  } catch (error) {
    failWith(res, error, "Uploading ad media failed");
  } finally {
    await cleanup();
  }
});

/** The Studio: a rendered post or story (JPEG/PNG data URL). */
router.post(`${base}/from-image`, async (req, res): Promise<void> => {
  const access = await ownerAccess(req, res);
  if (!access) return;
  const body = z.object({
    dataUrl: z.string().max(6_000_000).regex(/^data:image\/(png|jpe?g|webp);base64,/),
    name: z.string().trim().max(120).optional(),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
  }).safeParse(req.body ?? {});
  if (!body.success) {
    res.status(400).json({ error: "Send the image as a JPG or PNG data URL under 4 MB" });
    return;
  }
  try {
    const [row] = await db.insert(academyAdMediaTable).values({
      academyId: access.academyId,
      kind: "image",
      name: body.data.name ?? "Studio",
      source: "studio_post",
      imageData: body.data.dataUrl,
      bytes: Math.round((body.data.dataUrl.length * 3) / 4),
      width: body.data.width ?? null,
      height: body.data.height ?? null,
      status: "ready",
      createdBy: access.user.id,
    }).returning();
    res.status(201).json(mediaView(row, ownerPrefix(access.academyId)));
  } catch (error) {
    sendFailure(res, error, "Saving a Studio image to ad media failed");
  }
});

/** The Studio: an academy clip's branded export. */
router.post(`${base}/from-clip`, async (req, res): Promise<void> => {
  const access = await ownerAccess(req, res);
  if (!access) return;
  const clipId = Number(req.body?.userClipId);
  if (!Number.isSafeInteger(clipId) || clipId <= 0) {
    res.status(400).json({ error: "Which clip?" });
    return;
  }
  let file: string | null = null;
  try {
    const [clip] = await db.select().from(userClipsTable).where(eq(userClipsTable.id, clipId));
    if (!clip || clip.academyId !== access.academyId || clip.hiddenReason) {
      res.status(404).json({ error: "That clip isn't one of this academy's" });
      return;
    }
    if (!clip.exportedUrl || clip.exportStatus !== "done") {
      res.status(409).json({ error: "This clip isn't rendered yet. Press Download once, wait for it to finish, then try again.", code: "not_exported" });
      return;
    }
    const existing = await db.select().from(academyAdMediaTable)
      .where(and(eq(academyAdMediaTable.academyId, access.academyId), eq(academyAdMediaTable.userClipId, clipId))).limit(1);
    if (existing[0] && existing[0].status !== "failed") {
      res.json(mediaView(existing[0], ownerPrefix(access.academyId)));
      return;
    }
    file = await downloadToTemp(clip.exportedUrl);
    const row = await addVideo(access.academyId, access.user.id, file, clip.title || `Clip ${clip.id}`, "studio_clip", clip.id);
    res.status(201).json(mediaView(row, ownerPrefix(access.academyId)));
  } catch (error) {
    failWith(res, error, "Adding a clip to ad media failed");
  } finally {
    if (file) await fs.promises.rm(file, { force: true });
  }
});

router.delete(`${base}/:id`, async (req, res): Promise<void> => {
  const access = await ownerAccess(req, res);
  if (!access) return;
  const id = intParam(req.params.id);
  try {
    // A photo a live or waiting ad uses stays until that ad is done with it.
    const inUse = await db.select({ id: academyAdRequestsTable.id, cards: academyAdRequestsTable.cards }).from(academyAdRequestsTable).where(and(
      eq(academyAdRequestsTable.academyId, access.academyId),
      inArray(academyAdRequestsTable.status, ["pending_approval", "launching"]),
    ));
    if (inUse.some((r) => Array.isArray(r.cards) && (r.cards as Array<{ mediaId: number }>).some((c) => c.mediaId === id))) {
      res.status(409).json({ error: "An ad waiting to go live uses this. Delete it after that ad is out." });
      return;
    }
    const [row] = id ? await db.delete(academyAdMediaTable)
      .where(and(eq(academyAdMediaTable.id, id), eq(academyAdMediaTable.academyId, access.academyId))).returning() : [];
    if (!row) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    // Our own copy in Storage goes too (best effort; the row is already gone).
    const storagePath = row.storageUrl ? storagePathOf(row.storageUrl) : null;
    if (storagePath?.startsWith(`ad-media/${access.academyId}/`)) {
      await deleteBunnyStoragePath(storagePath).catch((error) => logger.warn({ mediaId: row.id, error: (error as Error).message }, "Deleting an ad video from Storage failed"));
    }
    res.status(204).send();
  } catch (error) {
    sendFailure(res, error, "Deleting ad media failed");
  }
});

// ─── Serving the files (owner, or an admin reviewing an ad) ─────────────────

async function sendThumb(res: Response, media: AcademyAdMedia | undefined) {
  const match = media?.imageData?.match(/^data:(image\/[a-z+]+);base64,(.+)$/);
  if (!match) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.setHeader("Content-Type", match[1]);
  res.setHeader("Cache-Control", "private, max-age=3600");
  res.send(Buffer.from(match[2], "base64"));
}

async function sendVideo(req: Request, res: Response, media: AcademyAdMedia | undefined) {
  if (!media?.storageUrl) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const range = typeof req.headers.range === "string" ? req.headers.range : undefined;
  const upstream = await fetchExportObject(media.storageUrl, { range });
  if (!upstream.ok || !upstream.body) {
    res.status(upstream.status === 404 ? 404 : 502).json({ error: "The video isn't available" });
    return;
  }
  res.status(upstream.status);
  for (const header of ["content-type", "content-length", "content-range", "accept-ranges"]) {
    const value = upstream.headers.get(header);
    if (value) res.setHeader(header, value);
  }
  res.setHeader("Cache-Control", "private, max-age=3600");
  const stream = Readable.fromWeb(upstream.body as never);
  req.on("close", () => stream.destroy());
  stream.on("error", (error) => {
    logger.warn({ mediaId: media.id, error: error.message }, "Streaming an ad video failed");
    res.destroy();
  });
  stream.pipe(res);
}

async function mediaFor(academyId: number | null, id: number | null): Promise<AcademyAdMedia | undefined> {
  if (!id) return undefined;
  const where = academyId ? and(eq(academyAdMediaTable.id, id), eq(academyAdMediaTable.academyId, academyId)) : eq(academyAdMediaTable.id, id);
  const [row] = await db.select().from(academyAdMediaTable).where(where);
  return row;
}

router.get(`${base}/:id/thumb`, async (req, res): Promise<void> => {
  const access = await ownerAccess(req, res);
  if (!access) return;
  await sendThumb(res, await mediaFor(access.academyId, intParam(req.params.id)));
});

router.get(`${base}/:id/file`, async (req, res): Promise<void> => {
  const access = await ownerAccess(req, res);
  if (!access) return;
  try {
    await sendVideo(req, res, await mediaFor(access.academyId, intParam(req.params.id)));
  } catch (error) {
    if (!res.headersSent) sendFailure(res, error, "Serving an ad video failed");
  }
});

router.get("/admin/meta-ads/media/:id/thumb", async (req, res): Promise<void> => {
  if (!(await adminAccess(req, res))) return;
  await sendThumb(res, await mediaFor(null, intParam(req.params.id)));
});

router.get("/admin/meta-ads/media/:id/file", async (req, res): Promise<void> => {
  if (!(await adminAccess(req, res))) return;
  try {
    await sendVideo(req, res, await mediaFor(null, intParam(req.params.id)));
  } catch (error) {
    if (!res.headersSent) sendFailure(res, error, "Serving an ad video failed");
  }
});

export default router;
