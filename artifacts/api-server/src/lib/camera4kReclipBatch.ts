import { randomUUID } from "node:crypto";
import {
  and,
  asc,
  count,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  or,
  sql,
} from "drizzle-orm";
import {
  camera4kReclipBatchesTable,
  camera4kReclipItemsTable,
  db,
  recordingsTable,
  userClipsTable,
  type Camera4kSourceProbe,
} from "@workspace/db";
import { logger } from "./logger";
import { waitForCamera4kSource } from "./clipExportSource";
import { createLegacyReclipSkipItem } from "./camera4kReclipEligibility";
import { renderAdminCamera4kBatchClip } from "../routes/userClips";

export const CAMERA_4K_RECLIP_BATCH_KEY = "camera-original-4k-20261108";
export const CAMERA_4K_RECLIP_CUTOFF = new Date("2026-11-08T16:05:00.000Z");
const BATCH_REVISION_PREFIX = "camera4k-20261108";
const LEASE_MS = 5 * 60_000;
const HEARTBEAT_MS = 30_000;
const TICK_MS = 60_000;
const GUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

export function isCamera4kReclipWindow(at: Date): boolean {
  const hour = at.getUTCHours();
  return hour >= 22 || hour < 6;
}

export function camera4kReclipRevision(clipId: number): string {
  return `${BATCH_REVISION_PREFIX}-${clipId}`;
}

async function findOrCreateBatch() {
  await db.insert(camera4kReclipBatchesTable).values({
    batchKey: CAMERA_4K_RECLIP_BATCH_KEY,
    status: "scheduled",
    scopeCutoff: CAMERA_4K_RECLIP_CUTOFF,
  }).onConflictDoNothing({ target: camera4kReclipBatchesTable.batchKey });
  const [batch] = await db.select().from(camera4kReclipBatchesTable)
    .where(eq(camera4kReclipBatchesTable.batchKey, CAMERA_4K_RECLIP_BATCH_KEY))
    .limit(1);
  if (!batch) throw new Error("Could not initialize the camera 4K re-clip batch");
  return batch;
}

async function probeRecording(recording: {
  id: number;
  date: string;
  timeSlot: string;
  videoUrl: string;
}): Promise<Camera4kSourceProbe | null> {
  const videoId = recording.videoUrl.match(GUID_RE)?.[1]?.toLowerCase();
  if (!videoId) return null;
  try {
    await waitForCamera4kSource(videoId, { timeoutMs: 8_000, pollIntervalMs: 750 });
    return {
      recordingId: recording.id,
      videoId,
      recordingDate: recording.date,
      timeSlot: recording.timeSlot,
      state: "ready",
      reason: null,
    };
  } catch (err) {
    return {
      recordingId: recording.id,
      videoId,
      recordingDate: recording.date,
      timeSlot: recording.timeSlot,
      state: "unavailable",
      reason: err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300),
    };
  }
}

async function seedBatchScope(batchId: number): Promise<void> {
  const recordings = await db.select({
    id: recordingsTable.id,
    date: recordingsTable.date,
    timeSlot: recordingsTable.timeSlot,
    videoUrl: recordingsTable.videoUrl,
  }).from(recordingsTable);
  const probes = (await Promise.all(recordings.map(probeRecording)))
    .filter((probe): probe is Camera4kSourceProbe => probe !== null);
  const ready = probes.filter((probe) => probe.state === "ready");
  const recordingByGuid = new Map(ready.map((probe) => [probe.videoId, probe.recordingId]));
  const readyGuids = [...recordingByGuid.keys()];

  if (readyGuids.length) {
    // There is no dependable export-completed timestamp on user_clips. Include
    // saved clips from known 4K sources up to the publish cutoff; clips created
    // after the 4K publish are excluded because their initial export already
    // uses the camera-original path.
    const clips = await db.select({
      id: userClipsTable.id,
      videoId: userClipsTable.videoId,
    }).from(userClipsTable).where(and(
      inArray(userClipsTable.videoId, readyGuids),
      eq(userClipsTable.exportStatus, "done"),
      isNotNull(userClipsTable.exportedUrl),
      lt(userClipsTable.createdAt, CAMERA_4K_RECLIP_CUTOFF),
    )).orderBy(asc(userClipsTable.id));

    if (clips.length) {
      await db.insert(camera4kReclipItemsTable).values(clips.map((clip) => createLegacyReclipSkipItem({
        batchId,
        clipId: clip.id,
        videoId: clip.videoId,
        recordingId: recordingByGuid.get(clip.videoId)!,
      }))).onConflictDoNothing({
        target: [camera4kReclipItemsTable.batchId, camera4kReclipItemsTable.clipId],
      });
    }
  }

  const [totals] = await db.select({ total: count() })
    .from(camera4kReclipItemsTable)
    .where(eq(camera4kReclipItemsTable.batchId, batchId));
  await db.update(camera4kReclipBatchesTable).set({
    scopeSeeded: true,
    sourceProbeSummary: probes,
    totalCount: Number(totals?.total ?? 0),
    updatedAt: new Date(),
  }).where(eq(camera4kReclipBatchesTable.id, batchId));
  await refreshCounts(batchId);
}

