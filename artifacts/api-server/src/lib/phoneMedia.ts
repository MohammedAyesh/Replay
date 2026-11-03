import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { and, asc, eq, gte, inArray, lte } from "drizzle-orm";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import {
  academiesTable,
  academyAdMediaTable,
  academyPhoneMediaTable,
  academyPlayersTable,
  academyRecordingsTable,
  academySessionsTable,
  db,
  fieldsTable,
  recordingsTable,
  type AcademyPhoneMedia,
} from "@workspace/db";
import {
  classifyCapture,
  distanceMetres,
  parseIso6709,
  readJpegExif,
  readMp4Meta,
  resolveCaptureTime,
  VENUE_RADIUS_M,
  type CaptureRaw,
  type CaptureTime,
  type PhaseResult,
  type SessionWindow,
} from "@workspace/api-zod";
import { recordFeatures, removeFeatures } from "./featured/store";
import { probeVideo, storeVideo, videoStill } from "./meta/media";
import { parseRecordingDuration } from "../routes/userClips";

/**
 * Phone videos and photos sorted by match time: the server half.
 *
 *   ingest   read the capture time (the browser's reading first: the iPhone
 *            picker can convert a file and drop its date; the file's own
 *            bytes as a fallback), check GPS against the venue and forget it,
 *            store the file with every metadata tag removed, sort it against
 *            the academy's sessions
 *   relink   a coach picks the session for a file the sort could not place
 *   tag      players in it (each a private appearance in the feature log)
 *
 * Rules are in @workspace/api-zod phoneCapture.ts.
 */

const ASSUMED_SESSION_MIN = { match: 100, training: 90 } as const;

function run(bin: string, args: string[], timeoutMs = 120_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
    proc.stdout.on("data", (d) => { out += d; });
    proc.stderr.on("data", (d) => { err += d; });
    proc.on("error", (e) => { clearTimeout(timer); reject(e); });
    proc.on("close", (code) => { clearTimeout(timer); code === 0 ? resolve(out) : reject(new Error(err.trim() || `${bin} exited ${code}`)); });
  });
}

const fileReader = (fd: number) => async (offset: number, length: number) => {
  const buf = Buffer.alloc(length);
  const n = fs.readSync(fd, buf, 0, length, offset);
  return new Uint8Array(buf.subarray(0, n));
};

/** What the file's own bytes say (the fallback when the browser could not read it). */
export async function readFileCapture(filePath: string, kind: "video" | "image"): Promise<{ raw: Partial<CaptureRaw>; gps: { lat: number; lon: number } | null; orientation: number | null }> {
  if (kind === "video") {
    const fd = fs.openSync(filePath, "r");
    try {
      const meta = await readMp4Meta(fileReader(fd), fs.fstatSync(fd).size).catch(() => null);
      if (!meta) return { raw: {}, gps: null, orientation: null };
      const { location, ...rest } = meta;
      return { raw: rest, gps: parseIso6709(location), orientation: null };
    } finally {
      fs.closeSync(fd);
    }
  }
  const head = Buffer.alloc(256 * 1024);
  const fd = fs.openSync(filePath, "r");
  try {
    const n = fs.readSync(fd, head, 0, head.length, 0);
    const exif = readJpegExif(new Uint8Array(head.subarray(0, n)));
    if (!exif) return { raw: {}, gps: null, orientation: null };
    const { gps, orientation, ...rest } = exif;
    return { raw: rest, gps, orientation };
  } finally {
    fs.closeSync(fd);
  }
}

/** The browser's reading where it has one, the server's where it doesn't. */
export function mergeRaw(client: Partial<CaptureRaw> | null, server: Partial<CaptureRaw>, base: Pick<CaptureRaw, "kind" | "fileName">): CaptureRaw {
  const out: CaptureRaw = { ...base };
  for (const key of ["lastModifiedMs", "durationSec", "quicktimeCreationDate", "mvhdCreation", "otherDate", "dateTimeOriginal", "offsetTimeOriginal", "make", "model"] as const) {
    const v = client?.[key] ?? server[key] ?? null;
    if (v !== null && v !== undefined) (out as Record<string, unknown>)[key] = v;
  }
  return out;
}

