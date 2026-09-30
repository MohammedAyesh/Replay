import type { Request } from "express";
import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  fieldsTable,
  footageRequestsTable,
  recordingSchedulesTable,
  recordingsTable,
} from "@workspace/db";
import { getLocalUserRecord } from "./clerkUserBridge";
import { matchesRecordingSchedule, type RecordingVisibilitySchedule } from "./recordingVisibility";

export type PublicFootageViewer = NonNullable<Awaited<ReturnType<typeof getLocalUserRecord>>> | null;

export type PublicFootageContext = {
  viewer: PublicFootageViewer;
  isAdmin: boolean;
  schedulesByField: Map<number, RecordingVisibilitySchedule[]>;
};

export function extractBunnyVideoId(value: string | null | undefined): string | null {
  if (!value) return null;
  if (!value.includes("/") && !value.includes(":")) return value;
  try {
    const firstSegment = new URL(value).pathname.split("/").filter(Boolean)[0];
    return firstSegment ?? null;
  } catch {
    return value;
  }
}

export function parseRecordingTitleTimestamp(title: string): { date: string; timeSlot: string } | null {
  const isoMatch = title.match(/(\d{4}-\d{2}-\d{2})_(\d{1,2}:\d{2})/);
  if (isoMatch) {
    const [hourText, minute] = isoMatch[2].split(":");
    const hour = Number(hourText);
    if (hour >= 0 && hour <= 23) {
      return { date: isoMatch[1], timeSlot: `${String(hour).padStart(2, "0")}:${minute}` };
    }
  }

  const underscoreDateMatch = title.match(/(\d{4})_(\d{2})_(\d{2})_(\d{1,2}:\d{2})/);
  if (underscoreDateMatch) {
    const [, year, month, day, time] = underscoreDateMatch;
    const [hourText, minute] = time.split(":");
    const hour = Number(hourText);
    if (hour >= 0 && hour <= 23 && Number(minute) <= 59) {
      return {
        date: `${year}-${month}-${day}`,
        timeSlot: `${String(hour).padStart(2, "0")}:${minute}`,
      };
    }
  }

  const compactMatch = title.match(/(\d{8})(\d{6})/);
  if (compactMatch) {
    const [, datePart, timePart] = compactMatch;
    const hour = Number(timePart.slice(0, 2));
    const minute = Number(timePart.slice(2, 4));
    if (hour <= 23 && minute <= 59) {
      return {
        date: `${datePart.slice(0, 4)}-${datePart.slice(4, 6)}-${datePart.slice(6, 8)}`,
        timeSlot: `${timePart.slice(0, 2)}:${timePart.slice(2, 4)}`,
      };
    }
  }

  return null;
}

export async function createPublicFootageContext(
  req: Request,
  fieldIds: number[] = [],
): Promise<PublicFootageContext> {
  const viewer = await getLocalUserRecord(req);
  const schedules = await db
    .select({
      fieldId: recordingSchedulesTable.fieldId,
      allowedDate: recordingSchedulesTable.allowedDate,
      startTime: recordingSchedulesTable.startTime,
      endTime: recordingSchedulesTable.endTime,
    })
    .from(recordingSchedulesTable)
    .where(fieldIds.length > 0 ? inArray(recordingSchedulesTable.fieldId, fieldIds) : undefined);

  const schedulesByField = new Map<number, RecordingVisibilitySchedule[]>();
  for (const schedule of schedules) {
    const existing = schedulesByField.get(schedule.fieldId) ?? [];
    existing.push({
      allowedDate: schedule.allowedDate,
      startTime: schedule.startTime,
      endTime: schedule.endTime,
    });
    schedulesByField.set(schedule.fieldId, existing);
  }

  return {
    viewer,
    isAdmin: viewer?.isAdmin === true,
    schedulesByField,
  };
}

