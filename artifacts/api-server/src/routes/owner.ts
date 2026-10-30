import { bookingPriceFils, loadCommerce } from "../lib/commerce";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import { Router, type IRouter, type Request, type Response } from "express";
import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, lte, sql } from "drizzle-orm";
import {
  academiesTable,
  db,
  fieldOwnersTable,
  fieldsTable,
  footagePaymentsTable,
  footageCancellationRequestsTable,
  footageRequestsTable,
  matchPlayersTable,
  matchRoomsTable,
  statUnlocksTable,
  varMarksTable,
  usersTable,
} from "@workspace/db";
import { z } from "zod/v4";
import { getLocalUserRecord, unauthenticatedResponse } from "../lib/clerkUserBridge";
import { computeAmountFils, computeBillableHours } from "../lib/footageBilling";
import { controlFetch, controlResponse } from "./contabo";
import { chooseFootageSource, gapPullPath, remoteJobPath, withGapStore } from "../lib/gapStore";
import { logger } from "../lib/logger";
import { buildOwnerFootageTitle } from "@workspace/api-zod";
import { ensureRoomForRequest, isRosterMemberOfRequest, randomToken } from "../lib/matchRooms";
import { liveAnalysisEnabled, queueLiveAnalysisForBooking } from "../lib/liveAnalysis";
import { attachAcademyRecordingsForFootageRequest } from "../lib/academyFootage";
import {
  attachReward, availableReward, canEarn, claimReward, loyaltyStatus, releaseReward, releaseRewardForMatch, unpaidLapseCutoffLocal,
  UNPAID_BOOKING_LAPSE_MS,
} from "../lib/freeMatch";

const router: IRouter = Router();
const AMMAN_TIME_ZONE = "Asia/Amman";
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

function isHistoricalBooking(row: Pick<FootageRequest, "startLocal" | "createdAt">): boolean {
  const start = ammanLocalInstant(row.startLocal);
  return Number.isFinite(start) && start < row.createdAt.getTime();
}

function unpaidBookingHasLapsed(
  row: Pick<FootageRequest, "startLocal" | "endLocal" | "createdAt">,
  now: number,
): boolean {
  return isHistoricalBooking(row)
    ? row.createdAt.getTime() <= now - UNPAID_BOOKING_LAPSE_MS
    : row.endLocal <= unpaidLapseCutoffLocal(now);
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
    row.academyId === null
    && (row.status === "ready" || row.status === "partial")
    && Boolean(row.shareToken)
    && !row.shareRevoked
    && Boolean(row.shareExpiresAt)
    && row.shareExpiresAt!.getTime() > now
  );
}

export function isVarActive(
  row: Pick<FootageRequest, "startLocal" | "endLocal" | "status" | "varState"> & Partial<Pick<FootageRequest, "academyId">>,
  now = Date.now(),
): boolean {
  if (row.academyId != null) return false;
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

type RoomLink = { code: string; captainToken: string } | null;

function requestToResponse(
  row: FootageRequest,
  req: Request,
  marks: VarMarkRow[] = [],
  cancellationStatus: string | null = null,
  room: RoomLink = null,
  academyName: string | null = null,
) {
  const active = isActiveShare(row);
  const academyOwned = row.academyId !== null;
  const varOpenMs = academyOwned ? Number.NaN : ammanLocalInstant(row.startLocal) - 3 * 60 * 1000;
  const varCloseMs = academyOwned ? Number.NaN : ammanLocalInstant(row.endLocal) + 5 * 60 * 1000;
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
    varState: academyOwned ? null : row.varState,
    varActive: isVarActive(row),
    cancellationStatus,
    academyName,
    marks: academyOwned ? [] : marks.map((mark) => markToResponse(mark, row)),
    match: room ? {
      code: room.code,
      url: `${base}/m/${room.code}`,
      captainUrl: `${base}/m/${room.code}?c=${room.captainToken}`,
    } : null,
  };
}

async function roomLinkFor(row: FootageRequest): Promise<RoomLink> {
  if (row.academyId !== null) return null;
  try {
    const room = await ensureRoomForRequest(row);
    return { code: room.code, captainToken: room.captainToken };
  } catch (error) {
    logger.warn({ error, requestId: row.id }, "Could not load match room for request");
    return null;
  }
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
  // SD card hours plus the off-schedule FTP store's hours (lib/gapStore.ts)
  const body = await withGapStore(camera, date, () => getSdAvailability(camera, date));
  availabilityCache.set(key, { body, expiresAt: Date.now() + AVAILABILITY_CACHE_MS });
  return body;
}