/** A video with every metadata tag removed (GPS, device, dates), streams copied as they are. */
export async function stripVideoMetadata(filePath: string): Promise<string> {
  const out = path.join(os.tmpdir(), `phone-${randomUUID()}.mp4`);
  await run("ffmpeg", ["-nostdin", "-v", "error", "-i", filePath, "-map", "0:v", "-map", "0:a?", "-c", "copy",
    "-map_metadata", "-1", "-map_metadata:s", "-1", "-map_chapters", "-1", "-movflags", "+faststart", "-f", "mp4", "-y", out], 300_000);
  return out;
}

/**
 * A photo re-encoded without EXIF (so without GPS). The decoder already turns
 * it upright from its EXIF orientation (measured: an orientation-6 40×20 photo
 * decodes as 20×40), so the re-encoded file needs no orientation tag.
 */
export async function stripImage(bytes: Buffer): Promise<{ dataUrl: string; width: number; height: number }> {
  const img = await loadImage(bytes);
  const scale = Math.min(1, 2160 / Math.max(img.width, img.height));
  const canvas = createCanvas(Math.round(img.width * scale), Math.round(img.height * scale));
  canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
  const jpeg = await canvas.encode("jpeg", 88);
  return { dataUrl: `data:image/jpeg;base64,${jpeg.toString("base64")}`, width: canvas.width, height: canvas.height };
}

/** Where the academy plays: its own pin, else its field's. */
async function venueOf(academyId: number): Promise<{ lat: number; lon: number } | null> {
  const [row] = await db.select({ lat: academiesTable.latitude, lon: academiesTable.longitude, fLat: fieldsTable.latitude, fLon: fieldsTable.longitude })
    .from(academiesTable).leftJoin(fieldsTable, eq(fieldsTable.id, academiesTable.fieldId)).where(eq(academiesTable.id, academyId));
  if (row?.lat != null && row?.lon != null) return { lat: row.lat, lon: row.lon };
  if (row?.fLat != null && row?.fLon != null) return { lat: row.fLat, lon: row.fLon };
  return null;
}

export function venueCheck(gps: { lat: number; lon: number } | null, venue: { lat: number; lon: number } | null): "at_venue" | "elsewhere" | "unknown" {
  if (!gps || !venue) return "unknown";
  return distanceMetres(gps, venue) <= VENUE_RADIUS_M ? "at_venue" : "elsewhere";
}

/** "2026-11-01" in Amman. */
export function ammanDay(d: Date): string {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Amman", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const v = Object.fromEntries(p.map((x) => [x.type, x.value]));
  return `${v.year}-${v.month}-${v.day}`;
}

/** A recording's wall-clock start from its Amman date and time slot ("18:00" or "18:00–20:00"). */
export function recordingStart(date: string, timeSlot: string): Date | null {
  const m = /^(\d{1,2}):(\d{2})/.exec(timeSlot.trim());
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m || !d) return null;
  return new Date(Date.UTC(+d[1], +d[2] - 1, +d[3], +m[1], +m[2]) - 3 * 3_600_000);
}

