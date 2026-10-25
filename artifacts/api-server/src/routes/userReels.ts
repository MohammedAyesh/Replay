/**
 * Highlight reels (2026-10-25): a player joins several of his own clips into
 * one video. Mohammed: "give the user the option to make a highlight reel of
 * different clips and have the overlay show at the end".
 *
 * Each clip is rendered from its recording with its own window and crop and
 * the venue's overlay; only the last one gets the end screen, after its end,
 * over the footage that follows it. The pieces share one encode spec, so they
 * join with the concat demuxer without a second encode.
 *
 * The end screen is the last clip's venue and match, with the reel's own card
 * and numbers choice; its QR opens the last clip's share card (a reel has no
 * public page of its own).
 */
import { Router, type IRouter } from "express";
import { randomBytes } from "crypto";
import { pipeline } from "stream/promises";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { db, userClipsTable, userReelsTable, type UserReelRow } from "@workspace/db";
import { getLocalUserId, unauthenticatedResponse } from "../lib/clerkUserBridge";
import { toQuotaResponse } from "../lib/downloadQuota";
import { logger } from "../lib/logger";
import {
  BUNNY_CDN_HOSTNAME,
  BunnyVideoNotFoundError,
  bunnyStorageUrlFor,
  getBunnyVideoInfo,
  isBunnyConfigured,
  isBunnyStorageConfigured,
  uploadFileToBunnyStoragePath,
  deleteBunnyStoragePath,
} from "../lib/bunny";
import { bufferRemoteClip, cleanupTempFile, concatSegments, renderClip } from "../lib/ffmpegExport";
import { selectExportSource } from "../lib/exportSource";
import { renderQueue } from "../lib/renderQueue";
import { fetchBrandingAsset } from "../lib/brandingFetch";
import { fetchExportObject, forwardExportContentLength } from "../lib/backupExport";
import { CLIP_PLAYBACK_RANGE_MAX_BYTES, planExportRange, sendBoundedExport } from "../lib/exportPlayback";
import { cleanChoice, endScreenFor, endScreenOptions, planClipBranding, publicBase } from "../lib/clipBranding/plan";
import { PREVIEW_DIMS, renderPreviewPng } from "../lib/clipBranding/preview";
import { MAX_CARD_STATS } from "../lib/clipBranding/types";
import { shareCardPath } from "../lib/shareCard";
import {
  fieldIdForClip,
  isLiveVideoId,
  isSoftDeletedClip,
  normalizeExportWindow,
  readableFromUpstream,
  reserveReelDownload,
  resolveBrandingForClip,
} from "./userClips";

const router: IRouter = Router();

export const REEL_MIN_CLIPS = 2;
export const REEL_MAX_CLIPS = 10;
/** Longest reel, in seconds of the clips themselves (the end screen is extra). */
export const REEL_MAX_SECONDS = Math.max(30, Number(process.env.REEL_MAX_SECONDS) || 180);
/** Reels one player can have being made at once, and in all. */
export const REEL_MAX_PENDING = 3;
export const REEL_MAX_TOTAL = 50;
/** A pending reel nobody has touched for this long lost its render (a restart). */
const STALE_PENDING_MS = 10 * 60_000;

type ClipRow = typeof userClipsTable.$inferSelect;

/** Reels being rendered in this process. */
const rendering = new Set<number>();
/** Reels whose end screen changed mid-render: render again when it ends. */
const renderAgain = new Set<number>();

/** A stable reason the app can show in the player's language. */
function errorCodeOf(reel: UserReelRow): string | null {
  if (reel.exportStatus === "expired") return "source_gone";
  if (!reel.exportError) return null;
  if (/deleted/i.test(reel.exportError)) return "clip_deleted";
  if (/seconds at most/i.test(reel.exportError)) return "too_long";
  if (/could not be applied/i.test(reel.exportError)) return "change_failed";
  return "failed";
}

