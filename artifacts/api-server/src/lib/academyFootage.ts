import { and, asc, eq, inArray, ne, or, sql } from "drizzle-orm";
import {
  academyRecordingsTable,
  academySessionsTable,
  academiesTable,
  db,
  fieldsTable,
  footageRequestsTable,
  recordingsTable,
} from "@workspace/db";
import { getBunnyPlaybackUrl } from "./bunny";
import {
  ammanNowWallEpoch,
  cancelFootageRequest,
  createFootageRequest,
  startCameraJob,
  validateAvailability,
  type FootageRequest,
} from "./footageBooking";
import { logger } from "./logger";

const ACTIVE_STATUSES = ["queued", "running", "scheduled", "recording"] as const;
// Statuses that hold the camera for a window. Matches the player booking path
// (owner.ts BOOKING_HOLD_STATUSES): an unpaid player booking already owns its slot.
const HOLD_STATUSES = [...ACTIVE_STATUSES, "awaiting_payment"] as const;
const REUSABLE_STATUSES = ["queued", "running", "scheduled", "recording"] as const;
const REBOOKABLE_STATUSES = ["failed", "cancelled", "expired", "refunded"] as const;
const FIVE_MINUTES_MS = 5 * 60 * 1000;
const MIN_DURATION_MS = 15 * 60 * 1000;
const MAX_DURATION_MS = 4 * 60 * 60 * 1000;
const DEFAULT_DURATION_MS = 90 * 60 * 1000;

export type AcademyFootageStatus =
  | "none"
  | "no_camera"
  | "scheduled"
  | "recording"
  | "processing"
  | "ready"
  | "failed"
  | "unavailable";

export interface AcademyFootageSummary {
  status: AcademyFootageStatus;
  note: string | null;
  recordingCount: number;
}

function wallEpoch(value: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(value);
  if (!match) return Number.NaN;
  const [, year, month, day, hour, minute] = match;
  return Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute));
}

function ammanLocalString(value: Date): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Amman",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value).map(({ type, value: part }) => [type, part]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

function wallString(value: number): string {
  const date = new Date(value);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")} ${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}`;
}

export function academyFootageWindow(startsAt: Date, endsAt: Date | null): {
  startLocal: string;
  endLocal: string;
  requestedSeconds: number;
  note: string | null;
} {
  const start = wallEpoch(ammanLocalString(startsAt));
  const defaultEnd = endsAt ?? new Date(startsAt.getTime() + DEFAULT_DURATION_MS);
  let end = wallEpoch(ammanLocalString(defaultEnd));
  const roundedStart = Math.floor(start / FIVE_MINUTES_MS) * FIVE_MINUTES_MS;
  end = Math.ceil(end / FIVE_MINUTES_MS) * FIVE_MINUTES_MS;
  if (end - roundedStart < MIN_DURATION_MS) end = roundedStart + MIN_DURATION_MS;
  const capped = end - roundedStart > MAX_DURATION_MS;
  if (capped) end = roundedStart + MAX_DURATION_MS;
  return {
    startLocal: wallString(roundedStart),
    endLocal: wallString(end),
    requestedSeconds: Math.floor((end - roundedStart) / 1000),
    note: capped ? "Recording limited to the first 4 hours." : null,
  };
}

function bookingErrorNote(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (/no footage/i.test(message)) return "No footage is available for this past session.";
  if (/unreachable|availability|camera/i.test(message)) return "Camera unreachable — try again.";
  return "Footage could not be booked — try again.";
}

export const CAMERA_BOOKED_ELSEWHERE_NOTE = "Camera booked by someone else for this time.";
export const CAMERA_BOOKED_BY_ACADEMY_NOTE = "The camera is already booked by this academy for an overlapping time.";
export const PAST_SESSION_NOTE = "Footage is only booked automatically for upcoming sessions.";
export const AWAY_SESSION_NOTE = "Away session — the academy's camera is not booked.";

/**
 * Sessions have only a free-text location. A location that says it is away
 * ("Away", "Away at X", "خارج الأرض") is clearly not at the academy's pitch.
 */
export function isAwayLocation(location: string): boolean {
  return /(^|[^\p{L}])away([^\p{L}]|$)/iu.test(location) || location.includes("خارج");
}

function localWindowContains(outerStart: string, outerEnd: string, innerStart: string, innerEnd: string): boolean {
  const values = [outerStart, outerEnd, innerStart, innerEnd].map(wallEpoch);
  return values.every(Number.isFinite) && values[0] <= values[2] && values[1] >= values[3];
}

