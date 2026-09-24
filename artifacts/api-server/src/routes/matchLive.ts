import { Router, type IRouter, type Request, type Response } from "express";
import { Readable } from "node:stream";
import { and, eq } from "drizzle-orm";
import {
  db,
  userClipsTable,
} from "@workspace/db";
import {
  CreateMatchLiveClipBody,
  CreateMatchLiveClipParams,
  CreateMatchLiveClipResponse,
  GetMatchLiveClipStatusParams,
  GetMatchLiveClipStatusResponse,
} from "@workspace/api-zod";
import { getLocalUserRecord, unauthenticatedResponse } from "../lib/clerkUserBridge";
import { LIVE_CAMERA_UPSTREAM, parseLiveCamera } from "../lib/liveCameras";
import { loadRoomByCode, matchPhase, matchWindow, normalizeCode } from "../lib/matchRooms";
import { logger } from "../lib/logger";
import { controlFetch, controlResponse } from "./contabo";
import { queueUserClipExport } from "./userClips";

const router: IRouter = Router();
const RATE_WINDOW_MS = 60_000;
const RATE_DAY_MS = 24 * 60 * 60_000;
const rateBuckets = new Map<string, { count: number; resetAt: number }>();
const MAX_LIVE_CLIP_SECONDS = 10 * 60;
const MIN_LIVE_CLIP_SECONDS = 1;
export function isValidLiveClipDurationMs(durationMs: number): boolean {
  return Number.isFinite(durationMs)
    && durationMs >= MIN_LIVE_CLIP_SECONDS * 1000
    && durationMs <= MAX_LIVE_CLIP_SECONDS * 1000;
}
const PARTIAL_LIVE_CLIP_NOTICE =
  "Part of this moment wasn't recorded (camera gap) — the clip is shorter than you picked.";
const MAX_UNKNOWN_JOB_WAIT_MS = 60 * 60 * 1000;

type LiveVariant = "hls" | "hevc" | "pan";
type MatchLiveContext = NonNullable<Awaited<ReturnType<typeof loadRoomByCode>>>;

function requestParam(req: Request, name: string): string {
  const value = req.params[name];
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function consumeRateLimit(
  key: string,
  max: number,
  windowMs: number,
): { allowed: boolean; retryAfterSeconds: number } {
  const now = Date.now();
  let bucket = rateBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + windowMs };
    rateBuckets.set(key, bucket);
  }
  if (rateBuckets.size > 20_000) {
    for (const [entry, value] of rateBuckets) {
      if (value.resetAt <= now) rateBuckets.delete(entry);
    }
  }
  const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
  if (bucket.count >= max) return { allowed: false, retryAfterSeconds };
  bucket.count += 1;
  return { allowed: true, retryAfterSeconds };
}

export function resetMatchLiveRateLimits(): void {
  rateBuckets.clear();
}

function rateLimit(max: number, scope: string, message: string) {
  return (req: Request, res: Response, next: () => void): void => {
    const code = normalizeCode(requestParam(req, "code"));
    const client = req.ip || req.socket.remoteAddress || "unknown";
    const limit = consumeRateLimit(`${scope}:ip:${client}:${code}`, max, RATE_WINDOW_MS);
    if (!limit.allowed) {
      res.set("Retry-After", String(limit.retryAfterSeconds));
      res.status(429).json({ error: message });
      return;
    }
    next();
  };
}

function limitLiveClipSave(userId: number, res: Response): boolean {
  const minuteLimit = consumeRateLimit(`live-clips:user:${userId}:minute`, 20, RATE_WINDOW_MS);
  const limit = minuteLimit.allowed
    ? consumeRateLimit(`live-clips:user:${userId}:day`, 200, RATE_DAY_MS)
    : minuteLimit;
  if (!limit.allowed) {
    res.set("Retry-After", String(limit.retryAfterSeconds));
    res.status(429).json({ error: "Too many live match requests" });
    return false;
  }
  return true;
}

function liveVariant(value: string): LiveVariant | null {
  return value === "hls" || value === "hevc" || value === "pan" ? value : null;
}

function varCamera(camera: string): string {
  if (camera.startsWith("camera")) return camera.replace(/^camera/, "cam");
  return camera;
}

