import { Router, type IRouter, type Request, type Response } from "express";
import { and, eq } from "drizzle-orm";
import {
  db,
  fieldOwnersTable,
  fieldsTable,
} from "@workspace/db";
import {
  GetStreamingStatusQueryParams,
  GetStreamingStatusResponse,
  StartStreamingBody,
  StopStreamingBody,
} from "@workspace/api-zod";
import { getLocalUserRecord, unauthenticatedResponse } from "../lib/clerkUserBridge";
import { loadRoomByCode } from "../lib/matchRooms";
import { logger } from "../lib/logger";
import { parseLiveCamera } from "../lib/liveCameras";
import { controlFetch } from "./contabo";

const router: IRouter = Router();

type LocalUser = NonNullable<Awaited<ReturnType<typeof getLocalUserRecord>>>;
type Target = { camera?: string; fieldId?: number; matchCode?: string };

function controlIsConfigured(): boolean {
  return Boolean(process.env.CONTABO_CONTROL_URL?.trim() && process.env.CONTABO_CONTROL_KEY);
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

async function cameraForTarget(
  user: LocalUser,
  target: Target,
  res: Response,
): Promise<string | null> {
  const targetCount = Number(target.camera !== undefined)
    + Number(target.fieldId !== undefined)
    + Number(target.matchCode !== undefined);
  if (targetCount !== 1) {
    res.status(400).json({ error: "Provide exactly one camera, fieldId, or matchCode" });
    return null;
  }

  if (target.camera !== undefined) {
    if (!user.isAdmin) {
      res.status(403).json({ error: "Admin access required for direct camera controls" });
      return null;
    }
    const camera = parseLiveCamera(target.camera);
    if (!camera) {
      res.status(400).json({ error: "Invalid camera" });
      return null;
    }
    return camera;
  }

  if (target.fieldId !== undefined) {
    const [field] = await db.select().from(fieldsTable).where(eq(fieldsTable.id, target.fieldId)).limit(1);
    if (!field) {
      res.status(404).json({ error: "Field not found" });
      return null;
    }
    if (!user.isAdmin && !(await isFieldOwner(user.id, field.id))) {
      res.status(403).json({ error: "Field owner access required" });
      return null;
    }
    const camera = parseLiveCamera(field.cameraId ?? undefined);
    if (!camera) {
      res.status(404).json({ error: "Field has no supported camera" });
      return null;
    }
    return camera;
  }

  const code = target.matchCode?.trim().toUpperCase() ?? "";
  const ctx = await loadRoomByCode(code);
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
  const camera = parseLiveCamera(ctx.field.cameraId ?? undefined);
  if (!camera) {
    res.status(404).json({ error: "Match field has no supported camera" });
    return null;
  }
  return camera;
}

function objectRecord(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {};
}

function stringValue(body: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = body[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function safeMessage(body: unknown, streamKey?: string): string | null {
  const record = objectRecord(body);
  const message = stringValue(record, "message", "error", "detail", "note");
  if (!message || (streamKey && message.includes(streamKey))) return null;
  return message.slice(0, 240);
}

function normalizeStatus(
  body: unknown,
  fallbackState: "offline" | "starting" | "unknown",
  streamKey?: string,
) {
  const record = objectRecord(body);
  const rawState = (stringValue(record, "state", "status", "phase") ?? "").toLowerCase();
  const rawLive = record.live === true || record.on === true || record.active === true;
  let state: "offline" | "starting" | "live" | "stopping" | "failed" | "unknown";
  if (["live", "running", "active", "streaming"].includes(rawState) || rawLive) state = "live";
  else if (["starting", "queued", "pending"].includes(rawState)) state = "starting";
  else if (["stopping", "shutting_down"].includes(rawState)) state = "stopping";
  else if (["offline", "off", "stopped", "idle"].includes(rawState) || record.on === false || record.live === false) state = "offline";
  else if (["failed", "error"].includes(rawState)) state = "failed";
  else state = fallbackState;

  const platform = stringValue(record, "platform", "destination");
  const normalized = {
    state,
    live: state === "live",
    platform: platform ? platform.slice(0, 40) : null,
    message: safeMessage(body, streamKey),
  };
  return GetStreamingStatusResponse.parse(normalized);
}

function missingControlConfig(res: Response): boolean {
  if (controlIsConfigured()) return false;
  res.status(503).json({ error: "Streaming control server is not configured" });
  return true;
}

function upstreamFailure(
  res: Response,
  result: { status: number; body: unknown },
  streamKey?: string,
): void {
  const status = result.status >= 400 && result.status < 600 ? result.status : 502;
  const message = safeMessage(result.body, streamKey);
  res.status(status).json({ error: message ?? "Streaming control request failed" });
}

router.get("/streaming/status", async (req, res): Promise<void> => {
  const user = await requireUser(req, res);
  if (!user) return;

  const parsed = GetStreamingStatusQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid streaming target" });
    return;
  }
  const camera = await cameraForTarget(user, parsed.data, res);
  if (!camera) return;
  if (missingControlConfig(res)) return;

  try {
    const result = await controlFetch(`/streaming/status/${encodeURIComponent(camera)}`);
    if (!result.ok) {
      upstreamFailure(res, result);
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.json(normalizeStatus(result.body, "unknown"));
  } catch {
    logger.warn({ camera }, "Social streaming status request failed");
    res.status(502).json({ error: "Streaming control server unavailable" });
  }
});

router.post("/streaming/start", async (req, res): Promise<void> => {
  const user = await requireUser(req, res);
  if (!user) return;

  const parsed = StartStreamingBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid streaming start request" });
    return;
  }
  const { camera: targetCamera, fieldId, matchCode, platform, streamKey } = parsed.data;
  const camera = await cameraForTarget(user, { camera: targetCamera, fieldId, matchCode }, res);
  if (!camera) return;
  if (missingControlConfig(res)) return;

  try {
    const result = await controlFetch(`/streaming/start/${encodeURIComponent(camera)}`, {
      method: "POST",
      body: JSON.stringify({ platform, stream_key: streamKey }),
    });
    if (!result.ok) {
      upstreamFailure(res, result, streamKey);
      return;
    }
    res.json(normalizeStatus(result.body, "starting", streamKey));
  } catch {
    logger.warn({ camera, platform }, "Social streaming start request failed");
    res.status(502).json({ error: "Streaming control server unavailable" });
  }
});

router.post("/streaming/stop", async (req, res): Promise<void> => {
  const user = await requireUser(req, res);
  if (!user) return;

  const parsed = StopStreamingBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid streaming stop request" });
    return;
  }
  const camera = await cameraForTarget(user, parsed.data, res);
  if (!camera) return;
  if (missingControlConfig(res)) return;

  try {
    const result = await controlFetch(`/streaming/stop/${encodeURIComponent(camera)}`, { method: "POST" });
    if (!result.ok) {
      upstreamFailure(res, result);
      return;
    }
    res.json(normalizeStatus(result.body, "offline"));
  } catch {
    logger.warn({ camera }, "Social streaming stop request failed");
    res.status(502).json({ error: "Streaming control server unavailable" });
  }
});

export default router;