function localWindowOverlaps(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  const aStartMs = wallEpoch(aStart);
  const aEndMs = wallEpoch(aEnd);
  const bStartMs = wallEpoch(bStart);
  const bEndMs = wallEpoch(bEnd);
  return [aStartMs, aEndMs, bStartMs, bEndMs].every(Number.isFinite)
    && aStartMs < bEndMs
    && bStartMs < aEndMs;
}

async function loadAcademySession(academyId: number, sessionId: number) {
  const [row] = await db.select({
    session: academySessionsTable,
    academyFieldId: academiesTable.fieldId,
    cameraId: fieldsTable.cameraId,
  })
    .from(academySessionsTable)
    .innerJoin(academiesTable, eq(academiesTable.id, academySessionsTable.academyId))
    .innerJoin(fieldsTable, eq(fieldsTable.id, academiesTable.fieldId))
    .where(and(
      eq(academySessionsTable.id, sessionId),
      eq(academySessionsTable.academyId, academyId),
    ));
  return row ?? null;
}

export async function bookAcademySessionFootage(
  academyId: number,
  sessionId: number,
  requestedBy: number,
): Promise<void> {
  const row = await loadAcademySession(academyId, sessionId);
  if (!row) return;
  const session = row.session;
  const cameraId = row.cameraId?.trim();
  if (!cameraId) {
    await db.update(academySessionsTable)
      .set({ footageNote: "No camera is assigned to this field." })
      .where(eq(academySessionsTable.id, sessionId));
    return;
  }

  const window = academyFootageWindow(session.startsAt, session.endsAt);
  let requestId = session.footageRequestId;
  if (requestId !== null) {
    const [existing] = await db.select().from(footageRequestsTable)
      .where(eq(footageRequestsTable.id, requestId));
    // A link to someone else's booking (a player's, another academy's) is never ours
    // to keep: it is dropped and the session is booked like a fresh one.
    const ours = existing?.academyId === academyId;
    if (ours && REUSABLE_STATUSES.includes(existing.status as typeof REUSABLE_STATUSES[number])) {
      await db.update(academySessionsTable)
        .set({ footageNote: window.note })
        .where(eq(academySessionsTable.id, sessionId));
      return;
    }
    if (ours && !REBOOKABLE_STATUSES.includes(existing.status as typeof REBOOKABLE_STATUSES[number])) {
      return;
    }
    await db.update(academySessionsTable)
      .set({ footageRequestId: null })
      .where(eq(academySessionsTable.id, sessionId));
    requestId = null;
  }

  // A free (rate 0) camera pull is booked only for an upcoming session at the
  // academy's own pitch, never for a past window or an away match.
  if (isAwayLocation(session.location)) {
    await db.update(academySessionsTable)
      .set({ footageNote: AWAY_SESSION_NOTE })
      .where(eq(academySessionsTable.id, sessionId));
    return;
  }
  if (wallEpoch(ammanLocalString(session.startsAt)) < ammanNowWallEpoch()) {
    await db.update(academySessionsTable)
      .set({ footageNote: PAST_SESSION_NOTE })
      .where(eq(academySessionsTable.id, sessionId));
    return;
  }

  try {
    await validateAvailability(cameraId, wallEpoch(window.startLocal), wallEpoch(window.endLocal));
  } catch (error) {
    await db.update(academySessionsTable)
      .set({ footageNote: bookingErrorNote(error) })
      .where(eq(academySessionsTable.id, sessionId));
    return;
  }

  const holdingRequests = await db.select({
    id: footageRequestsTable.id,
    academyId: footageRequestsTable.academyId,
    status: footageRequestsTable.status,
    startLocal: footageRequestsTable.startLocal,
    endLocal: footageRequestsTable.endLocal,
  })
    .from(footageRequestsTable)
    .where(and(
      or(
        eq(footageRequestsTable.fieldId, row.academyFieldId),
        eq(footageRequestsTable.cameraId, cameraId),
      ),
      inArray(footageRequestsTable.status, HOLD_STATUSES),
    ));
  const overlapping = holdingRequests.filter((candidate) => localWindowOverlaps(
    window.startLocal,
    window.endLocal,
    candidate.startLocal,
    candidate.endLocal,
  ));
  // Only this academy's own booking that covers the whole session is shared.
  const reusable = overlapping.find((candidate) => candidate.academyId === academyId
    && REUSABLE_STATUSES.includes(candidate.status as typeof REUSABLE_STATUSES[number])
    && localWindowContains(candidate.startLocal, candidate.endLocal, window.startLocal, window.endLocal));
  if (reusable) {
    await db.update(academySessionsTable)
      .set({ footageRequestId: reusable.id, footageNote: window.note })
      .where(eq(academySessionsTable.id, sessionId));
    return;
  }
  if (overlapping.length > 0) {
    // Someone already holds the camera for part of this window. A second camera job
    // for the same time is never created.
    const elsewhere = overlapping.some((candidate) => candidate.academyId !== academyId);
    await db.update(academySessionsTable)
      .set({ footageNote: elsewhere ? CAMERA_BOOKED_ELSEWHERE_NOTE : CAMERA_BOOKED_BY_ACADEMY_NOTE })
      .where(eq(academySessionsTable.id, sessionId));
    return;
  }

  try {
    const created = await createFootageRequest({
      fieldId: row.academyFieldId,
      cameraId,
      requestedBy,
      startLocal: window.startLocal,
      endLocal: window.endLocal,
      requestedSeconds: window.requestedSeconds,
      rateFils: 0,
      academyId,
      status: "scheduled",
    }, { startJob: false });
    await db.update(academySessionsTable)
      .set({ footageRequestId: created.id, footageNote: window.note })
      .where(eq(academySessionsTable.id, sessionId));
    await startCameraJob(created, cameraId);
    const [started] = await db.select({
      status: footageRequestsTable.status,
      message: footageRequestsTable.message,
    }).from(footageRequestsTable).where(eq(footageRequestsTable.id, created.id));
    if (started?.status === "failed") {
      await db.update(academySessionsTable)
        .set({ footageNote: started.message || "Camera unreachable — try again." })
        .where(eq(academySessionsTable.id, sessionId));
    }
  } catch (error) {
    logger.warn({ academyId, sessionId, error }, "Academy footage booking failed");
    await db.update(academySessionsTable)
      .set({ footageNote: bookingErrorNote(error) })
      .where(eq(academySessionsTable.id, sessionId));
  }
}