function publicReel(reel: UserReelRow) {
  return {
    id: reel.id,
    title: reel.title,
    clipIds: reel.clipIds,
    aspectRatio: reel.aspectRatio,
    endScreen: cleanChoice(reel.endScreen),
    status: reel.exportStatus ?? "pending",
    error: reel.exportError,
    errorCode: errorCodeOf(reel),
    durationSec: reel.durationSec,
    createdAt: reel.createdAt,
    updatedAt: reel.updatedAt,
  };
}

async function ownReel(userId: number, rawId: unknown): Promise<UserReelRow | null> {
  const id = parseInt(String(Array.isArray(rawId) ? rawId[0] : rawId), 10);
  if (isNaN(id)) return null;
  const [reel] = await db.select().from(userReelsTable)
    .where(and(eq(userReelsTable.id, id), eq(userReelsTable.userId, userId), isNull(userReelsTable.deletedAt)));
  return reel ?? null;
}

/** The reel's clips in its order; null if any is gone or not his. */
async function reelClips(userId: number, clipIds: number[]): Promise<ClipRow[] | null> {
  if (!clipIds.length) return null;
  const rows = await db.select().from(userClipsTable)
    .where(and(inArray(userClipsTable.id, clipIds), eq(userClipsTable.userId, userId)));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const ordered = clipIds.map((id) => byId.get(id));
  if (ordered.some((c) => !c || isSoftDeletedClip(c) || isLiveVideoId(c.videoId))) return null;
  return ordered as ClipRow[];
}

/** The branding identity of a clip; the last clip carries the reel's end screen choice. */
function brandingClip(clip: ClipRow, endScreen?: unknown) {
  return {
    id: clip.id,
    userId: clip.userId,
    academyId: clip.academyId,
    matchCode: clip.matchCode,
    footageRequestId: clip.footageRequestId,
    endScreen: endScreen === undefined ? clip.endScreen : endScreen,
  };
}

class ReelSourceGone extends Error {}

/**
 * Render the reel and return the local file. Every clip is required: a reel
 * missing a clip is not the reel he made, so any clip that cannot be rendered
 * fails it (with a message saying which).
 */
async function renderReel(reel: UserReelRow, clips: ClipRow[]): Promise<{ path: string; seconds: number }> {
  const portrait = reel.aspectRatio === "9:16";
  const referer = `https://${BUNNY_CDN_HOSTNAME}/`;
  const parts: string[] = [];
  const temps: string[] = [];
  let seconds = 0;
  try {
    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i];
      const last = i === clips.length - 1;
      let info: Awaited<ReturnType<typeof getBunnyVideoInfo>>;
      try {
        info = await getBunnyVideoInfo(clip.videoId);
      } catch (err) {
        // Only a recording Bunny says is gone is gone; anything else can be retried.
        if (err instanceof BunnyVideoNotFoundError) {
          throw new ReelSourceGone(`The recording behind "${clip.title}" is no longer available`, { cause: err });
        }
        throw err;
      }
      const window = normalizeExportWindow(parseFloat(clip.startTime), parseFloat(clip.endTime), info.duration);
      if (window.clipDuration <= 0) throw new Error(`"${clip.title}" has no footage`);
      seconds += window.clipDuration;
      if (seconds > REEL_MAX_SECONDS) throw new Error(`A reel can be ${REEL_MAX_SECONDS} seconds at most`);

      const source = await selectExportSource({
        videoId: clip.videoId,
        hasMP4Fallback: info.hasMP4Fallback,
        availableResolutions: info.availableResolutions,
        referer,
      });
      const buffer = await bufferRemoteClip({
        remoteUrl: source.url,
        referer,
        startSec: window.startSec,
        clipDuration: window.clipDuration,
        totalDuration: info.duration,
      });
      temps.push(buffer.bufferPath);

      const fieldId = await fieldIdForClip(clip.id);
      const ctx = { academyId: clip.academyId, fieldId, userId: clip.userId };
      const uploaded = await resolveBrandingForClip(clip.academyId, fieldId, ctx);
      const drawn = await planClipBranding(
        brandingClip(clip, last ? reel.endScreen : undefined),
        fieldId,
        portrait,
        ctx,
        { noEndScreen: !last },
      );
      temps.push(...drawn.temps);
      const [overlayPath, endCardPath] = await Promise.all([
        drawn.overlayPath ? Promise.resolve(null) : fetchBrandingAsset(uploaded.overlayUrl, "overlay", { referer: uploaded.brandingReferer }),
        last && !drawn.endScreen ? fetchBrandingAsset(uploaded.endCardUrl, "end card", { referer: uploaded.brandingReferer }) : Promise.resolve(null),
      ]);
      for (const [remote, local] of [[uploaded.overlayUrl, overlayPath], [uploaded.endCardUrl, endCardPath]] as const) {
        if (local && local !== remote) temps.push(local);
      }
      const options = {
        videoUrl: buffer.bufferPath,
        totalDuration: buffer.bufferedDuration,
        startTime: 0,
        endTime: Math.min(1, window.clipDuration / buffer.bufferedDuration),
        cropPath: (clip.cropPath ?? []) as { t: number; x: number; y: number; w: number; h: number }[],
        aspectRatio: reel.aspectRatio,
        title: clip.title,
        normalizeAudio: true,
      };
      let part: string;
      try {
        part = await renderClip({
          ...options,
          overlayUrl: drawn.overlayPath ?? overlayPath ?? undefined,
          endScreen: last ? drawn.endScreen ?? undefined : undefined,
          endCardUrl: endCardPath ?? undefined,
        });
      } catch (err) {
        // Branding never costs the reel: one more try with none.
        logger.error({ err, reelId: reel.id, clipId: clip.id }, "Branded reel piece failed — rendering it plain");
        part = await renderClip(options);
      }
      parts.push(part);
      // Done with this clip's source: do not hold ten of them on disk.
      cleanupTempFile(buffer.bufferPath);
      temps.splice(temps.indexOf(buffer.bufferPath), 1);
    }
    const joined = await concatSegments(parts);
    return { path: joined, seconds };
  } finally {
    for (const p of [...parts, ...temps]) cleanupTempFile(p);
  }
}

