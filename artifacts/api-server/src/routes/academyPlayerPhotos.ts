import { Router, type IRouter, type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { and, asc, desc, eq } from "drizzle-orm";
import { academyPlayerPhotosTable, academyPlayersTable, db } from "@workspace/db";
import { requireAcademyConsoleUser, requireAcademyMembership } from "../lib/academyAccess";
import { academyIdParam } from "../lib/academyOwner";
import {
  PLAYER_PHOTO_INPUT_TYPES,
  PLAYER_PHOTO_MAX_BYTES,
  PlayerPhotoError,
  academyPlayer,
  academyPlayerPhoto,
  addPlayerPhoto,
  cleanLabel,
  photoView,
  playerGallery,
  processPlayerPhoto,
  readPlayerPhotoFile,
  removePlayerPhoto,
  setPrimaryPhoto,
} from "../lib/academyPlayerPhotos";
import { logger } from "../lib/logger";

/**
 * Academy console → Players → photos (academy_player_photos). Members of the
 * academy only; the pictures are never public.
 *
 *   GET    …/players/photos                          every player's photos (for the list's thumbnails)
 *   POST   …/players/photos/bulk                     a photoshoot: files[] + assign (JSON: playerId per file, labels)
 *   GET    …/players/:playerId/photos                one player's gallery, primary first
 *   POST   …/players/:playerId/photos                add one (file, label?, primary?)
 *   PATCH  …/players/:playerId/photos/:photoId       { label?, isPrimary: true }
 *   DELETE …/players/:playerId/photos/:photoId
 *   GET    …/players/:playerId/photos/:photoId/file  the picture (PNG with transparency, or WebP)
 *
 * Uploads keep transparency (PNG / WebP in, PNG / WebP out) and are scaled to
 * at most 1600 px on the longest side.
 */
const router: IRouter = Router();
const base = "/academy/console/academies/:academyId/players";
const BULK_MAX_FILES = 60;

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: PLAYER_PHOTO_MAX_BYTES, files: BULK_MAX_FILES } });

const intParam = (v: string | string[] | undefined) => academyIdParam(v);

async function member(req: Request, res: Response): Promise<{ userId: number; academyId: number } | null> {
  const user = await requireAcademyConsoleUser(req, res);
  if (!user) return null;
  const academyId = academyIdParam(req.params.academyId);
  if (!academyId) { res.status(400).json({ error: "Invalid academy id" }); return null; }
  const roles = await requireAcademyMembership(user.id, academyId, res);
  if (!roles) return null;
  return { userId: user.id, academyId };
}

function failed(res: Response, error: unknown, what: string) {
  if (error instanceof PlayerPhotoError) { res.status(error.status).json({ error: error.message }); return; }
  logger.error({ error: (error as Error)?.message }, what);
  if (!res.headersSent) res.status(500).json({ error: "Something went wrong. Try again." });
}

/** Multer after the membership check, so nothing is read for someone who can't upload here. */
function withFiles(kind: "single" | "array") {
  return async (req: Request, res: Response, next: NextFunction) => {
    const access = await member(req, res).catch((error) => { next(error); return null; });
    if (!access) return;
    res.locals.photoAccess = access;
    const mw = kind === "single" ? upload.single("file") : upload.array("files", BULK_MAX_FILES);
    mw(req, res, (error: unknown) => {
      const code = (error as { code?: string })?.code;
      if (code === "LIMIT_FILE_SIZE") { res.status(413).json({ error: `Photos can be at most ${PLAYER_PHOTO_MAX_BYTES / 1024 / 1024} MB each` }); return; }
      if (code === "LIMIT_FILE_COUNT" || code === "LIMIT_UNEXPECTED_FILE") { res.status(413).json({ error: `Up to ${BULK_MAX_FILES} photos at a time` }); return; }
      if (error) { next(error); return; }
      next();
    });
  };
}

const truthy = (v: unknown) => v === true || v === "true" || v === "1";

router.get(`${base}/photos`, async (req, res): Promise<void> => {
  const access = await member(req, res);
  if (!access) return;
  try {
    const rows = await db.select().from(academyPlayerPhotosTable)
      .where(eq(academyPlayerPhotosTable.academyId, access.academyId))
      .orderBy(asc(academyPlayerPhotosTable.playerId), desc(academyPlayerPhotosTable.isPrimary), desc(academyPlayerPhotosTable.createdAt))
      .limit(4000);
    res.setHeader("Cache-Control", "private, no-store");
    res.json({ photos: rows.map(photoView) });
  } catch (error) {
    failed(res, error, "Player photos: list failed");
  }
});

