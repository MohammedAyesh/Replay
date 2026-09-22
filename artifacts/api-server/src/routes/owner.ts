import crypto from "node:crypto";
import { Readable } from "node:stream";
import { Router, type IRouter, type Request, type Response } from "express";
import { and, asc, desc, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";
import {
  db,
  fieldOwnersTable,
  fieldsTable,
  footagePaymentsTable,
  footageCancellationRequestsTable,
  footageRequestsTable,
  varMarksTable,
  usersTable,
} from "@workspace/db";
import { z } from "zod/v4";
import { getLocalUserRecord, unauthenticatedResponse } from "../lib/clerkUserBridge";
import { computeAmountFils, computeBillableHours } from "../lib/footageBilling";
import { controlFetch, controlResponse } from "./contabo";
import { logger } from "../lib/logger";
import { buildOwnerFootageTitle } from "@workspace/api-zod";

const router: IRouter = Router();
const AMMAN_TIME_ZONE = "Asia/Amman";
const REQUEST_RATE_FILS = 1000;
const SHARE_LIFETIME_MS = 14 * 24 * 60 * 60 * 1000;
const AVAILABILITY_CACHE_MS = 2 * 60 * 1000;
const REQUEST_REFRESH_MS = 10 * 1000;
const MAX_UNFINISHED_REQUESTS = 2;
const MAX_SCHEDULED_REQUESTS = 10;
const ACTIVE_REQUEST_STATUSES = ["queued", "running", "scheduled", "recording"] as const;
const CANCELLABLE_REQUEST_STATUSES = ACTIVE_REQUEST_STATUSES;
const AMMAN_UTC_OFFSET_MS = 3 * 60 * 60 * 1000;

type OwnerUser = NonNullable<Awaited<ReturnType<typeof getLocalUserRecord>>>;
type FootageRequest = typeof footageRequestsTable.$inferSelect;
type VarMarkRow = typeof varMarksTable.$inferSelect;
type Availability = Record<string, unknown>;

const requestBodySchema = z.object({
  startLocal: z.string(),
  endLocal: z.string(),
});
const varMarkBodySchema = z.object({
  atUtc: z.coerce.date(),
  kind: z.enum(["goal", "foul", "offside", "other"]),
  note: z.string().trim().max(500).nullable().optional(),
});

const availabilityCache = new Map<string, { expiresAt: number; body: Availability }>();
const requestRefreshAt = new Map<number, number>();
const syncState = new Map<number, {
  remoteUpdatedAt: string | null;
  remoteChangedAt: number;
}>();
let syncInterval: ReturnType<typeof setInterval> | null = null;
let syncInProgress = false;

class CameraUnavailableError extends Error {}

function rawParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function parseId(value: string | string[] | undefined): number | null {
  const parsed = Number.parseInt(rawParam(value), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function getAmmanNow(): { local: string; date: string } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: AMMAN_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date()).map((part) => [part.type, part.value]));
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  return { date, local: `${date} ${parts.hour}:${parts.minute}` };
}

type LocalDateTime = {
  value: string;
  date: string;
  hour: number;
  minute: number;
  epochMs: number;
};