async function runReelRender(reelId: number): Promise<void> {
  if (rendering.has(reelId)) { renderAgain.add(reelId); return; }
  rendering.add(reelId);
  let out: string | null = null;
  // Keeps updatedAt fresh while it waits and renders, so no other instance
  // takes it for a lost render and starts a second one.
  const heartbeat = setInterval(() => {
    void db.update(userReelsTable).set({ updatedAt: new Date() })
      .where(and(eq(userReelsTable.id, reelId), eq(userReelsTable.exportStatus, "pending"))).catch(() => {});
  }, 60_000);
  heartbeat.unref();
  let previousPath: string | null = null;
  try {
    await renderQueue.run(`reel-${reelId}`, async () => {
      const [reel] = await db.select().from(userReelsTable).where(eq(userReelsTable.id, reelId));
      if (!reel || reel.deletedAt) return;
      previousPath = reel.exportPath;
      const clips = await reelClips(reel.userId, reel.clipIds);
      if (!clips) {
        await db.update(userReelsTable).set({ exportStatus: "error", exportError: "One of the clips in this reel was deleted", updatedAt: new Date() })
          .where(eq(userReelsTable.id, reelId));
        return;
      }
      logger.info({ reelId, clips: reel.clipIds }, "Rendering highlight reel");
      const rendered = await renderReel(reel, clips);
      out = rendered.path;
      const remote = `reels/r${reel.id}-${randomBytes(10).toString("hex")}.mp4`;
      await uploadFileToBunnyStoragePath(rendered.path, remote);
      const [current] = await db.update(userReelsTable)
        .set({ exportStatus: "done", exportPath: remote, exportError: null, durationSec: Math.round(rendered.seconds), updatedAt: new Date() })
        .where(and(eq(userReelsTable.id, reelId), isNull(userReelsTable.deletedAt)))
        .returning({ id: userReelsTable.id });
      if (reel.exportPath && reel.exportPath !== remote) {
        await deleteBunnyStoragePath(reel.exportPath).catch((err) => logger.warn({ err, reelId }, "Could not delete the reel's previous file"));
      }
      if (!current) await deleteBunnyStoragePath(remote).catch(() => {});
      logger.info({ reelId, seconds: rendered.seconds }, "Highlight reel ready");
    });
  } catch (err) {
    const gone = err instanceof ReelSourceGone;
    const message = err instanceof Error ? err.message.slice(0, 300) : "The reel could not be made";
    logger.error({ err, reelId }, "Highlight reel render failed");
    // A change that failed on a reel that already has a good file keeps that
    // file playable; the player is told his last change did not apply.
    await db.update(userReelsTable).set(previousPath
      ? { exportStatus: "done", exportError: `Your last change could not be applied: ${message}`.slice(0, 300), updatedAt: new Date() }
      : { exportStatus: gone ? "expired" : "error", exportError: message, updatedAt: new Date() })
      .where(eq(userReelsTable.id, reelId)).catch(() => {});
  } finally {
    clearInterval(heartbeat);
    if (out) cleanupTempFile(out);
    rendering.delete(reelId);
    if (renderAgain.delete(reelId)) void queueReelRender(reelId);
  }
}

