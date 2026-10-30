import { Router, type IRouter, type Request, type Response } from "express";
import { and, eq } from "drizzle-orm";
import { academyMembersTable, db, fieldOwnersTable } from "@workspace/db";
import { BUNNY_API_KEY, BUNNY_LIBRARY_ID } from "../lib/bunny";
import { getLocalUserRecord } from "../lib/clerkUserBridge";
import { getSettingValue } from "../lib/settings";
import { isPlaying, loadRoomByCode, rosterFor } from "../lib/matchRooms";
import { remoteJobPath } from "../lib/gapStore";
import { controlFetch } from "./contabo";
import { proxyProgressiveMp4 } from "./hlsProxy";

const router: IRouter = Router();
const CACHE_MS = 30_000;
type ReasonCode =
  | "early_play_off" | "bunny_failed" | "bunny_not_found" | "bunny_error"
  | "vps_unreachable" | "disabled" | "request_cancelled";
type PlayResult = {
  state: "waiting" | "early" | "ready" | "unavailable";
  reason: string;
  reasonCode?: ReasonCode;
  phase?: string | null;
  encodeProgress?: number | null;
  streamUrl?: string;
  directUrl?: string;
  codec?: "hvc1";
  durationSec?: number | null;
};
type PlayMetadata = {
  allowEarlyPlay: boolean;
  originalUrl: string | null;
  status: number | null;
  durationSec: number | null;
};
type CacheItem = { expiresAt: number; result: PlayResult; metadata: PlayMetadata | null };
const resultCache = new Map<number, CacheItem>();
const inflight = new Map<number, Promise<CacheItem>>();

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function percent(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : null;
}

function unavailable(reasonCode: ReasonCode, reason: string): PlayResult {
  return { state: "unavailable", reason, reasonCode };
}

function requestCode(req: Request): string {
  const value = req.params.code;
  return (Array.isArray(value) ? value[0] : value ?? "").toUpperCase();
}

async function authorizedRequest(req: Request, res: Response) {
  const roomCode = requestCode(req);
  const ctx = await loadRoomByCode(roomCode);
  if (!ctx || ["cancelled", "failed", "refunded"].includes(ctx.request.status)) {
    res.status(404).json({ error: "Match not found" });
    return null;
  }
  let viewer = null;
  try {
    viewer = await getLocalUserRecord(req);
  } catch {
    viewer = null;
  }
  const roster = await rosterFor(ctx.room.id);
  const me = viewer ? roster.find((player) => player.userId === viewer!.id) ?? null : null;
  const member = Boolean(viewer && (
    ctx.room.captainUserId === viewer.id || isPlaying(me)
  ));
  if (ctx.request.academyId !== null) {
    const [academyMember] = viewer && !viewer.isGuest
      ? await db.select({ id: academyMembersTable.id }).from(academyMembersTable).where(and(
        eq(academyMembersTable.academyId, ctx.request.academyId),
        eq(academyMembersTable.userId, viewer.id),
      )).limit(1)
      : [];
    if (!academyMember) {
      res.status(404).json({ error: "Match not found" });
      return null;
    }
  } else if (!member) {
    const [owner] = viewer
      ? await db.select({ id: fieldOwnersTable.id }).from(fieldOwnersTable).where(and(
        eq(fieldOwnersTable.fieldId, ctx.room.fieldId),
        eq(fieldOwnersTable.userId, viewer.id),
      )).limit(1)
      : [];
    if (!owner && !viewer?.isAdmin) {
      res.status(404).json({ error: "Match not found" });
      return null;
    }
  }
  return { ctx, viewer };
}

function validOriginalUrl(raw: unknown, videoId: string): string | null {
  if (typeof raw !== "string") return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || !/^[a-z0-9-]+\.b-cdn\.net$/i.test(url.hostname)) return null;
    if (url.pathname !== `/${videoId}/original`) return null;
    return url.toString();
  } catch {
    return null;
  }
}

async function bunnyPlay(videoId: string): Promise<
  { ok: true; value: PlayMetadata } | { ok: false; reasonCode: "bunny_error" | "bunny_not_found" | "bunny_failed"; reason: string }