function parseLocalDateTime(value: string): LocalDateTime | null {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;

  const [, yearText, monthText, dayText, hourText, minuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;

  const epochMs = Date.UTC(year, month - 1, day, hour, minute);
  const check = new Date(epochMs);
  if (
    check.getUTCFullYear() !== year
    || check.getUTCMonth() !== month - 1
    || check.getUTCDate() !== day
    || check.getUTCHours() !== hour
    || check.getUTCMinutes() !== minute
  ) {
    return null;
  }

  return { value, date: `${yearText}-${monthText}-${dayText}`, hour, minute, epochMs };
}

function localFromEpoch(epochMs: number): LocalDateTime {
  const date = new Date(epochMs);
  const value = [
    date.getUTCFullYear().toString().padStart(4, "0"),
    (date.getUTCMonth() + 1).toString().padStart(2, "0"),
    date.getUTCDate().toString().padStart(2, "0"),
  ].join("-") + ` ${date.getUTCHours().toString().padStart(2, "0")}:${date.getUTCMinutes().toString().padStart(2, "0")}`;
  return parseLocalDateTime(value)!;
}

function getTouchedHours(startMs: number, endMs: number): Array<{ date: string; hour: number }> {
  const touched: Array<{ date: string; hour: number }> = [];
  for (let cursor = startMs; cursor < endMs; cursor += 60 * 60 * 1000) {
    const local = localFromEpoch(cursor);
    const key = `${local.date}:${local.hour}`;
    if (!touched.some((entry) => `${entry.date}:${entry.hour}` === key)) {
      touched.push({ date: local.date, hour: local.hour });
    }
  }
  return touched;
}

function ammanLocalEpoch(value: string): number {
  const parsed = parseLocalDateTime(value);
  return parsed?.epochMs ?? Number.NaN;
}

function ammanLocalInstant(value: string): number {
  const epoch = ammanLocalEpoch(value);
  return Number.isFinite(epoch) ? epoch - AMMAN_UTC_OFFSET_MS : Number.NaN;
}

function publicBaseUrl(req: Request): string {
  const configured = process.env.PUBLIC_SHARE_BASE_URL || process.env.PUBLIC_BASE_URL;
  if (configured) return configured.replace(/\/$/, "");
  const proto = (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0]
    || req.protocol
    || "https";
  const host = (req.headers["x-forwarded-host"] as string | undefined)?.split(",")[0]
    || req.get("host")
    || "";
  return `${proto}://${host}`;
}

function newShareToken(): string {
  return crypto.randomBytes(16).toString("hex");
}

function isActiveShare(row: FootageRequest, now = Date.now()): boolean {
  return (
    (row.status === "ready" || row.status === "partial")
    && Boolean(row.shareToken)
    && !row.shareRevoked
    && Boolean(row.shareExpiresAt)
    && row.shareExpiresAt!.getTime() > now
  );
}

export function isVarActive(row: Pick<FootageRequest, "startLocal" | "endLocal" | "status" | "varState">, now = Date.now()): boolean {
  const opensAt = ammanLocalInstant(row.startLocal) - 3 * 60 * 1000;
  const closesAt = ammanLocalInstant(row.endLocal) + 5 * 60 * 1000;
  return (
    Number.isFinite(opensAt)
    && Number.isFinite(closesAt)
    && now >= opensAt
    && now <= closesAt
    && ACTIVE_REQUEST_STATUSES.includes(row.status as typeof ACTIVE_REQUEST_STATUSES[number])
    && row.varState !== "unsupported"
    && row.varState !== "ftp-failed"
  );
}

function markToResponse(mark: VarMarkRow, request: FootageRequest) {
  const startInstant = ammanLocalInstant(request.startLocal);
  return {
    id: mark.id,
    atUtc: mark.atUtc.toISOString(),
    kind: mark.kind,
    note: mark.note,
    createdBy: mark.createdBy,
    offsetSeconds: Number.isFinite(startInstant)
      ? (mark.atUtc.getTime() - startInstant) / 1000
      : null,
  };
}

function requestToResponse(
  row: FootageRequest,
  req: Request,
  marks: VarMarkRow[] = [],
  cancellationStatus: string | null = null,
) {
  const active = isActiveShare(row);
  const varOpenMs = ammanLocalInstant(row.startLocal) - 3 * 60 * 1000;
  const varCloseMs = ammanLocalInstant(row.endLocal) + 5 * 60 * 1000;
  const base = publicBaseUrl(req);
  const shareUrl = active ? `${base}/w/${row.shareToken}` : null;
  const playbackManifestUrl = active ? `${base}/w/${row.shareToken}/manifest.m3u8` : null;
  return {
    id: row.id,
    startLocal: row.startLocal,
    endLocal: row.endLocal,
    requestedSeconds: row.requestedSeconds,
    status: row.status,
    progress: row.progress,
    message: row.message,
    billableHours: row.billableHours,
    amountFils: row.amountFils,
    readyAt: row.readyAt?.toISOString() ?? null,
    shareUrl,
    shareExpiresAt: row.shareExpiresAt?.toISOString() ?? null,
    playbackManifestUrl,
    varOpensAt: Number.isFinite(varOpenMs) ? new Date(varOpenMs).toISOString() : null,
    varClosesAt: Number.isFinite(varCloseMs) ? new Date(varCloseMs).toISOString() : null,
    varState: row.varState,
    varActive: isVarActive(row),
    cancellationStatus,
    marks: marks.map((mark) => markToResponse(mark, row)),
  };
}

async function marksForRequests(rows: FootageRequest[]): Promise<Map<number, VarMarkRow[]>> {
  const ids = rows.map((row) => row.id);
  if (!ids.length) return new Map();
  const marks = await db.select().from(varMarksTable)
    .where(inArray(varMarksTable.footageRequestId, ids))
    .orderBy(asc(varMarksTable.atUtc), asc(varMarksTable.id));
  const grouped = new Map<number, VarMarkRow[]>();
  for (const mark of marks) {
    const current = grouped.get(mark.footageRequestId) ?? [];
    current.push(mark);
    grouped.set(mark.footageRequestId, current);
  }
  return grouped;
}

async function cancellationStatusForRequests(rows: FootageRequest[]): Promise<Map<number, string>> {
  const ids = rows.map((row) => row.id);
  if (!ids.length) return new Map();
  const cancellations = await db.select({
    footageRequestId: footageCancellationRequestsTable.footageRequestId,
    status: footageCancellationRequestsTable.status,
  }).from(footageCancellationRequestsTable)
    .where(inArray(footageCancellationRequestsTable.footageRequestId, ids));
  return new Map(cancellations.map((row) => [row.footageRequestId, row.status]));
}

type VarVariant = "hls" | "hevc";

function parseVarVariant(value: string | string[] | undefined): VarVariant | null {
  const variant = rawParam(value);
  return variant === "hls" || variant === "hevc" ? variant : null;
}

function vpsVarCamera(camera: string): string {
  if (camera === "camera1") return "cam1";
  if (camera === "camera2") return "cam2";
  return camera;
}

function validVarSegmentName(value: string | string[] | undefined): string | null {
  const name = rawParam(value);
  return /^[A-Za-z0-9._-]+\.(ts|m4s|mp4)$/.test(name) ? name : null;
}

function varPath(camera: string, variant: VarVariant, suffix: string): string {
  return `/var/${encodeURIComponent(vpsVarCamera(camera))}/${variant}/${suffix}`;
}

function rewriteVarPlaylist(
  playlist: string,
  variant: VarVariant,
  proxyPrefix: string,
): string {
  const sourcePath = new RegExp(
    `/var/[^/\\s"]+/${variant}/seg/([A-Za-z0-9._-]+\\.(?:ts|m4s|mp4))`,
    "g",
  );
  return playlist.replace(sourcePath, `${proxyPrefix}/$1`);
}

function varWindowSummary(body: unknown): { live: boolean; newestAgeSec: number | null } {
  if (!body || typeof body !== "object") return { live: false, newestAgeSec: null };
  const value = body as Record<string, unknown>;
  const variants = value.variants;
  const hls = variants && typeof variants === "object"
    ? (variants as Record<string, unknown>).hls
    : null;
  const hlsValue = hls && typeof hls === "object" ? hls as Record<string, unknown> : null;
  const newestAgeSec = hlsValue?.newestAgeSec
    ?? hlsValue?.newest_age_sec
    ?? value.newestAgeSec
    ?? value.newest_age_sec;
  return {
    live: hlsValue?.live === true || (!hlsValue && value.live === true),
    newestAgeSec: typeof newestAgeSec === "number" && Number.isFinite(newestAgeSec) ? newestAgeSec : null,
  };
}

async function sendVarPlaylist(
  res: Response,
  camera: string,
  variant: VarVariant,
  proxyPrefix: string,
  since?: number,
): Promise<void> {
  const query = since === undefined ? "" : `?since=${Math.floor(since / 1000)}`;
  let upstream: globalThis.Response;
  try {
    upstream = await controlResponse(`${varPath(camera, variant, "playlist.m3u8")}${query}`, {}, 30_000);
  } catch (error) {
    logger.warn({ error, camera, variant }, "VAR playlist proxy failed");
    res.status(502).json({ error: "VAR control server unreachable" });
    return;
  }
  if (!upstream.ok) {
    res.status(upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502)
      .json({ error: "VAR playlist unavailable" });
    return;
  }

  const playlist = await upstream.text();
  const rewritten = rewriteVarPlaylist(playlist, variant, proxyPrefix);
  res
    .set("Cache-Control", "no-store")
    .type("application/vnd.apple.mpegurl")
    .send(rewritten);
}

async function sendVarSegment(
  res: Response,
  camera: string,
  variant: VarVariant,
  name: string,
): Promise<void> {
  let upstream: globalThis.Response;
  try {
    upstream = await controlResponse(varPath(camera, variant, `seg/${encodeURIComponent(name)}`), {}, 30_000);
  } catch (error) {
    logger.warn({ error, camera, variant, name }, "VAR segment proxy failed");
    res.status(502).json({ error: "VAR control server unreachable" });
    return;
  }
  if (!upstream.ok || !upstream.body) {
    res.status(upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502)
      .json({ error: "VAR segment unavailable" });
    return;
  }

  const contentType = upstream.headers.get("content-type");
  if (contentType) res.set("Content-Type", contentType);
  res.set("Cache-Control", "private, max-age=3600");
  const stream = Readable.fromWeb(upstream.body as globalThis.ReadableStream<Uint8Array>);
  let closed = false;
  const cleanup = () => {
    closed = true;
    stream.removeListener("error", onStreamError);
  };
  const onStreamError = (error: unknown) => {
    if (closed) return;
    logger.warn({ error, camera, variant, name }, "VAR segment stream ended before completion");
    closed = true;
    if (!res.headersSent && !res.destroyed) {
      res.status(502).json({ error: "VAR segment unavailable" });
    } else if (!res.destroyed) {
      res.destroy();
    }
  };
  stream.once("error", onStreamError);
  res.once("finish", cleanup);
  res.once("close", () => {
    if (!res.writableFinished) stream.destroy();
    cleanup();
  });
  stream.pipe(res);
}

async function requireOwnerUser(req: Request, res: Response): Promise<OwnerUser | null> {
  const user = await getLocalUserRecord(req);
  if (!user) {
    unauthenticatedResponse(res, req);
    return null;
  }
  if (user.isAdmin) return user;

  const [owned] = await db
    .select({ fieldId: fieldOwnersTable.fieldId })
    .from(fieldOwnersTable)
    .where(eq(fieldOwnersTable.userId, user.id))
    .limit(1);
  if (!owned) {
    res.status(403).json({ error: "Owner or admin access required" });
    return null;
  }
  return user;
}

async function requireAdminUser(req: Request, res: Response): Promise<OwnerUser | null> {
  const user = await getLocalUserRecord(req);
  if (!user) {
    unauthenticatedResponse(res, req);
    return null;
  }
  if (!user.isAdmin) {
    res.status(403).json({ error: "Admin access required" });
    return null;
  }
  return user;
}

async function requireFieldAccess(
  req: Request,
  res: Response,
  fieldId: number,
): Promise<OwnerUser | null> {
  const user = await getLocalUserRecord(req);
  if (!user) {
    unauthenticatedResponse(res, req);
    return null;
  }
  if (user.isAdmin) return user;

  const [owned] = await db
    .select({ fieldId: fieldOwnersTable.fieldId })
    .from(fieldOwnersTable)
    .where(and(
      eq(fieldOwnersTable.userId, user.id),
      eq(fieldOwnersTable.fieldId, fieldId),
    ))
    .limit(1);
  if (!owned) {
    res.status(403).json({ error: "Owner or admin access required" });
    return null;
  }
  return user;
}

async function fieldForAccess(fieldId: number, res: Response) {
  const [field] = await db.select().from(fieldsTable).where(eq(fieldsTable.id, fieldId));
  if (!field) {
    res.status(404).json({ error: "Field not found" });
    return null;
  }
  return field;
}

function availabilityHasHour(body: Availability, hour: number): boolean {
  const hours = body.hours;
  if (!Array.isArray(hours)) return false;
  return hours.some((entry) => {
    if (typeof entry === "number") return entry === hour;
    if (typeof entry === "string") return Number.parseInt(entry.slice(0, 2), 10) === hour;
    if (!entry || typeof entry !== "object") return false;
    const value = (entry as { hour?: unknown }).hour;
    return typeof value === "number"
      ? value === hour
      : Number.parseInt(String(value ?? "").slice(0, 2), 10) === hour;
  });
}

async function getAvailability(camera: string, date: string): Promise<Availability> {
  const key = `${camera}:${date}`;
  const cached = availabilityCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.body;

  let result;
  try {
    result = await controlFetch(
      `/sd/${encodeURIComponent(camera)}/available?date=${encodeURIComponent(date)}`,
      {},
      90_000,
    );
  } catch (error) {
    throw new CameraUnavailableError("Camera unreachable — try again in a few minutes", { cause: error });
  }
  if (!result.ok || !result.body || typeof result.body !== "object") {
    throw new CameraUnavailableError("Camera unreachable — try again in a few minutes");
  }

  const body = result.body as Availability;
  availabilityCache.set(key, { body, expiresAt: Date.now() + AVAILABILITY_CACHE_MS });
  return body;
}

async function validateAvailability(camera: string, startMs: number, endMs: number, nowMs = Date.now()): Promise<void> {
  const byDate = new Map<string, Availability>();
  for (const { date, hour } of getTouchedHours(startMs, endMs)) {
    // Future and currently-recording hours are valid booking targets even
    // though the SD-card availability endpoint cannot report them yet.
    const hourStart = ammanLocalEpoch(
      `${date} ${hour.toString().padStart(2, "0")}:00`,
    );
    if (!Number.isFinite(hourStart) || hourStart + 60 * 60 * 1000 > nowMs) continue;

    const body = byDate.get(date) ?? await getAvailability(camera, date);
    byDate.set(date, body);
    if (!availabilityHasHour(body, hour)) {
      throw new Error(`No footage on the camera for ${hour.toString().padStart(2, "0")}:00`);
    }
  }
}

function responseJobId(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const value = body as Record<string, unknown>;
  const jobId = value.jobId ?? value.job_id ?? value.id;
  return typeof jobId === "string" || typeof jobId === "number" ? String(jobId) : null;
}

function bodyString(body: unknown, ...keys: string[]): string | null {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  for (const key of keys) {
    if (typeof record[key] === "string" && record[key]) return record[key] as string;
  }
  return null;
}

function bodyNumber(body: unknown, ...keys: string[]): number | null {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  for (const key of keys) {
    if (typeof record[key] === "number" && Number.isFinite(record[key])) return record[key] as number;
  }
  return null;
}

function varStateFromJob(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const value = (body as Record<string, unknown>).var;
  if (!value || typeof value !== "object") return null;
  const state = (value as Record<string, unknown>).state;
  return typeof state === "string" && state ? state : null;
}

function mappedStatus(body: unknown): "scheduled" | "recording" | "queued" | "running" | "ready" | "partial" | "failed" | "cancelled" {
  const status = (bodyString(body, "status", "state") ?? "").toLowerCase();
  if (status === "done" || status === "completed" || status === "ready") return "ready";
  if (status === "partial") return "partial";
  if (status === "failed" || status === "error") return "failed";
  if (status === "cancelled" || status === "canceled") return "cancelled";
  if (status === "scheduled") return "scheduled";
  if (status === "recording") return "recording";
  if (status === "queued") return "queued";
  return "running";
}

function errorMessage(body: unknown, fallback: string): string {
  return bodyString(body, "error", "message", "note") ?? fallback;
}

async function failRequest(id: number, message: string): Promise<void> {
  await db.update(footageRequestsTable)
    .set({ status: "failed", message, updatedAt: new Date() })
    .where(eq(footageRequestsTable.id, id));
}

async function completeRequest(row: FootageRequest, body: unknown, status: "ready" | "partial"): Promise<void> {
  const now = new Date();
  const deliveredSeconds = status === "partial"
    ? Math.max(0, bodyNumber(body, "durationSeconds", "duration_seconds", "deliveredSeconds", "delivered_seconds") ?? 0)
    : row.deliveredSeconds;
  const billableHours = computeBillableHours(
    status === "partial" ? "partial" : "done",
    row.requestedSeconds,
    deliveredSeconds,
  );
  const videoId = bodyString(body, "videoId", "video_id") ?? row.videoId;

  await db.update(footageRequestsTable)
    .set({
      status,
      progress: 100,
      message: bodyString(body, "message", "note"),
      deliveredSeconds,
      videoId,
      readyAt: now,
      shareToken: newShareToken(),
      shareExpiresAt: new Date(now.getTime() + SHARE_LIFETIME_MS),
      shareRevoked: false,
      billableHours,
      amountFils: computeAmountFils(billableHours, row.rateFils),
      updatedAt: now,
    })
    .where(and(
      eq(footageRequestsTable.id, row.id),
      inArray(footageRequestsTable.status, ACTIVE_REQUEST_STATUSES),
    ));
}

export async function refreshOwnerRequest(
  row: FootageRequest,
  camera: string,
  now = Date.now(),
): Promise<void> {
  if (!row.vpsJobId) {
    await failRequest(row.id, "The camera pull did not return a job id");
    return;
  }

  let result;
  try {
    result = await controlFetch(
      `/record-hq/${encodeURIComponent(camera)}/${encodeURIComponent(row.vpsJobId)}`,
      {},
      90_000,
    );
  } catch (error) {
    logger.warn({ requestId: row.id, error }, "Owner footage status refresh failed");
    return;
  }

  if (!result.ok) {
    if (
      result.status === 404
      && (row.status === "queued" || row.status === "running")
      && now - row.createdAt.getTime() > 10 * 60 * 1000
    ) {
      await failRequest(row.id, "The camera pull could not be found — not charged");
    }
    return;
  }

  const next = mappedStatus(result.body);
  const nextVarState = varStateFromJob(result.body);
  await db.update(footageRequestsTable)
    .set({ varState: nextVarState, updatedAt: new Date() })
    .where(eq(footageRequestsTable.id, row.id));
  row = { ...row, varState: nextVarState };
  const remoteUpdatedAt = bodyString(result.body, "updatedAt", "updated_at");
  const state = syncState.get(row.id) ?? {
    remoteUpdatedAt: null,
    remoteChangedAt: now,
  };
  if (remoteUpdatedAt && remoteUpdatedAt !== state.remoteUpdatedAt) {
    state.remoteUpdatedAt = remoteUpdatedAt;
    state.remoteChangedAt = now;
  }
  syncState.set(row.id, state);

  const endEpoch = ammanLocalEpoch(row.endLocal);
  const pastStaleWindow = Number.isFinite(endEpoch)
    && now > endEpoch + 90 * 60 * 1000;
  const staleLimitApplies = next === "running"
    || ((next === "scheduled" || next === "recording") && pastStaleWindow);
  if (staleLimitApplies && remoteUpdatedAt && now - state.remoteChangedAt > 45 * 60 * 1000) {
    await failRequest(row.id, "The camera pull stopped — not charged");
    return;
  }

  if (next === "ready" || next === "partial") {
    await completeRequest(row, result.body, next);
    syncState.delete(row.id);
    return;
  }
  if (next === "failed") {
    await failRequest(row.id, errorMessage(result.body, "The camera pull failed — not charged"));
    syncState.delete(row.id);
    return;
  }
  if (next === "cancelled") {
    await db.update(footageRequestsTable)
      .set({ status: "cancelled", message: bodyString(result.body, "message", "note") ?? "Cancelled", updatedAt: new Date() })
      .where(and(
        eq(footageRequestsTable.id, row.id),
        inArray(footageRequestsTable.status, ACTIVE_REQUEST_STATUSES),
      ));
    syncState.delete(row.id);
    return;
  }

  const progress = Math.max(0, Math.min(100, bodyNumber(result.body, "progress", "percent") ?? row.progress));
  await db.update(footageRequestsTable)
    .set({
      status: next,
      progress,
      message: bodyString(result.body, "message", "note", "stage") ?? row.message,
      updatedAt: new Date(),
    })
    .where(and(
      eq(footageRequestsTable.id, row.id),
      inArray(footageRequestsTable.status, ACTIVE_REQUEST_STATUSES),
    ));
}

async function expireOwnerShares(now = new Date()): Promise<void> {
  await db.update(footageRequestsTable)
    .set({ status: "expired", updatedAt: now })
    .where(and(
      inArray(footageRequestsTable.status, ["ready", "partial"]),
      isNotNull(footageRequestsTable.shareExpiresAt),
      // Keep the comparison in SQL so this also works when the process has
      // been asleep between interval ticks.
      lt(footageRequestsTable.shareExpiresAt, now),
    ));
}

export async function runOwnerStatusSync(): Promise<void> {
  if (syncInProgress) return;
  syncInProgress = true;
  try {
    const rows = await db
      .select({ request: footageRequestsTable, camera: fieldsTable.cameraId })
      .from(footageRequestsTable)
      .innerJoin(fieldsTable, eq(fieldsTable.id, footageRequestsTable.fieldId))
      .where(inArray(footageRequestsTable.status, ACTIVE_REQUEST_STATUSES));
    await Promise.allSettled(
      rows
        .filter(({ camera }) => Boolean(camera))
        .map(({ request, camera }) => refreshOwnerRequest(request, camera!)),
    );
    await expireOwnerShares();
  } finally {
    syncInProgress = false;
  }
}

export function startOwnerStatusSync(): void {
  if (syncInterval) return;
  void runOwnerStatusSync();
  syncInterval = setInterval(() => {
    void runOwnerStatusSync();
  }, 60_000);
}

async function refreshUnfinishedRequest(row: FootageRequest, camera: string): Promise<void> {
  const previous = requestRefreshAt.get(row.id) ?? 0;
  if (Date.now() - previous < REQUEST_REFRESH_MS) return;
  requestRefreshAt.set(row.id, Date.now());
  await refreshOwnerRequest(row, camera);
}

async function balanceForField(fieldId: number): Promise<{ chargedFils: number; paidFils: number; balanceFils: number }> {
  const [charges, payments] = await Promise.all([
    db.select({ amountFils: footageRequestsTable.amountFils })
      .from(footageRequestsTable)
      .where(and(
        eq(footageRequestsTable.fieldId, fieldId),
        inArray(footageRequestsTable.status, ["ready", "partial", "expired"]),
      )),
    db.select({ amountFils: footagePaymentsTable.amountFils })
      .from(footagePaymentsTable)
      .where(eq(footagePaymentsTable.fieldId, fieldId)),
  ]);
  const chargedFils = charges.reduce((sum, row) => sum + row.amountFils, 0);
  // Refund entries are deliberately negative in the ledger, but they are not
  // payments made against the field balance. A refunded delivery is removed
  // from charges by its request status, while the negative entry remains
  // visible for audit purposes.
  const paidFils = payments
    .filter((row) => row.amountFils > 0)
    .reduce((sum, row) => sum + row.amountFils, 0);
  return { chargedFils, paidFils, balanceFils: chargedFils - paidFils };
}

router.get("/admin/footage-owners", async (req, res): Promise<void> => {
  if (!await requireAdminUser(req, res)) return;
  const rows = await db
    .select({
      id: fieldOwnersTable.id,
      fieldId: fieldsTable.id,
      fieldName: fieldsTable.name,
      userId: usersTable.id,
      name: usersTable.name,
      email: usersTable.email,
      createdAt: fieldOwnersTable.createdAt,
    })
    .from(fieldOwnersTable)
    .innerJoin(fieldsTable, eq(fieldsTable.id, fieldOwnersTable.fieldId))
    .innerJoin(usersTable, eq(usersTable.id, fieldOwnersTable.userId))
    .orderBy(fieldsTable.name, usersTable.email);
  res.json(rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })));
});