/** The academy's sessions between two instants, with their real window (the recording's when there is one). */
export async function sessionWindows(academyId: number, from: Date, to: Date): Promise<SessionWindow[]> {
  const sessions = await db.select({ id: academySessionsTable.id, type: academySessionsTable.type, startsAt: academySessionsTable.startsAt, endsAt: academySessionsTable.endsAt })
    .from(academySessionsTable)
    .where(and(eq(academySessionsTable.academyId, academyId), gte(academySessionsTable.startsAt, from), lte(academySessionsTable.startsAt, to)))
    .orderBy(asc(academySessionsTable.startsAt));
  if (!sessions.length) return [];
  const recs = await db.select({ sessionId: academyRecordingsTable.sessionId, id: recordingsTable.id, date: recordingsTable.date, timeSlot: recordingsTable.timeSlot, duration: recordingsTable.duration })
    .from(academyRecordingsTable).innerJoin(recordingsTable, eq(recordingsTable.id, academyRecordingsTable.recordingId))
    .where(and(eq(academyRecordingsTable.academyId, academyId), inArray(academyRecordingsTable.sessionId, sessions.map((s) => s.id))))
    .orderBy(asc(recordingsTable.id));
  return sessions.map((s) => {
    const rec = recs.find((r) => r.sessionId === s.id) ?? null;
    const recStart = rec ? recordingStart(rec.date, rec.timeSlot) : null;
    const recDur = rec ? parseRecordingDuration(rec.duration) || null : null;
    const plannedEnd = s.endsAt ?? new Date(s.startsAt.getTime() + ASSUMED_SESSION_MIN[s.type === "match" ? "match" : "training"] * 60_000);
    // Planned times, or the recording's real start when there is one.
    const start = recStart ?? s.startsAt;
    const end = recStart && recDur ? new Date(recStart.getTime() + recDur * 1000) : new Date(start.getTime() + (plannedEnd.getTime() - s.startsAt.getTime()));
    return { id: s.id, start, end, recordingId: rec?.id ?? null, recordingStart: recStart, recordingDurationSec: recDur };
  });
}

/** Sort a capture against the academy's sessions within a day either side of it. */
export async function sortCapture(academyId: number, capture: Pick<CaptureTime, "start" | "end" | "dateOnly">): Promise<PhaseResult> {
  const pivot = capture.start ? new Date(capture.start) : capture.dateOnly ? new Date(`${capture.dateOnly}T09:00:00Z`) : null;
  if (!pivot) return classifyCapture(capture, [], ammanDay);
  const windows = await sessionWindows(academyId, new Date(pivot.getTime() - 30 * 3_600_000), new Date(pivot.getTime() + 30 * 3_600_000));
  return classifyCapture(capture, windows, ammanDay);
}

export type IngestInput = {
  academyId: number;
  filePath: string;
  fileName: string;
  mime: string;
  size: number;
  /** What the browser read before upload (no coordinates). */
  client: Partial<CaptureRaw> | null;
  /** Coordinates the browser read, used for the venue check and then dropped. */
  clientGps: { lat: number; lon: number } | null;
  uploadedBy: number;
  role: AcademyPhoneMedia["uploaderRole"];
  playerId: number | null;
  now?: Date;
};

export class PhoneMediaError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

const IMAGE = new Set(["image/jpeg", "image/png", "image/webp"]);
const VIDEO = new Set(["video/mp4", "video/quicktime", "video/x-m4v", "video/3gpp"]);
export const PHONE_MAX_VIDEO_SECONDS = 10 * 60;