export async function syncAcademySessionFootageAfterTimeChange(
  academyId: number,
  sessionId: number,
  requestedBy: number,
): Promise<void> {
  const row = await loadAcademySession(academyId, sessionId);
  if (!row) return;
  const requestId = row.session.footageRequestId;
  if (requestId === null) {
    await bookAcademySessionFootage(academyId, sessionId, requestedBy);
    return;
  }
  const [footage] = await db.select().from(footageRequestsTable)
    .where(eq(footageRequestsTable.id, requestId));
  if (!footage || footage.academyId !== academyId) {
    // Someone else's booking is never changed here; the session just stops pointing at it.
    await db.update(academySessionsTable)
      .set({ footageRequestId: null })
      .where(eq(academySessionsTable.id, sessionId));
    await bookAcademySessionFootage(academyId, sessionId, requestedBy);
    return;
  }
  const [otherSession] = await db.select({ id: academySessionsTable.id })
    .from(academySessionsTable)
    .where(and(
      eq(academySessionsTable.footageRequestId, requestId),
      ne(academySessionsTable.id, sessionId),
    ))
    .limit(1);
  if (
    footage.academyId === academyId
    && footage.status === "scheduled"
    && footage.shareToken === null
    && !otherSession
  ) {
    const cancelled = await cancelFootageRequest(footage, {
      allowedStatuses: ["scheduled"],
      message: "Cancelled because the academy session time changed",
    });
    if ("cancelled" in cancelled) {
      await db.update(academySessionsTable)
        .set({ footageRequestId: null, footageNote: null })
        .where(eq(academySessionsTable.id, sessionId));
      await bookAcademySessionFootage(academyId, sessionId, requestedBy);
      return;
    }
    await db.update(academySessionsTable)
      .set({ footageNote: "The scheduled camera booking could not be changed; try again." })
      .where(eq(academySessionsTable.id, sessionId));
    return;
  }
  if (REBOOKABLE_STATUSES.includes(footage.status as typeof REBOOKABLE_STATUSES[number])) {
    await db.update(academySessionsTable)
      .set({ footageRequestId: null, footageNote: null })
      .where(eq(academySessionsTable.id, sessionId));
    await bookAcademySessionFootage(academyId, sessionId, requestedBy);
    return;
  }
  await db.update(academySessionsTable)
    .set({ footageNote: "The session time changed; this footage keeps its original booking window." })
    .where(eq(academySessionsTable.id, sessionId));
}