async function getMatchContext(req: Request, res: Response): Promise<MatchLiveContext | null> {
  const parsed = CreateMatchLiveClipParams.safeParse({ code: normalizeCode(requestParam(req, "code")) });
  if (!parsed.success || !parsed.data.code) {
    res.status(404).json({ error: "Match not found" });
    return null;
  }
  const ctx = await loadRoomByCode(parsed.data.code);
  if (!ctx) {
    res.status(404).json({ error: "Match not found" });
    return null;
  }
  return ctx;
}

function cameraForMatch(ctx: MatchLiveContext): { controlCamera: string; streamCamera: string } | null {
  const controlCamera = parseLiveCamera(ctx.field.cameraId ?? undefined);
  if (!controlCamera) return null;
  const streamCamera = LIVE_CAMERA_UPSTREAM.get(controlCamera) ?? varCamera(controlCamera);
  return { controlCamera, streamCamera };
}

function isWithinLiveWindow(ctx: MatchLiveContext, now = Date.now()): boolean {
  const window = matchWindow(ctx.request);
  return matchPhase(ctx.request, now) === "live"
    && Number.isFinite(window.startMs)
    && Number.isFinite(window.endMs)
    && now >= window.startMs - 3 * 60 * 1000
    && now <= window.endMs + 5 * 60 * 1000;
}

function record(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" ? body as Record<string, unknown> : {};
}

function recordValue(body: unknown, key: string): unknown {
  return record(body)[key];
}

function stringValue(body: unknown, ...keys: string[]): string | null {
  const value = record(body);
  for (const key of keys) {
    const item = value[key];
    if (typeof item === "string" && item.trim()) return item.trim();
    if (typeof item === "number" && Number.isFinite(item)) return String(item);
  }
  return null;
}

function numberValue(body: unknown, ...keys: string[]): number | null {
  const value = record(body);
  for (const key of keys) {
    const item = value[key];
    if (typeof item === "number" && Number.isFinite(item)) return item;
  }
  return null;
}

function jobPayload(body: unknown): unknown {
  const nested = recordValue(body, "job") ?? recordValue(body, "result");
  return nested && typeof nested === "object" ? nested : body;
}

function summaryFromWindow(body: unknown): { live: boolean; newestAgeSec: number | null } {
  const value = record(body);
  const variants = record(value.variants);
  const hls = record(variants.hls);
  const age = hls.newestAgeSec ?? hls.newest_age_sec ?? value.newestAgeSec ?? value.newest_age_sec;
  return {
    live: hls.live === true || (!Object.keys(hls).length && value.live === true),
    newestAgeSec: typeof age === "number" && Number.isFinite(age) ? age : null,
  };
}

function panIsReady(body: unknown): boolean {
  const value = record(body);
  return value.on === true && value.state === "live";
}

function captureStatus(body: unknown): string {
  const status = (stringValue(body, "status", "state") ?? "").toLowerCase();
  if (["done", "complete", "completed", "ready"].includes(status)) return "ready";
  if (["failed", "error", "cancelled", "canceled"].includes(status)) return "failed";
  return "processing";
}

function safeError(value: unknown, fallback: string): string {
  const message = typeof value === "string" ? value.trim() : "";
  return (message || fallback).slice(0, 1000);
}

function validBunnyGuid(value: string | null): value is string {
  return Boolean(value && /^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i.test(value));
}

function validCropPath(path: Array<{ t: number; x: number; y: number; w: number; h: number }>): boolean {
  return path.length > 0 && path.length <= 2_000 && path.every((point) =>
    Number.isFinite(point.t) && point.t >= 0 && point.t <= 1
    && Number.isFinite(point.x) && point.x >= 0 && point.x <= 1
    && Number.isFinite(point.y) && point.y >= 0 && point.y <= 1
    && Number.isFinite(point.w) && point.w > 0 && point.w <= 1
    && Number.isFinite(point.h) && point.h > 0 && point.h <= 1,
  );
}