export async function ingestPhoneMedia(input: IngestInput): Promise<AcademyPhoneMedia> {
  const now = input.now ?? new Date();
  const isVideo = VIDEO.has(input.mime) || /\.(mp4|mov|m4v|3gp)$/i.test(input.fileName);
  const isImage = !isVideo && IMAGE.has(input.mime);
  if (!isVideo && !isImage) throw new PhoneMediaError("Use a photo (JPG, PNG) or a video (MP4, MOV)");
  const kind = isVideo ? "video" : "image";
  const fromFile = await readFileCapture(input.filePath, kind).catch(() => ({ raw: {}, gps: null, orientation: null }));
  const raw = mergeRaw(input.client, fromFile.raw, { kind, fileName: input.fileName });
  let stripped: string | null = null;
  let mediaRow: typeof academyAdMediaTable.$inferSelect;
  try {
    if (kind === "video") {
      const facts = await probeVideo(input.filePath).catch(() => null);
      if (!facts) throw new PhoneMediaError("That file isn't a video we can read. Export it from your phone as MP4 and try again.");
      if (facts.durationSec && facts.durationSec > PHONE_MAX_VIDEO_SECONDS) throw new PhoneMediaError(`Videos can be at most ${PHONE_MAX_VIDEO_SECONDS / 60} minutes long.`);
      raw.durationSec ??= facts.durationSec;
      stripped = await stripVideoMetadata(input.filePath);
      const still = await videoStill(stripped, facts.durationSec);
      const storageUrl = await storeVideo(input.academyId, stripped);
      [mediaRow] = await db.insert(academyAdMediaTable).values({
        academyId: input.academyId, kind: "video", name: input.fileName.slice(0, 120), source: "phone", imageData: still, storageUrl,
        bytes: input.size, width: facts.width, height: facts.height, durationSec: facts.durationSec, status: "ready", createdBy: input.uploadedBy,
      }).returning();
    } else {
      const bytes = await fs.promises.readFile(input.filePath);
      const clean = await stripImage(bytes).catch(() => { throw new PhoneMediaError("That photo couldn't be read. Try a JPG or PNG."); });
      [mediaRow] = await db.insert(academyAdMediaTable).values({
        academyId: input.academyId, kind: "image", name: input.fileName.slice(0, 120), source: "phone", imageData: clean.dataUrl,
        bytes: Buffer.byteLength(clean.dataUrl), width: clean.width, height: clean.height, status: "ready", createdBy: input.uploadedBy,
      }).returning();
    }
  } finally {
    if (stripped) await fs.promises.rm(stripped, { force: true });
  }

  const capture = resolveCaptureTime(raw, now);
  const sorted = await sortCapture(input.academyId, capture);
  const venue = venueCheck(input.clientGps ?? fromFile.gps, await venueOf(input.academyId));
  const [row] = await db.insert(academyPhoneMediaTable).values({
    academyId: input.academyId,
    mediaId: mediaRow.id,
    kind,
    fileName: input.fileName.slice(0, 200),
    uploadedBy: input.uploadedBy,
    uploaderRole: input.role,
    playerId: input.playerId,
    capturedStart: capture.start ? new Date(capture.start) : null,
    capturedEnd: capture.end ? new Date(capture.end) : null,
    captureDate: capture.dateOnly ?? (capture.start ? ammanDay(new Date(capture.start)) : null),
    captureSource: capture.source,
    captureConfidence: capture.confidence,
    captureNotes: capture.notes,
    venue,
    sessionId: sorted.sessionId,
    phase: sorted.phase,
    offsetSec: sorted.offsetSec,
    recordingId: sorted.recordingId,
    needsReview: sorted.needsReview,
    reviewReason: sorted.needsReview ? sorted.reason : null,
    playerIds: input.playerId ? [input.playerId] : [],
  }).returning();
  if (input.playerId) await logTags(row, [input.playerId]);
  return row;
}

/** Re-sort files the time put (not a coach): sessions change after uploads (a match added, a time moved). */
export async function resortPhoneMedia(academyId: number): Promise<number> {
  const rows = await db.select().from(academyPhoneMediaTable).where(and(eq(academyPhoneMediaTable.academyId, academyId), eq(academyPhoneMediaTable.linkedBy, "auto")));
  let changed = 0;
  for (const r of rows) {
    const sorted = await sortCapture(academyId, {
      start: r.capturedStart?.toISOString() ?? null, end: r.capturedEnd?.toISOString() ?? null,
      dateOnly: r.capturedStart ? null : r.captureDate,
    });
    if (sorted.sessionId === r.sessionId && sorted.phase === r.phase && sorted.offsetSec === r.offsetSec) continue;
    await db.update(academyPhoneMediaTable).set({
      sessionId: sorted.sessionId, phase: sorted.phase, offsetSec: sorted.offsetSec, recordingId: sorted.recordingId,
      needsReview: sorted.needsReview, reviewReason: sorted.needsReview ? sorted.reason : null, updatedAt: new Date(),
    }).where(eq(academyPhoneMediaTable.id, r.id));
    changed += 1;
  }
  return changed;
}

