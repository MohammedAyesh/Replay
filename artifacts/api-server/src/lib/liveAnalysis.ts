import { and, desc, eq, like, notInArray, or, sql } from "drizzle-orm";
import { analysisJobsTable, db, recordingsTable, type FootageRequest } from "@workspace/db";
import { BUNNY_CDN_HOSTNAME } from "./bunny";
import { logger } from "./logger";
import { getSettingValue } from "./settings";

/**
 * Bookings analysed while they are played.
 *
 * vps1 watches every booking for its real kick-off and analyses it on a rented
 * GPU as the footage comes off the camera (liveanalysis/live_runner.py), so the
 * bundle is ready shortly after the whistle. What it cannot do is attach that
 * bundle to anything: the app only takes bundles through an analysis job on a
 * recording. This queues that job the moment a booking's footage is ready,
 * with params.liveJob naming the VPS job, and the cloud GPU worker then uploads
 * the live bundle instead of analysing the recording again (or analyses it
 * normally if the live run failed or never happened).
 *
 * Off unless the "stats.liveAnalysis" setting is on for the booking's field.
 */
export const LIVE_ANALYSIS_SETTING = "stats.liveAnalysis";

export type LiveAnalysisOutcome =
  | { queued: true; jobId: number; recordingId: number }
  | { queued: false; reason: string; recordingId?: number };

/** cam1 / camera1 / anything else -> the court name the pipeline expects ("cam1"). */
export function courtFromCamera(cameraId: string): string {
  const m = /^cam(?:era)?(\d+)$/i.exec(cameraId.trim());
  return m ? `cam${m[1]}` : cameraId.trim();
}

