import fs from "node:fs";
import os from "node:os";
import { and, desc, eq, gte, lt } from "drizzle-orm";
import { Router, type IRouter, type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { z } from "zod";
import { academyAdMediaTable, academyMembersTable, academyPhoneMediaTable, academySessionsTable, db, type AcademyPhoneMedia } from "@workspace/db";
import type { CaptureRaw } from "@workspace/api-zod";
import { getLocalUserRecord, unauthenticatedResponse } from "../lib/clerkUserBridge";
import { logger } from "../lib/logger";
import { MAX_VIDEO_BYTES } from "../lib/meta/media";
import { ingestPhoneMedia, PhoneMediaError, relinkPhoneMedia, resortPhoneMedia, tagPhoneMedia } from "../lib/phoneMedia";
import { consoleAccess } from "./academyMatches";
import { findFamilyPlayersForUser } from "./academyFamily";

/**
 * Phone videos and photos sorted by match time.
 *
 *   POST   /academy/console/academies/:academyId/phone-media        a coach, manager or owner adds files
 *   GET    /academy/console/academies/:academyId/phone-media        the list (?sessionId, ?phase, ?review=1)
 *   PATCH  /academy/console/academies/:academyId/phone-media/:id    put it in a session, tag players
 *   DELETE /academy/console/academies/:academyId/phone-media/:id    the owner, or whoever added it
 *   POST   /academy/console/academies/:academyId/phone-media/resort sort again (sessions changed)
 *   GET    /academy/console/academies/:academyId/phone-media/:id/thumb
 *   POST   /academy/family/phone-media?playerId=                    a parent adds files of his child
 *
 * Uploads are multipart: `file`, and `capture` (JSON) with what the browser read
 * from the file before upload. GPS travels separately (`gps`), is compared with
 * the venue and dropped: nothing stores coordinates.
 */
const router: IRouter = Router();
const base = "/academy/console/academies/:academyId/phone-media";
const upload = multer({ dest: os.tmpdir(), limits: { fileSize: MAX_VIDEO_BYTES, files: 1 } });

const CaptureBody = z.object({
  lastModifiedMs: z.number().finite().nullish(),
  durationSec: z.number().finite().min(0).nullish(),
  quicktimeCreationDate: z.string().max(64).nullish(),
  mvhdCreation: z.string().max(64).nullish(),
  otherDate: z.string().max(64).nullish(),
  dateTimeOriginal: z.string().max(32).nullish(),
  offsetTimeOriginal: z.string().max(10).nullish(),
  make: z.string().max(64).nullish(),
  model: z.string().max(64).nullish(),
}).partial();
const GpsBody = z.object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) });

function parseJson<T>(value: unknown, schema: z.ZodType<T>): T | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const r = schema.safeParse(JSON.parse(value));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

function view(r: AcademyPhoneMedia) {
  return {
    id: r.id,
    mediaId: r.mediaId,
    kind: r.kind,
    fileName: r.fileName,
    uploaderRole: r.uploaderRole,
    playerId: r.playerId,
    capturedAt: r.capturedStart?.toISOString() ?? null,
    capturedEnd: r.capturedEnd?.toISOString() ?? null,
    captureDate: r.captureDate,
    captureSource: r.captureSource,
    captureConfidence: r.captureConfidence,
    captureNotes: r.captureNotes as string[],
    venue: r.venue,
    sessionId: r.sessionId,
    phase: r.phase,
    offsetSec: r.offsetSec,
    recordingId: r.recordingId,
    needsReview: r.needsReview,
    reviewReason: r.reviewReason,
    linkedBy: r.linkedBy,
    playerIds: r.playerIds as number[],
    thumbnailUrl: `/api/academy/console/academies/${r.academyId}/phone-media/${r.id}/thumb`,
    createdAt: r.createdAt.toISOString(),
  };
}

