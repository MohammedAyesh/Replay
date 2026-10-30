import { and, eq, inArray } from "drizzle-orm";
import { db, footageRequestsTable } from "@workspace/db";
import { buildOwnerFootageTitle } from "@workspace/api-zod";
import { liveAnalysisEnabled } from "./liveAnalysis";
import { logger } from "./logger";
import { controlFetch } from "../routes/contabo";
import { chooseFootageSource, gapPullPath, remoteJobPath, withGapStore } from "./gapStore";

export type FootageRequest = typeof footageRequestsTable.$inferSelect;
export type Availability = Record<string, unknown>;

const ACTIVE_REQUEST_STATUSES = ["queued", "running", "scheduled", "recording"] as const;
const DEFAULT_CANCELLABLE_STATUSES = ACTIVE_REQUEST_STATUSES;
const AVAILABILITY_CACHE_MS = 2 * 60 * 1000;
const availabilityCache = new Map<string, { expiresAt: number; body: Availability }>();

export class CameraUnavailableError extends Error {}

function parseLocalWallEpoch(value: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(value.trim());
  if (!match) return Number.NaN;
  const [, year, month, day, hour, minute] = match;
  const epoch = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute));
  const date = new Date(epoch);
  return date.getUTCFullYear() === Number(year)
    && date.getUTCMonth() === Number(month) - 1
    && date.getUTCDate() === Number(day)
    && date.getUTCHours() === Number(hour)
    && date.getUTCMinutes() === Number(minute)
    ? epoch
    : Number.NaN;
}

export function ammanNowWallEpoch(now = new Date()): number {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Amman",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now).map(({ type, value }) => [type, value]));
  return Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
  );
}