router.post("/admin/footage-owners", async (req, res): Promise<void> => {
  if (!await requireAdminUser(req, res)) return;
  const fieldId = Number(req.body?.fieldId);
  const email = typeof req.body?.email === "string" ? req.body.email.trim() : "";
  if (!Number.isSafeInteger(fieldId) || fieldId <= 0 || !email) {
    res.status(400).json({ error: "fieldId and email are required" });
    return;
  }
  const [field] = await db.select({ id: fieldsTable.id }).from(fieldsTable).where(eq(fieldsTable.id, fieldId));
  if (!field) {
    res.status(404).json({ error: "Field not found" });
    return;
  }
  const [user] = await db.select({ id: usersTable.id, name: usersTable.name, email: usersTable.email })
    .from(usersTable)
    .where(sql`lower(${usersTable.email}) = lower(${email})`)
    .limit(1);
  if (!user) {
    res.status(404).json({ error: "No user found with that email" });
    return;
  }
  const [existing] = await db.select({ id: fieldOwnersTable.id })
    .from(fieldOwnersTable)
    .where(and(eq(fieldOwnersTable.fieldId, fieldId), eq(fieldOwnersTable.userId, user.id)))
    .limit(1);
  if (existing) {
    res.status(409).json({ error: "That user already owns this field" });
    return;
  }
  const [created] = await db.insert(fieldOwnersTable).values({ fieldId, userId: user.id }).returning();
  res.status(201).json({
    id: created.id,
    fieldId,
    fieldName: (await db.select({ name: fieldsTable.name }).from(fieldsTable).where(eq(fieldsTable.id, fieldId)))[0]?.name ?? "",
    userId: user.id,
    name: user.name,
    email: user.email,
    createdAt: created.createdAt.toISOString(),
  });
});

