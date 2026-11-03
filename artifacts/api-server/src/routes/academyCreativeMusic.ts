import fs from "node:fs";
import os from "node:os";
import { Router, type IRouter, type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { and, eq } from "drizzle-orm";
import { creativeMusicTracksTable, db } from "@workspace/db";
import { MUSIC_LICENSES, MUSIC_MOODS, MUSIC_UPLOAD_MAX_BYTES } from "@workspace/api-zod";
import { requireAcademyConsoleUser, requireAcademyMembership } from "../lib/academyAccess";
import { academyIdParam } from "../lib/academyOwner";
import { CREATIVE_BASE, creativeOwner } from "../lib/creative/projects";
import {
  MusicError,
  addTrack,
  adminLibrary,
  cleanBpm,
  cleanText,
  deleteMusicFile,
  ensureReplayMusic,
  isMood,
  isMusicUpload,
  ownTrack,
  replayTrack,
  sendMusicFile,
  titleFromFileName,
  trackView,
  tracksFor,
  usableTrack,
} from "../lib/creative/music";
import { adminAccess, intParam } from "../lib/meta/routeAccess";
import { logger } from "../lib/logger";

/**
 * Creative hub → Music (creative_music_tracks, 0063).
 *
 * Academy console (owner, like the rest of the Creative hub):
 *   GET    …/creative/music?scope=replay|academy&mood=   Replay's library and the academy's own, active only
 *   POST   …/creative/music                               upload (file, title?, artist?, mood, bpm?, rights=true)
 *   PATCH  …/creative/music/:trackId                      the academy's own: { title?, artist?, mood?, bpm? }
 *   DELETE …/creative/music/:trackId                      the academy's own
 *   GET    …/creative/music/:trackId/file                 the .m4a (Range); any member of the academy,
 *                                                         Replay's tracks or the academy's own only
 *
 * Admin (users.is_admin), Replay's library:
 *   GET    /admin/creative/music                          every Replay track, hidden ones too
 *   POST   /admin/creative/music                          upload (file, title?, artist?, mood, bpm?, license?)
 *   PATCH  /admin/creative/music/:trackId                 { title?, artist?, mood?, bpm?, status?, license? }
 *   GET    /admin/creative/music/:trackId/file
 *
 * An upload is transcoded to AAC .m4a, measured (duration, loudness,
 * waveform) and stored like other academy media. An academy's upload needs its
 * owner to confirm the rights to the music; the confirmation is kept in the
 * track's licence line.
 */
const router: IRouter = Router();
const base = `${CREATIVE_BASE}/music`;
const adminBase = "/admin/creative/music";

const upload = multer({ dest: os.tmpdir(), limits: { fileSize: MUSIC_UPLOAD_MAX_BYTES, files: 1 } });

const truthy = (v: unknown) => v === true || v === "true" || v === "1" || v === "on";

function failed(res: Response, error: unknown, what: string) {
  if (error instanceof MusicError) { res.status(error.status).json({ error: error.message }); return; }
  logger.error({ error: (error as Error)?.message }, what);
  if (!res.headersSent) res.status(500).json({ error: "Something went wrong. Try again." });
}

/** Multer once `who` let the request through, so nothing is written for someone who can't upload. */
function withFile(who: (req: Request, res: Response) => Promise<unknown>) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const access = await who(req, res).catch((error) => { next(error); return null; });
    if (!access) return;
    res.locals.musicAccess = access;
    upload.single("file")(req, res, (error: unknown) => {
      const code = (error as { code?: string })?.code;
      if (code === "LIMIT_FILE_SIZE") { res.status(413).json({ error: `Music files can be at most ${MUSIC_UPLOAD_MAX_BYTES / 1024 / 1024} MB` }); return; }
      if (code === "LIMIT_UNEXPECTED_FILE" || code === "LIMIT_FILE_COUNT") { res.status(400).json({ error: "Upload one music file at a time" }); return; }
      if (error) { next(error); return; }
      next();
    });
  };
}

async function dropUpload(file: Express.Multer.File | undefined) {
  if (file?.path) await fs.promises.rm(file.path, { force: true }).catch(() => {});
}