async function readLiveStatus(ctx: MatchLiveContext) {
  const window = matchWindow(ctx.request);
  const camera = cameraForMatch(ctx);
  if (!camera || !isWithinLiveWindow(ctx)) {
    return {
      matchCode: ctx.room.code,
      live: false,
      varActive: false,
      panAvailable: false,
      startUtc: window.varOpensAt,
      endUtc: window.varClosesAt,
      error: null,
    };
  }

  const varPath = encodeURIComponent(varCamera(camera.controlCamera));
  const [windowResult, panResult] = await Promise.all([
    controlFetch(`/var/${varPath}/window`, {}, 30_000),
    controlFetch(`/livepan/status/${encodeURIComponent(camera.controlCamera)}`, {}, 15_000),
  ]);
  const summary = windowResult.ok ? summaryFromWindow(windowResult.body) : { live: false, newestAgeSec: null };
  const varActive = isWithinLiveWindow(ctx) && windowResult.ok && summary.live;
  const panAvailable = panResult.ok && panIsReady(panResult.body);
  return {
    matchCode: ctx.room.code,
    live: varActive,
    varActive,
    panAvailable,
    startUtc: window.varOpensAt,
    endUtc: window.varClosesAt,
    error: !windowResult.ok
      ? "Live playback status is unavailable"
      : null,
  };
}

function rewritePlaylist(playlist: string, code: string, variant: LiveVariant): string | null {
  const prefix = `/api/matches/${encodeURIComponent(code)}/live/${variant}/seg/`;
  const rewriteUri = (uri: string): string | null => {
    const match = /(?:^|\/)seg\/([A-Za-z0-9._-]+\.(?:ts|m4s|mp4))(?:\?.*)?$/i.exec(uri)
      ?? /^([A-Za-z0-9._-]+\.(?:ts|m4s|mp4))(?:\?.*)?$/i.exec(uri);
    if (!match) return null;
    return `${prefix}${match[1]}`;
  };
  const lines = playlist.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line) continue;
    if (line.startsWith("#")) {
      lines[i] = line.replace(/URI="([^"]+)"/g, (full, uri: string) => {
        const proxied = rewriteUri(uri);
        return proxied ? `URI="${proxied}"` : full;
      });
      if (/URI="https?:\/\//i.test(lines[i])) return null;
      continue;
    }
    const proxied = rewriteUri(line.trim());
    if (proxied) lines[i] = proxied;
    else if (/^https?:\/\//i.test(line.trim())) return null;
  }
  return lines.join("\n");
}

async function ensureMediaAccess(req: Request, res: Response): Promise<{
  ctx: MatchLiveContext;
  camera: { controlCamera: string; streamCamera: string };
} | null> {
  const ctx = await getMatchContext(req, res);
  if (!ctx) return null;
  if (!isWithinLiveWindow(ctx)) {
    res.status(404).json({ error: "Live playback is outside this match window" });
    return null;
  }
  const camera = cameraForMatch(ctx);
  if (!camera) {
    res.status(404).json({ error: "Live camera unavailable" });
    return null;
  }
  return { ctx, camera };
}

router.get(
  "/matches/:code/live/status",
  rateLimit(60, "match-live-status", "Too many live status requests"),
  async (req, res): Promise<void> => {
  const ctx = await getMatchContext(req, res);
  if (!ctx) return;
  try {
    res.set("Cache-Control", "no-store").json(await readLiveStatus(ctx));
  } catch (error) {
    logger.warn({ error, matchCode: ctx.room.code }, "Public match live status proxy failed");
    res.status(502).json({ error: "Live playback status is unavailable" });
  }
});

router.get(
  "/matches/:code/live/:variant/playlist.m3u8",
  rateLimit(300, "match-live-playlist", "Too many live playlist requests"),
  async (req, res): Promise<void> => {
    const access = await ensureMediaAccess(req, res);
    if (!access) return;
    const variant = liveVariant(requestParam(req, "variant"));
    if (!variant) {
      res.status(400).json({ error: "Invalid live variant" });
      return;
    }
    if (variant === "pan") {
      try {
        const pan = await controlFetch(`/livepan/status/${encodeURIComponent(access.camera.controlCamera)}`, {}, 15_000);
        if (!pan.ok || !panIsReady(pan.body)) {
          res.status(409).json({ error: "Ball-follow playback is not active" });
          return;
        }
      } catch {
        res.status(502).json({ error: "Ball-follow status unavailable" });
        return;
      }
    }

    try {
      const camera = encodeURIComponent(varCamera(access.camera.controlCamera));
      const upstream = await controlResponse(`/var/${camera}/${variant}/playlist.m3u8`, {}, 30_000);
      if (!upstream.ok) {
        res.status(upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502)
          .json({ error: "Live playlist unavailable" });
        return;
      }
      const playlist = rewritePlaylist(await upstream.text(), access.ctx.room.code, variant);
      if (!playlist) {
        logger.warn({ matchCode: access.ctx.room.code, variant }, "Rejected live playlist containing an unproxied URL");
        res.status(502).json({ error: "Live playlist could not be safely proxied" });
        return;
      }
      res.set("Cache-Control", "no-store").type("application/vnd.apple.mpegurl").send(playlist);
    } catch (error) {
      logger.warn({ error, matchCode: access.ctx.room.code, variant }, "Public match playlist proxy failed");
      res.status(502).json({ error: "Live playlist unavailable" });
    }
  },
);

