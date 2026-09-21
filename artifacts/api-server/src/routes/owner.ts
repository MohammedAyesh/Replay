import crypto from "node:crypto";
import { Router, type IRouter, type Request, type Response } from "express";
import { and, desc, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";
import {
  db,
  fieldOwnersTable,
  fieldsTable,
  footagePaymentsTable,
  footageRequestsTable,
  usersTable,
} from "@workspace/db";
import { z } from "zod/v4";
import { getLocalUserRecord, unauthenticatedResponse } from "../lib/clerkUserBridge";
import { computeAmountFils, computeBillableHours } from "../lib/footageBilling";
import { controlFetch } from "./contabo";
import { logger } from "../lib/logger";

const router: IRouter = Router();
const AMMAN_TIME_ZONE = "Asia/Amman";
const REQUEST_RATE_FILS = 1000;
const SHARE_LIFETIME_MS = 14 * 24 * 60 * 60 * 1000;
const AVAILABILITY_CACHE_MS = 2 * 60 * 1000;
const REQUEST_REFRESH_MS = 10 * 1000;
const MAX_UNFINISHED_REQUESTS = 2;
const MAX_SCHEDULED_REQUESTS = 10;
const ACTIVE_REQUEST_STATUSES = ["queued", "running", "scheduled", "recording"] as const;
const AMMAN_UTC_OFFSET_MS = 3 * 60 * 60 * 1000;

type OwnerUser = NonNullable<Awaited<ReturnType<typeof getLocalUserRecord>>>;
type FootageRequest = typeof footageRequestsTable.$inferSelect;
type Availability = Record<string, unknown>;

const requestBodySchema = z.object({
  startLocal: z.string(),
  endLocal: z.string(),
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

function requestToResponse(row: FootageRequest, req: Request) {
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
  };
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
  const paidFils = payments.reduce((sum, row) => sum + row.amountFils, 0);
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

  const title = `${field.name} ${start.value}–${end.hour.toString().padStart(2, "0")}:${end.minute.toString().padStart(2, "0")} (owner request #${created.id})`;
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
  res.json(refreshed.map((row) => requestToResponse(row, req)));
});

async function requestWithField(id: number): Promise<{ request: FootageRequest; fieldId: number } | null> {
  const [row] = await db.select({
    request: footageRequestsTable,
    fieldId: footageRequestsTable.fieldId,
  }).from(footageRequestsTable).where(eq(footageRequestsTable.id, id));
  return row ?? null;
}

async function requireRequestAccess(req: Request, res: Response, id: number): Promise<{ user: OwnerUser; request: FootageRequest } | null> {
  const found = await requestWithField(id);
  if (!found) {
    res.status(404).json({ error: "Request not found" });
    return null;
  }
  const user = await requireFieldAccess(req, res, found.fieldId);
  if (!user) return null;
  return { user, request: found.request };
}

router.post("/owner/requests/:id/cancel", async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  if (!id) {
    res.status(404).json({ error: "Request not found" });
    return;
  }
  const found = await requireRequestAccess(req, res, id);
  if (!found) return;

  if (found.request.status !== "scheduled") {
    res.status(409).json({
      error: found.request.status === "recording"
        ? "This footage is already recording and cannot be cancelled"
        : "Only scheduled footage can be cancelled",
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
      eq(footageRequestsTable.status, "scheduled"),
    ))
    .returning();
  if (!cancelled) {
    res.status(409).json({ error: "The footage booking has already started" });
    return;
  }
  syncState.delete(id);
  res.json(requestToResponse(cancelled, req));
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