/** The form's fields, checked; `null` and a response sent when they don't hold. */
function uploadFields(req: Request, res: Response): { title: string; artist: string | null; mood: (typeof MUSIC_MOODS)[number]; bpm: number | null } | null {
  const file = req.file;
  if (!file) { res.status(400).json({ error: "Choose a music file", field: "file" }); return null; }
  if (!isMusicUpload(file)) { res.status(400).json({ error: "Use an MP3, M4A, AAC or WAV file", field: "file" }); return null; }
  const mood = req.body?.mood;
  if (!isMood(mood)) { res.status(400).json({ error: "Pick a mood for the music", field: "mood" }); return null; }
  return {
    title: cleanText(req.body?.title, 80) ?? titleFromFileName(file.originalname),
    artist: cleanText(req.body?.artist, 80),
    mood,
    bpm: cleanBpm(req.body?.bpm),
  };
}

// ── Academy console ──────────────────────────────────────────────────────────

router.get(base, async (req, res): Promise<void> => {
  const access = await creativeOwner(req, res);
  if (!access) return;
  try {
    await ensureReplayMusic();
    const scope = req.query.scope === "replay" || req.query.scope === "academy" ? req.query.scope : undefined;
    const mood = isMood(req.query.mood) ? req.query.mood : undefined;
    const rows = await tracksFor(access.academyId, { scope, mood });
    res.setHeader("Cache-Control", "private, no-store");
    res.json({ tracks: rows.map((t) => trackView(t, access.academyId)), moods: MUSIC_MOODS });
  } catch (error) {
    failed(res, error, "Creative music: list failed");
  }
});

router.post(base, withFile(creativeOwner), async (req, res): Promise<void> => {
  const access = res.locals.musicAccess as { user: { id: number }; academyId: number };
  try {
    const fields = uploadFields(req, res);
    if (!fields) return;
    if (!truthy(req.body?.rights)) {
      res.status(400).json({ error: "Tick the box to confirm you own this music or have the rights to use it", field: "rights", code: "rights_required" });
      return;
    }
    const row = await addTrack({
      scope: "academy",
      academyId: access.academyId,
      uploadPath: req.file!.path,
      ...fields,
      // What the owner confirmed, by whom and when (the rights are the academy's).
      license: `${MUSIC_LICENSES.academy} (user ${access.user.id}, ${new Date().toISOString().slice(0, 10)})`,
      createdBy: access.user.id,
    });
    res.status(201).json({ track: trackView(row, access.academyId) });
  } catch (error) {
    failed(res, error, "Creative music: upload failed");
  } finally {
    await dropUpload(req.file);
  }
});

router.patch(`${base}/:trackId`, async (req, res): Promise<void> => {
  const access = await creativeOwner(req, res);
  if (!access) return;
  const id = intParam(req.params.trackId);
  if (!id) { res.status(400).json({ error: "Invalid track id" }); return; }
  try {
    const track = await ownTrack(access.academyId, id);
    if (!track) { res.status(404).json({ error: "Not found" }); return; }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const set: Partial<typeof creativeMusicTracksTable.$inferInsert> = {};
    if (body.title !== undefined) { const t = cleanText(body.title, 80); if (t) set.title = t; }
    if (body.artist !== undefined) set.artist = cleanText(body.artist, 80);
    if (body.mood !== undefined) { if (!isMood(body.mood)) { res.status(400).json({ error: "Unknown mood", field: "mood" }); return; } set.mood = body.mood; }
    if (body.bpm !== undefined) set.bpm = cleanBpm(body.bpm);
    const [row] = Object.keys(set).length
      ? await db.update(creativeMusicTracksTable).set(set)
        .where(and(eq(creativeMusicTracksTable.id, track.id), eq(creativeMusicTracksTable.academyId, access.academyId))).returning()
      : [track];
    res.json({ track: trackView(row, access.academyId) });
  } catch (error) {
    failed(res, error, "Creative music: update failed");
  }
});