router.get(
  "/matches/:code/live/:variant/seg/:name",
  rateLimit(900, "match-live-segment", "Too many live segment requests"),
  async (req, res): Promise<void> => {
    const access = await ensureMediaAccess(req, res);
    if (!access) return;
    const variant = liveVariant(requestParam(req, "variant"));
    const name = requestParam(req, "name");
    if (!variant || !/^[A-Za-z0-9._-]+\.(?:ts|m4s|mp4)$/i.test(name)) {
      res.status(400).json({ error: "Invalid live segment" });
      return;
    }
    try {
      const camera = encodeURIComponent(varCamera(access.camera.controlCamera));
      const upstream = await controlResponse(
        `/var/${camera}/${variant}/seg/${encodeURIComponent(name)}`,
        {},
        30_000,
      );
      if (!upstream.ok || !upstream.body) {
        res.status(upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502)
          .json({ error: "Live segment unavailable" });
        return;
      }
      const contentType = upstream.headers.get("content-type");
      if (contentType) res.set("Content-Type", contentType);
      res.set("Cache-Control", "private, max-age=60");
      const stream = Readable.fromWeb(upstream.body as globalThis.ReadableStream<Uint8Array>);
      stream.once("error", (error) => {
        logger.warn({ error, matchCode: access.ctx.room.code, variant, name }, "Live segment stream failed");
        if (!res.headersSent && !res.destroyed) res.status(502).json({ error: "Live segment unavailable" });
        else if (!res.destroyed) res.destroy();
      });
      res.once("close", () => {
        if (!res.writableFinished) stream.destroy();
      });
      stream.pipe(res);
    } catch (error) {
      logger.warn({ error, matchCode: access.ctx.room.code, variant, name }, "Public match segment proxy failed");
      res.status(502).json({ error: "Live segment unavailable" });
    }
  },
);