> {
  if (!BUNNY_API_KEY || !BUNNY_LIBRARY_ID) {
    return { ok: false, reasonCode: "bunny_error", reason: "Bunny playback status is not configured." };
  }
  let response: globalThis.Response;
  try {
    response = await fetch(
      `https://video.bunnycdn.com/library/${encodeURIComponent(BUNNY_LIBRARY_ID)}/videos/${encodeURIComponent(videoId)}/play`,
      { headers: { AccessKey: BUNNY_API_KEY, accept: "application/json" }, signal: AbortSignal.timeout(10_000) },
    );
  } catch {
    return { ok: false, reasonCode: "bunny_error", reason: "Bunny could not be reached." };
  }
  if (response.status === 404) return { ok: false, reasonCode: "bunny_not_found", reason: "Bunny no longer has this video." };
  if (!response.ok) {
    return { ok: false, reasonCode: "bunny_error", reason: `Bunny returned HTTP ${response.status}.` };
  }
  let body: Record<string, unknown>;
  try {
    const raw = await response.json() as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid JSON");
    body = raw as Record<string, unknown>;
  } catch {
    return { ok: false, reasonCode: "bunny_error", reason: "Bunny returned an unreadable status response." };
  }
  const video = body.video && typeof body.video === "object" ? body.video as Record<string, unknown> : body;
  const status = typeof video.status === "number" ? video.status : null;
  const length = typeof video.length === "number" && Number.isFinite(video.length) ? video.length : null;
  return {
    ok: true,
    value: {
      allowEarlyPlay: body.allowEarlyPlay === true,
      originalUrl: validOriginalUrl(body.originalUrl, videoId),
      status,
      durationSec: length,
    },
  };
}

async function loadEarlyResult(requestId: number, ctx: NonNullable<Awaited<ReturnType<typeof loadRoomByCode>>>): Promise<CacheItem> {
  const request = ctx.request;
  if (request.status === "ready" || request.status === "partial") {
    return { expiresAt: Date.now() + CACHE_MS, result: { state: "ready", reason: "The full match is ready." }, metadata: null };
  }
  const settingEnabled = await getSettingValue<boolean>("playback.earlyPlayEnabled", {
    fieldId: ctx.field.id,
    academyId: request.academyId,
  });
  if (!settingEnabled) return { expiresAt: Date.now() + CACHE_MS, result: unavailable("disabled", "Early play is turned off by an administrator."), metadata: null };

  if (!request.vpsJobId) {
    return { expiresAt: Date.now() + CACHE_MS, result: { state: "waiting", reason: "The camera upload has not started yet.", phase: null, encodeProgress: null }, metadata: null };
  }
  let job;
  try {
    job = await controlFetch(remoteJobPath(request.cameraId, request.vpsJobId), {}, 15_000);
  } catch {
    return { expiresAt: Date.now() + CACHE_MS, result: unavailable("vps_unreachable", "The camera status service could not be reached."), metadata: null };
  }
  if (job.status === 404) {
    return { expiresAt: Date.now() + CACHE_MS, result: unavailable("vps_unreachable", "The camera no longer has this upload job."), metadata: null };
  }
  if (!job.ok || !job.body || typeof job.body !== "object" || Array.isArray(job.body)) {
    return { expiresAt: Date.now() + CACHE_MS, result: unavailable("vps_unreachable", "The camera status service is unavailable."), metadata: null };
  }
  const body = job.body as Record<string, unknown>;
  const phase = text(body.phase);
  const encodeProgress = percent(body.encodeProgress ?? body.encode_progress);
  if (body.cancelled === true || body.status === "cancelled") {
    return { expiresAt: Date.now() + CACHE_MS, result: unavailable("request_cancelled", "This footage request was cancelled."), metadata: null };
  }
  const videoId = text(body.videoId ?? body.video_id) ?? request.videoId;
  const uploaded = body.uploaded === true || (body.uploaded === undefined && phase === "encode");
  if (!videoId || !uploaded) {
    return { expiresAt: Date.now() + CACHE_MS, result: {
      state: "waiting",
      reason: "The camera is still uploading the match.",
      phase,
      encodeProgress,
    }, metadata: null };
  }

  const bunny = await bunnyPlay(videoId);
  if (!bunny.ok) {
    return { expiresAt: Date.now() + CACHE_MS, result: unavailable(bunny.reasonCode, bunny.reason), metadata: null };
  }
  const metadata = bunny.value;
  if (metadata.status === 4) {
    return { expiresAt: Date.now() + CACHE_MS, result: { state: "ready", reason: "The full match is ready." }, metadata };
  }
  if (metadata.status === 5 || metadata.status === 6) {
    return { expiresAt: Date.now() + CACHE_MS, result: unavailable("bunny_failed", "Bunny could not encode this video."), metadata };
  }
  if (!metadata.allowEarlyPlay || !metadata.originalUrl) {
    return { expiresAt: Date.now() + CACHE_MS, result: unavailable("early_play_off", "Early play is unavailable for this video."), metadata };
  }
  if (metadata.status === null || metadata.status < 0 || metadata.status > 3) {
    return { expiresAt: Date.now() + CACHE_MS, result: unavailable("bunny_error", "Bunny returned an unsupported encoding status."), metadata };
  }
  return {
    expiresAt: Date.now() + CACHE_MS,
    result: {
      state: "early",
      reason: "The original match video is ready to watch while HD processing continues.",
      streamUrl: `/api/matches/${encodeURIComponent(ctx.room.code)}/early-play/video`,
      codec: "hvc1",
      encodeProgress,
      durationSec: metadata.durationSec,
    },
    metadata,
  };
}