function durationLabel(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** The recordings row for a Bunny video, created (hidden) if the Bunny sync has not made one yet. */
export async function ensureRecordingForVideo(row: FootageRequest, videoId: string, seconds: number): Promise<number> {
  const [existing] = await db
    .select({ id: recordingsTable.id })
    .from(recordingsTable)
    .where(like(recordingsTable.videoUrl, `%/${videoId}/%`))
    .limit(1);
  if (existing) return existing.id;
  const [date, time = ""] = row.startLocal.trim().split(/\s+/);
  const [inserted] = await db
    .insert(recordingsTable)
    .values({
      fieldId: row.fieldId,
      court: courtFromCamera(row.cameraId),
      date,
      timeSlot: time.slice(0, 5),
      duration: durationLabel(seconds),
      videoUrl: `https://${BUNNY_CDN_HOSTNAME}/${videoId}/playlist.m3u8`,
      isVisible: false,
    })
    .returning({ id: recordingsTable.id });
  return inserted.id;
}

/** Is "Analyse bookings during the match" on for this field? Never throws: off on error. */
export async function liveAnalysisEnabled(fieldId: number): Promise<boolean> {
  try {
    return (await getSettingValue<boolean>(LIVE_ANALYSIS_SETTING, { fieldId })) === true;
  } catch (error) {
    logger.warn({ fieldId, error }, "Could not read the live analysis setting; treating it as off");
    return false;
  }
}

async function recordingsForBooking(row: FootageRequest, videoId: string | null) {
  const conditions = [
    ...(videoId ? [like(recordingsTable.videoUrl, `%/${videoId}/%`)] : []),
    ...(row.vpsJobId ? [like(recordingsTable.videoUrl, `%${row.vpsJobId}%`)] : []),
  ];
  if (!conditions.length) return [];
  return db.select({ id: recordingsTable.id, videoUrl: recordingsTable.videoUrl })
    .from(recordingsTable)
    .where(or(...conditions));
}

async function existingAnalysisForBooking(row: FootageRequest, recordingIds: number[]) {
  const associations = [
    sql`${analysisJobsTable.params} ->> 'footageRequestId' = ${String(row.id)}`,
  ];
  if (row.vpsJobId) {
    associations.push(sql`${analysisJobsTable.params} ->> 'liveJob' = ${row.vpsJobId}`);
  }
  for (const recordingId of recordingIds) {
    associations.push(
      sql`${analysisJobsTable.recordingId} = ${recordingId}`,
      sql`${analysisJobsTable.sourceRecordingIds} @> ${JSON.stringify([recordingId])}::jsonb`,
      sql`${analysisJobsTable.bundleRecordingIds} @> ${JSON.stringify([recordingId])}::jsonb`,
    );
  }
  const [job] = await db.select().from(analysisJobsTable)
    .where(and(
      notInArray(analysisJobsTable.status, ["failed", "cancelled"]),
      or(...associations),
    ))
    .orderBy(
      sql`CASE WHEN ${analysisJobsTable.status} = 'succeeded' THEN 0 ELSE 1 END`,
      desc(analysisJobsTable.createdAt),
    )
    .limit(1);
  return job ?? null;
}

async function linkExistingAnalysisToBooking(
  row: FootageRequest,
  job: typeof analysisJobsTable.$inferSelect,
  recordingId?: number,
): Promise<number> {
  const linkedRecordingId = recordingId ?? job.recordingId;
  await db.update(analysisJobsTable)
    .set({
      recordingId: linkedRecordingId,
      params: { ...job.params, footageRequestId: row.id },
      updatedAt: new Date(),
    })
    .where(eq(analysisJobsTable.id, job.id));
  logger.info({
    analysisJobId: job.id,
    footageRequestId: row.id,
    recordingId: linkedRecordingId,
    status: job.status,
  }, "Linked existing analysis to completed footage booking");
  return linkedRecordingId;
}

export async function queueLiveAnalysisForBooking(
  row: FootageRequest,
  videoId: string | null,
  deliveredSeconds: number | null,
): Promise<LiveAnalysisOutcome> {
  const matchedRecordings = await recordingsForBooking(row, videoId);
  const videoRecording = videoId
    ? matchedRecordings.find((recording) => recording.videoUrl.includes(`/${videoId}/`))
    : undefined;
  const relatedRecordingIds = [...new Set(matchedRecordings.map((recording) => recording.id))];
  let recordingId = videoRecording?.id;

  const existing = await existingAnalysisForBooking(row, relatedRecordingIds);
  if (existing) {
    if (!recordingId && videoId) {
      recordingId = await ensureRecordingForVideo(row, videoId, deliveredSeconds ?? row.requestedSeconds);
    }
    const linkedRecordingId = await linkExistingAnalysisToBooking(row, existing, recordingId);
    return {
      queued: false,
      reason: `existing analysis job #${existing.id} linked`,
      recordingId: linkedRecordingId,
    };
  }

  if (!videoId || !row.vpsJobId) return { queued: false, reason: "no video or no VPS job" };
  if (!(await liveAnalysisEnabled(row.fieldId))) return { queued: false, reason: "setting off for this field" };

  recordingId ??= await ensureRecordingForVideo(row, videoId, deliveredSeconds ?? row.requestedSeconds);
  // Recheck after resolving/creating the canonical video recording, so a job
  // linked through that recording is reused instead of being duplicated.
  const existingAfterRecording = await existingAnalysisForBooking(row, [...new Set([...relatedRecordingIds, recordingId])]);
  if (existingAfterRecording) {
    const linkedRecordingId = await linkExistingAnalysisToBooking(row, existingAfterRecording, recordingId);
    return {
      queued: false,
      reason: `existing analysis job #${existingAfterRecording.id} linked`,
      recordingId: linkedRecordingId,
    };
  }

  const [job] = await db
    .insert(analysisJobsTable)
    .values({
      recordingId,
      sourceRecordingIds: [recordingId],
      matchStartSeconds: 0,
      params: { liveJob: row.vpsJobId, footageRequestId: row.id },
      createdBy: row.requestedBy,
    })
    .returning({ id: analysisJobsTable.id });
  logger.info({ jobId: job.id, recordingId, footageRequestId: row.id, vpsJobId: row.vpsJobId },
    "Booking analysis queued (live bundle)");
  return { queued: true, jobId: job.id, recordingId };
}