router.post("/matches/:code/live-clips", async (req, res): Promise<void> => {
  const params = CreateMatchLiveClipParams.safeParse({ code: normalizeCode(requestParam(req, "code")) });
  if (!params.success || !params.data.code) {
    res.status(404).json({ error: "Match not found" });
    return;
  }
  const parsed = CreateMatchLiveClipBody.safeParse(req.body);
  if (!parsed.success || !validCropPath(parsed.data.cropPath)) {
    res.status(400).json({ error: parsed.success ? "Invalid crop keyframes" : parsed.error.message });
    return;
  }

  const user = await getLocalUserRecord(req);
  if (!user) {
    unauthenticatedResponse(res, req);
    return;
  }
  if (user.isGuest) {
    res.status(403).json({ error: "Sign in with a real account to save live clips" });
    return;
  }
  if (!limitLiveClipSave(user.id, res)) return;

  const ctx = await loadRoomByCode(params.data.code);
  if (!ctx) {
    res.status(404).json({ error: "Match not found" });
    return;
  }
  const camera = cameraForMatch(ctx);
  if (!camera || !isWithinLiveWindow(ctx)) {
    res.status(409).json({ error: "Live clipping is only available during this match" });
    return;
  }
  const startMs = parsed.data.start * 1000;
  const endMs = parsed.data.end * 1000;
  const durationMs = endMs - startMs;
  const window = matchWindow(ctx.request);
  const now = Date.now();
  if (
    !Number.isFinite(startMs) || !Number.isFinite(endMs)
    || !isValidLiveClipDurationMs(durationMs)
    || startMs < window.startMs - 3 * 60 * 1000
    || endMs > Math.min(window.endMs + 5 * 60 * 1000, now)
  ) {
    res.status(400).json({ error: "Clip must be at least 1 second and no longer than 10 minutes, within the live match window" });
    return;
  }

  if (parsed.data.useBallPan) {
    try {
      const pan = await controlFetch(`/livepan/status/${encodeURIComponent(camera.controlCamera)}`, {}, 15_000);
      if (!pan.ok || !panIsReady(pan.body)) {
        res.status(409).json({ error: "Ball-follow is not currently active" });
        return;
      }
      const query = `start=${encodeURIComponent(String(parsed.data.start))}&end=${encodeURIComponent(String(parsed.data.end))}`;
      const ballPath = await controlFetch(
        `/live/ballpath/${encodeURIComponent(camera.controlCamera)}?${query}`,
        {},
        30_000,
      );
      if (!ballPath.ok) {
        res.status(502).json({ error: "Ball-path is unavailable" });
        return;
      }
      if (recordValue(ballPath.body, "available") !== true) {
        res.status(409).json({ error: "Ball-follow is unavailable for this clip window" });
        return;
      }
    } catch (error) {
      logger.warn({ error, matchCode: ctx.room.code }, "Ball-follow validation failed");
      res.status(502).json({ error: "Ball-follow is unavailable" });
      return;
    }
  }

  const [clip] = await db.insert(userClipsTable).values({
    userId: user.id,
    videoId: `live:${camera.controlCamera}`,
    title: parsed.data.title.trim(),
    startTime: "0",
    endTime: "1",
    cropPath: parsed.data.cropPath,
    aspectRatio: parsed.data.aspectRatio,
    visibility: "private",
    matchCode: ctx.room.code,
    liveClipStatus: "queued",
    exportStatus: null,
  }).returning();

  const workerTitle = `liveclip_${ctx.room.code}_${clip.id}`;
  const query = `start=${encodeURIComponent(String(parsed.data.start))}`
    + `&end=${encodeURIComponent(String(parsed.data.end))}`
    + `&title=${encodeURIComponent(workerTitle)}`;
  let result: { ok: boolean; status: number; body: unknown };
  try {
    result = await controlFetch(
      `/live/clip/${encodeURIComponent(camera.controlCamera)}?${query}`,
      { method: "POST" },
      30_000,
    );
  } catch (error) {
    logger.warn({ error, clipId: clip.id, matchCode: ctx.room.code }, "Live clip enqueue request failed");
    result = { ok: false, status: 502, body: { error: "Live clip worker is unavailable" } };
  }

  const jobId = stringValue(result.body, "job", "jobId", "job_id", "id");
  const queued = result.ok && jobId && /^[A-Za-z0-9._-]{1,128}$/.test(jobId);
  const failureMessage = !result.ok
    ? safeError(stringValue(result.body, "error", "message"), "Live clip could not be queued")
    : "Live clip worker did not return a valid job id";
  const [updated] = await db.update(userClipsTable)
    .set(queued
      ? { liveClipJobId: jobId, liveClipStatus: "queued", liveClipError: null }
      : { liveClipStatus: "failed", liveClipError: failureMessage })
    .where(eq(userClipsTable.id, clip.id))
    .returning();

  res.status(201).json(CreateMatchLiveClipResponse.parse({
    id: updated.id,
    matchCode: updated.matchCode,
    liveClipStatus: updated.liveClipStatus,
    liveClipError: updated.liveClipError,
    exportStatus: updated.exportStatus,
  }));
});