async function getSdAvailability(camera: string, date: string): Promise<Availability> {
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

  return result.body as Availability;
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

  const completed = await db.update(footageRequestsTable)
    .set({
      status,
      progress: 100,
      message: bodyString(body, "message", "note"),
      deliveredSeconds,
      videoId,
      readyAt: now,
      shareToken: row.academyId === null ? newShareToken() : null,
      shareExpiresAt: row.academyId === null ? new Date(now.getTime() + SHARE_LIFETIME_MS) : null,
      shareRevoked: row.academyId !== null,
      billableHours,
      amountFils: computeAmountFils(billableHours, row.rateFils),
      updatedAt: now,
    })
    .where(and(
      eq(footageRequestsTable.id, row.id),
      inArray(footageRequestsTable.status, ACTIVE_REQUEST_STATUSES),
    )).returning({ id: footageRequestsTable.id });

  // Only the call that actually completed the request queues its analysis.
  if (completed.length > 0 && row.academyId === null) {
    try {
      await queueLiveAnalysisForBooking(row, videoId, deliveredSeconds);
    } catch (error) {
      logger.warn({ requestId: row.id, error }, "Could not queue the booking's analysis");
    }
  }
  try {
    await attachAcademyRecordingsForFootageRequest(row, videoId, deliveredSeconds);
  } catch (error) {
    logger.warn({ requestId: row.id, error }, "Could not attach completed footage to academy sessions");
  }
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
      remoteJobPath(camera, row.vpsJobId),
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
      isNull(footageRequestsTable.academyId),
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
    await lapseUnpaidBookings().catch((error) => logger.warn({ error }, "Lapsing unpaid bookings failed"));
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
        isNull(footageRequestsTable.academyId),
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

/** The owner's footage rate for one field (Admin -> Settings -> Pricing), for the console's price labels. */
router.get("/owner/fields/:fieldId/rate", async (req, res): Promise<void> => {
  const fieldId = parseId(req.params.fieldId);
  if (!fieldId) {
    res.status(400).json({ error: "Invalid field id" });
    return;
  }
  const user = await requireFieldAccess(req, res, fieldId);
  if (!user) return;
  const commerce = await loadCommerce({ userId: user.id, fieldId });
  res.json({ ratePerHourFils: commerce.ownerFootageFilsPerHour });
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

/**
 * Hands a booking to the camera service on vps1. Future windows become
 * scheduled pulls (ready about 20 minutes after the end); past windows are
 * pulled from the SD card straight away. Failures mark the request failed
 * (never charged).
 */
export async function startCameraJob(row: FootageRequest, cameraId: string): Promise<void> {
  const end = parseLocalDateTime(row.endLocal);
  const nowMs = ammanLocalEpoch(getAmmanNow().local);
  const future = end ? end.epochMs > nowMs : false;
  const title = buildOwnerFootageTitle(cameraId, row.id, row.startLocal);
  try {
    // The camera service expects seconds, while the owner-facing and database
    // contract intentionally stays at minute precision.
    const remoteStart = `${row.startLocal}:00`;
    const remoteEnd = `${row.endLocal}:00`;
    // "Analyse bookings during the match": tells the VPS to watch this booking
    // for its kick-off and analyse it as it is played (lib/liveAnalysis.ts).
    const live = future && await liveAnalysisEnabled(row.fieldId);
    // A past window the SD card doesn't record comes from the off-schedule FTP store.
    const source = future
      ? "sd"
      : await chooseFootageSource(cameraId, remoteStart, remoteEnd, (date) => getAvailability(cameraId, date));
    const result = await controlFetch(
      source === "ftp"
        ? gapPullPath(cameraId, remoteStart, remoteEnd, title)
        : `/record-hq/${encodeURIComponent(cameraId)}?start=${encodeURIComponent(remoteStart)}&end=${encodeURIComponent(remoteEnd)}&title=${encodeURIComponent(title)}${live ? "&live=1" : ""}`,
      { method: "POST" },
      90_000,
    );
    const jobId = responseJobId(result.body);
    if (!result.ok || !jobId) {
      await failRequest(row.id, errorMessage(result.body, "The camera pull could not be started — not charged"));
    } else {
      const remoteStatus = bodyString(result.body, "status", "state");
      const status = remoteStatus ? mappedStatus(result.body) : (future ? "scheduled" : "queued");
      await db.update(footageRequestsTable)
        .set({ vpsJobId: jobId, status, updatedAt: new Date() })
        .where(eq(footageRequestsTable.id, row.id));
    }
  } catch (error) {
    logger.error({ requestId: row.id, error }, "Failed to queue footage request");
    await failRequest(row.id, "The camera pull could not be started — not charged");
  }
}

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
      isNull(footageRequestsTable.academyId),
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
      isNull(footageRequestsTable.academyId),
      inArray(footageRequestsTable.status, ["scheduled", "recording"]),
    ));
  if (scheduled.length >= MAX_SCHEDULED_REQUESTS) {
    res.status(400).json({ error: "You already have 10 scheduled footage bookings" });
    return;
  }

  const overlapping = (await db
    .select({
      startLocal: footageRequestsTable.startLocal,
      endLocal: footageRequestsTable.endLocal,
      academyId: footageRequestsTable.academyId,
    })
    .from(footageRequestsTable)
    .where(and(
      eq(footageRequestsTable.fieldId, fieldId),
      inArray(footageRequestsTable.status, ACTIVE_REQUEST_STATUSES),
    ))).filter((existing) => {
    const existingStart = ammanLocalEpoch(existing.startLocal);
    const existingEnd = ammanLocalEpoch(existing.endLocal);
    return Number.isFinite(existingStart)
      && Number.isFinite(existingEnd)
      && start.epochMs < existingEnd
      && existingStart < end.epochMs;
  });
  if (overlapping.length) {
    // Academy sessions hold the camera too, but they are hidden from the owner's
    // list: say who has the slot, and nothing more about it.
    const academyOnly = overlapping.every((existing) => existing.academyId !== null);
    res.status(400).json({ error: academyOnly ? "The academy has this slot booked" : "You already booked footage for this time" });
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
    rateFils: (await loadCommerce({ userId: user.id, fieldId })).ownerFootageFilsPerHour,
    status: end.epochMs > nowMs ? "scheduled" : "queued",
  }).returning();

  await startCameraJob(created, field.cameraId);

  const [saved] = await db.select().from(footageRequestsTable).where(eq(footageRequestsTable.id, created.id));
  const room = await roomLinkFor(saved ?? created);
  res.status(201).json(requestToResponse(saved ?? created, req, [], null, room));
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

  const requestScope = and(
    eq(footageRequestsTable.fieldId, fieldId),
    ...(user.isAdmin ? [] : [isNull(footageRequestsTable.academyId)]),
  );
  const rows = await db.select({ request: footageRequestsTable }).from(footageRequestsTable)
    .where(requestScope)
    .orderBy(desc(footageRequestsTable.createdAt));
  await Promise.all(rows
    .filter(({ request }) => ACTIVE_REQUEST_STATUSES.includes(request.status as typeof ACTIVE_REQUEST_STATUSES[number]))
    .map(({ request }) => field.cameraId ? refreshUnfinishedRequest(request, field.cameraId) : Promise.resolve()));
  await expireOwnerShares();

  const refreshed = await db.select({
    request: footageRequestsTable,
    academyName: academiesTable.name,
  }).from(footageRequestsTable)
    .leftJoin(academiesTable, eq(academiesTable.id, footageRequestsTable.academyId))
    .where(requestScope)
    .orderBy(desc(footageRequestsTable.createdAt));
  const requestRows = refreshed.map(({ request }) => request);
  const marksByRequest = await marksForRequests(requestRows);
  const cancellationByRequest = await cancellationStatusForRequests(requestRows);
  const rooms = await Promise.all(requestRows.map((row) => roomLinkFor(row)));
  res.json(refreshed.map(({ request, academyName }, index) => requestToResponse(
    request,
    req,
    marksByRequest.get(request.id) ?? [],
    cancellationByRequest.get(request.id) ?? null,
    rooms[index],
    user.isAdmin ? academyName : null,
  )));
});