router.post(`${base}/photos/bulk`, withFiles("array"), async (req, res): Promise<void> => {
  const access = res.locals.photoAccess as { userId: number; academyId: number };
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  if (!files.length) { res.status(400).json({ error: "Choose the photos to upload" }); return; }
  let assign: Array<{ playerId?: unknown; label?: unknown } | null> = [];
  try {
    const raw = JSON.parse(String(req.body?.assign ?? "[]"));
    if (Array.isArray(raw)) assign = raw;
  } catch { /* falls through: nothing assigned */ }
  if (assign.length !== files.length) { res.status(400).json({ error: "Say which player each photo is for" }); return; }
  try {
    const players = await db.select({ id: academyPlayersTable.id }).from(academyPlayersTable).where(eq(academyPlayersTable.academyId, access.academyId));
    const own = new Set(players.map((p) => p.id));
    const added: ReturnType<typeof photoView>[] = [];
    const skipped: Array<{ index: number; name: string; error: string }> = [];
    for (const [index, file] of files.entries()) {
      const a = assign[index];
      const playerId = Number(a?.playerId);
      if (!a || !Number.isSafeInteger(playerId) || !own.has(playerId)) { skipped.push({ index, name: file.originalname, error: "No player picked" }); continue; }
      if (!PLAYER_PHOTO_INPUT_TYPES.has(file.mimetype)) { skipped.push({ index, name: file.originalname, error: "Use PNG, WebP or JPG" }); continue; }
      try {
        const photo = await processPlayerPhoto(file.buffer);
        const row = await addPlayerPhoto({ academyId: access.academyId, playerId, photo, label: cleanLabel(a.label), createdBy: access.userId });
        added.push(photoView(row));
      } catch (error) {
        if (!(error instanceof PlayerPhotoError)) logger.warn({ error: (error as Error)?.message, academyId: access.academyId }, "Player photos: one bulk file failed");
        skipped.push({ index, name: file.originalname, error: error instanceof PlayerPhotoError ? error.message : "Couldn't save it" });
      }
    }
    res.status(added.length ? 201 : 400).json({ added, skipped });
  } catch (error) {
    failed(res, error, "Player photos: bulk upload failed");
  }
});

router.get(`${base}/:playerId/photos`, async (req, res): Promise<void> => {
  const access = await member(req, res);
  if (!access) return;
  const playerId = intParam(req.params.playerId);
  if (!playerId) { res.status(400).json({ error: "Invalid player id" }); return; }
  try {
    if (!(await academyPlayer(access.academyId, playerId))) { res.status(404).json({ error: "Player not found" }); return; }
    res.setHeader("Cache-Control", "private, no-store");
    res.json({ photos: (await playerGallery(access.academyId, playerId)).map(photoView) });
  } catch (error) {
    failed(res, error, "Player photos: gallery failed");
  }
});

router.post(`${base}/:playerId/photos`, withFiles("single"), async (req, res): Promise<void> => {
  const access = res.locals.photoAccess as { userId: number; academyId: number };
  const playerId = intParam(req.params.playerId);
  const file = req.file;
  if (!playerId) { res.status(400).json({ error: "Invalid player id" }); return; }
  if (!file) { res.status(400).json({ error: "Choose a photo" }); return; }
  if (!PLAYER_PHOTO_INPUT_TYPES.has(file.mimetype)) { res.status(400).json({ error: "Use a PNG, WebP or JPG photo" }); return; }
  try {
    if (!(await academyPlayer(access.academyId, playerId))) { res.status(404).json({ error: "Player not found" }); return; }
    const photo = await processPlayerPhoto(file.buffer);
    const row = await addPlayerPhoto({
      academyId: access.academyId, playerId, photo, label: cleanLabel(req.body?.label), createdBy: access.userId, makePrimary: truthy(req.body?.primary),
    });
    res.status(201).json({ photo: photoView(row) });
  } catch (error) {
    failed(res, error, "Player photos: upload failed");
  }
});

async function ownPhoto(req: Request, res: Response) {
  const access = await member(req, res);
  if (!access) return null;
  const playerId = intParam(req.params.playerId);
  const photoId = intParam(req.params.photoId);
  if (!playerId || !photoId) { res.status(400).json({ error: "Invalid id" }); return null; }
  const photo = await academyPlayerPhoto(access.academyId, photoId);
  if (!photo || photo.playerId !== playerId) { res.status(404).json({ error: "Not found" }); return null; }
  return { access, photo };
}

router.patch(`${base}/:playerId/photos/:photoId`, async (req, res): Promise<void> => {
  try {
    const hit = await ownPhoto(req, res);
    if (!hit) return;
    const body = (req.body ?? {}) as { label?: unknown; isPrimary?: unknown };
    if (body.label !== undefined) {
      await db.update(academyPlayerPhotosTable).set({ label: cleanLabel(body.label) })
        .where(and(eq(academyPlayerPhotosTable.id, hit.photo.id), eq(academyPlayerPhotosTable.academyId, hit.access.academyId)));
    }
    if (body.isPrimary === true) await setPrimaryPhoto(hit.access.academyId, hit.photo);
    const fresh = await academyPlayerPhoto(hit.access.academyId, hit.photo.id);
    res.json({ photo: fresh ? photoView(fresh) : null });
  } catch (error) {
    failed(res, error, "Player photos: update failed");
  }
});

router.delete(`${base}/:playerId/photos/:photoId`, async (req, res): Promise<void> => {
  try {
    const hit = await ownPhoto(req, res);
    if (!hit) return;
    await removePlayerPhoto(hit.access.academyId, hit.photo);
    res.status(204).send();
  } catch (error) {
    failed(res, error, "Player photos: delete failed");
  }
});

router.get(`${base}/:playerId/photos/:photoId/file`, async (req, res): Promise<void> => {
  try {
    const hit = await ownPhoto(req, res);
    if (!hit) return;
    const bytes = await readPlayerPhotoFile(hit.photo);
    if (!bytes) { res.status(404).json({ error: "Not found" }); return; }
    res.setHeader("Content-Type", hit.photo.mime);
    // Private: a child's picture is never cached by a shared cache.
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.send(bytes);
  } catch (error) {
    failed(res, error, "Player photos: file failed");
  }
});

export default router;