router.get(
  "/matches/:code/live-clips/:id/status",
  rateLimit(30, "match-live-clip-status", "Too many live clip status requests"),
  async (req, res): Promise<void> => {
    const user = await getLocalUserRecord(req);
    if (!user || user.isGuest) {
      unauthenticatedResponse(res, req);
      return;
    }
    const params = GetMatchLiveClipStatusParams.safeParse({
      code: normalizeCode(requestParam(req, "code")),
      id: Number.parseInt(requestParam(req, "id"), 10),
    });
    if (!params.success || !params.data.code || !Number.isSafeInteger(params.data.id) || params.data.id <= 0) {
      res.status(400).json({ error: "Invalid live clip" });
      return;
    }
    let [clip] = await db.select().from(userClipsTable)
      .where(and(
        eq(userClipsTable.id, params.data.id),
        eq(userClipsTable.userId, user.id),
        eq(userClipsTable.matchCode, params.data.code),
      ));
    if (!clip) {
      res.status(404).json({ error: "Live clip not found" });
      return;
    }

    if (
      clip.liveClipStatus !== "ready"
      && clip.liveClipStatus !== "failed"
      && clip.liveClipJobId
    ) {
      try {
        const job = await controlFetch(
          `/live/clip/job/${encodeURIComponent(clip.liveClipJobId)}`,
          {},
          30_000,
        );
        if (job.ok) {
          const payload = jobPayload(job.body);
          const partialNotice = recordValue(payload, "partial") === true
            || clip.liveClipError === PARTIAL_LIVE_CLIP_NOTICE
            ? PARTIAL_LIVE_CLIP_NOTICE
            : null;
          const nextStatus = captureStatus(payload);
          if (nextStatus === "failed") {
            const message = safeError(
              stringValue(payload, "error", "message", "note"),
              "Live clip processing failed",
            );
            [clip] = await db.update(userClipsTable)
              .set({ liveClipStatus: "failed", liveClipError: partialNotice ?? message })
              .where(eq(userClipsTable.id, clip.id))
              .returning();
          } else if (nextStatus === "ready") {
            const guid = stringValue(payload, "guid", "videoId", "video_id");
            const duration = numberValue(payload, "duration", "durationSeconds", "duration_seconds");
            const offsetStart = numberValue(payload, "offsetStart", "offset_start", "startOffset", "start_offset", "sourceStart");
            const offsetEnd = numberValue(payload, "offsetEnd", "offset_end", "endOffset", "end_offset", "sourceEnd");
            if (
              !validBunnyGuid(guid)
              || duration == null || duration <= 0
              || offsetStart == null || offsetEnd == null
              || offsetStart < 0 || offsetEnd <= offsetStart || offsetEnd > duration
            ) {
              [clip] = await db.update(userClipsTable)
                .set({
                  liveClipStatus: "failed",
                  liveClipError: partialNotice ?? "Live clip worker returned incomplete source offsets",
                })
                .where(eq(userClipsTable.id, clip.id))
                .returning();
            } else {
              const [readyClip] = await db.update(userClipsTable)
                .set({
                  videoId: guid,
                  startTime: String(offsetStart / duration),
                  endTime: String(offsetEnd / duration),
                  liveClipStatus: "ready",
                  liveClipError: partialNotice,
                })
                .where(eq(userClipsTable.id, clip.id))
                .returning();
              clip = readyClip;
              try {
                const exportStatus = await queueUserClipExport(readyClip);
                clip = { ...readyClip, exportStatus };
              } catch (error) {
                logger.error({ error, clipId: clip.id }, "Could not queue live clip export");
                await db.update(userClipsTable)
                  .set({ exportStatus: "error" })
                  .where(eq(userClipsTable.id, clip.id));
                clip = { ...clip, exportStatus: "error" };
              }
            }
          } else {
            const progressStatus = stringValue(payload, "status", "state")?.toLowerCase() ?? "processing";
            [clip] = await db.update(userClipsTable)
              .set({ liveClipStatus: progressStatus, liveClipError: partialNotice })
              .where(eq(userClipsTable.id, clip.id))
              .returning();
          }
        } else if (job.status === 404 && Date.now() - clip.createdAt.getTime() > MAX_UNKNOWN_JOB_WAIT_MS) {
          [clip] = await db.update(userClipsTable)
            .set({
              liveClipStatus: "failed",
              liveClipError: "The live clip job expired before it finished",
            })
            .where(eq(userClipsTable.id, clip.id))
            .returning();
        }
      } catch (error) {
        // Keep the last persisted state while the upstream worker is temporarily unavailable.
        logger.warn({ error, clipId: clip.id }, "Live clip status poll failed");
      }
    } else if (!clip.liveClipJobId && clip.liveClipStatus === "queued" && Date.now() - clip.createdAt.getTime() > 60_000) {
      [clip] = await db.update(userClipsTable)
        .set({
          liveClipStatus: "failed",
          liveClipError: "The live clip worker did not start",
        })
        .where(eq(userClipsTable.id, clip.id))
        .returning();
    }

    res.set("Cache-Control", "no-store").json(GetMatchLiveClipStatusResponse.parse({
      id: clip.id,
      matchCode: clip.matchCode,
      liveClipStatus: clip.liveClipStatus,
      liveClipError: clip.liveClipError,
      exportStatus: clip.exportStatus,
    }));
  },
);

export default router;