router.delete("/admin/footage-owners", async (req, res): Promise<void> => {
  if (!await requireAdminUser(req, res)) return;
  const fieldId = Number(req.body?.fieldId);
  const email = typeof req.body?.email === "string" ? req.body.email.trim() : "";
  if (!Number.isSafeInteger(fieldId) || fieldId <= 0 || !email) {
    res.status(400).json({ error: "fieldId and email are required" });
    return;
  }
  const [user] = await db.select({ id: usersTable.id })
    .from(usersTable)
    .where(sql`lower(${usersTable.email}) = lower(${email})`)
    .limit(1);
  if (!user) {
    res.status(404).json({ error: "No user found with that email" });
    return;
  }
  const deleted = await db.delete(fieldOwnersTable)
    .where(and(eq(fieldOwnersTable.fieldId, fieldId), eq(fieldOwnersTable.userId, user.id)))
    .returning({ id: fieldOwnersTable.id });
  if (!deleted.length) {
    res.status(404).json({ error: "Owner assignment not found" });
    return;
  }
  res.json({ ok: true });
});

router.get("/admin/footage-billing", async (req, res): Promise<void> => {
  if (!await requireAdminUser(req, res)) return;
  await expireOwnerShares();
  const fields = await db.select().from(fieldsTable).where(isNotNull(fieldsTable.cameraId)).orderBy(fieldsTable.name);
  const owners = await db
    .select({
      fieldId: fieldOwnersTable.fieldId,
      userId: usersTable.id,
      name: usersTable.name,
      email: usersTable.email,
    })
    .from(fieldOwnersTable)
    .innerJoin(usersTable, eq(usersTable.id, fieldOwnersTable.userId));
  const ownerByField = new Map<number, typeof owners[number]>();
  for (const owner of owners) ownerByField.set(owner.fieldId, owner);
  const payments = await db.select({
    id: footagePaymentsTable.id,
    fieldId: footagePaymentsTable.fieldId,
    amountFils: footagePaymentsTable.amountFils,
    method: footagePaymentsTable.method,
    note: footagePaymentsTable.note,
    createdAt: footagePaymentsTable.createdAt,
    recordedBy: usersTable.email,
  })
    .from(footagePaymentsTable)
    .innerJoin(usersTable, eq(usersTable.id, footagePaymentsTable.recordedBy))
    .orderBy(desc(footagePaymentsTable.createdAt))
    .limit(50);
  const balances = await Promise.all(fields.map(async (field) => ({
    fieldId: field.id,
    fieldName: field.name,
    owner: ownerByField.get(field.id) ?? null,
    ...(await balanceForField(field.id)),
  })));
  res.json({
    fields: balances,
    payments: payments.map((payment) => ({ ...payment, createdAt: payment.createdAt.toISOString() })),
    totalChargedFils: balances.reduce((sum, field) => sum + field.chargedFils, 0),
    totalPaidFils: balances.reduce((sum, field) => sum + field.paidFils, 0),
    totalBalanceFils: balances.reduce((sum, field) => sum + field.balanceFils, 0),
  });
});

