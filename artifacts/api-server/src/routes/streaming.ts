import { Router, type IRouter, type Request, type Response } from "express";
import { and, eq } from "drizzle-orm";
import { db, fieldOwnersTable, fieldsTable } from "@workspace/db";
import {
  GetStreamingStatusResponse,
  StartStreamingBody,
  StopStreamingBody,
} from "@workspace/api-zod";
import { getLocalUserRecord, unauthenticatedResponse } from "../lib/clerkUserBridge";
import { loadRoomByCode, matchPhase } from "../lib/matchRooms";
import { logger } from "../lib/logger";
import { parseLiveCamera } from "../lib/liveCameras";
import { controlFetch } from "./contabo";
import { matchRoomsTable } from "@workspace/db";

const router: IRouter = Router();
type LocalUser = NonNullable<Awaited<ReturnType<typeof getLocalUserRecord>>>;
const RTMP_VPS_BASE_URL = "http://169.58.73.17:8080";

function controlIsConfigured(): boolean {
  return Boolean(process.env.CONTABO_CONTROL_KEY);
}

async function requireUser(req: Request, res: Response): Promise<LocalUser | null> {
  const user = await getLocalUserRecord(req);
  if (!user) {
    unauthenticatedResponse(res, req);
    return null;
  }
  if (user.isGuest) {
    res.status(403).json({ error: "Create an account to manage a stream" });
    return null;
  }
  return user;
}

async function isFieldOwner(userId: number, fieldId: number): Promise<boolean> {
  const [owned] = await db.select({ id: fieldOwnersTable.id })
    .from(fieldOwnersTable)
    .where(and(
      eq(fieldOwnersTable.userId, userId),
      eq(fieldOwnersTable.fieldId, fieldId),
    ))
    .limit(1);
  return Boolean(owned);
}

type AccessContext = { fieldId?: number; matchCode?: string };

async function authorizeCamera(
  user: LocalUser,
  camValue: unknown,
  context: AccessContext,
  res: Response,
): Promise<string | null> {
  const camera = parseLiveCamera(typeof camValue === "string" ? camValue : undefined);
  if (!camera) {
    res.status(400).json({ error: "Invalid camera" });
    return null;
  }

  const contextCount = Number(context.fieldId !== undefined) + Number(context.matchCode !== undefined);
  if (contextCount > 1) {
    res.status(400).json({ error: "Provide either fieldId or matchCode, not both" });
    return null;
  }

  if (context.fieldId !== undefined) {
    const [field] = await db.select().from(fieldsTable)
      .where(eq(fieldsTable.id, context.fieldId))
      .limit(1);
    if (!field) {
      res.status(404).json({ error: "Field not found" });
      return null;
    }
    if (!user.isAdmin && !(await isFieldOwner(user.id, field.id))) {
      res.status(403).json({ error: "Field owner access required" });
      return null;
    }
    if (parseLiveCamera(field.cameraId ?? undefined) !== camera) {
      res.status(403).json({ error: "Camera does not belong to this field" });
      return null;
    }
    return camera;
  }

  if (context.matchCode !== undefined) {
    const ctx = await loadRoomByCode(context.matchCode.trim().toUpperCase());
    if (!ctx) {
      res.status(404).json({ error: "Match not found" });
      return null;
    }
    if (!user.isAdmin) {
      const captain = ctx.room.captainUserId === user.id;
      const owner = await isFieldOwner(user.id, ctx.room.fieldId);
      if (!captain && !owner) {
        res.status(403).json({ error: "Match captain or field owner access required" });
        return null;
      }
    }
    if (parseLiveCamera(ctx.field.cameraId ?? undefined) !== camera) {
      res.status(403).json({ error: "Camera does not belong to this match" });
      return null;
    }
    return camera;
  }

  if (!user.isAdmin) {
    res.status(403).json({ error: "Admin access required for direct camera controls" });
    return null;
  }
  return camera;
}

async function authorizeStatusCamera(
  user: LocalUser,
  camValue: unknown,
  res: Response,
): Promise<string | null> {
  const camera = parseLiveCamera(typeof camValue === "string" ? camValue : undefined);
  if (!camera) {
    res.status(400).json({ error: "Invalid camera" });
    return null;
  }
  if (user.isAdmin) return camera;

  const [field] = await db.select().from(fieldsTable)
    .where(eq(fieldsTable.cameraId, camera))
    .limit(1);
  if (!field || parseLiveCamera(field.cameraId ?? undefined) !== camera) {
    res.status(404).json({ error: "Camera not found" });
    return null;
  }
  if (await isFieldOwner(user.id, field.id)) return camera;

  const candidateRooms = await db.select({ code: matchRoomsTable.code })
    .from(matchRoomsTable)
    .where(and(
      eq(matchRoomsTable.fieldId, field.id),
      eq(matchRoomsTable.captainUserId, user.id),
    ))
    .limit(20);
  for (const candidate of candidateRooms) {
    const ctx = await loadRoomByCode(candidate.code);
    if (ctx && (matchPhase(ctx.request) === "pre" || matchPhase(ctx.request) === "live")) {
      return camera;
    }
  }

  res.status(403).json({ error: "Match captain or field owner access required" });
  return null;
}