/**
 * A coach puts a file in a session. With a known time the phase follows from
 * it; with only a date (a WhatsApp forward) he also says before, during or after.
 */
export async function relinkPhoneMedia(row: AcademyPhoneMedia, sessionId: number | null, phase: "before" | "during" | "after" | null): Promise<AcademyPhoneMedia> {
  if (sessionId === null) {
    const [r] = await db.update(academyPhoneMediaTable).set({ sessionId: null, phase: "unlinked", offsetSec: null, recordingId: null, linkedBy: "coach", needsReview: false, reviewReason: null, updatedAt: new Date() })
      .where(eq(academyPhoneMediaTable.id, row.id)).returning();
    return r;
  }
  const [s] = await db.select({ startsAt: academySessionsTable.startsAt }).from(academySessionsTable)
    .where(and(eq(academySessionsTable.id, sessionId), eq(academySessionsTable.academyId, row.academyId)));
  if (!s) throw new PhoneMediaError("That session isn't in this academy", 404);
  let result: { phase: "before" | "during" | "after"; offsetSec: number | null; recordingId: number | null };
  const windows = await sessionWindows(row.academyId, new Date(s.startsAt.getTime() - 60_000), new Date(s.startsAt.getTime() + 60_000));
  const own = windows.filter((w) => w.id === sessionId);
  if (row.capturedStart) {
    const sorted = classifyCapture({ start: row.capturedStart.toISOString(), end: (row.capturedEnd ?? row.capturedStart).toISOString(), dateOnly: null }, own, ammanDay);
    const p = phase ?? (sorted.phase === "unlinked" ? "during" : sorted.phase);
    result = { phase: p, offsetSec: p === "during" ? sorted.offsetSec : null, recordingId: p === "during" ? own[0]?.recordingId ?? null : null };
  } else {
    // Only a date: the coach's word for the phase; no offset can be known.
    result = { phase: phase ?? "during", offsetSec: null, recordingId: (phase ?? "during") === "during" ? own[0]?.recordingId ?? null : null };
  }
  const [r] = await db.update(academyPhoneMediaTable).set({ sessionId, ...result, linkedBy: "coach", needsReview: false, reviewReason: null, updatedAt: new Date() })
    .where(eq(academyPhoneMediaTable.id, row.id)).returning();
  return r;
}

async function logTags(row: AcademyPhoneMedia, playerIds: number[]): Promise<void> {
  if (!playerIds.length) return;
  await recordFeatures(row.academyId, [{
    playerIds, solo: playerIds.length === 1, itemType: "phone_video", itemId: String(row.id), visibility: "private", at: row.capturedStart ?? row.createdAt,
  }]);
}

/** Tag the players in a file: each tag is a private appearance (the feature log). */
export async function tagPhoneMedia(row: AcademyPhoneMedia, playerIds: number[]): Promise<AcademyPhoneMedia> {
  const valid = playerIds.length
    ? (await db.select({ id: academyPlayersTable.id }).from(academyPlayersTable)
      .where(and(eq(academyPlayersTable.academyId, row.academyId), inArray(academyPlayersTable.id, playerIds)))).map((p) => p.id)
    : [];
  const [r] = await db.update(academyPhoneMediaTable).set({ playerIds: valid, updatedAt: new Date() }).where(eq(academyPhoneMediaTable.id, row.id)).returning();
  await removeFeatures(row.academyId, "phone_video", String(row.id));
  await logTags(r, valid);
  return r;
}