router.get("/admin/footage-cancellation-requests", async (req, res): Promise<void> => {
  if (!await requireAdminUser(req, res)) return;
  const rows = await db.select({
    request: footageCancellationRequestsTable,
    footage: footageRequestsTable,
    fieldName: fieldsTable.name,
    ownerName: usersTable.name,
    ownerEmail: usersTable.email,
  })
    .from(footageCancellationRequestsTable)
    .innerJoin(footageRequestsTable, eq(footageRequestsTable.id, footageCancellationRequestsTable.footageRequestId))
    .innerJoin(fieldsTable, eq(fieldsTable.id, footageRequestsTable.fieldId))
    .innerJoin(usersTable, eq(usersTable.id, footageCancellationRequestsTable.requestedBy))
    .orderBy(desc(footageCancellationRequestsTable.createdAt));
  res.json(rows.map(({ request, footage, fieldName, ownerName, ownerEmail }) => ({
    id: request.id,
    footageRequestId: request.footageRequestId,
    fieldId: footage.fieldId,
    fieldName,
    ownerName,
    ownerEmail,
    startLocal: footage.startLocal,
    endLocal: footage.endLocal,
    amountFils: footage.amountFils,
    reason: request.reason,
    status: request.status,
    adminNote: request.adminNote,
    createdAt: request.createdAt.toISOString(),
    reviewedAt: request.reviewedAt?.toISOString() ?? null,
  })));
});

const cancellationReviewSchema = z.object({
  status: z.enum(["approved", "declined"]),
  note: z.string().trim().max(1000).nullable().optional(),
});

router.patch("/admin/footage-cancellation-requests/:id", async (req, res): Promise<void> => {
  const admin = await requireAdminUser(req, res);
  if (!admin) return;
  const id = parseId(req.params.id);
  if (!id) {
    res.status(400).json({ error: "Invalid cancellation request id" });
    return;
  }
  const parsed = cancellationReviewSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "status must be approved or declined" });
    return;
  }
  const [pending] = await db.select()
    .from(footageCancellationRequestsTable)
    .where(and(
      eq(footageCancellationRequestsTable.id, id),
      eq(footageCancellationRequestsTable.status, "pending"),
    ));
  if (!pending) {
    res.status(409).json({ error: "This cancellation request has already been reviewed" });
    return;
  }
  const [footage] = await db.select().from(footageRequestsTable)
    .where(eq(footageRequestsTable.id, pending.footageRequestId));
  if (!footage) {
    res.status(404).json({ error: "Footage request not found" });
    return;
  }
  const now = new Date();
  const note = parsed.data.note?.trim() || null;
  if (parsed.data.status === "declined") {
    const [updated] = await db.update(footageCancellationRequestsTable)
      .set({ status: "declined", adminNote: note, reviewedBy: admin.id, reviewedAt: now, updatedAt: now })
      .where(and(
        eq(footageCancellationRequestsTable.id, id),
        eq(footageCancellationRequestsTable.status, "pending"),
      ))
      .returning();
    res.json({ id: updated.id, status: updated.status, adminNote: updated.adminNote });
    return;
  }
  await db.transaction(async (tx) => {
    await tx.update(footageCancellationRequestsTable)
      .set({ status: "approved", adminNote: note, reviewedBy: admin.id, reviewedAt: now, updatedAt: now })
      .where(and(
        eq(footageCancellationRequestsTable.id, id),
        eq(footageCancellationRequestsTable.status, "pending"),
      ));
    await tx.update(footageRequestsTable)
      .set({
        status: "refunded",
        amountFils: 0,
        billableHours: 0,
        shareRevoked: true,
        shareToken: null,
        shareExpiresAt: null,
        message: note || "Refund approved",
        updatedAt: now,
      })
      .where(and(
        eq(footageRequestsTable.id, footage.id),
        inArray(footageRequestsTable.status, ["ready", "partial"]),
      ));
    await tx.insert(footagePaymentsTable).values({
      fieldId: footage.fieldId,
      amountFils: -Math.max(0, footage.amountFils),
      method: "Refund",
      note: note || `Refund for footage request #${footage.id}`,
      recordedBy: admin.id,
    });
  });
  res.json({ id: pending.id, status: "approved", adminNote: note, refundedFils: footage.amountFils });
});

router.post("/admin/fields/:fieldId/payments", async (req, res): Promise<void> => {
  const admin = await requireAdminUser(req, res);
  if (!admin) return;
  const fieldId = parseId(req.params.fieldId);
  const amountJod = Number(req.body?.amountJod);
  const method = req.body?.method;
  const note = typeof req.body?.note === "string" ? req.body.note.trim() : null;
  if (!fieldId || !Number.isFinite(amountJod) || amountJod <= 0 || !["CliQ", "Cash", "Other"].includes(method)) {
    res.status(400).json({ error: "amountJod, method (CliQ, Cash, or Other), and optional note are required" });
    return;
  }
  const [field] = await db.select({ id: fieldsTable.id }).from(fieldsTable).where(eq(fieldsTable.id, fieldId));
  if (!field) {
    res.status(404).json({ error: "Field not found" });
    return;
  }
  const amountFils = Math.round(amountJod * 1000);
  if (amountFils < 1) {
    res.status(400).json({ error: "Payment must be at least 0.001 JOD" });
    return;
  }
  const [payment] = await db.insert(footagePaymentsTable).values({
    fieldId,
    amountFils,
    method,
    note: note || null,
    recordedBy: admin.id,
  }).returning();
  res.status(201).json({
    id: payment.id,
    fieldId: payment.fieldId,
    amountFils: payment.amountFils,
    amountJod: payment.amountFils / 1000,
    method: payment.method,
    note: payment.note,
    createdAt: payment.createdAt.toISOString(),
  });
});