async function getCachedResult(requestId: number, ctx: NonNullable<Awaited<ReturnType<typeof loadRoomByCode>>>): Promise<CacheItem> {
  const cached = resultCache.get(requestId);
  if (cached && cached.expiresAt > Date.now()) return cached;
  const pending = inflight.get(requestId);
  if (pending) return pending;
  const task = loadEarlyResult(requestId, ctx).catch(() => ({
    expiresAt: Date.now() + CACHE_MS,
    result: unavailable("bunny_error", "Early play status could not be checked."),
    metadata: null,
  }));
  inflight.set(requestId, task);
  const item = await task;
  inflight.delete(requestId);
  resultCache.set(requestId, item);
  if (resultCache.size > 500) {
    for (const [key, value] of resultCache) if (value.expiresAt <= Date.now()) resultCache.delete(key);
    if (resultCache.size > 500) resultCache.delete(resultCache.keys().next().value!);
  }
  return item;
}

export function isDirectEarlyPlayHost(hostHeader?: string, forwardedHeader?: string, trustProxy = false): boolean {
  const forwarded = trustProxy ? forwardedHeader?.split(",", 1)[0]?.trim() : undefined;
  const host = (forwarded || hostHeader || "").trim().toLowerCase();
  return host === "replayjo.com";
}

function logNonEarly(req: Request, code: string, result: PlayResult): void {
  if (result.state !== "early") req.log?.info({ code, state: result.state, reasonCode: result.reasonCode, reason: result.reason }, "Early play status");
}

router.get("/matches/:code/early-play", async (req, res): Promise<void> => {
  const access = await authorizedRequest(req, res);
  if (!access) return;
  const { ctx } = access;
  try {
    const item = await getCachedResult(ctx.request.id, ctx);
    const result = { ...item.result };
    if (result.state === "early" && isDirectEarlyPlayHost(req.get("host"), req.get("x-forwarded-host"), Boolean(req.app.get("trust proxy")))) result.directUrl = item.metadata?.originalUrl ?? undefined;
    logNonEarly(req, ctx.room.code, result);
    res.json(result);
  } catch {
    const result = unavailable("bunny_error", "Early play status could not be checked.");
    logNonEarly(req, ctx.room.code, result);
    res.json(result);
  }
});

router.get("/matches/:code/early-play/video", async (req, res): Promise<void> => {
  const access = await authorizedRequest(req, res);
  if (!access) return;
  const { ctx } = access;
  try {
    const item = await getCachedResult(ctx.request.id, ctx);
    if (item.result.state === "ready") {
      res.status(409).json({ state: "ready" });
      return;
    }
    if (item.result.state !== "early" || !item.metadata?.originalUrl) {
      const status = item.result.reasonCode === "request_cancelled" ? 404 : 503;
      res.status(status).json({ state: item.result.state, reason: item.result.reason, reasonCode: item.result.reasonCode });
      return;
    }
    const upstream = new URL(item.metadata.originalUrl);
    await proxyProgressiveMp4(req, res, item.metadata.originalUrl, upstream.hostname);
  } catch {
    if (!res.headersSent) res.status(503).json({ state: "unavailable", reason: "The early video could not be streamed.", reasonCode: "bunny_error" });
  }
});

export default router;