async function refreshCounts(batchId: number): Promise<{
  total: number;
  pending: number;
  running: number;
  completed: number;
  failed: number;
  skipped: number;
}> {
  const rows = await db.select({
    status: camera4kReclipItemsTable.status,
    value: count(),
  }).from(camera4kReclipItemsTable)
    .where(eq(camera4kReclipItemsTable.batchId, batchId))
    .groupBy(camera4kReclipItemsTable.status);
  const values = new Map(rows.map((row) => [row.status, Number(row.value)]));
  const counts = {
    total: [...values.values()].reduce((sum, value) => sum + value, 0),
    pending: values.get("pending") ?? 0,
    running: values.get("running") ?? 0,
    completed: values.get("completed") ?? 0,
    failed: values.get("failed") ?? 0,
    skipped: values.get("skipped") ?? 0,
  };
  await db.update(camera4kReclipBatchesTable).set({
    totalCount: counts.total,
    completedCount: counts.completed,
    failedCount: counts.failed,
    skippedCount: counts.skipped,
    updatedAt: new Date(),
  }).where(eq(camera4kReclipBatchesTable.id, batchId));
  return counts;
}

async function recoverInterruptedItems(batchId: number): Promise<void> {
  const interrupted = await db.select().from(camera4kReclipItemsTable)
    .where(and(
      eq(camera4kReclipItemsTable.batchId, batchId),
      eq(camera4kReclipItemsTable.status, "running"),
    ));
  for (const item of interrupted) {
    const revision = camera4kReclipRevision(item.clipId);
    const [clip] = await db.select({
      exportedUrl: userClipsTable.exportedUrl,
      exportStatus: userClipsTable.exportStatus,
    }).from(userClipsTable).where(eq(userClipsTable.id, item.clipId));
    if (clip?.exportStatus === "done" && clip.exportedUrl?.endsWith(`-${revision}.mp4`)) {
      await db.update(camera4kReclipItemsTable).set({
        status: "completed",
        failureReason: null,
        completedAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(camera4kReclipItemsTable.id, item.id));
    } else {
      // A render that did not publish its deterministic revision is incomplete
      // and can be safely retried; completed replacements are never repeated.
      await db.update(camera4kReclipItemsTable).set({
        status: "pending",
        startedAt: null,
        updatedAt: new Date(),
      }).where(eq(camera4kReclipItemsTable.id, item.id));
    }
  }
}

async function setBatchState(
  batchId: number,
  status: "scheduled" | "running" | "paused" | "completed",
  completedAt?: Date | null,
): Promise<void> {
  await db.update(camera4kReclipBatchesTable).set({
    status,
    ...(completedAt !== undefined ? { completedAt } : {}),
    ...(status === "running" ? { startedAt: sql`coalesce(${camera4kReclipBatchesTable.startedAt}, now())` } : {}),
    updatedAt: new Date(),
  }).where(eq(camera4kReclipBatchesTable.id, batchId));
}

async function processBatchTick(): Promise<void> {
  const batch = await findOrCreateBatch();
  if (batch.status === "completed") return;

  const leaseToken = randomUUID();
  const now = new Date();
  const [lease] = await db.update(camera4kReclipBatchesTable).set({
    leaseToken,
    leaseUntil: new Date(now.getTime() + LEASE_MS),
    updatedAt: now,
  }).where(and(
    eq(camera4kReclipBatchesTable.id, batch.id),
    or(isNull(camera4kReclipBatchesTable.leaseUntil), lt(camera4kReclipBatchesTable.leaseUntil, now)),
    ne(camera4kReclipBatchesTable.status, "completed"),
  )).returning({ id: camera4kReclipBatchesTable.id });
  if (!lease) return;

  let leaseLost = false;
  const heartbeat = setInterval(() => {
    void db.update(camera4kReclipBatchesTable).set({
      leaseUntil: new Date(Date.now() + LEASE_MS),
      updatedAt: new Date(),
    }).where(and(
      eq(camera4kReclipBatchesTable.id, batch.id),
      eq(camera4kReclipBatchesTable.leaseToken, leaseToken),
    )).returning({ id: camera4kReclipBatchesTable.id })
      .then((rows) => { if (!rows.length) leaseLost = true; })
      .catch((err) => logger.warn({ err }, "Camera 4K re-clip lease heartbeat failed"));
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  try {
    let [current] = await db.select().from(camera4kReclipBatchesTable)
      .where(eq(camera4kReclipBatchesTable.id, batch.id));
    if (!current) return;
    if (!current.scopeSeeded) {
      await seedBatchScope(current.id);
      [current] = await db.select().from(camera4kReclipBatchesTable)
        .where(eq(camera4kReclipBatchesTable.id, batch.id));
      if (!current) return;
    }
    if (current.paused) {
      await setBatchState(current.id, "paused");
      return;
    }
    if (!isCamera4kReclipWindow(new Date())) {
      const counts = await refreshCounts(current.id);
      if (counts.pending === 0 && counts.running === 0) {
        await setBatchState(current.id, "completed", new Date());
      } else {
        await setBatchState(current.id, "scheduled");
      }
      return;
    }
    await recoverInterruptedItems(current.id);
    await setBatchState(current.id, "running");

    while (!leaseLost && isCamera4kReclipWindow(new Date())) {
      const [state] = await db.select({
        paused: camera4kReclipBatchesTable.paused,
      }).from(camera4kReclipBatchesTable)
        .where(eq(camera4kReclipBatchesTable.id, current.id));
      if (!state || state.paused) {
        await setBatchState(current.id, "paused");
        return;
      }

      const [item] = await db.select().from(camera4kReclipItemsTable)
        .where(and(
          eq(camera4kReclipItemsTable.batchId, current.id),
          eq(camera4kReclipItemsTable.status, "pending"),
        ))
        .orderBy(asc(camera4kReclipItemsTable.id))
        .limit(1);
      if (!item) {
        const counts = await refreshCounts(current.id);
        if (counts.pending === 0 && counts.running === 0) {
          await setBatchState(current.id, "completed", new Date());
        } else {
          await setBatchState(current.id, "scheduled");
        }
        return;
      }

      const revision = camera4kReclipRevision(item.clipId);
      const [clip] = await db.select().from(userClipsTable)
        .where(eq(userClipsTable.id, item.clipId));
      if (clip?.exportStatus === "done" && clip.exportedUrl?.endsWith(`-${revision}.mp4`)) {
        await db.update(camera4kReclipItemsTable).set({
          status: "completed",
          failureReason: null,
          completedAt: new Date(),
          updatedAt: new Date(),
        }).where(eq(camera4kReclipItemsTable.id, item.id));
        await refreshCounts(current.id);
        continue;
      }
      if (!clip || clip.videoId !== item.videoId || clip.exportStatus !== "done" || !clip.exportedUrl) {
        await db.update(camera4kReclipItemsTable).set({
          status: "skipped",
          failureReason: "Clip was deleted, changed source, or no longer has a settled export.",
          completedAt: new Date(),
          updatedAt: new Date(),
        }).where(eq(camera4kReclipItemsTable.id, item.id));
        await refreshCounts(current.id);
        continue;
      }

      const startedAt = new Date();
      await db.update(camera4kReclipItemsTable).set({
        status: "running",
        failureReason: null,
        startedAt,
        updatedAt: startedAt,
      }).where(and(
        eq(camera4kReclipItemsTable.id, item.id),
        eq(camera4kReclipItemsTable.status, "pending"),
      ));

      const result = await renderAdminCamera4kBatchClip(clip, revision);
      if (result.state === "busy") {
        await db.update(camera4kReclipItemsTable).set({
          status: "pending",
          startedAt: null,
          updatedAt: new Date(),
        }).where(eq(camera4kReclipItemsTable.id, item.id));
        await setBatchState(current.id, "scheduled");
        return;
      }

      const completedAt = new Date();
      const validation = result.state === "completed" ? result.validation : result.validation;
      await db.update(camera4kReclipItemsTable).set({
        status: result.state === "completed" ? "completed" : "failed",
        failureReason: result.state === "failed" ? result.reason.slice(0, 500) : null,
        completedAt,
        elapsedMs: Math.max(0, completedAt.getTime() - startedAt.getTime()),
        oldDurationSeconds: validation ? String(validation.oldDurationSeconds) : null,
        newDurationSeconds: validation ? String(validation.newDurationSeconds) : null,
        oldBytes: validation?.oldBytes ?? null,
        newBytes: validation?.newBytes ?? null,
        width: validation?.width ?? null,
        height: validation?.height ?? null,
        updatedAt: completedAt,
      }).where(eq(camera4kReclipItemsTable.id, item.id));
      await refreshCounts(current.id);
    }
    if (leaseLost) logger.warn({ batchKey: current.batchKey }, "Camera 4K re-clip lease was lost");
  } finally {
    clearInterval(heartbeat);
    await db.update(camera4kReclipBatchesTable).set({
      leaseToken: null,
      leaseUntil: null,
      updatedAt: new Date(),
    }).where(and(
      eq(camera4kReclipBatchesTable.id, batch.id),
      eq(camera4kReclipBatchesTable.leaseToken, leaseToken),
    )).catch((err) => logger.warn({ err }, "Could not release camera 4K re-clip lease"));
  }
}

export function startCamera4kReclipBatchWorker(): () => void {
  if (process.env.NODE_ENV !== "production") return () => {};
  let busy = false;
  const tick = () => {
    if (busy) return;
    busy = true;
    void processBatchTick()
      .catch((err) => logger.error({ err }, "Camera 4K re-clip batch tick failed"))
      .finally(() => { busy = false; });
  };
  const timer = setInterval(tick, TICK_MS);
  timer.unref?.();
  const first = setTimeout(tick, 15_000);
  first.unref?.();
  return () => {
    clearInterval(timer);
    clearTimeout(first);
  };
}

export async function getCamera4kReclipStatus() {
  const [batch] = await db.select().from(camera4kReclipBatchesTable)
    .where(eq(camera4kReclipBatchesTable.batchKey, CAMERA_4K_RECLIP_BATCH_KEY))
    .limit(1);
  if (!batch) return null;

  const [current] = await db.select({
    clipId: camera4kReclipItemsTable.clipId,
    status: camera4kReclipItemsTable.status,
    startedAt: camera4kReclipItemsTable.startedAt,
  }).from(camera4kReclipItemsTable)
    .where(and(
      eq(camera4kReclipItemsTable.batchId, batch.id),
      eq(camera4kReclipItemsTable.status, "running"),
    )).limit(1);
  const failures = await db.select({
    clipId: camera4kReclipItemsTable.clipId,
    status: camera4kReclipItemsTable.status,
    failureReason: camera4kReclipItemsTable.failureReason,
    elapsedMs: camera4kReclipItemsTable.elapsedMs,
  }).from(camera4kReclipItemsTable)
    .where(and(
      eq(camera4kReclipItemsTable.batchId, batch.id),
      inArray(camera4kReclipItemsTable.status, ["failed", "skipped"]),
    ))
    .orderBy(asc(camera4kReclipItemsTable.clipId));
  return {
    batchKey: batch.batchKey,
    status: batch.status,
    paused: batch.paused,
    scopeSeeded: batch.scopeSeeded,
    scopeCutoff: batch.scopeCutoff,
    totalCount: batch.totalCount,
    completedCount: batch.completedCount,
    failedCount: batch.failedCount,
    skippedCount: batch.skippedCount,
    startedAt: batch.startedAt,
    completedAt: batch.completedAt,
    currentClipId: current?.clipId ?? null,
    currentClipStartedAt: current?.startedAt ?? null,
    sourceProbeSummary: batch.sourceProbeSummary,
    failures,
  };
}

export async function setCamera4kReclipPaused(paused: boolean) {
  const [batch] = await db.update(camera4kReclipBatchesTable).set({
    paused,
    status: paused ? "paused" : "scheduled",
    updatedAt: new Date(),
  }).where(and(
    eq(camera4kReclipBatchesTable.batchKey, CAMERA_4K_RECLIP_BATCH_KEY),
    ne(camera4kReclipBatchesTable.status, "completed"),
  )).returning({ id: camera4kReclipBatchesTable.id });
  if (!batch) return false;
  return true;
}