async function requestWithField(id: number): Promise<{ request: FootageRequest; fieldId: number; fieldName: string } | null> {
  const [row] = await db.select({
    request: footageRequestsTable,
    fieldId: footageRequestsTable.fieldId,
    fieldName: fieldsTable.name,
  }).from(footageRequestsTable)
    .innerJoin(fieldsTable, eq(fieldsTable.id, footageRequestsTable.fieldId))
    .where(and(
      eq(footageRequestsTable.id, id),
      isNull(footageRequestsTable.academyId),
    ));
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

/**
 * VAR is open to the field's owners and admins, and to the players of that
 * match: anyone whose match-room RSVP is "in" (or the room's captain).
 */
async function requireVarAccess(req: Request, res: Response, id: number): Promise<{ user: OwnerUser; request: FootageRequest; fieldName: string } | null> {
  const found = await requestWithField(id);
  if (!found) {
    res.status(404).json({ error: "Request not found" });
    return null;
  }
  const user = await getLocalUserRecord(req);
  if (!user) {
    unauthenticatedResponse(res, req);
    return null;
  }
  if (!user.isAdmin) {
    const [owned] = await db
      .select({ fieldId: fieldOwnersTable.fieldId })
      .from(fieldOwnersTable)
      .where(and(eq(fieldOwnersTable.userId, user.id), eq(fieldOwnersTable.fieldId, found.fieldId)))
      .limit(1);
    if (!owned && !(await isRosterMemberOfRequest(user.id, id))) {
      res.status(403).json({ error: "Only this match's players can open its VAR" });
      return null;
    }
  }
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

  const found = await requireVarAccess(req, res, id);
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

  const found = await requireVarAccess(req, res, id);
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
  const found = await requireVarAccess(req, res, id);
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
  const found = await requireVarAccess(req, res, id);
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
  const found = await requireVarAccess(req, res, id);
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
        remoteJobPath(found.request.cameraId, found.request.vpsJobId),
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
        isNull(footageRequestsTable.academyId),
        inArray(footageRequestsTable.status, ["ready", "partial", "expired", "refunded"]),
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
       status: row.status,
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

// ---------------------------------------------------------------- player bookings
//
// Anyone with an account can book a future recording. The booking waits for a
// CliQ payment; an admin confirms it (Admin -> Payments) and only then is the
// camera job started. The field owner is never billed for these (rate 0 on the
// request); the money lives on the payment row.

// Prices and limits come from Admin -> Settings (lib/commerce.ts).
const BOOKING_HOLD_STATUSES = [...ACTIVE_REQUEST_STATUSES, "awaiting_payment"];
/** pg_advisory_xact_lock(namespace, fieldId): serialises player booking creation per field. */
const BOOKING_LOCK_NAMESPACE = 7742;

router.get("/bookings/fields", async (req, res): Promise<void> => {
  const viewer = await getLocalUserRecord(req).catch(() => null);
  const commerce = await loadCommerce({ userId: viewer && !viewer.isGuest ? viewer.id : null });
  const rows = await db.select({
    id: fieldsTable.id,
    name: fieldsTable.name,
    location: fieldsTable.location,
    imageUrl: fieldsTable.thumbnailUrl,
    cameraId: fieldsTable.cameraId,
  }).from(fieldsTable).where(isNotNull(fieldsTable.cameraId)).orderBy(asc(fieldsTable.name));
  res.json({
    fields: rows.map(({ cameraId: _camera, ...field }) => field),
    pricePerHourFils: commerce.playerBookingFilsPerHour,
    maxDaysAhead: commerce.bookingMaxDaysAhead,
    maxMinutes: commerce.bookingMaxMinutes,
    enabled: commerce.bookingEnabled,
    payAtField: commerce.payAtField,
    cliqAlias: commerce.cliqAlias,
    freeMatch: viewer && !viewer.isGuest ? await (async () => {
      // Loyalty first: a block he has just completed writes its free match, which availableReward then finds.
      const loyalty = await loyaltyStatus(viewer.id, commerce).catch(() => null);
      const reward = await availableReward(viewer.id).catch(() => null);
      return {
        enabled: commerce.freeMatchEnabled,
        // False once he has had his one free match: a new booking can't count, so don't say it does.
        canEarn: await canEarn(viewer.id, commerce).catch(() => false),
        friendsRequired: commerce.freeMatchFriendsRequired,
        freeHours: commerce.freeMatchHours,
        reward: reward ? { id: reward.id, freeHours: reward.freeHours, expiresAt: reward.expiresAt.toISOString() } : null,
        loyalty: loyalty ? { enabled: loyalty.enabled, every: loyalty.every, count: loyalty.count } : null,
      };
    })() : null,
  });
});

router.get("/bookings/taken", async (req, res): Promise<void> => {
  const fieldId = parseId(typeof req.query.fieldId === "string" ? req.query.fieldId : undefined);
  const date = typeof req.query.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date) ? req.query.date : null;
  if (!fieldId || !date) {
    res.status(400).json({ error: "fieldId and date are required" });
    return;
  }
  const rows = await db.select({ startLocal: footageRequestsTable.startLocal, endLocal: footageRequestsTable.endLocal })
    .from(footageRequestsTable)
    .where(and(
      eq(footageRequestsTable.fieldId, fieldId),
      inArray(footageRequestsTable.status, BOOKING_HOLD_STATUSES),
    ));
  const dayStart = ammanLocalEpoch(`${date} 00:00`);
  const dayEnd = dayStart + 24 * 60 * 60 * 1000;
  res.json({
    taken: rows.filter((row) => {
      const s = ammanLocalEpoch(row.startLocal);
      const e = ammanLocalEpoch(row.endLocal);
      return Number.isFinite(s) && Number.isFinite(e) && s < dayEnd && e > dayStart;
    }),
    now: getAmmanNow().local,
  });
});

const playerBookingSchema = z.object({
  fieldId: z.number().int().positive(),
  startLocal: z.string(),
  endLocal: z.string(),
  title: z.string().trim().max(60).nullable().optional(),
  /** cliq: the recording waits for the transfer. field: locked in now, cash at the field. */
  payWith: z.enum(["cliq", "field"]).optional(),
  /** Spend the player's free match on this booking: its free hours cost nothing. */
  useFreeMatch: z.boolean().optional(),
});

/**
 * Bookings a player holds without having paid: CliQ ones waiting, plus locked-in
 * ones (pay at the field, or switched from it to CliQ) not yet collected or confirmed.
 */
async function unpaidHolds(userId: number): Promise<number> {
  const [cliq] = await db.select({ n: sql<number>`count(*)::int` }).from(footageRequestsTable)
    .where(and(eq(footageRequestsTable.requestedBy, userId), eq(footageRequestsTable.status, "awaiting_payment")));
  const [field] = await db.select({ n: sql<number>`count(*)::int` }).from(statUnlocksTable)
    .innerJoin(matchRoomsTable, eq(matchRoomsTable.id, statUnlocksTable.matchId))
    .innerJoin(footageRequestsTable, eq(footageRequestsTable.id, matchRoomsTable.footageRequestId))
    .where(and(
      eq(statUnlocksTable.userId, userId), eq(statUnlocksTable.kind, "booking"),
      inArray(statUnlocksTable.method, ["field", "cliq"]), eq(statUnlocksTable.status, "pending"),
      inArray(footageRequestsTable.status, ["queued", "scheduled", "recording", "running"]),
    ));
  return (cliq?.n ?? 0) + (field?.n ?? 0);
}

router.post("/bookings", async (req, res): Promise<void> => {
  const user = await getLocalUserRecord(req);
  if (!user) {
    unauthenticatedResponse(res, req);
    return;
  }
  if (user.isGuest) {
    res.status(403).json({ error: "Create an account to book a recording" });
    return;
  }
  const body = playerBookingSchema.safeParse(req.body ?? {});
  if (!body.success) {
    res.status(400).json({ error: "Pick a field, a start and an end" });
    return;
  }
  const [field] = await db.select().from(fieldsTable).where(eq(fieldsTable.id, body.data.fieldId));
  if (!field || !field.cameraId) {
    res.status(404).json({ error: "This field can't record yet" });
    return;
  }
  const commerce = await loadCommerce({ userId: user.id, fieldId: field.id });
  if (!commerce.bookingEnabled) {
    res.status(403).json({ error: "Booking is closed right now" });
    return;
  }
  const start = parseLocalDateTime(body.data.startLocal);
  const end = parseLocalDateTime(body.data.endLocal);
  if (!start || !end || start.minute % 15 !== 0 || end.minute % 15 !== 0) {
    res.status(400).json({ error: "Start and end must be on a 15-minute step" });
    return;
  }
  const durationSeconds = Math.floor((end.epochMs - start.epochMs) / 1000);
  if (durationSeconds < 30 * 60 || durationSeconds > commerce.bookingMaxMinutes * 60) {
    res.status(400).json({ error: `A recording is between 30 minutes and ${commerce.bookingMaxMinutes} minutes` });
    return;
  }
  const nowMs = ammanLocalEpoch(getAmmanNow().local);
  const pastCutoff = nowMs - 15 * 60 * 1000;
  const isPastBooking = end.epochMs <= pastCutoff;
  if (start.epochMs < pastCutoff && !isPastBooking) {
    res.status(400).json({ error: "Pick a time that hasn't started yet" });
    return;
  }
  if (isPastBooking && Math.ceil(end.epochMs / (60 * 60 * 1000)) * 60 * 60 * 1000 > nowMs) {
    res.status(400).json({ error: "Camera availability for that hour is not ready yet. Try again after the hour ends." });
    return;
  }
  if (start.epochMs > nowMs + commerce.bookingMaxDaysAhead * 24 * 60 * 60 * 1000) {
    res.status(400).json({ error: `You can book up to ${commerce.bookingMaxDaysAhead} days ahead` });
    return;
  }
  const payWith = body.data.payWith ?? "cliq";
  if (isPastBooking && payWith !== "cliq") {
    res.status(400).json({ error: "Past-game footage must be paid by CliQ" });
    return;
  }
  if (isPastBooking) {
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
  }
  // Past footage always requires a CliQ confirmation, so it cannot be made
  // free by claiming a reward before the payment gate.
  const reward = body.data.useFreeMatch && !isPastBooking ? await availableReward(user.id) : null;
  if (body.data.useFreeMatch && !reward) {
    res.status(409).json({ error: "You don't have a free match to use" });
    return;
  }
  if (payWith === "field" && !commerce.payAtField) {
    res.status(400).json({ error: "Paying at the field isn't available right now. Pay by CliQ instead." });
    return;
  }
  const waiting = await unpaidHolds(user.id);
  if (waiting >= commerce.bookingMaxAwaiting) {
    res.status(409).json({ error: `You have ${waiting} bookings waiting for payment. Pay or cancel one first.` });
    return;
  }
  // A free match covers its free hours; anything longer is paid as usual, per started hour.
  const amountFils = reward
    ? Math.max(0, Math.ceil(durationSeconds / 3600) - reward.freeHours) * commerce.playerBookingFilsPerHour
    : bookingPriceFils(durationSeconds, commerce.playerBookingFilsPerHour);
  const fullyFree = Boolean(reward) && amountFils === 0;
  if (isPastBooking && amountFils <= 0) {
    res.status(400).json({ error: "Past-game footage requires a CliQ payment" });
    return;
  }
  const method = fullyFree ? "free" : payWith;
  const fieldCamera = field.cameraId;
  // One booking at a time per field: the slot check, the free-match claim and the
  // insert that holds the slot can't interleave with another booking's, so two
  // taps for one slot can't both pass (nor both spend a free match).
  const held = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${BOOKING_LOCK_NAMESPACE}, ${field.id})`);
    const others = await tx.select({ startLocal: footageRequestsTable.startLocal, endLocal: footageRequestsTable.endLocal })
      .from(footageRequestsTable)
      .where(and(eq(footageRequestsTable.fieldId, field.id), inArray(footageRequestsTable.status, BOOKING_HOLD_STATUSES)));
    if (others.some((o) => {
      const s = ammanLocalEpoch(o.startLocal);
      const e = ammanLocalEpoch(o.endLocal);
      return start.epochMs < e && s < end.epochMs;
    })) return { error: "Someone already booked that time" } as const;
    // Claim the free match with the slot, so a double tap is turned away cleanly.
    if (reward && !(await claimReward(reward.id, user.id, tx))) return { error: "You don't have a free match to use" } as const;
    const [row] = await tx.insert(footageRequestsTable).values({
      fieldId: field.id,
      cameraId: fieldCamera,
      requestedBy: user.id,
      startLocal: start.value,
      endLocal: end.value,
      requestedSeconds: durationSeconds,
      // Paid by the players, so the field owner's ledger charges nothing for it.
      rateFils: 0,
      status: "awaiting_payment",
      message: "Waiting for payment",
    }).returning();
    return { row } as const;
  });
  if ("error" in held) {
    res.status(409).json({ error: held.error });
    return;
  }
  const created: typeof footageRequestsTable.$inferSelect = held.row;
  let room: Awaited<ReturnType<typeof ensureRoomForRequest>>;
  let reference: string;
  try {
    room = await ensureRoomForRequest(created);
    if (reward) await attachReward(reward.id, room.id);
    await db.update(matchRoomsTable).set({
      captainUserId: user.id,
      title: body.data.title || null,
      updatedAt: new Date(),
    }).where(eq(matchRoomsTable.id, room.id));
    await db.insert(matchPlayersTable).values({
      matchId: room.id,
      userId: user.id,
      displayName: user.name,
      inviteToken: randomToken(10),
      rsvp: "in",
      rsvpAt: new Date(),
      shirtNumber: user.shirtNumber ?? null,
    }).onConflictDoNothing();
    reference = `${fullyFree ? "RF" : "RB"}${room.code}-${randomToken(3).toUpperCase()}`;
    await db.insert(statUnlocksTable).values({
      userId: user.id,
      matchId: room.id,
      kind: "booking",
      amountFils,
      reference,
      method,
      // Nothing to collect on a fully free booking.
      ...(fullyFree ? { status: "paid", confirmedAt: new Date() } : {}),
    });
  } catch (error) {
    // Don't leave a half-made booking holding the slot or the free match.
    await db.update(footageRequestsTable).set({ status: "cancelled", message: "Booking could not be completed", updatedAt: new Date() })
      .where(eq(footageRequestsTable.id, created.id)).catch(() => undefined);
    if (reward) await releaseReward(reward.id).catch(() => undefined);
    throw error;
  }
  // Pay at the field, or nothing to pay: the recording is locked in now.
  const activated = payWith === "field" || fullyFree ? await activatePaidBooking(created.id) : null;
  res.status(201).json({
    code: room.code,
    requestId: created.id,
    amountFils,
    reference,
    method,
    freeMatch: Boolean(reward),
    status: activated?.status ?? created.status,
    cliqAlias: commerce.cliqAlias,
    startLocal: created.startLocal,
    endLocal: created.endLocal,
    fieldName: field.name,
  });
});

/** What an unpaid booking says once its slot is long over without the payment. */
const LAPSED_MESSAGE = "Payment not received in time";

async function bookingStatus(requestId: number): Promise<string> {
  const [fresh] = await db.select({ status: footageRequestsTable.status }).from(footageRequestsTable)
    .where(eq(footageRequestsTable.id, requestId));
  return fresh?.status ?? "missing";
}

/**
 * A booking that won't record owes nothing: its waiting payment is turned down,
 * a fully free one is voided, and a free match it spent comes back.
 */
async function settleCancelledBooking(roomId: number): Promise<void> {
  await db.update(statUnlocksTable).set({ status: "rejected", confirmedAt: new Date() })
    .where(and(eq(statUnlocksTable.matchId, roomId), eq(statUnlocksTable.kind, "booking"), eq(statUnlocksTable.status, "pending")));
  await db.update(statUnlocksTable).set({ status: "rejected", confirmedAt: new Date() })
    .where(and(eq(statUnlocksTable.matchId, roomId), eq(statUnlocksTable.kind, "booking"), eq(statUnlocksTable.method, "free")));
  await releaseRewardForMatch(roomId);
}

/**
 * Stop a locked-in booking's camera job, then cancel it. "camera": the camera
 * service refused, nothing changed, try again. "moved": the booking had already
 * left the active states (someone else finished or cancelled it).
 */
async function stopAndCancelBooking(row: FootageRequest, message: string): Promise<"cancelled" | "camera" | "moved"> {
  if (row.vpsJobId) {
    try {
      const result = await controlFetch(
        remoteJobPath(row.cameraId, row.vpsJobId),
        { method: "DELETE" },
        30_000,
      );
      if (!result.ok && result.status !== 404) return "camera";
    } catch (error) {
      logger.warn({ requestId: row.id, error }, "Booking camera job could not be stopped");
      return "camera";
    }
  }
  syncState.delete(row.id);
  const cancelled = await db.update(footageRequestsTable).set({ status: "cancelled", message, updatedAt: new Date() })
    .where(and(eq(footageRequestsTable.id, row.id), inArray(footageRequestsTable.status, ACTIVE_REQUEST_STATUSES)))
    .returning({ id: footageRequestsTable.id });
  return cancelled.length ? "cancelled" : "moved";
}

/** The booker can drop an unpaid booking. */
router.delete("/bookings/:id", async (req, res): Promise<void> => {
  const user = await getLocalUserRecord(req);
  if (!user) {
    unauthenticatedResponse(res, req);
    return;
  }
  const id = parseId(req.params.id);
  if (!id) {
    res.status(404).json({ error: "Booking not found" });
    return;
  }
  const [row] = await db.select().from(footageRequestsTable).where(eq(footageRequestsTable.id, id));
  if (!row || (row.requestedBy !== user.id && !user.isAdmin)) {
    res.status(404).json({ error: "Booking not found" });
    return;
  }
  if (row.status === "awaiting_payment") {
    // Only while it is still waiting: an admin may have confirmed the transfer
    // (and started the camera) since it was read.
    if (await cancelUnpaidBooking(id, "Cancelled before payment")) {
      res.status(204).send();
      return;
    }
    if (await bookingStatus(id) === "cancelled") {
      res.status(204).send();
      return;
    }
    res.status(409).json({ error: "This booking was just confirmed, so it can't be cancelled here" });
    return;
  }
  const [room] = await db.select({ id: matchRoomsTable.id }).from(matchRoomsTable).where(eq(matchRoomsTable.footageRequestId, id));
  // A locked-in booking is already scheduled: pay at the field, switched from that
  // to CliQ, or fully free (a free match, nothing extra). It can still be dropped
  // before kick-off while nothing has been paid: stop the camera job, then cancel.
  const [unpaid] = room ? await db.select().from(statUnlocksTable).where(and(
    eq(statUnlocksTable.matchId, room.id), eq(statUnlocksTable.kind, "booking"),
    inArray(statUnlocksTable.method, ["field", "cliq"]), eq(statUnlocksTable.status, "pending"),
  )) : [];
  const [freePayment] = room && !unpaid ? await db.select().from(statUnlocksTable).where(and(
    eq(statUnlocksTable.matchId, room.id), eq(statUnlocksTable.kind, "booking"), eq(statUnlocksTable.method, "free"),
  )) : [];
  const beforeKickoff = ammanLocalEpoch(row.startLocal) > ammanLocalEpoch(getAmmanNow().local);
  if ((!unpaid && !freePayment) || !beforeKickoff || !["queued", "scheduled"].includes(row.status)) {
    res.status(409).json({ error: "Only unpaid bookings can be cancelled here, before kick-off" });
    return;
  }
  // Turn the waiting payment down first, only if it is still waiting: the field
  // collecting the cash or an admin confirming the transfer right now wins instead.
  if (unpaid) {
    const taken = await db.update(statUnlocksTable).set({ status: "rejected", confirmedAt: new Date() })
      .where(and(eq(statUnlocksTable.id, unpaid.id), eq(statUnlocksTable.status, "pending")))
      .returning({ id: statUnlocksTable.id });
    if (!taken.length) {
      res.status(409).json({ error: "This booking was just paid, so it can't be cancelled here" });
      return;
    }
  }
  const restorePayment = async () => {
    if (unpaid) {
      await db.update(statUnlocksTable).set({ status: "pending", confirmedAt: null })
        .where(and(eq(statUnlocksTable.id, unpaid.id), eq(statUnlocksTable.status, "rejected")));
    }
  };
  const outcome = await stopAndCancelBooking(row, "Cancelled before payment");
  if (outcome === "camera") {
    await restorePayment();
    res.status(502).json({ error: "The recording could not be cancelled. Try again in a minute." });
    return;
  }
  if (outcome === "moved") {
    if (await bookingStatus(id) === "cancelled") {
      res.status(204).send();
      return;
    }
    await restorePayment();
    res.status(409).json({ error: "Only unpaid bookings can be cancelled here, before kick-off" });
    return;
  }
  // A booking that spent a free match gives it back.
  if (room) await settleCancelledBooking(room.id);
  res.status(204).send();
});

/**
 * Switch how an unpaid booking will be paid. CliQ -> field locks the recording in
 * now. Field -> CliQ keeps it locked in, and it stays resolvable: the admin
 * confirms the transfer as usual (or rejecting it cancels the recording), the
 * field can still take cash for it, and the booker can still cancel it before
 * kick-off.
 */
router.post("/bookings/:id/pay-with", async (req, res): Promise<void> => {
  const user = await getLocalUserRecord(req);
  if (!user) {
    unauthenticatedResponse(res, req);
    return;
  }
  const id = parseId(req.params.id);
  const method = (req.body ?? {}).method;
  if (!id || (method !== "cliq" && method !== "field")) {
    res.status(400).json({ error: "Pick CliQ or pay at the field" });
    return;
  }
  const [row] = await db.select().from(footageRequestsTable).where(eq(footageRequestsTable.id, id));
  if (!row || (row.requestedBy !== user.id && !user.isAdmin)) {
    res.status(404).json({ error: "Booking not found" });
    return;
  }
  const [room] = await db.select({ id: matchRoomsTable.id }).from(matchRoomsTable).where(eq(matchRoomsTable.footageRequestId, id));
  const [payment] = room ? await db.select().from(statUnlocksTable).where(and(
    eq(statUnlocksTable.matchId, room.id), eq(statUnlocksTable.kind, "booking"), eq(statUnlocksTable.status, "pending"),
  )) : [];
  if (!payment || !["awaiting_payment", ...ACTIVE_REQUEST_STATUSES].includes(row.status)) {
    res.status(409).json({ error: "This booking has no payment waiting" });
    return;
  }
  if (method === "field") {
    if (isHistoricalBooking(row)) {
      res.status(400).json({ error: "Past-game footage must be paid by CliQ" });
      return;
    }
    const commerce = await loadCommerce({ userId: user.id, fieldId: row.fieldId });
    if (!commerce.payAtField) {
      res.status(400).json({ error: "Paying at the field isn't available right now" });
      return;
    }
  }
  await db.update(statUnlocksTable).set({ method }).where(and(eq(statUnlocksTable.id, payment.id), eq(statUnlocksTable.status, "pending")));
  const activated = method === "field" ? await activatePaidBooking(id) : null;
  if (activated?.status === "cancelled") {
    res.status(409).json({ error: "This booking lapsed before it was paid" });
    return;
  }
  res.json({ method, status: activated?.status ?? row.status });
});

/**
 * Called when an admin confirms a booking payment (or a booking is locked in by
 * paying at the field): start the camera job. Only a booking still waiting for
 * its payment moves on; one cancelled in the meantime stays cancelled, and one
 * whose slot is long over (see UNPAID_BOOKING_LAPSE_MS) lapses instead.
 */
export async function activatePaidBooking(requestId: number): Promise<{ status: string }> {
  const [row] = await db.select().from(footageRequestsTable).where(eq(footageRequestsTable.id, requestId));
  if (!row) return { status: "missing" };
  if (row.status !== "awaiting_payment") return { status: row.status };
  const now = Date.now();
  if (unpaidBookingHasLapsed(row, now)) {
    await cancelUnpaidBooking(requestId, LAPSED_MESSAGE);
    return { status: await bookingStatus(requestId) };
  }
  if (isHistoricalBooking(row)) {
    const start = parseLocalDateTime(row.startLocal);
    const end = parseLocalDateTime(row.endLocal);
    if (!start || !end) {
      await cancelUnpaidBooking(requestId, "The requested camera time is invalid");
      return { status: await bookingStatus(requestId) };
    }
    try {
      await validateAvailability(row.cameraId, start.epochMs, end.epochMs, ammanLocalEpoch(getAmmanNow().local));
    } catch (error) {
      if (error instanceof CameraUnavailableError) return { status: "camera_unavailable" };
      await cancelUnpaidBooking(requestId, "The requested footage is no longer available on the camera");
      return { status: await bookingStatus(requestId) };
    }
  }
  const claimed = await db.update(footageRequestsTable).set({ status: "queued", message: null, updatedAt: new Date() })
    .where(and(eq(footageRequestsTable.id, requestId), eq(footageRequestsTable.status, "awaiting_payment")))
    .returning({ id: footageRequestsTable.id });
  if (!claimed.length) return { status: await bookingStatus(requestId) };
  await startCameraJob({ ...row, status: "queued" }, row.cameraId);
  return { status: await bookingStatus(requestId) };
}

/**
 * Cancel a booking that is still waiting for its payment, and settle it (its
 * waiting payment turned down, its free match back). False when it had already
 * moved on (confirmed, or cancelled by someone else).
 */
export async function cancelUnpaidBooking(requestId: number, message = "Payment not received"): Promise<boolean> {
  const cancelled = await db.update(footageRequestsTable).set({ status: "cancelled", message, updatedAt: new Date() })
    .where(and(eq(footageRequestsTable.id, requestId), eq(footageRequestsTable.status, "awaiting_payment")))
    .returning({ id: footageRequestsTable.id });
  if (!cancelled.length) return false;
  const [room] = await db.select({ id: matchRoomsTable.id }).from(matchRoomsTable).where(eq(matchRoomsTable.footageRequestId, requestId));
  if (room) await settleCancelledBooking(room.id);
  return true;
}

/**
 * An admin turned a booking's payment down. Still waiting for it: the booking is
 * cancelled. Locked in on a CliQ transfer (a pay-at-field booking switched to
 * CliQ): its camera job is stopped and it is cancelled, whatever state it has
 * reached, so it never records unpaid. A pay-at-field payment (the cash
 * wasn't paid) or an already delivered match keeps its recording; only the
 * payment is rejected. `{ error: "camera" }`: the camera job couldn't be
 * stopped; nothing changed, try again.
 */
export async function rejectBookingPayment(requestId: number, method: string): Promise<{ status: string } | { error: "camera" }> {
  if (await cancelUnpaidBooking(requestId)) return { status: "cancelled" };
  const [row] = await db.select().from(footageRequestsTable).where(eq(footageRequestsTable.id, requestId));
  if (!row) return { status: "missing" };
  if (method === "cliq" && ACTIVE_REQUEST_STATUSES.includes(row.status as typeof ACTIVE_REQUEST_STATUSES[number])) {
    const outcome = await stopAndCancelBooking(row, "Payment not received");
    if (outcome === "camera") return { error: "camera" };
    if (outcome === "cancelled") {
      const [room] = await db.select({ id: matchRoomsTable.id }).from(matchRoomsTable).where(eq(matchRoomsTable.footageRequestId, requestId));
      if (room) await settleCancelledBooking(room.id);
    }
  }
  return { status: await bookingStatus(requestId) };
}

/**
 * Unpaid CliQ bookings whose slot is long over never record: the status sweep
 * cancels them, so they stop holding the player's free match and his count of
 * bookings waiting for payment.
 */
export async function lapseUnpaidBookings(now = Date.now()): Promise<number> {
  const rows = await db.select({
    id: footageRequestsTable.id,
    startLocal: footageRequestsTable.startLocal,
    endLocal: footageRequestsTable.endLocal,
    createdAt: footageRequestsTable.createdAt,
  }).from(footageRequestsTable).where(eq(footageRequestsTable.status, "awaiting_payment"));
  let lapsed = 0;
  for (const row of rows) {
    if (unpaidBookingHasLapsed(row, now) && await cancelUnpaidBooking(row.id, LAPSED_MESSAGE)) lapsed += 1;
  }
  return lapsed;
}


export default router;