router.get("/owner/fields", async (req, res): Promise<void> => {
  const user = await requireOwnerUser(req, res);
  if (!user) return;

  const fields = user.isAdmin
    ? await db.select().from(fieldsTable).where(isNotNull(fieldsTable.cameraId)).orderBy(fieldsTable.name)
    : await db.select({ field: fieldsTable })
      .from(fieldsTable)
      .innerJoin(fieldOwnersTable, eq(fieldOwnersTable.fieldId, fieldsTable.id))
      .where(and(
        eq(fieldOwnersTable.userId, user.id),
        isNotNull(fieldsTable.cameraId),
      ))
      .orderBy(fieldsTable.name)
      .then((rows) => rows.map(({ field }) => field));

  const result = await Promise.all(fields.map(async (field) => ({
    id: field.id,
    name: field.name,
    cameraId: field.cameraId!,
    balanceFils: (await balanceForField(field.id)).balanceFils,
  })));
  res.json(result);
});

router.get("/owner/fields/:fieldId/availability/:date", async (req, res): Promise<void> => {
  const fieldId = parseId(req.params.fieldId);
  if (!fieldId) {
    res.status(400).json({ error: "Invalid field id" });
    return;
  }
  const user = await requireFieldAccess(req, res, fieldId);
  if (!user) return;
  const field = await fieldForAccess(fieldId, res);
  if (!field) return;
  if (!field.cameraId) {
    res.status(404).json({ error: "Field has no camera" });
    return;
  }
  const date = rawParam(req.params.date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !parseLocalDateTime(`${date} 00:00`)) {
    res.status(400).json({ error: "Invalid date" });
    return;
  }
  try {
    res.json(await getAvailability(field.cameraId, date));
  } catch (error) {
    if (error instanceof CameraUnavailableError) {
      res.status(503).json({ error: error.message });
      return;
    }
    throw error;
  }
});

router.post("/owner/fields/:fieldId/requests", async (req, res): Promise<void> => {
  const fieldId = parseId(req.params.fieldId);
  if (!fieldId) {
    res.status(400).json({ error: "Invalid field id" });
    return;
  }
  const user = await requireFieldAccess(req, res, fieldId);
  if (!user) return;
  const field = await fieldForAccess(fieldId, res);
  if (!field) return;
  if (!field.cameraId) {
    res.status(400).json({ error: "This field has no camera" });
    return;
  }

  const body = requestBodySchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "startLocal and endLocal are required as YYYY-MM-DD HH:MM" });
    return;
  }
  const start = parseLocalDateTime(body.data.startLocal);
  const end = parseLocalDateTime(body.data.endLocal);
  if (!start || !end) {
    res.status(400).json({ error: "startLocal and endLocal must be YYYY-MM-DD HH:MM" });
    return;
  }
  if (start.minute % 15 !== 0 || end.minute % 15 !== 0) {
    res.status(400).json({ error: "Start and end must be on a 15-minute step" });
    return;
  }
  const durationSeconds = Math.floor((end.epochMs - start.epochMs) / 1000);
  if (durationSeconds < 15 * 60) {
    res.status(400).json({ error: "Footage requests must be at least 15 minutes" });
    return;
  }
  if (durationSeconds > 4 * 60 * 60) {
    res.status(400).json({ error: "Footage requests cannot exceed 4 hours" });
    return;
  }
  const now = getAmmanNow();
  const nowMs = ammanLocalEpoch(now.local);
  if (start.epochMs > nowMs + 14 * 24 * 60 * 60 * 1000) {
    res.status(400).json({ error: "Footage can only be booked up to 14 days ahead" });
    return;
  }

  const unfinished = await db
    .select({ id: footageRequestsTable.id })
    .from(footageRequestsTable)
    .where(and(
      eq(footageRequestsTable.requestedBy, user.id),
      inArray(footageRequestsTable.status, ["queued", "running"]),
    ));
  if (unfinished.length >= MAX_UNFINISHED_REQUESTS) {
    res.status(400).json({ error: "You already have 2 unfinished footage requests" });
    return;
  }

  const scheduled = await db
    .select({ id: footageRequestsTable.id })
    .from(footageRequestsTable)
    .where(and(
      eq(footageRequestsTable.requestedBy, user.id),
      inArray(footageRequestsTable.status, ["scheduled", "recording"]),
    ));
  if (scheduled.length >= MAX_SCHEDULED_REQUESTS) {
    res.status(400).json({ error: "You already have 10 scheduled footage bookings" });
    return;
  }

  const overlapping = await db
    .select({
      startLocal: footageRequestsTable.startLocal,
      endLocal: footageRequestsTable.endLocal,
    })
    .from(footageRequestsTable)
    .where(and(
      eq(footageRequestsTable.fieldId, fieldId),
      inArray(footageRequestsTable.status, ACTIVE_REQUEST_STATUSES),
    ));
  if (overlapping.some((existing) => {
    const existingStart = ammanLocalEpoch(existing.startLocal);
    const existingEnd = ammanLocalEpoch(existing.endLocal);
    return Number.isFinite(existingStart)
      && Number.isFinite(existingEnd)
      && start.epochMs < existingEnd
      && existingStart < end.epochMs;
  })) {
    res.status(400).json({ error: "You already booked footage for this time" });
    return;
  }

  try {
    await validateAvailability(field.cameraId, start.epochMs, end.epochMs, nowMs);
  } catch (error) {
    if (error instanceof CameraUnavailableError) {
      res.status(503).json({ error: error.message });
      return;
    }
    res.status(400).json({ error: error instanceof Error ? error.message : "Camera availability validation failed" });
    return;
  }

  const [created] = await db.insert(footageRequestsTable).values({
    fieldId,
    cameraId: field.cameraId,
    requestedBy: user.id,
    startLocal: start.value,
    endLocal: end.value,
    requestedSeconds: durationSeconds,
    rateFils: REQUEST_RATE_FILS,
    status: end.epochMs > nowMs ? "scheduled" : "queued",
  }).returning();

  const title = buildOwnerFootageTitle(field.cameraId, created.id, start.value);
  try {
    // The camera service expects seconds, while the owner-facing and database
    // contract intentionally stays at minute precision.
    const remoteStart = `${start.value}:00`;
    const remoteEnd = `${end.value}:00`;
    const result = await controlFetch(
      `/record-hq/${encodeURIComponent(field.cameraId)}?start=${encodeURIComponent(remoteStart)}&end=${encodeURIComponent(remoteEnd)}&title=${encodeURIComponent(title)}`,
      { method: "POST" },
      90_000,
    );
    const jobId = responseJobId(result.body);
    if (!result.ok || !jobId) {
      await failRequest(created.id, errorMessage(result.body, "The camera pull could not be started — not charged"));
    } else {
      const remoteStatus = bodyString(result.body, "status", "state");
      const status = remoteStatus
        ? mappedStatus(result.body)
        : (end.epochMs > nowMs ? "scheduled" : "queued");
      await db.update(footageRequestsTable)
        .set({ vpsJobId: jobId, status, updatedAt: new Date() })
        .where(eq(footageRequestsTable.id, created.id));
    }
  } catch (error) {
    logger.error({ requestId: created.id, error }, "Failed to queue owner footage request");
    await failRequest(created.id, "The camera pull could not be started — not charged");
  }

  const [saved] = await db.select().from(footageRequestsTable).where(eq(footageRequestsTable.id, created.id));
  res.status(201).json(requestToResponse(saved ?? created, req));
});

router.get("/owner/fields/:fieldId/requests", async (req, res): Promise<void> => {
  const fieldId = parseId(req.params.fieldId);
  if (!fieldId) {
    res.status(400).json({ error: "Invalid field id" });
    return;
  }
  const user = await requireFieldAccess(req, res, fieldId);
  if (!user) return;
  const field = await fieldForAccess(fieldId, res);
  if (!field) return;

  const rows = await db.select().from(footageRequestsTable)
    .where(eq(footageRequestsTable.fieldId, fieldId))
    .orderBy(desc(footageRequestsTable.createdAt));
  await Promise.all(rows
    .filter((row) => ACTIVE_REQUEST_STATUSES.includes(row.status as typeof ACTIVE_REQUEST_STATUSES[number]))
    .map((row) => field.cameraId ? refreshUnfinishedRequest(row, field.cameraId) : Promise.resolve()));
  await expireOwnerShares();

  const refreshed = await db.select().from(footageRequestsTable)
    .where(eq(footageRequestsTable.fieldId, fieldId))
    .orderBy(desc(footageRequestsTable.createdAt));
  const marksByRequest = await marksForRequests(refreshed);
  const cancellationByRequest = await cancellationStatusForRequests(refreshed);
  res.json(refreshed.map((row) => requestToResponse(
    row,
    req,
    marksByRequest.get(row.id) ?? [],
    cancellationByRequest.get(row.id) ?? null,
  )));
});