export function isPublicRecordingInContext(
  recording: typeof recordingsTable.$inferSelect,
  field: typeof fieldsTable.$inferSelect,
  context: PublicFootageContext,
): boolean {
  if (context.isAdmin) return true;
  // This is an explicit per-recording admin override. Keep field-level hiding
  // authoritative, but do not require a second schedule match after an admin
  // has marked the imported recording visible.
  return !field.isHidden && recording.isVisible;
}

export function isPublicBunnyVideoInContext(
  field: typeof fieldsTable.$inferSelect,
  context: PublicFootageContext,
  date: string | null,
  timeSlot: string | null,
): boolean {
  if (context.isAdmin) return true;
  if (field.isHidden) return false;
  if (!date || !timeSlot) return false;
  return matchesRecordingSchedule(date, timeSlot, context.schedulesByField.get(field.id) ?? []);
}

/**
 * Apply the same visibility rule to a video returned from a Bunny collection
 * that the media proxy applies when the browser requests its manifest.
 *
 * Imported rows are authoritative: an admin-visible imported recording is
 * public without a schedule, and a hidden imported recording must not become
 * public again just because its Bunny title contains a scheduled timestamp.
 * Unimported videos may still be shown when their title identifies a scheduled
 * public recording.
 */
export function isPublicBunnyCollectionVideo(
  field: typeof fieldsTable.$inferSelect,
  videoId: string,
  title: string,
  context: PublicFootageContext,
  importedRecordings: Array<Pick<typeof recordingsTable.$inferSelect, "videoUrl" | "isVisible">>,
): boolean {
  if (context.isAdmin) return true;
  if (field.isHidden) return false;

  const matchingRecordings = importedRecordings.filter(
    (recording) => extractBunnyVideoId(recording.videoUrl) === videoId,
  );
  if (matchingRecordings.length > 0) {
    return matchingRecordings.some((recording) => recording.isVisible);
  }

  const timestamp = parseRecordingTitleTimestamp(title);
  return Boolean(
    timestamp
    && isPublicBunnyVideoInContext(
      field,
      context,
      timestamp.date,
      timestamp.timeSlot,
    ),
  );
}

export async function isActiveOwnerVideo(videoId: string): Promise<boolean> {
  const [request] = await db
    .select({ id: footageRequestsTable.id })
    .from(footageRequestsTable)
    .where(and(
      eq(footageRequestsTable.videoId, videoId),
      eq(footageRequestsTable.shareRevoked, false),
      inArray(footageRequestsTable.status, ["ready", "partial"]),
    ))
    .limit(1);

  if (!request) return false;

  const [activeShare] = await db
    .select({ shareExpiresAt: footageRequestsTable.shareExpiresAt })
    .from(footageRequestsTable)
    .where(eq(footageRequestsTable.id, request.id));

  return Boolean(activeShare?.shareExpiresAt && activeShare.shareExpiresAt.getTime() > Date.now());
}

export async function canCreateClipFromVideo(req: Request, videoId: string): Promise<boolean> {
  const context = await createPublicFootageContext(req);
  if (context.isAdmin) return true;
  if (await isActiveOwnerVideo(videoId)) return true;

  const recordings = await db
    .select({ recording: recordingsTable, field: fieldsTable })
    .from(recordingsTable)
    .innerJoin(fieldsTable, eq(recordingsTable.fieldId, fieldsTable.id));

  return recordings.some(({ recording, field }) => (
    extractBunnyVideoId(recording.videoUrl) === videoId
    && isPublicRecordingInContext(recording, field, context)
  ));
}

export async function canViewBunnyVideo(req: Request, videoId: string): Promise<boolean> {
  const context = await createPublicFootageContext(req);
  if (context.isAdmin) return true;

  const recordings = await db
    .select({ recording: recordingsTable, field: fieldsTable })
    .from(recordingsTable)
    .innerJoin(fieldsTable, eq(recordingsTable.fieldId, fieldsTable.id));

  return recordings.some(({ recording, field }) => (
    extractBunnyVideoId(recording.videoUrl) === videoId
    && isPublicRecordingInContext(recording, field, context)
  ));
}