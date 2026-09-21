import type { Request } from "express";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
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
  ownerVideoIds: Set<string>;
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

export function isOwnerFootageTitle(title: string | null | undefined): boolean {
  return typeof title === "string" && /\(owner request #\d+\)/i.test(title);
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
  const ownerRows = await db
    .select({ videoId: footageRequestsTable.videoId })
    .from(footageRequestsTable)
    .where(isNotNull(footageRequestsTable.videoId));

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
    ownerVideoIds: new Set(ownerRows.flatMap(({ videoId }) => videoId ? [videoId] : [])),
    schedulesByField,
  };
}

export function isPublicRecordingInContext(
  recording: typeof recordingsTable.$inferSelect,
  field: typeof fieldsTable.$inferSelect,
  context: PublicFootageContext,
): boolean {
  if (context.isAdmin) return true;
  if (field.isHidden || !recording.isVisible) return false;

  const videoId = extractBunnyVideoId(recording.videoUrl);
  if (videoId && context.ownerVideoIds.has(videoId)) return false;

  const schedules = context.schedulesByField.get(field.id) ?? [];
  return matchesRecordingSchedule(recording.date, recording.timeSlot, schedules);
}

export function isPublicBunnyVideoInContext(
  field: typeof fieldsTable.$inferSelect,
  videoId: string,
  title: string,
  context: PublicFootageContext,
  date: string | null,
  timeSlot: string | null,
): boolean {
  if (context.isAdmin) return true;
  if (field.isHidden || context.ownerVideoIds.has(videoId) || isOwnerFootageTitle(title)) return false;
  if (!date || !timeSlot) return false;
  return matchesRecordingSchedule(date, timeSlot, context.schedulesByField.get(field.id) ?? []);
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
  if (context.ownerVideoIds.has(videoId)) return false;

  const recordings = await db
    .select({ recording: recordingsTable, field: fieldsTable })
    .from(recordingsTable)
    .innerJoin(fieldsTable, eq(recordingsTable.fieldId, fieldsTable.id));

  return recordings.some(({ recording, field }) => (
    extractBunnyVideoId(recording.videoUrl) === videoId
    && isPublicRecordingInContext(recording, field, context)
  ));
}