async function requestWithField(id: number): Promise<{ request: FootageRequest; fieldId: number; fieldName: string } | null> {
  const [row] = await db.select({
    request: footageRequestsTable,
    fieldId: footageRequestsTable.fieldId,
    fieldName: fieldsTable.name,
  }).from(footageRequestsTable)
    .innerJoin(fieldsTable, eq(fieldsTable.id, footageRequestsTable.fieldId))
    .where(eq(footageRequestsTable.id, id));
  return row ?? null;
}

async function requireRequestAccess(req: Request, res: Response, id: number): Promise<{ user: OwnerUser; request: FootageRequest; fieldName: string } | null> {
  const found = await requestWithField(id);
  if (!found) {
    res.status(404).json({ error: "Request not found" });
    return null;
  }
  const user = await requireFieldAccess(req, res, found.fieldId);
  if (!user) return null;
  return { user, request: found.request, fieldName: found.fieldName };
}

router.get("/owner/requests/:id/var/:variant/playlist.m3u8", async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  const variant = parseVarVariant(req.params.variant);
  if (!id) {
    res.status(404).json({ error: "Request not found" });
    return;
  }
  if (!variant) {
    res.status(400).json({ error: "Invalid VAR variant" });
    return;
  }

  const found = await requireRequestAccess(req, res, id);
  if (!found) return;
  if (!isVarActive(found.request)) {
    res.status(404).json({ error: "VAR is not active for this request" });
    return;
  }

  const startInstant = ammanLocalInstant(found.request.startLocal);
  if (!Number.isFinite(startInstant)) {
    res.status(404).json({ error: "VAR is not active for this request" });
    return;
  }
  await sendVarPlaylist(
    res,
    found.request.cameraId,
    variant,
    `/api/owner/requests/${id}/var/${variant}/seg`,
    startInstant - 3 * 60 * 1000,
  );
});

router.get("/owner/requests/:id/var/:variant/seg/:name", async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  const variant = parseVarVariant(req.params.variant);
  if (!id) {
    res.status(404).json({ error: "Request not found" });
    return;
  }
  if (!variant) {
    res.status(400).json({ error: "Invalid VAR variant" });
    return;
  }

  const found = await requireRequestAccess(req, res, id);
  if (!found) return;
  if (!isVarActive(found.request)) {
    res.status(404).json({ error: "VAR is not active for this request" });
    return;
  }

  const name = validVarSegmentName(req.params.name);
  if (!name) {
    res.status(400).json({ error: "Invalid VAR segment name" });
    return;
  }
  await sendVarSegment(res, found.request.cameraId, variant, name);
});

router.get("/owner/requests/:id/var/status", async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  if (!id) {
    res.status(404).json({ error: "Request not found" });
    return;
  }
  const found = await requireRequestAccess(req, res, id);
  if (!found) return;

  let result;
  let stateResult;
  try {
    const camera = encodeURIComponent(vpsVarCamera(found.request.cameraId));
    [result, stateResult] = await Promise.all([
      controlFetch(`/var/${camera}/window`, {}, 30_000),
      controlFetch(`/var/${camera}/state`, {}, 30_000),
    ]);
  } catch (error) {
    logger.warn({ error, requestId: id }, "VAR window status proxy failed");
    res.status(502).json({ error: "VAR control server unreachable" });
    return;
  }
  if (!result.ok) {
    res.status(result.status >= 400 && result.status < 600 ? result.status : 502)
      .json({ error: "VAR window unavailable" });
    return;
  }

  const summary = varWindowSummary(result.body);
  const varActive = isVarActive(found.request);
  const rawCdnUrl = stateResult.ok && stateResult.body && typeof stateResult.body === "object"
    ? (stateResult.body as Record<string, unknown>).cdnUrl
    : null;
  const cdnUrl = varActive
    && typeof rawCdnUrl === "string"
    && /^https:\/\/[^/]+\/var\/cam\d+\/[a-f0-9]{32}\/index\.m3u8$/i.test(rawCdnUrl)
    ? rawCdnUrl
    : undefined;
  res.json({
    fieldName: found.fieldName,
    startLocal: found.request.startLocal,
    endLocal: found.request.endLocal,
    varActive,
    varState: found.request.varState,
    live: summary.live,
    newestAgeSec: summary.newestAgeSec,
    ...(cdnUrl ? { cdnUrl } : {}),
  });
});

router.get("/owner/requests/:id/var-marks", async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  if (!id) {
    res.status(404).json({ error: "Request not found" });
    return;
  }
  const found = await requireRequestAccess(req, res, id);
  if (!found) return;
  const marks = await db.select().from(varMarksTable)
    .where(eq(varMarksTable.footageRequestId, id))
    .orderBy(asc(varMarksTable.atUtc), asc(varMarksTable.id));
  res.json(marks.map((mark) => markToResponse(mark, found.request)));
});

router.post("/owner/requests/:id/var-marks", async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  if (!id) {
    res.status(404).json({ error: "Request not found" });
    return;
  }
  const found = await requireRequestAccess(req, res, id);
  if (!found) return;

  const parsed = varMarkBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid VAR mark" });
    return;
  }

  const startInstant = ammanLocalInstant(found.request.startLocal);
  const endInstant = ammanLocalInstant(found.request.endLocal);
  const now = Date.now();
  if (
    !Number.isFinite(startInstant)
    || !Number.isFinite(endInstant)
    || now < startInstant - 3 * 60 * 1000
    || now > endInstant + 30 * 60 * 1000
  ) {
    res.status(409).json({ error: "VAR marking is closed for this request" });
    return;
  }

  const atUtcMs = parsed.data.atUtc.getTime();
  if (
    !Number.isFinite(atUtcMs)
    || atUtcMs < startInstant - 3 * 60 * 1000
    || atUtcMs > endInstant + 5 * 60 * 1000
  ) {
    res.status(400).json({ error: "The marked time is outside the request window" });
    return;
  }

  const [mark] = await db.insert(varMarksTable).values({
    footageRequestId: id,
    atUtc: parsed.data.atUtc,
    kind: parsed.data.kind,
    note: parsed.data.note || null,
    createdBy: found.user.id,
  }).returning();
  res.status(201).json(markToResponse(mark, found.request));
});

router.delete("/owner/var-marks/:markId", async (req, res): Promise<void> => {
  const markId = parseId(req.params.markId);
  if (!markId) {
    res.status(404).json({ error: "Mark not found" });
    return;
  }
  const user = await getLocalUserRecord(req);
  if (!user) {
    unauthenticatedResponse(res, req);
    return;
  }
  const [mark] = await db.select().from(varMarksTable).where(eq(varMarksTable.id, markId));
  if (!mark) {
    res.status(404).json({ error: "Mark not found" });
    return;
  }
  if (!user.isAdmin && mark.createdBy !== user.id) {
    res.status(403).json({ error: "You cannot delete this mark" });
    return;
  }
  await db.delete(varMarksTable).where(eq(varMarksTable.id, markId));
  res.status(204).send();
});

