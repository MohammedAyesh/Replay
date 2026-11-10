import fs from "node:fs";
import os from "node:os";
import { Router, type IRouter, type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { eq, like, or } from "drizzle-orm";
import { z } from "zod";
import { academyAdMediaTable, db, recordingsTable } from "@workspace/db";
import { academyClip, academyRecording } from "../lib/creative/renderMedia";
import { clipSpan } from "../lib/creative/clipSpan";
import { centreFraming, clipFallback, framingFor, recordingBall, type FramingAnswer } from "../lib/creative/framing";
import { playerFollowFraming } from "../lib/creative/playerFraming";
import { extractBunnyVideoId } from "../lib/publicFootage";
import { CREATIVE_BASE, creativeOwner, projectIdParam } from "../lib/creative/projects";
import { parseLibraryFilters } from "../lib/creative/library";
import { libraryClips, libraryMatches, libraryPlayerMedia, libraryPlayers, librarySessionMoments, libraryUpload, libraryUploads } from "../lib/creative/libraryData";
import { logger } from "../lib/logger";
import { MAX_IMAGE_BYTES, MAX_VIDEO_BYTES, probeVideo, storeVideo, videoStill } from "../lib/meta/media";
import { namesAllowed } from "./academyStudio";
import { venueFieldIds, venueLibraryClips, venueLibraryMatches, venueRecordingMoments } from "../lib/creative/venueLibrary";

/**
 * Creative hub → Library (owner only). What a post, story or video can be made
 * from, all of it the academy's own:
 *
 *   GET  …/creative/library/matches                       sessions with the academy's footage
 *   GET  …/creative/library/matches/:sessionId/moments    goals, chances, highlights, saved moments
 *   GET  …/creative/library/clips                         clips the academy's members made
 *   GET  …/creative/library/uploads                       photos and videos (shared with Ads → Media)
 *   POST …/creative/library/uploads                       add a photo or a short video
 *   GET  …/creative/library/players                       shirt numbers (first names if allowed), squads, primary photos (names allowed)
 *   GET  …/creative/library/players/:playerId/media       the Player picker: his photos (names allowed), clips, match moments
 *
 * Filters (query): squadId, player (shirt number, "7" or "#7"), type
 * (goal,chance,highlight,saved), from / to (Amman days, YYYY-MM-DD), kind
 * (image|video, uploads), sessionType (match|training). Paging: offset, limit;
 * each list answers { total, nextOffset }.
 *
 * Players' names: the academy's own "show player names" setting is read here
 * for every request; without it a player is only a shirt number.
 */
const router: IRouter = Router();
const base = `${CREATIVE_BASE}/library`;

/** A Library video is a scene ingredient, so it is kept short (a scene is at most 3 minutes). */
export const LIBRARY_MAX_VIDEO_SECONDS = 180;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const VIDEO_TYPES = new Set(["video/mp4", "video/quicktime", "video/x-m4v", "video/webm", "video/3gpp"]);
// Ads → Media's limits and storage (lib/meta/media): the two share academy_ad_media.
const upload = multer({ dest: os.tmpdir(), limits: { fileSize: MAX_VIDEO_BYTES, files: 1 } });

function failed(res: Response, error: unknown, what: string) {
  logger.error({ error: (error as Error)?.message }, what);
  if (!res.headersSent) res.status(500).json({ error: "Something went wrong. Try again." });
}

router.get(`${base}/matches`, async (req, res): Promise<void> => {
  const access = await creativeOwner(req, res);
  if (!access) return;
  try {
    const fieldIds = await venueFieldIds(access.academyId);
    if (fieldIds) { res.json(await venueLibraryMatches(fieldIds, parseLibraryFilters(req.query as Record<string, unknown>))); return; }
    res.json(await libraryMatches(access.academyId, parseLibraryFilters(req.query as Record<string, unknown>)));
  } catch (error) {
    failed(res, error, "Creative library: matches failed");
  }
});

router.get(`${base}/matches/:sessionId/moments`, async (req, res): Promise<void> => {
  const access = await creativeOwner(req, res);
  if (!access) return;
  const sessionId = projectIdParam(req.params.sessionId);
  if (!sessionId) { res.status(400).json({ error: "Invalid session id" }); return; }
  try {
    const fieldIds = await venueFieldIds(access.academyId);
    if (fieldIds) {
      // A field's "match" is one of its recordings.
      const out = await venueRecordingMoments(fieldIds, sessionId, parseLibraryFilters(req.query as Record<string, unknown>, { limit: 40, maxLimit: 120 }));
      if (!out) { res.status(404).json({ error: "Not found" }); return; }
      res.json(out);
      return;
    }
    const showNames = await namesAllowed(access.academyId);
    const out = await librarySessionMoments(access.academyId, sessionId, parseLibraryFilters(req.query as Record<string, unknown>, { limit: 40, maxLimit: 120 }), showNames);
    if (!out) { res.status(404).json({ error: "Not found" }); return; }
    res.json(out);
  } catch (error) {
    failed(res, error, "Creative library: moments failed");
  }
});

router.get(`${base}/clips`, async (req, res): Promise<void> => {
  const access = await creativeOwner(req, res);
  if (!access) return;
  try {
    const fieldIds = await venueFieldIds(access.academyId);
    if (fieldIds) {
      const origin = req.query.origin === "auto" || req.query.origin === "player" ? req.query.origin : null;
      const sort = req.query.sort === "match" || req.query.sort === "player" ? req.query.sort : "newest";
      res.json(await venueLibraryClips(access.academyId, fieldIds, parseLibraryFilters(req.query as Record<string, unknown>), origin, sort));
      return;
    }
    const showNames = await namesAllowed(access.academyId);
    res.json(await libraryClips(access.academyId, parseLibraryFilters(req.query as Record<string, unknown>), showNames));
  } catch (error) {
    failed(res, error, "Creative library: clips failed");
  }
});

const framingBody = z.object({
  src: z.union([
    z.object({ type: z.literal("recording"), recordingId: z.number().int().positive(), fromMs: z.number().min(0), toMs: z.number().min(0) }),
    z.object({ type: z.literal("clip"), clipId: z.number().int().positive() }),
  ]),
  /** Follow this academy player (his match track) instead of the ball, where the analysis has him. */
  followPlayerId: z.number().int().positive().optional(),
});

/** Follow the player when asked and he is in sight, else the ball (or the fallback). */
async function framingWith(
  academyId: number,
  recordingId: number | null,
  fromMs: number,
  toMs: number,
  followPlayerId: number | undefined,
  fallback?: Parameters<typeof framingFor>[3],
): Promise<FramingAnswer | (Omit<FramingAnswer, "source"> & { source: "player" })> {
  if (recordingId && followPlayerId) {
    const followed = await playerFollowFraming(academyId, recordingId, followPlayerId, fromMs, toMs);
    if (followed) return { framing: followed.framing, source: "player", coverage: followed.coverage };
  }
  return framingFor(recordingId, fromMs, toMs, fallback);
}

/**
 * POST …/creative/library/framing  { src: recording window | clip, followPlayerId? }
 * A camera following the ball through it (keys relative to the source's start),
 * else the clip's own camera path, else the middle. Also says where a clip sits
 * in its recording, so the editor can move its start and end.
 */
router.post(`${base}/framing`, async (req, res): Promise<void> => {
  const access = await creativeOwner(req, res);
  if (!access) return;
  const body = framingBody.safeParse(req.body ?? {});
  if (!body.success) { res.status(400).json({ error: "Pick a clip or a moment" }); return; }
  try {
    const src = body.data.src;
    if (src.type === "recording") {
      if (src.toMs <= src.fromMs || src.toMs - src.fromMs > 10 * 60_000) { res.status(400).json({ error: "That stretch is too long" }); return; }
      const rec = await academyRecording(access.academyId, src.recordingId);
      if (!rec) { res.status(404).json({ error: "Not found" }); return; }
      res.json({ ...(await framingWith(access.academyId, rec.id, src.fromMs, src.toMs, body.data.followPlayerId)), ball: await ballThrough(rec.id, src.fromMs, src.toMs) });
      return;
    }
    const clip = await academyClip(access.academyId, src.clipId);
    if (!clip) { res.status(404).json({ error: "Not found" }); return; }
    const span = await clipSpan(clip);
    if (!span) { res.json({ ...centre(), window: null }); return; }
    const recordingId = clip.sourceRecordingId ?? (await recordingOfVideo(clip.videoId));
    const owned = recordingId && (await academyRecording(access.academyId, recordingId)) ? recordingId : null;
    const answer = await framingWith(access.academyId, owned, span.startSec * 1000, span.endSec * 1000, body.data.followPlayerId, clipFallback(clip, span.endSec - span.startSec));
    res.json({
      ...answer,
      ball: owned ? await ballThrough(owned, span.startSec * 1000, span.endSec * 1000) : [],
      // The clip's stretch of its recording: "Make a video" starts from this window, so its start and end can move.
      window: recordingId ? { recordingId, fromMs: Math.round(span.startSec * 1000), toMs: Math.round(span.endSec * 1000) } : null,
    });
  } catch (error) {
    failed(res, error, "Creative library: framing failed");
  }
});

const centre = () => ({ framing: centreFraming(), source: "centre" as const, coverage: 0 });

/** The ball path through [fromMs, toMs] of a recording, as [seconds from fromMs, x, y], for the framer's red trail preview. */
async function ballThrough(recordingId: number, fromMs: number, toMs: number): Promise<Array<[number, number, number]>> {
  const samples = await recordingBall(recordingId).catch(() => null);
  if (!samples?.length) return [];
  const from = fromMs / 1000 - 1;
  const to = toMs / 1000 + 1;
  return samples
    .filter((s) => s[0] >= from && s[0] <= to)
    .map((s) => [Math.round((s[0] - fromMs / 1000) * 100) / 100, s[1], s[2]] as [number, number, number]);
}

async function recordingOfVideo(videoId: string): Promise<number | null> {
  const rows = await db.select({ id: recordingsTable.id, videoUrl: recordingsTable.videoUrl }).from(recordingsTable)
    .where(or(like(recordingsTable.videoUrl, `%/${videoId}/%`), eq(recordingsTable.videoUrl, videoId))).limit(5);
  return rows.find((r) => extractBunnyVideoId(r.videoUrl)?.toLowerCase() === videoId.toLowerCase())?.id ?? null;
}

router.get(`${base}/uploads`, async (req, res): Promise<void> => {
  const access = await creativeOwner(req, res);
  if (!access) return;
  try {
    const phase = typeof req.query.phase === "string" && ["before", "during", "after", "unlinked"].includes(req.query.phase) ? req.query.phase : null;
    const sessionId = Number(req.query.sessionId);
    res.json(await libraryUploads(access.academyId, parseLibraryFilters(req.query as Record<string, unknown>), {
      phase, sessionId: Number.isSafeInteger(sessionId) && sessionId > 0 ? sessionId : null,
    }));
  } catch (error) {
    failed(res, error, "Creative library: uploads failed");
  }
});

router.post(`${base}/uploads`, async (req: Request, res: Response, next: NextFunction) => {
  // Who it is first: nothing is written to disk for someone who can't upload here.
  const access = await creativeOwner(req, res).catch((error) => { next(error); return null; });
  if (!access) return;
  res.locals.creativeAccess = access;
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
  try {
    const access = res.locals.creativeAccess as { user: { id: number }; academyId: number };
    if (!file) { res.status(400).json({ error: "Choose a photo or a video" }); return; }
    const name = (typeof req.body?.name === "string" && req.body.name.trim() ? req.body.name.trim() : file.originalname || "").slice(0, 120);
    if (IMAGE_TYPES.has(file.mimetype)) {
      if (file.size > MAX_IMAGE_BYTES) { res.status(413).json({ error: `Photos can be at most ${MAX_IMAGE_BYTES / 1024 / 1024} MB` }); return; }
      const bytes = await fs.promises.readFile(file.path);
      const width = Number(req.body?.width) || null;
      const height = Number(req.body?.height) || null;
      const [row] = await db.insert(academyAdMediaTable).values({
        academyId: access.academyId,
        kind: "image",
        name,
        source: "upload",
        imageData: `data:${file.mimetype};base64,${bytes.toString("base64")}`,
        bytes: file.size,
        width: width && width > 0 ? Math.round(width) : null,
        height: height && height > 0 ? Math.round(height) : null,
        status: "ready",
        createdBy: access.user.id,
      }).returning();
      const { imageData, ...rest } = row;
      res.status(201).json({ upload: libraryUpload({ ...rest, hasImage: Boolean(imageData) }) });
      return;
    }
    if (VIDEO_TYPES.has(file.mimetype) || /\.(mp4|mov|m4v|webm|3gp)$/i.test(file.originalname ?? "")) {
      const facts = await probeVideo(file.path).catch(() => null);
      if (!facts) { res.status(400).json({ error: "That file isn't a video we can read. Export it from your phone as MP4 and try again." }); return; }
      if (facts.durationSec && facts.durationSec > LIBRARY_MAX_VIDEO_SECONDS) {
        res.status(400).json({ error: `Videos here can be at most ${LIBRARY_MAX_VIDEO_SECONDS / 60} minutes long.` });
        return;
      }
      const still = await videoStill(file.path, facts.durationSec);
      const storageUrl = await storeVideo(access.academyId, file.path);
      const [row] = await db.insert(academyAdMediaTable).values({
        academyId: access.academyId,
        kind: "video",
        name,
        source: "upload",
        imageData: still,
        storageUrl,
        bytes: file.size,
        width: facts.width,
        height: facts.height,
        durationSec: facts.durationSec,
        status: "ready",
        createdBy: access.user.id,
      }).returning();
      const { imageData, ...rest } = row;
      res.status(201).json({ upload: libraryUpload({ ...rest, hasImage: Boolean(imageData) }) });
      return;
    }
    res.status(400).json({ error: "Use a JPG or PNG photo, or an MP4 or MOV video" });
  } catch (error) {
    failed(res, error, "Creative library: upload failed");
  } finally {
    if (file) await fs.promises.rm(file.path, { force: true });
  }
});

router.get(`${base}/players`, async (req, res): Promise<void> => {
  const access = await creativeOwner(req, res);
  if (!access) return;
  try {
    const showNames = await namesAllowed(access.academyId);
    const f = parseLibraryFilters(req.query as Record<string, unknown>);
    res.json(await libraryPlayers(access.academyId, f.squadId, showNames));
  } catch (error) {
    failed(res, error, "Creative library: players failed");
  }
});

router.get(`${base}/players/:playerId/media`, async (req, res): Promise<void> => {
  const access = await creativeOwner(req, res);
  if (!access) return;
  const playerId = projectIdParam(req.params.playerId);
  if (!playerId) { res.status(400).json({ error: "Invalid player id" }); return; }
  try {
    const out = await libraryPlayerMedia(access.academyId, playerId, await namesAllowed(access.academyId));
    if (!out) { res.status(404).json({ error: "Not found" }); return; }
    res.setHeader("Cache-Control", "private, no-store");
    res.json(out);
  } catch (error) {
    failed(res, error, "Creative library: player media failed");
  }
});

export default router;