async function handleUpload(req: Request, res: Response, who: { academyId: number; userId: number; role: AcademyPhoneMedia["uploaderRole"]; playerId: number | null }) {
  const file = req.file;
  try {
    if (!file) { res.status(400).json({ error: "Choose a photo or a video" }); return; }
    const row = await ingestPhoneMedia({
      academyId: who.academyId,
      filePath: file.path,
      fileName: (typeof req.body?.name === "string" && req.body.name.trim() ? req.body.name : file.originalname || "file").slice(0, 200),
      mime: file.mimetype,
      size: file.size,
      client: parseJson(req.body?.capture, CaptureBody) as Partial<CaptureRaw> | null,
      clientGps: parseJson(req.body?.gps, GpsBody),
      uploadedBy: who.userId,
      role: who.role,
      playerId: who.playerId,
    });
    res.status(201).json({ item: view(row) });
  } catch (error) {
    if (error instanceof PhoneMediaError) { res.status(error.status).json({ error: error.message }); return; }
    logger.error({ error: (error as Error)?.message, academyId: who.academyId }, "Phone media upload failed");
    res.status(500).json({ error: "The upload failed. Try again." });
  } finally {
    if (file) await fs.promises.rm(file.path, { force: true });
  }
}

const withFile = (req: Request, res: Response, next: NextFunction) => {
  upload.single("file")(req, res, (error: unknown) => {
    if ((error as { code?: string })?.code === "LIMIT_FILE_SIZE") { res.status(413).json({ error: `Files can be at most ${MAX_VIDEO_BYTES / 1024 / 1024} MB` }); return; }
    if (error) { next(error); return; }
    next();
  });
};

// ─── Console (owner, manager, coach) ────────────────────────────────────────

router.post(base, async (req, res, next) => {
  // Who it is first: nothing is written to disk for someone who can't upload here.
  const access = await consoleAccess(req, res).catch((error) => { next(error); return null; });
  if (!access) return;
  res.locals.phoneAccess = access;
  withFile(req, res, next);
}, async (req, res): Promise<void> => {
  const access = res.locals.phoneAccess as NonNullable<Awaited<ReturnType<typeof consoleAccess>>>;
  const roles = (await db.select({ role: academyMembersTable.role }).from(academyMembersTable)
    .where(and(eq(academyMembersTable.academyId, access.academyId), eq(academyMembersTable.userId, access.user.id)))).map((r) => r.role);
  const role = roles.includes("owner") ? "owner" : roles.includes("manager") ? "manager" : "coach";
  await handleUpload(req, res, { academyId: access.academyId, userId: access.user.id, role, playerId: null });
});

router.get(base, async (req, res): Promise<void> => {
  const access = await consoleAccess(req, res);
  if (!access) return;
  const where = [eq(academyPhoneMediaTable.academyId, access.academyId)];
  const sessionId = Number(req.query.sessionId);
  if (Number.isSafeInteger(sessionId) && sessionId > 0) where.push(eq(academyPhoneMediaTable.sessionId, sessionId));
  if (typeof req.query.phase === "string" && ["before", "during", "after", "unlinked"].includes(req.query.phase)) where.push(eq(academyPhoneMediaTable.phase, req.query.phase));
  if (req.query.review === "1") where.push(eq(academyPhoneMediaTable.needsReview, true));
  const rows = await db.select().from(academyPhoneMediaTable).where(and(...where)).orderBy(desc(academyPhoneMediaTable.createdAt)).limit(200);
  res.json({ items: rows.map(view) });
});

router.post(`${base}/resort`, async (req, res): Promise<void> => {
  const access = await consoleAccess(req, res);
  if (!access) return;
  res.json({ changed: await resortPhoneMedia(access.academyId) });
});

async function loadItem(req: Request, res: Response, academyId: number) {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) { res.status(400).json({ error: "Invalid id" }); return null; }
  const [row] = await db.select().from(academyPhoneMediaTable).where(and(eq(academyPhoneMediaTable.id, id), eq(academyPhoneMediaTable.academyId, academyId)));
  if (!row) { res.status(404).json({ error: "Not found" }); return null; }
  return row;
}

const PatchBody = z.object({
  sessionId: z.number().int().positive().nullable().optional(),
  phase: z.enum(["before", "during", "after"]).nullable().optional(),
  playerIds: z.array(z.number().int().positive()).max(40).optional(),
});

