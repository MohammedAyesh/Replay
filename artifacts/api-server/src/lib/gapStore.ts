/**
 * Off-schedule FTP gap store on vps1 (ops/gapstore).
 *
 * The cameras record to their SD card only in the hours their recording
 * schedule covers. In the other hours vps1 has the camera push its footage over
 * FTP and keeps it in a rolling 100 GB store. These helpers let every footage
 * pull (admin console, owner console, academies) use that store as a second
 * source: availability is the union of the SD card and the store, and a past
 * window the SD card does not hold is pulled from the store instead.
 *
 * Store jobs have ids starting "gs-" and live under /gapstore/{cam}/pull/{id};
 * their status body follows the /record-hq contract (status, progress, note,
 * videoId, durationSeconds), so the existing refresh code reads them unchanged.
 */
import { controlFetch } from "../routes/contabo";
import { logger } from "./logger";

export type Availability = Record<string, unknown>;

export const GAP_JOB_PREFIX = "gs-";

export function isGapStoreJob(jobId: string | null | undefined): boolean {
  return typeof jobId === "string" && jobId.startsWith(GAP_JOB_PREFIX);
}

/** Status / cancel path on vps1 for a footage job id from either source. */
export function remoteJobPath(cameraId: string, jobId: string): string {
  const cam = encodeURIComponent(cameraId);
  const job = encodeURIComponent(jobId);
  return isGapStoreJob(jobId) ? `/gapstore/${cam}/pull/${job}` : `/record-hq/${cam}/${job}`;
}

export function gapPullPath(cameraId: string, start: string, end: string, title: string): string {
  return `/gapstore/${encodeURIComponent(cameraId)}/pull?start=${encodeURIComponent(start)}`
    + `&end=${encodeURIComponent(end)}&title=${encodeURIComponent(title)}`;
}

/** Hours of one Amman date held in the store, or null when vps1 can't say. */
export async function gapAvailability(cameraId: string, date: string): Promise<Availability | null> {
  try {
    const result = await controlFetch(
      `/gapstore/${encodeURIComponent(cameraId)}/available?date=${encodeURIComponent(date)}`,
      {},
      20_000,
    );
    if (!result.ok || !result.body || typeof result.body !== "object") return null;
    return result.body as Availability;
  } catch (error) {
    logger.warn({ cameraId, date, error }, "Gap store availability unavailable");
    return null;
  }
}

function hourOf(entry: unknown): number | null {
  if (typeof entry === "number") return entry;
  if (typeof entry === "string") {
    const n = Number.parseInt(entry.slice(0, 2), 10);
    return Number.isFinite(n) ? n : null;
  }
  if (entry && typeof entry === "object") {
    const value = (entry as { hour?: unknown }).hour;
    if (typeof value === "number") return value;
    const n = Number.parseInt(String(value ?? "").slice(0, 2), 10);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Union of the SD card's hours and the store's hours. SD entries keep their
 * shape (and win when an hour is in both); store-only hours are added as
 * { hour, segments, bytes, seconds, source: "ftp" }. `ftpHours` lists every
 * hour the store holds.
 */
export function mergeAvailability(sd: Availability | null, gap: Availability | null): Availability {
  const base: Availability = sd ? { ...sd } : { ...(gap ?? {}), hours: [] };
  const sdHours = Array.isArray(sd?.hours) ? (sd!.hours as unknown[]) : [];
  const seen = new Set(sdHours.map(hourOf).filter((h): h is number => h !== null));
  const gapHours = Array.isArray(gap?.hours) ? (gap!.hours as unknown[]) : [];
  const ftpHours: number[] = [];
  const added: unknown[] = [];
  for (const entry of gapHours) {
    const hour = hourOf(entry);
    if (hour === null) continue;
    ftpHours.push(hour);
    if (seen.has(hour)) continue;
    const e = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
    added.push({
      hour,
      segments: typeof e.segments === "number" ? e.segments : 0,
      bytes: typeof e.bytes === "number" ? e.bytes : 0,
      seconds: typeof e.seconds === "number" ? e.seconds : undefined,
      source: "ftp",
    });
  }
  const hours = [...sdHours, ...added].sort((a, b) => (hourOf(a) ?? 0) - (hourOf(b) ?? 0));
  return { ...base, hours, ftpHours: ftpHours.sort((a, b) => a - b) };
}

/**
 * SD availability with the store merged in. If the camera can't be reached but
 * the store holds footage for the date, the store's hours alone are returned.
 */
export async function withGapStore(
  cameraId: string,
  date: string,
  sd: () => Promise<Availability>,
): Promise<Availability> {
  const [sdResult, gap] = await Promise.all([
    sd().then((body) => ({ body, error: null as unknown }), (error: unknown) => ({ body: null, error })),
    gapAvailability(cameraId, date),
  ]);
  const gapHasHours = Array.isArray(gap?.hours) && (gap!.hours as unknown[]).length > 0;
  if (sdResult.error && !gapHasHours) throw sdResult.error;
  return mergeAvailability(sdResult.body, gap);
}

function wallEpoch(local: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/.exec(local.trim());
  if (!m) return Number.NaN;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
}

/**
 * Which source a past window should be pulled from. "ftp" when the store holds
 * more of the window than the SD card's hours do, otherwise "sd" (the SD card
 * stays the source of record for the hours it records).
 */
export async function chooseFootageSource(
  cameraId: string,
  startLocal: string,
  endLocal: string,
  availabilityFor: (date: string) => Promise<Availability>,
): Promise<"sd" | "ftp"> {
  const startMs = wallEpoch(startLocal);
  const endMs = wallEpoch(endLocal);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return "sd";

  let covered = 0;
  try {
    const result = await controlFetch(
      `/gapstore/${encodeURIComponent(cameraId)}/coverage?start=${encodeURIComponent(startLocal)}&end=${encodeURIComponent(endLocal)}`,
      {},
      20_000,
    );
    const value = (result.body as { coveredSeconds?: unknown } | null)?.coveredSeconds;
    if (result.ok && typeof value === "number") covered = value;
  } catch (error) {
    logger.warn({ cameraId, error }, "Gap store coverage unavailable");
  }
  if (covered < 60) return "sd";

  let sdSeconds = 0;
  for (let t = Math.floor(startMs / 3_600_000) * 3_600_000; t < endMs; t += 3_600_000) {
    const d = new Date(t);
    const date = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
    let body: Availability | null = null;
    try {
      body = await availabilityFor(date);
    } catch {
      body = null;
    }
    const entry = Array.isArray(body?.hours)
      ? (body!.hours as unknown[]).find((e) => hourOf(e) === d.getUTCHours())
      : undefined;
    const fromSd = entry !== undefined
      && !(entry && typeof entry === "object" && (entry as { source?: unknown }).source === "ftp");
    if (fromSd) {
      sdSeconds += (Math.min(endMs, t + 3_600_000) - Math.max(startMs, t)) / 1000;
    }
  }
  return covered > sdSeconds ? "ftp" : "sd";
}