router.get("/admin/var/:camera/:variant/playlist.m3u8", async (req, res): Promise<void> => {
  const user = await requireAdminUser(req, res);
  if (!user) return;
  const camera = rawParam(req.params.camera);
  const variant = parseVarVariant(req.params.variant);
  if (!camera) {
    res.status(400).json({ error: "Invalid camera" });
    return;
  }
  if (!variant) {
    res.status(400).json({ error: "Invalid VAR variant" });
    return;
  }
  await sendVarPlaylist(
    res,
    camera,
    variant,
    `/api/admin/var/${encodeURIComponent(camera)}/${variant}/seg`,
  );
});

router.get("/admin/var/:camera/:variant/seg/:name", async (req, res): Promise<void> => {
  const user = await requireAdminUser(req, res);
  if (!user) return;
  const camera = rawParam(req.params.camera);
  const variant = parseVarVariant(req.params.variant);
  const name = validVarSegmentName(req.params.name);
  if (!camera) {
    res.status(400).json({ error: "Invalid camera" });
    return;
  }
  if (!variant) {
    res.status(400).json({ error: "Invalid VAR variant" });
    return;
  }
  if (!name) {
    res.status(400).json({ error: "Invalid VAR segment name" });
    return;
  }
  await sendVarSegment(res, camera, variant, name);
});

router.get("/admin/var/:camera/window", async (req, res): Promise<void> => {
  const user = await requireAdminUser(req, res);
  if (!user) return;
  const camera = rawParam(req.params.camera);
  if (!camera) {
    res.status(400).json({ error: "Invalid camera" });
    return;
  }
  let result;
  try {
    result = await controlFetch(`/var/${encodeURIComponent(vpsVarCamera(camera))}/window`, {}, 30_000);
  } catch (error) {
    logger.warn({ error, camera }, "Admin VAR window proxy failed");
    res.status(502).json({ error: "VAR control server unreachable" });
    return;
  }
  res.status(result.ok ? 200 : (result.status >= 400 && result.status < 600 ? result.status : 502))
    .json(result.body);
});

router.post("/owner/requests/:id/cancel", async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  if (!id) {
    res.status(404).json({ error: "Request not found" });
    return;
  }
  const found = await requireRequestAccess(req, res, id);
  if (!found) return;

  if (!CANCELLABLE_REQUEST_STATUSES.includes(found.request.status as typeof CANCELLABLE_REQUEST_STATUSES[number])) {
    res.status(409).json({
      error: "Only queued, scheduled, recording, or running footage can be cancelled",
    });
    return;
  }

  if (found.request.vpsJobId) {
    let result;
    try {
      result = await controlFetch(
        `/record-hq/${encodeURIComponent(found.request.cameraId)}/${encodeURIComponent(found.request.vpsJobId)}`,
        { method: "DELETE" },
        30_000,
      );
    } catch (error) {
      logger.warn({ requestId: id, error }, "Scheduled footage cancellation failed");
      res.status(502).json({ error: "The camera pull could not be cancelled" });
      return;
    }
    if (!result.ok) {
      res.status(result.status >= 400 && result.status < 500 ? result.status : 502).json({
        error: errorMessage(result.body, "The camera pull could not be cancelled"),
      });
      return;
    }
  }

  const [cancelled] = await db.update(footageRequestsTable)
    .set({ status: "cancelled", message: "Cancelled by owner", updatedAt: new Date() })
    .where(and(
      eq(footageRequestsTable.id, id),
      inArray(footageRequestsTable.status, CANCELLABLE_REQUEST_STATUSES),
    ))
    .returning();
  if (!cancelled) {
    res.status(409).json({ error: "The footage booking has already started" });
    return;
  }
  syncState.delete(id);
  res.json(requestToResponse(cancelled, req));
});

const cancellationBodySchema = z.object({
  reason: z.string().trim().min(1).max(1000),
});

router.post("/owner/requests/:id/cancellation", async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  if (!id) {
    res.status(404).json({ error: "Request not found" });
    return;
  }
  const found = await requireRequestAccess(req, res, id);
  if (!found) return;
  if (found.request.status !== "ready" && found.request.status !== "partial") {
    res.status(409).json({ error: "Cancellation requests are only available for delivered footage" });
    return;
  }
  const parsed = cancellationBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Please provide a reason for the cancellation request" });
    return;
  }
  const [existing] = await db.select({ id: footageCancellationRequestsTable.id, status: footageCancellationRequestsTable.status })
    .from(footageCancellationRequestsTable)
    .where(eq(footageCancellationRequestsTable.footageRequestId, id));
  if (existing) {
    res.status(409).json({ error: existing.status === "declined" ? "A cancellation request was already declined" : "A cancellation request already exists" });
    return;
  }
  const [created] = await db.insert(footageCancellationRequestsTable).values({
    footageRequestId: id,
    requestedBy: found.user.id,
    reason: parsed.data.reason,
  }).returning();
  res.status(201).json({
    id: created.id,
    footageRequestId: id,
    reason: created.reason,
    status: created.status,
    adminNote: created.adminNote,
    reviewedAt: null,
    createdAt: created.createdAt.toISOString(),
  });
});

router.post("/owner/requests/:id/revoke-link", async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  if (!id) {
    res.status(404).json({ error: "Request not found" });
    return;
  }
  const found = await requireRequestAccess(req, res, id);
  if (!found) return;
  await db.update(footageRequestsTable)
    .set({ shareRevoked: true, updatedAt: new Date() })
    .where(eq(footageRequestsTable.id, id));
  res.json({
    shareUrl: null,
    shareExpiresAt: found.request.shareExpiresAt?.toISOString() ?? null,
    revoked: true,
  });
});

router.post("/owner/requests/:id/new-link", async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  if (!id) {
    res.status(404).json({ error: "Request not found" });
    return;
  }
  const found = await requireRequestAccess(req, res, id);
  if (!found) return;
  const token = newShareToken();
  await db.update(footageRequestsTable)
    .set({ shareToken: token, shareRevoked: false, updatedAt: new Date() })
    .where(eq(footageRequestsTable.id, id));
  const active = isActiveShare({
    ...found.request,
    shareToken: token,
    shareRevoked: false,
  });
  res.json({
    shareUrl: active ? `${publicBaseUrl(req)}/w/${token}` : null,
    shareExpiresAt: found.request.shareExpiresAt?.toISOString() ?? null,
    revoked: false,
  });
});

router.get("/owner/fields/:fieldId/ledger", async (req, res): Promise<void> => {
  const fieldId = parseId(req.params.fieldId);
  if (!fieldId) {
    res.status(400).json({ error: "Invalid field id" });
    return;
  }
  const user = await requireFieldAccess(req, res, fieldId);
  if (!user) return;
  const field = await fieldForAccess(fieldId, res);
  if (!field) return;

  await expireOwnerShares();
  const [charges, payments] = await Promise.all([
    db.select().from(footageRequestsTable)
      .where(and(
        eq(footageRequestsTable.fieldId, fieldId),
        inArray(footageRequestsTable.status, ["ready", "partial", "expired"]),
      ))
      .orderBy(desc(footageRequestsTable.createdAt)),
    db.select().from(footagePaymentsTable)
      .where(eq(footagePaymentsTable.fieldId, fieldId))
      .orderBy(desc(footagePaymentsTable.createdAt)),
  ]);
  const totalChargedFils = charges.reduce((sum, row) => sum + row.amountFils, 0);
  const paidFils = payments.reduce((sum, row) => sum + row.amountFils, 0);
  res.json({
    charges: charges.map((row) => ({
      id: row.id,
      startLocal: row.startLocal,
      endLocal: row.endLocal,
      billableHours: row.billableHours,
      amountFils: row.amountFils,
    })),
    payments: payments.map((row) => ({
      id: row.id,
      amountFils: row.amountFils,
      method: row.method,
      note: row.note,
      createdAt: row.createdAt.toISOString(),
    })),
    totalChargedFils,
    paidFils,
    balanceFils: totalChargedFils - paidFils,
  });
});

export default router;