router.delete(`${base}/:trackId`, async (req, res): Promise<void> => {
  const access = await creativeOwner(req, res);
  if (!access) return;
  const id = intParam(req.params.trackId);
  if (!id) { res.status(400).json({ error: "Invalid track id" }); return; }
  try {
    const track = await ownTrack(access.academyId, id);
    if (!track) { res.status(404).json({ error: "Not found" }); return; }
    await db.delete(creativeMusicTracksTable).where(and(eq(creativeMusicTracksTable.id, track.id), eq(creativeMusicTracksTable.academyId, access.academyId)));
    await deleteMusicFile(track);
    res.status(204).send();
  } catch (error) {
    failed(res, error, "Creative music: delete failed");
  }
});

router.get(`${base}/:trackId/file`, async (req, res): Promise<void> => {
  try {
    const user = await requireAcademyConsoleUser(req, res);
    if (!user) return;
    const academyId = academyIdParam(req.params.academyId);
    if (!academyId) { res.status(400).json({ error: "Invalid academy id" }); return; }
    if (!(await requireAcademyMembership(user.id, academyId, res))) return;
    const id = intParam(req.params.trackId);
    const track = id ? await usableTrack(academyId, id) : null;
    if (!track) { res.status(404).json({ error: "Not found" }); return; }
    await sendMusicFile(req, res, track);
  } catch (error) {
    failed(res, error, "Creative music: file failed");
  }
});

// ── Admin: Replay's library ──────────────────────────────────────────────────

router.get(adminBase, async (req, res): Promise<void> => {
  if (!(await adminAccess(req, res))) return;
  try {
    await ensureReplayMusic();
    res.setHeader("Cache-Control", "private, no-store");
    res.json({ tracks: (await adminLibrary()).map((t) => trackView(t, null)), moods: MUSIC_MOODS });
  } catch (error) {
    failed(res, error, "Creative music: admin list failed");
  }
});

router.post(adminBase, withFile(adminAccess), async (req, res): Promise<void> => {
  const admin = res.locals.musicAccess as { id: number };
  try {
    const fields = uploadFields(req, res);
    if (!fields) return;
    const row = await addTrack({
      scope: "replay",
      academyId: null,
      uploadPath: req.file!.path,
      ...fields,
      license: cleanText(req.body?.license, 200) ?? MUSIC_LICENSES.replay,
      createdBy: admin.id,
    });
    res.status(201).json({ track: trackView(row, null) });
  } catch (error) {
    failed(res, error, "Creative music: admin upload failed");
  } finally {
    await dropUpload(req.file);
  }
});

router.patch(`${adminBase}/:trackId`, async (req, res): Promise<void> => {
  if (!(await adminAccess(req, res))) return;
  const id = intParam(req.params.trackId);
  if (!id) { res.status(400).json({ error: "Invalid track id" }); return; }
  try {
    const track = await replayTrack(id);
    if (!track) { res.status(404).json({ error: "Not found" }); return; }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const set: Partial<typeof creativeMusicTracksTable.$inferInsert> = {};
    if (body.title !== undefined) { const t = cleanText(body.title, 80); if (t) set.title = t; }
    if (body.artist !== undefined) set.artist = cleanText(body.artist, 80);
    if (body.mood !== undefined) { if (!isMood(body.mood)) { res.status(400).json({ error: "Unknown mood", field: "mood" }); return; } set.mood = body.mood; }
    if (body.bpm !== undefined) set.bpm = cleanBpm(body.bpm);
    if (body.license !== undefined) { const l = cleanText(body.license, 200); if (l) set.license = l; }
    if (body.status !== undefined) {
      if (body.status !== "active" && body.status !== "hidden") { res.status(400).json({ error: "Status is active or hidden", field: "status" }); return; }
      set.status = body.status;
    }
    const [row] = Object.keys(set).length
      ? await db.update(creativeMusicTracksTable).set(set).where(eq(creativeMusicTracksTable.id, track.id)).returning()
      : [track];
    res.json({ track: trackView(row, null) });
  } catch (error) {
    failed(res, error, "Creative music: admin update failed");
  }
});

router.get(`${adminBase}/:trackId/file`, async (req, res): Promise<void> => {
  if (!(await adminAccess(req, res))) return;
  const id = intParam(req.params.trackId);
  try {
    const track = id ? await replayTrack(id) : null;
    if (!track) { res.status(404).json({ error: "Not found" }); return; }
    await sendMusicFile(req, res, track);
  } catch (error) {
    failed(res, error, "Creative music: admin file failed");
  }
});

export default router;