/** Pick up pending reels whose render was lost (a restart, another instance gone). */
function resumeStale(reels: UserReelRow[]): void {
  for (const reel of reels) {
    if (reel.exportStatus === "pending" && !rendering.has(reel.id)
      && Date.now() - reel.updatedAt.getTime() > STALE_PENDING_MS) {
      void queueReelRender(reel.id);
    }
  }
}

async function queueReelRender(reelId: number): Promise<void> {
  await db.update(userReelsTable).set({ exportStatus: "pending", exportError: null, updatedAt: new Date() })
    .where(eq(userReelsTable.id, reelId));
  void runReelRender(reelId);
}

function parseChoice(raw: unknown): { ok: true; choice: ReturnType<typeof cleanChoice> | null } | { ok: false; error: string } {
  if (raw == null) return { ok: true, choice: null };
  if (typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "Unknown end screen" };
  const r = raw as Record<string, unknown>;
  const choice = cleanChoice(r);
  if (r.card != null && r.card !== "auto" && choice.card === undefined) return { ok: false, error: "Unknown card" };
  if (Array.isArray(r.stats) && (choice.stats?.length ?? 0) !== new Set(r.stats).size) {
    return { ok: false, error: `Pick up to ${MAX_CARD_STATS} numbers from the list` };
  }
  return { ok: true, choice: choice.card === undefined && !choice.stats ? null : choice };
}