export async function cancelScheduledAcademyFootageForSession(
  academyId: number,
  sessionId: number,
): Promise<void> {
  const [session] = await db.select().from(academySessionsTable)
    .where(and(
      eq(academySessionsTable.id, sessionId),
      eq(academySessionsTable.academyId, academyId),
    ));
  if (!session?.footageRequestId) return;
  const [otherSession] = await db.select({ id: academySessionsTable.id })
    .from(academySessionsTable)
    .where(and(
      eq(academySessionsTable.footageRequestId, session.footageRequestId),
      ne(academySessionsTable.id, sessionId),
    ))
    .limit(1);
  if (otherSession) return;
  const [footage] = await db.select().from(footageRequestsTable)
    .where(eq(footageRequestsTable.id, session.footageRequestId));
  if (
    !footage
    || footage.academyId !== academyId
    || !ACTIVE_STATUSES.includes(footage.status as typeof ACTIVE_STATUSES[number])
    || footage.shareToken !== null
  ) return;
  // Same cancellation as the owner's cancel: a queued/running/recording pull is
  // stopped on vps1 (DELETE /record-hq/<cam>/<job>) before the row is cancelled.
  const result = await cancelFootageRequest(footage, {
    allowedStatuses: ACTIVE_STATUSES,
    message: "Cancelled because the academy session was deleted",
  });
  if ("error" in result) {
    logger.warn({ academyId, sessionId, requestId: footage.id, error: result.error }, "Could not cancel deleted session's footage booking");
  }
}

export function academyFootageSummary(
  request: Pick<FootageRequest, "status"> | null,
  note: string | null,
  recordingCount: number,
): AcademyFootageSummary {
  let status: AcademyFootageStatus;
  if (!request) {
    status = note
      ? (/no camera/i.test(note) ? "no_camera" : "unavailable")
      : "none";
  } else if (request.status === "scheduled") {
    status = "scheduled";
  } else if (request.status === "recording") {
    status = "recording";
  } else if (request.status === "ready" || request.status === "partial") {
    status = "ready";
  } else if (["failed", "cancelled", "expired", "refunded"].includes(request.status)) {
    status = "failed";
  } else {
    status = "processing";
  }
  return { status, note, recordingCount };
}

export async function attachAcademyRecordingsForFootageRequest(
  request: FootageRequest,
  videoId: string | null,
  deliveredSeconds: number | null,
): Promise<void> {
  // Only an academy's own booking feeds its sessions; a player's or owner's
  // booking (academyId null) never attaches to any academy.
  const requestAcademyId = request.academyId;
  if (!videoId || requestAcademyId === null) return;
  const playbackUrl = getBunnyPlaybackUrl(videoId);
  await db.transaction(async (tx) => {
    // Serialize duplicate completion callbacks across API replicas without a
    // schema change; otherwise two workers could create duplicate recordings.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${playbackUrl}, 0))`);
    const linkedSessions = await tx.select({
      id: academySessionsTable.id,
      academyId: academySessionsTable.academyId,
    })
      .from(academySessionsTable)
      .where(and(
        eq(academySessionsTable.footageRequestId, request.id),
        eq(academySessionsTable.academyId, requestAcademyId),
      ))
      .orderBy(asc(academySessionsTable.startsAt), asc(academySessionsTable.id));
    if (linkedSessions.length === 0) return;

    const [existingRecording] = await tx.select({ id: recordingsTable.id })
      .from(recordingsTable)
      .where(eq(recordingsTable.videoUrl, playbackUrl))
      .limit(1);
    let recordingId = existingRecording?.id;
    if (!recordingId) {
      const [field] = await tx.select({ name: fieldsTable.name })
        .from(fieldsTable)
        .where(eq(fieldsTable.id, request.fieldId));
      if (!field) return;
      const [date, time = ""] = request.startLocal.split(/\s+/);
      const [, endTime = ""] = request.endLocal.split(/\s+/);
      const minutes = Math.max(1, Math.ceil((deliveredSeconds ?? request.requestedSeconds) / 60));
      const [recording] = await tx.insert(recordingsTable).values({
        fieldId: request.fieldId,
        court: field.name,
        date,
        timeSlot: `${time.slice(0, 5)}–${endTime.slice(0, 5)}`,
        duration: `${minutes} min`,
        videoUrl: playbackUrl,
        score: null,
        isVisible: false,
      }).returning({ id: recordingsTable.id });
      recordingId = recording.id;
    }

    const earliestSessionByAcademy = new Map<number, number>();
    for (const session of linkedSessions) {
      if (!earliestSessionByAcademy.has(session.academyId)) {
        earliestSessionByAcademy.set(session.academyId, session.id);
      }
    }
    for (const [academyId, sessionId] of earliestSessionByAcademy) {
      const [existingLink] = await tx.select({ id: academyRecordingsTable.id })
        .from(academyRecordingsTable)
        .where(and(
          eq(academyRecordingsTable.academyId, academyId),
          eq(academyRecordingsTable.recordingId, recordingId),
        ))
        .limit(1);
      if (existingLink) continue;
      await tx.insert(academyRecordingsTable).values({
        academyId,
        recordingId,
        sessionId,
      }).onConflictDoNothing();
    }
  });
}