router.patch(`${base}/:id`, async (req, res): Promise<void> => {
  const access = await consoleAccess(req, res);
  if (!access) return;
  const body = PatchBody.safeParse(req.body ?? {});
  if (!body.success) { res.status(400).json({ error: "Invalid" }); return; }
  let row = await loadItem(req, res, access.academyId);
  if (!row) return;
  try {
    if (body.data.sessionId !== undefined) row = await relinkPhoneMedia(row, body.data.sessionId, body.data.phase ?? null);
    if (body.data.playerIds) row = await tagPhoneMedia(row, body.data.playerIds);
    res.json({ item: view(row) });
  } catch (error) {
    if (error instanceof PhoneMediaError) { res.status(error.status).json({ error: error.message }); return; }
    throw error;
  }
});

router.delete(`${base}/:id`, async (req, res): Promise<void> => {
  const access = await consoleAccess(req, res);
  if (!access) return;
  const row = await loadItem(req, res, access.academyId);
  if (!row) return;
  if (!access.isOwner && row.uploadedBy !== access.user.id) { res.status(403).json({ error: "Only the owner or whoever added it can remove it" }); return; }
  // The file goes with it (academy_phone_media cascades from academy_ad_media).
  await db.delete(academyAdMediaTable).where(and(eq(academyAdMediaTable.id, row.mediaId), eq(academyAdMediaTable.academyId, access.academyId)));
  res.json({ deleted: row.id });
});

router.get(`${base}/:id/thumb`, async (req, res): Promise<void> => {
  const access = await consoleAccess(req, res);
  if (!access) return;
  const row = await loadItem(req, res, access.academyId);
  if (!row) return;
  const [m] = await db.select({ imageData: academyAdMediaTable.imageData }).from(academyAdMediaTable).where(eq(academyAdMediaTable.id, row.mediaId));
  const match = /^data:(image\/[a-z+]+);base64,(.*)$/.exec(m?.imageData ?? "");
  if (!match) { res.status(404).json({ error: "No picture" }); return; }
  res.setHeader("Cache-Control", "private, max-age=3600");
  res.type(match[1]).send(Buffer.from(match[2], "base64"));
});

// ─── Family (a parent, or the player himself) ───────────────────────────────

router.post("/academy/family/phone-media", async (req, res, next) => {
  const user = await getLocalUserRecord(req).catch((error) => { next(error); return null; });
  if (!user || user.isGuest || user.isDisabled) { unauthenticatedResponse(res, req); return; }
  const linked = await findFamilyPlayersForUser(user.id);
  const wanted = Number(req.query.playerId);
  const player = Number.isSafeInteger(wanted) && wanted > 0 ? linked.find((p) => p.id === wanted) : linked[0];
  if (!player) { res.status(404).json({ error: "No academy player is linked to this account" }); return; }
  res.locals.family = { userId: user.id, academyId: player.academyId, playerId: player.id };
  withFile(req, res, next);
}, async (req, res): Promise<void> => {
  const who = res.locals.family as { userId: number; academyId: number; playerId: number };
  await handleUpload(req, res, { ...who, role: "parent" });
});

/** The academy's sessions around a day, for a coach placing an unlinked file. */
router.get(`${base}/sessions`, async (req, res): Promise<void> => {
  const access = await consoleAccess(req, res);
  if (!access) return;
  const day = typeof req.query.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date) ? req.query.date : null;
  if (!day) { res.status(400).json({ error: "date=YYYY-MM-DD" }); return; }
  const from = new Date(`${day}T00:00:00+03:00`);
  const to = new Date(from.getTime() + 86_400_000);
  const rows = await db.select({ id: academySessionsTable.id, type: academySessionsTable.type, startsAt: academySessionsTable.startsAt, opponent: academySessionsTable.opponent })
    .from(academySessionsTable)
    .where(and(eq(academySessionsTable.academyId, access.academyId), gte(academySessionsTable.startsAt, from), lt(academySessionsTable.startsAt, to)));
  res.json({ sessions: rows.map((r) => ({ ...r, startsAt: r.startsAt.toISOString() })) });
});

export default router;