function record(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {};
}

function safeRtmpUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = new URL(value);
    if (
      !["rtmp:", "rtmps:"].includes(parsed.protocol)
      || !parsed.hostname
      || parsed.username
      || parsed.password
      || parsed.search
      || parsed.hash
    ) return null;
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return null;
  }
}

function normalizedStatus(body: unknown, camera: string, fallback: "off" | "starting") {
  const payload = record(body);
  const rawState = typeof payload.state === "string" ? payload.state.toLowerCase() : "";
  const state = ["off", "running", "starting", "failed"].includes(rawState)
    ? rawState as "off" | "running" | "starting" | "failed"
    : fallback;
  const rawVariant = payload.variant;
  const variant = rawVariant === "pan" || rawVariant === "hevc" ? rawVariant : null;
  const rawStartedAt = payload.startedAt;
  const startedAt = typeof rawStartedAt === "number" && Number.isFinite(rawStartedAt) ? rawStartedAt : null;
  return GetStreamingStatusResponse.parse({
    cam: camera,
    state,
    variant,
    rtmp_url: safeRtmpUrl(payload.rtmp_url),
    startedAt,
  });
}

function missingControlConfig(res: Response): boolean {
  if (controlIsConfigured()) return false;
  res.status(503).json({ error: "Streaming control server is not configured" });
  return true;
}

function sendUpstreamError(res: Response, status: number): void {
  // Never reflect an upstream body here: it may contain request parameters, including stream_key.
  const safeStatus = status >= 400 && status < 600 ? status : 502;
  res.status(safeStatus).json({ error: safeStatus === 409 ? "RTMP stream could not be started" : "RTMP control request failed" });
}

router.get("/live/rtmp/status/:cam", async (req, res): Promise<void> => {
  const user = await requireUser(req, res);
  if (!user) return;

  const camera = await authorizeStatusCamera(user, req.params.cam, res);
  if (!camera) return;
  if (missingControlConfig(res)) return;

  try {
    const result = await controlFetch(
      `/live/rtmp/status/${encodeURIComponent(camera)}`,
      {},
      15_000,
      RTMP_VPS_BASE_URL,
    );
    if (!result.ok) {
      sendUpstreamError(res, result.status);
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.json(normalizedStatus(result.body, camera, "off"));
  } catch {
    logger.warn({ camera }, "RTMP status request failed");
    res.status(502).json({ error: "Streaming control server unavailable" });
  }
});

router.post("/live/rtmp/start/:cam", async (req, res): Promise<void> => {
  const user = await requireUser(req, res);
  if (!user) return;

  const parsed = StartStreamingBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid RTMP start request" });
    return;
  }
  const { fieldId, matchCode, platform, rtmpUrl, streamKey } = parsed.data;
  if (!safeRtmpUrl(rtmpUrl)) {
    res.status(400).json({ error: "RTMP URL must be a base ingest URL without credentials or query parameters" });
    return;
  }
  if (!streamKey.trim()) {
    res.status(400).json({ error: "Stream key is required" });
    return;
  }

  const camera = await authorizeCamera(user, req.params.cam, { fieldId, matchCode }, res);
  if (!camera) return;
  if (missingControlConfig(res)) return;

  try {
    const query = new URLSearchParams({ rtmp_url: safeRtmpUrl(rtmpUrl)!, stream_key: streamKey });
    const result = await controlFetch(
      `/live/rtmp/start/${encodeURIComponent(camera)}?${query.toString()}`,
      { method: "POST" },
      15_000,
      RTMP_VPS_BASE_URL,
    );
    if (!result.ok) {
      sendUpstreamError(res, result.status);
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.json(normalizedStatus(result.body, camera, "starting"));
  } catch {
    logger.warn({ camera, platform }, "RTMP start request failed");
    res.status(502).json({ error: "Streaming control server unavailable" });
  }
});

router.post("/live/rtmp/stop/:cam", async (req, res): Promise<void> => {
  const user = await requireUser(req, res);
  if (!user) return;

  const parsed = StopStreamingBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid RTMP stop request" });
    return;
  }
  const camera = await authorizeCamera(user, req.params.cam, parsed.data, res);
  if (!camera) return;
  if (missingControlConfig(res)) return;

  try {
    const result = await controlFetch(
      `/live/rtmp/stop/${encodeURIComponent(camera)}`,
      { method: "POST" },
      15_000,
      RTMP_VPS_BASE_URL,
    );
    if (!result.ok) {
      sendUpstreamError(res, result.status);
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.json({ cam: camera, state: "off" });
  } catch {
    logger.warn({ camera }, "RTMP stop request failed");
    res.status(502).json({ error: "Streaming control server unavailable" });
  }
});

export default router;