router.post("/user-reels", async (req, res): Promise<void> => {
  const userId = await getLocalUserId(req);
  if (!userId) { unauthenticatedResponse(res, req); return; }
  if (!isBunnyConfigured() || !isBunnyStorageConfigured()) {
    res.status(503).json({ error: "Reels are not available on this server" });
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const title = typeof body.title === "string" && body.title.trim() ? body.title.trim().slice(0, 80) : "My highlights";
  const clipIds = Array.isArray(body.clipIds) ? body.clipIds.map((v) => Number(v)) : [];
  if (clipIds.some((v) => !Number.isInteger(v) || v <= 0) || new Set(clipIds).size !== clipIds.length) {
    res.status(400).json({ error: "Each clip can be in a reel once" });
    return;
  }
  if (clipIds.length < REEL_MIN_CLIPS || clipIds.length > REEL_MAX_CLIPS) {
    res.status(400).json({ error: `Pick ${REEL_MIN_CLIPS} to ${REEL_MAX_CLIPS} clips` });
    return;
  }
  const choice = parseChoice(body.endScreen);
  if (!choice.ok) { res.status(400).json({ error: choice.error }); return; }
  const clips = await reelClips(userId, clipIds);
  if (!clips) { res.status(400).json({ error: "Only your own saved clips can go in a reel" }); return; }
  const shapes = new Set(clips.map((c) => (c.aspectRatio === "9:16" ? "9:16" : "16:9")));
  // A render holds a slot for every clip in it: a few at a time per player.
  const mine = await db.select({ status: userReelsTable.exportStatus }).from(userReelsTable)
    .where(and(eq(userReelsTable.userId, userId), isNull(userReelsTable.deletedAt)));
  if (mine.length >= REEL_MAX_TOTAL) { res.status(429).json({ error: `You can keep ${REEL_MAX_TOTAL} reels. Delete one to make another.` }); return; }
  if (mine.filter((r) => r.status === "pending").length >= REEL_MAX_PENDING) {
    res.status(429).json({ error: "Wait for your reels being made to finish first." });
    return;
  }
  if (shapes.size > 1) { res.status(400).json({ error: "Pick clips of one shape: all vertical or all wide" }); return; }
  const [reel] = await db.insert(userReelsTable).values({
    userId,
    title,
    clipIds,
    aspectRatio: [...shapes][0],
    endScreen: choice.choice,
    exportStatus: "pending",
  }).returning();
  void runReelRender(reel.id);
  res.status(201).json(publicReel(reel));
});

router.get("/user-reels", async (req, res): Promise<void> => {
  const userId = await getLocalUserId(req);
  if (!userId) { unauthenticatedResponse(res, req); return; }
  const reels = await db.select().from(userReelsTable)
    .where(and(eq(userReelsTable.userId, userId), isNull(userReelsTable.deletedAt)))
    .orderBy(desc(userReelsTable.createdAt));
  resumeStale(reels);
  res.json(reels.map(publicReel));
});

router.get("/user-reels/:id", async (req, res): Promise<void> => {
  const userId = await getLocalUserId(req);
  if (!userId) { unauthenticatedResponse(res, req); return; }
  const reel = await ownReel(userId, req.params.id);
  if (!reel) { res.status(404).json({ error: "Reel not found" }); return; }
  // A render this process lost (a restart) is picked up again when looked at.
  resumeStale([reel]);
  res.json(publicReel(reel));
});

router.patch("/user-reels/:id", async (req, res): Promise<void> => {
  const userId = await getLocalUserId(req);
  if (!userId) { unauthenticatedResponse(res, req); return; }
  const reel = await ownReel(userId, req.params.id);
  if (!reel) { res.status(404).json({ error: "Reel not found" }); return; }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const set: Partial<typeof userReelsTable.$inferInsert> = { updatedAt: new Date() };
  if (typeof body.title === "string" && body.title.trim()) set.title = body.title.trim().slice(0, 80);
  let rerender = false;
  if ("endScreen" in body) {
    const choice = parseChoice(body.endScreen);
    if (!choice.ok) { res.status(400).json({ error: choice.error }); return; }
    if (JSON.stringify(cleanChoice(reel.endScreen)) !== JSON.stringify(cleanChoice(choice.choice))) {
      set.endScreen = choice.choice;
      rerender = true;
    }
  }
  const [updated] = await db.update(userReelsTable).set(set).where(eq(userReelsTable.id, reel.id)).returning();
  if (rerender) await queueReelRender(reel.id);
  res.json(publicReel(rerender ? { ...updated, exportStatus: "pending" } : updated));
});

router.post("/user-reels/:id/retry", async (req, res): Promise<void> => {
  const userId = await getLocalUserId(req);
  if (!userId) { unauthenticatedResponse(res, req); return; }
  const reel = await ownReel(userId, req.params.id);
  if (!reel) { res.status(404).json({ error: "Reel not found" }); return; }
  if (reel.exportStatus !== "error" && !(reel.exportStatus === "done" && reel.exportError)) {
    res.status(409).json({ error: "This reel is not waiting for a retry" });
    return;
  }
  await queueReelRender(reel.id);
  res.json(publicReel({ ...reel, exportStatus: "pending" }));
});

router.delete("/user-reels/:id", async (req, res): Promise<void> => {
  const userId = await getLocalUserId(req);
  if (!userId) { unauthenticatedResponse(res, req); return; }
  const reel = await ownReel(userId, req.params.id);
  if (!reel) { res.status(404).json({ error: "Reel not found" }); return; }
  await db.update(userReelsTable).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(userReelsTable.id, reel.id));
  if (reel.exportPath) {
    await deleteBunnyStoragePath(reel.exportPath).catch((err) => logger.warn({ err, reelId: reel.id }, "Could not delete a deleted reel's file"));
  }
  res.status(204).end();
});