function touchedHours(startMs: number, endMs: number): Array<{ date: string; hour: number }> {
  const result: Array<{ date: string; hour: number }> = [];
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return result;
  const firstHour = Math.floor(startMs / 3_600_000) * 3_600_000;
  const lastHour = Math.floor((endMs - 1) / 3_600_000) * 3_600_000;
  for (let time = firstHour; time <= lastHour; time += 3_600_000) {
    const date = new Date(time);
    result.push({
      date: `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`,
      hour: date.getUTCHours(),
    });
  }
  return result;
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

export async function validateAvailability(
  camera: string,
  startWallMs: number,
  endWallMs: number,
  nowWallMs = ammanNowWallEpoch(),
): Promise<void> {
  const byDate = new Map<string, Availability>();
  for (const { date, hour } of touchedHours(startWallMs, endWallMs)) {
    const hourStart = Date.UTC(
      Number(date.slice(0, 4)),
      Number(date.slice(5, 7)) - 1,
      Number(date.slice(8, 10)),
      hour,
    );
    if (hourStart + 3_600_000 > nowWallMs) continue;
    const body = byDate.get(date) ?? await getAvailability(camera, date);
    byDate.set(date, body);
    if (!availabilityHasHour(body, hour)) {
      throw new Error(`No footage on the camera for ${String(hour).padStart(2, "0")}:00`);
    }
  }
}

function bodyString(body: unknown, ...keys: string[]): string | null {
  if (!body || typeof body !== "object") return null;
  const data = body as Record<string, unknown>;
  for (const key of keys) {
    const value = data[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function responseJobId(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const data = body as Record<string, unknown>;
  for (const key of ["jobId", "job_id", "id"]) {
    const value = data[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  }
  return null;
}

function errorMessage(body: unknown, fallback: string): string {
  return bodyString(body, "error", "message", "detail") ?? fallback;
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

function localTimeEpoch(value: string): number {
  return parseLocalWallEpoch(value);
}

export async function startCameraJob(row: FootageRequest, cameraId: string): Promise<void> {
  const endMs = localTimeEpoch(row.endLocal);
  const future = Number.isFinite(endMs) && endMs > ammanNowWallEpoch();
  const title = buildOwnerFootageTitle(cameraId, row.id, row.startLocal);
  try {
    const remoteStart = `${row.startLocal}:00`;
    const remoteEnd = `${row.endLocal}:00`;
    const live = row.academyId === null && future && await liveAnalysisEnabled(row.fieldId);
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
      await db.update(footageRequestsTable)
        .set({
          status: "failed",
          message: errorMessage(result.body, "The camera pull could not be started — not charged"),
          updatedAt: new Date(),
        })
        .where(and(
          eq(footageRequestsTable.id, row.id),
          inArray(footageRequestsTable.status, ACTIVE_REQUEST_STATUSES),
        ));
      return;
    }
    const remoteStatus = bodyString(result.body, "status", "state");
    const status = remoteStatus
      ? mappedStatus(result.body)
      : (future ? "scheduled" : "queued");
    await db.update(footageRequestsTable)
      .set({
        vpsJobId: jobId,
        status,
        updatedAt: new Date(),
      })
      .where(eq(footageRequestsTable.id, row.id));
  } catch (error) {
    logger.error({ requestId: row.id, error }, "Failed to queue footage request");
    await db.update(footageRequestsTable)
      .set({
        status: "failed",
        message: "The camera pull could not be started — not charged",
        updatedAt: new Date(),
      })
      .where(and(
        eq(footageRequestsTable.id, row.id),
        inArray(footageRequestsTable.status, ACTIVE_REQUEST_STATUSES),
      ));
  }
}

export interface CreateFootageRequestInput {
  fieldId: number;
  cameraId: string;
  requestedBy: number;
  startLocal: string;
  endLocal: string;
  requestedSeconds: number;
  rateFils: number;
  academyId?: number | null;
  status?: string;
}

export async function createFootageRequest(
  input: CreateFootageRequestInput,
  options: { startJob?: boolean } = {},
): Promise<FootageRequest> {
  const [created] = await db.insert(footageRequestsTable).values({
    ...input,
    academyId: input.academyId ?? null,
    billableHours: 0,
    amountFils: 0,
    status: input.status ?? "queued",
  }).returning();
  if (options.startJob !== false) await startCameraJob(created, input.cameraId);
  const [saved] = await db.select().from(footageRequestsTable)
    .where(eq(footageRequestsTable.id, created.id));
  return saved ?? created;
}

export type CancelFootageRequestResult =
  | { cancelled: FootageRequest }
  | { error: string; status: number };

export async function cancelFootageRequest(
  row: FootageRequest,
  options: {
    allowedStatuses?: readonly string[];
    message?: string;
  } = {},
): Promise<CancelFootageRequestResult> {
  const allowed = options.allowedStatuses ?? DEFAULT_CANCELLABLE_STATUSES;
  if (!allowed.includes(row.status)) {
    return {
      error: "Only queued, scheduled, recording, or running footage can be cancelled",
      status: 409,
    };
  }
  if (row.vpsJobId) {
    let result;
    try {
      result = await controlFetch(
        remoteJobPath(row.cameraId, row.vpsJobId),
        { method: "DELETE" },
        30_000,
      );
    } catch (error) {
      logger.warn({ requestId: row.id, error }, "Scheduled footage cancellation failed");
      return { error: "The camera pull could not be cancelled", status: 502 };
    }
    if (!result.ok) {
      return {
        error: errorMessage(result.body, "The camera pull could not be cancelled"),
        status: result.status >= 400 && result.status < 500 ? result.status : 502,
      };
    }
  }
  const [cancelled] = await db.update(footageRequestsTable)
    .set({ status: "cancelled", message: options.message ?? "Cancelled by owner", updatedAt: new Date() })
    .where(and(
      eq(footageRequestsTable.id, row.id),
      inArray(footageRequestsTable.status, allowed),
    ))
    .returning();
  if (!cancelled) return { error: "The footage booking has already started", status: 409 };
  return { cancelled };
}