// ── Its end screen: the same choices a clip has, for the reel's last clip ──

router.get("/user-reels/:id/end-screen", async (req, res): Promise<void> => {
  const userId = await getLocalUserId(req);
  if (!userId) { unauthenticatedResponse(res, req); return; }
  const reel = await ownReel(userId, req.params.id);
  if (!reel) { res.status(404).json({ error: "Reel not found" }); return; }
  const clips = await reelClips(userId, reel.clipIds);
  if (!clips) { res.json({ enabled: false, seconds: 3, choice: {}, current: null, cards: [], stats: [] }); return; }
  const last = clips[clips.length - 1];
  const fieldId = await fieldIdForClip(last.id);
  res.json(await endScreenOptions(brandingClip(last, reel.endScreen), fieldId,
    { academyId: last.academyId, fieldId, userId }));
});

/**
 * The end screen options for clips not yet in a reel (the builder, before
 * the reel exists): GET /user-reels-draft/end-screen?clipIds=1,2,3.
 */
router.get("/user-reels-draft/end-screen", async (req, res): Promise<void> => {
  const userId = await getLocalUserId(req);
  if (!userId) { unauthenticatedResponse(res, req); return; }
  const ids = String(req.query.clipIds ?? "").split(",").map(Number).filter((v) => Number.isInteger(v) && v > 0);
  const clips = await reelClips(userId, ids.slice(0, REEL_MAX_CLIPS));
  if (!clips) { res.status(400).json({ error: "Only your own saved clips can go in a reel" }); return; }
  const last = clips[clips.length - 1];
  const fieldId = await fieldIdForClip(last.id);
  res.json(await endScreenOptions(brandingClip(last, null), fieldId, { academyId: last.academyId, fieldId, userId }));
});

router.get("/user-reels-draft/end-screen/preview.png", async (req, res): Promise<void> => {
  const userId = await getLocalUserId(req);
  if (!userId) { unauthenticatedResponse(res, req); return; }
  const ids = String(req.query.clipIds ?? "").split(",").map(Number).filter((v) => Number.isInteger(v) && v > 0);
  const clips = await reelClips(userId, ids.slice(0, REEL_MAX_CLIPS));
  if (!clips) { res.status(400).json({ error: "Only your own saved clips can go in a reel" }); return; }
  const last = clips[clips.length - 1];
  const q = req.query as Record<string, unknown>;
  const choice = cleanChoice({
    card: typeof q.card === "string" ? q.card : undefined,
    stats: typeof q.stats === "string" && q.stats ? q.stats.split(",") : undefined,
  });
  const fieldId = await fieldIdForClip(last.id);
  const temps: string[] = [];
  try {
    const card = await endScreenFor(brandingClip(last, choice), fieldId, { academyId: last.academyId, fieldId, userId }, temps,
      `${publicBase()}${shareCardPath(last.id)}`);
    if (!card) { res.status(404).json({ error: "These clips have no end screen" }); return; }
    const png = await renderPreviewPng({
      look: card.spec.look, what: card.spec.kind, blur: card.blur, dim: card.dim, spec: card.spec,
      dims: PREVIEW_DIMS[last.aspectRatio === "9:16" ? "9:16" : "16:9"],
    });
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "private, max-age=60");
    res.send(png);
  } catch (err) {
    logger.error({ err }, "Could not draw the reel end screen preview");
    if (!res.headersSent) res.status(500).json({ error: "Preview failed" });
  } finally {
    for (const t of temps) cleanupTempFile(t);
  }
});

// ── Watching and saving it ──

router.get("/user-reels/:id/playback", async (req, res): Promise<void> => {
  const userId = await getLocalUserId(req);
  if (!userId) { unauthenticatedResponse(res, req); return; }
  const reel = await ownReel(userId, req.params.id);
  if (!reel || reel.exportStatus !== "done" || !reel.exportPath) { res.status(404).json({ error: "Reel not ready" }); return; }
  // Bounded 206s only: the host refuses a Content-Length over 32 MiB.
  const plan = planExportRange(req.header("range") ?? undefined, CLIP_PLAYBACK_RANGE_MAX_BYTES);
  const abort = new AbortController();
  const abortUpstream = () => { if (!res.writableEnded && !abort.signal.aborted) abort.abort(); };
  res.once("close", abortUpstream);
  try {
    const upstream = await fetchExportObject(bunnyStorageUrlFor(reel.exportPath), { range: plan.upstreamRange, signal: abort.signal });
    if (upstream.status !== 416 && (!upstream.ok || !upstream.body)) {
      await upstream.body?.cancel().catch(() => {});
      res.status(502).json({ error: "Playback unavailable" });
      return;
    }
    const outcome = await sendBoundedExport(res, upstream, plan, {
      "Content-Type": "video/mp4",
      "Cache-Control": "private, no-store",
    });
    if (outcome === "unusable") {
      await upstream.body?.cancel().catch(() => {});
      res.status(502).json({ error: "Playback unavailable" });
    }
  } catch (err) {
    if (!abort.signal.aborted) logger.warn({ err, reelId: reel.id }, "Reel playback failed");
    if (!res.headersSent) res.status(502).json({ error: "Playback unavailable" });
  } finally {
    res.off("close", abortUpstream);
  }
});

/**
 * Each clip in the reel counts as a download (unless already downloaded in
 * the window): a reel is not a way round the allowance. See reserveReelDownload.
 */
router.get("/user-reels/:id/download", async (req, res): Promise<void> => {
  const userId = await getLocalUserId(req);
  if (!userId) { unauthenticatedResponse(res, req); return; }
  const reel = await ownReel(userId, req.params.id);
  if (!reel || reel.exportStatus !== "done" || !reel.exportPath) { res.status(404).json({ error: "Reel not ready" }); return; }
  const reservation = await reserveReelDownload(userId, reel.clipIds, new Date());
  if (reservation.outcome === "disabled") { res.status(403).json({ error: "Downloads are currently disabled" }); return; }
  if (reservation.outcome === "refused") {
    res.status(402).json({
      error: "Download limit reached",
      needed: reservation.needed,
      quota: toQuotaResponse(reservation.state),
    });
    return;
  }
  const abort = new AbortController();
  let nodeStream: ReturnType<typeof readableFromUpstream> | null = null;
  const abortUpstream = () => {
    if (!abort.signal.aborted) abort.abort();
    nodeStream?.destroy();
  };
  req.once("aborted", abortUpstream);
  res.once("close", abortUpstream);
  try {
    const upstream = await fetchExportObject(bunnyStorageUrlFor(reel.exportPath), { signal: abort.signal });
    if (!upstream.ok || !upstream.body) {
      await upstream.body?.cancel().catch(() => {});
      res.status(502).json({ error: "Download unavailable" });
      return;
    }
    // Titles are often Arabic: keep what is safe, else name it after the reel.
    const safeName = /[a-z0-9]/i.test(reel.title) ? reel.title.replace(/[^a-z0-9_\-]/gi, "_") : `reel-${reel.id}`;
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", `attachment; filename="${safeName}.mp4"`);
    forwardExportContentLength(res, upstream, false);
    nodeStream = readableFromUpstream(upstream.body as ReadableStream<Uint8Array>);
    await pipeline(nodeStream, res);
  } catch (err) {
    if (!abort.signal.aborted) logger.error({ err, reelId: reel.id }, "Reel download failed");
    if (!res.headersSent) res.status(502).json({ error: "Download failed" });
  } finally {
    req.off("aborted", abortUpstream);
    res.off("close", abortUpstream);
  }
});

/** For tests: whether a render is running. */
export function reelRendering(reelId: number): boolean {
  return rendering.has(reelId);
}

/** For tests. */
export { runReelRender };

export default router;
