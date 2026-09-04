import { Router, type IRouter } from "express";
import multer from "multer";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  analysisJobsTable,
  analysisWorkersTable,
  recordingsTable,
  fieldsTable,
  usersTable,
  type AnalysisJobRow,
  type AnalysisJobStatus,
} from "@workspace/db";
import { getLocalUserId, unauthenticatedResponse } from "../lib/clerkUserBridge";
import { logger } from "../lib/logger";
import { parseZipBundleDetailed, storeUploadBundle } from "./claimMatch";
import {
  ACTIVE_STATUSES,
  MAX_ATTEMPTS,
  STALE_HEARTBEAT_MS,
  canTransition,
  describeSource,
  isWorkerOnline,
  normaliseParams,
  queuePosition,
  reclaimDecision,
  validateMatchStart,
  validateSources,
  workerKeyMatches,
  type SourceDescriptor,
} from "../lib/analysisJobs";

const router: IRouter = Router();

/**
 * The tracking pipeline runs on a GPU workstation that is not this server and
 * is not reachable from it - it is a desktop behind a home connection. So the
 * direction of the relationship is inverted: the workstation calls in, asks
 * whether there is work, and reports back. Nothing here ever dials out.
 *
 * That inversion is also why the worker endpoints authenticate with a shared
 * key rather than a session. There is no browser and no human at the far end.
 */
const WORKER_KEY = () => process.env.ANALYSIS_WORKER_KEY ?? "";

const bundleUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 75 * 1024 * 1024 },
});
const bundleUploadSingle: import("express").RequestHandler = (req, res, next) => {
  bundleUpload.single("bundle")(req, res, (error) => {
    if (!error) return next();
    if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
      res.status(400).json({ error: "The ZIP file exceeds the 75 MB upload limit" });
      return;
    }
    next(error);
  });
};

async function requireAdmin(req: Parameters<typeof getLocalUserId>[0]): Promise<number | null> {
  const userId = await getLocalUserId(req);
  if (!userId) return null;
  const [user] = await db
    .select({ isAdmin: usersTable.isAdmin })
    .from(usersTable)
    .where(eq(usersTable.id, userId));
  return user?.isAdmin ? userId : null;
}

function requireWorker(req: import("express").Request, res: import("express").Response): string | null {
  const expected = WORKER_KEY();
  if (!expected) {
    // Distinguished from a wrong key on purpose: this is the server's fault,
    // and a worker that keeps retrying a 401 forever is harder to diagnose
    // than one told the deployment has no key set.
    res.status(503).json({ error: "This deployment has no ANALYSIS_WORKER_KEY set, so it cannot accept workers." });
    return null;
  }
  const header = req.header("x-worker-key");
  if (!workerKeyMatches(expected, header)) {
    res.status(401).json({ error: "Bad worker key" });
    return null;
  }
  const workerId = String(req.body?.workerId ?? req.header("x-worker-id") ?? "").trim();
  if (!workerId || workerId.length > 120) {
    res.status(400).json({ error: "workerId is required" });
    return null;
  }
  return workerId;
}

function parseId(raw: unknown): number | null {
  const value = Number.parseInt(Array.isArray(raw) ? String(raw[0]) : String(raw), 10);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** The schema is pushed, not migrated, so a fresh deploy may not have it yet. */
export function isMissingAnalysisSchema(err: unknown): boolean {
  const code = (err as { code?: string })?.code ?? ((err as { cause?: { code?: string } })?.cause)?.code;
  if (code === "42P01") return true;
  return /relation .* does not exist/i.test(String((err as Error)?.message ?? ""));
}

const SCHEMA_MISSING =
  "The analysis queue tables have not been created in this database yet. Open a Shell tab and run: pnpm --filter @workspace/db run push";

async function loadSources(ids: number[]) {
  if (!ids.length) return [];
  return db
    .select({
      id: recordingsTable.id,
      court: recordingsTable.court,
      date: recordingsTable.date,
      timeSlot: recordingsTable.timeSlot,
      duration: recordingsTable.duration,
      videoUrl: recordingsTable.videoUrl,
    })
    .from(recordingsTable)
    .where(inArray(recordingsTable.id, ids));
}

/**
 * Return jobs whose worker has gone quiet to the queue before anything reads
 * the queue. Done on demand rather than on a timer because this process may be
 * one of several and none of them is guaranteed to stay alive; a sweep that
 * runs whenever somebody looks cannot silently stop running.
 */
async function sweepStaleJobs(now = new Date()): Promise<void> {
  const held = await db
    .select({
      id: analysisJobsTable.id,
      status: analysisJobsTable.status,
      attempts: analysisJobsTable.attempts,
      heartbeatAt: analysisJobsTable.heartbeatAt,
      claimedAt: analysisJobsTable.claimedAt,
    })
    .from(analysisJobsTable)
    .where(inArray(analysisJobsTable.status, ["claimed", "running"]));
  for (const job of held) {
    const decision = reclaimDecision(job, now);
    if (decision.action === "leave") continue;
    if (decision.action === "requeue") {
      await db
        .update(analysisJobsTable)
        .set({
          status: "queued",
          workerId: null,
          claimedAt: null,
          heartbeatAt: null,
          stage: null,
          error: decision.reason,
          updatedAt: now,
        })
        .where(and(eq(analysisJobsTable.id, job.id), inArray(analysisJobsTable.status, ["claimed", "running"])));
      logger.warn({ jobId: job.id }, "Analysis job returned to the queue after a silent worker");
    } else {
      await db
        .update(analysisJobsTable)
        .set({ status: "failed", error: decision.reason, finishedAt: now, updatedAt: now })
        .where(and(eq(analysisJobsTable.id, job.id), inArray(analysisJobsTable.status, ["claimed", "running"])));
      logger.error({ jobId: job.id }, "Analysis job failed after repeated silent workers");
    }
  }
}

type JobView = AnalysisJobRow & {
  sources: SourceDescriptor[];
  queuePosition: number | null;
  recordingLabel: string | null;
};

async function viewJobs(rows: AnalysisJobRow[]): Promise<JobView[]> {
  const allIds = [...new Set(rows.flatMap((row) => [row.recordingId, ...row.sourceRecordingIds]))];
  const sources = await loadSources(allIds);
  const byId = new Map(sources.map((row) => [row.id, row]));
  const queuedOldestFirst = rows
    .filter((row) => row.status === "queued")
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .map((row) => row.id);
  return rows.map((row) => {
    const target = byId.get(row.recordingId);
    return {
      ...row,
      sources: row.sourceRecordingIds
        .map((id) => byId.get(id))
        .filter((found): found is NonNullable<typeof found> => !!found)
        .map(describeSource),
      queuePosition: queuePosition(row, queuedOldestFirst),
      recordingLabel: target ? `${target.court} ${target.date} ${target.timeSlot}`.trim() : null,
    };
  });
}

/* ------------------------------------------------------------------ admin -- */

/**
 * POST /admin/analysis-jobs
 * Queue a pipeline run. Body: recordingId, sourceRecordingIds (ordered),
 * matchStartSeconds, params.
 */
router.post("/admin/analysis-jobs", async (req, res): Promise<void> => {
  const adminId = await requireAdmin(req);
  if (!adminId) { unauthenticatedResponse(res, req); return; }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const rawSources = Array.isArray(body.sourceRecordingIds) ? body.sourceRecordingIds : [];
  const sourceIds = rawSources
    .map((value) => Number.parseInt(String(value), 10))
    .filter((value) => Number.isFinite(value) && value > 0);
  if (sourceIds.length !== rawSources.length) {
    res.status(400).json({ error: "sourceRecordingIds must be recording ids." });
    return;
  }
  const recordingId = parseId(body.recordingId ?? sourceIds[0]);
  if (!recordingId) { res.status(400).json({ error: "recordingId is required." }); return; }
  if (!sourceIds.includes(recordingId)) {
    res.status(400).json({ error: "The recording the bundle attaches to must be one of the chosen recordings." });
    return;
  }
  const matchStartSeconds = Number(body.matchStartSeconds ?? 0);

  try {
    const found = await loadSources(sourceIds);
    const validation = validateSources(sourceIds, found);
    if (!validation.ok) { res.status(400).json({ error: validation.error }); return; }
    const startError = validateMatchStart(matchStartSeconds, validation.ordered);
    if (startError) { res.status(400).json({ error: startError }); return; }

    // One active job per target recording. Two runs writing bundles to the same
    // recording would race, and the loser's work is thrown away silently.
    const [existing] = await db
      .select({ id: analysisJobsTable.id, status: analysisJobsTable.status })
      .from(analysisJobsTable)
      .where(and(
        eq(analysisJobsTable.recordingId, recordingId),
        inArray(analysisJobsTable.status, ACTIVE_STATUSES),
      ));
    if (existing) {
      res.status(409).json({
        error: `Analysis job #${existing.id} for this recording is already ${existing.status}. Cancel it first.`,
        jobId: existing.id,
      });
      return;
    }

    const [job] = await db
      .insert(analysisJobsTable)
      .values({
        recordingId,
        sourceRecordingIds: sourceIds,
        matchStartSeconds: Math.max(0, matchStartSeconds),
        params: normaliseParams(body.params),
        createdBy: adminId,
      })
      .returning();
    logger.info({ jobId: job.id, adminId, sourceIds }, "Analysis job queued");
    const [view] = await viewJobs([job]);
    res.status(201).json(view);
  } catch (error) {
    if (isMissingAnalysisSchema(error)) { res.status(503).json({ error: SCHEMA_MISSING }); return; }
    logger.error({ err: error }, "Could not queue the analysis job");
    res.status(500).json({ error: "Could not queue the analysis job." });
  }
});

/** GET /admin/analysis-jobs — the queue plus the workstation's health. */
router.get("/admin/analysis-jobs", async (req, res): Promise<void> => {
  const adminId = await requireAdmin(req);
  if (!adminId) { unauthenticatedResponse(res, req); return; }
  const now = new Date();
  try {
    await sweepStaleJobs(now);
    const rows = await db
      .select()
      .from(analysisJobsTable)
      .orderBy(desc(analysisJobsTable.createdAt))
      .limit(100);
    const workers = await db.select().from(analysisWorkersTable);
    res.json({
      schemaReady: true,
      jobs: await viewJobs(rows),
      workers: workers.map((worker) => ({
        ...worker,
        online: isWorkerOnline(worker.lastSeenAt, now),
      })),
      staleAfterMinutes: Math.round(STALE_HEARTBEAT_MS / 60000),
      maxAttempts: MAX_ATTEMPTS,
    });
  } catch (error) {
    if (isMissingAnalysisSchema(error)) {
      res.json({ schemaReady: false, jobs: [], workers: [], message: SCHEMA_MISSING });
      return;
    }
    logger.error({ err: error }, "Could not read the analysis queue");
    res.status(500).json({ error: "Could not read the analysis queue." });
  }
});

/** GET /admin/analysis-jobs/recordings — what can be analysed, newest first. */
router.get("/admin/analysis-jobs/recordings", async (req, res): Promise<void> => {
  const adminId = await requireAdmin(req);
  if (!adminId) { unauthenticatedResponse(res, req); return; }
  const rows = await db
    .select({
      id: recordingsTable.id,
      fieldId: recordingsTable.fieldId,
      fieldName: fieldsTable.name,
      court: recordingsTable.court,
      date: recordingsTable.date,
      timeSlot: recordingsTable.timeSlot,
      duration: recordingsTable.duration,
      videoUrl: recordingsTable.videoUrl,
    })
    .from(recordingsTable)
    .leftJoin(fieldsTable, eq(fieldsTable.id, recordingsTable.fieldId))
    .orderBy(desc(recordingsTable.date), desc(recordingsTable.timeSlot))
    .limit(400);
  res.json(rows.filter((row) => !!row.videoUrl));
});

async function adminSetStatus(
  req: import("express").Request,
  res: import("express").Response,
  next: AnalysisJobStatus,
  extra: Partial<typeof analysisJobsTable.$inferInsert> = {},
): Promise<void> {
  const adminId = await requireAdmin(req);
  if (!adminId) { unauthenticatedResponse(res, req); return; }
  const id = parseId(req.params.id);
  if (!id) { res.status(400).json({ error: "Invalid job id" }); return; }
  const [job] = await db.select().from(analysisJobsTable).where(eq(analysisJobsTable.id, id));
  if (!job) { res.status(404).json({ error: "No such analysis job" }); return; }
  if (!canTransition(job.status, next)) {
    res.status(409).json({ error: `An analysis job that is ${job.status} cannot be set to ${next}.` });
    return;
  }
  const [updated] = await db
    .update(analysisJobsTable)
    .set({ status: next, updatedAt: new Date(), ...extra })
    .where(eq(analysisJobsTable.id, id))
    .returning();
  const [view] = await viewJobs([updated]);
  res.json(view);
}

router.post("/admin/analysis-jobs/:id/cancel", async (req, res) => {
  // workerId is deliberately left in place. It is the record of which machine
  // was running this when it was cancelled, and clearing it would also make the
  // worker's next heartbeat look like a heartbeat for somebody else's job -
  // which reads as "no such job" rather than "stop".
  await adminSetStatus(req, res, "cancelled", { finishedAt: new Date() });
});

router.post("/admin/analysis-jobs/:id/retry", async (req, res) => {
  await adminSetStatus(req, res, "queued", {
    workerId: null,
    claimedAt: null,
    heartbeatAt: null,
    startedAt: null,
    finishedAt: null,
    stage: null,
    progress: 0,
    error: null,
    attempts: 0,
  });
});

/* ----------------------------------------------------------------- worker -- */

/** POST /worker/analysis/ping — "I am here", whether or not there is work. */
router.post("/worker/analysis/ping", async (req, res): Promise<void> => {
  const workerId = requireWorker(req, res);
  if (!workerId) return;
  const version = typeof req.body?.version === "string" ? req.body.version.slice(0, 60) : null;
  const note = typeof req.body?.note === "string" ? req.body.note.slice(0, 400) : null;
  try {
    await db
      .insert(analysisWorkersTable)
      .values({ id: workerId, lastSeenAt: new Date(), status: "idle", version, note })
      .onConflictDoUpdate({
        target: analysisWorkersTable.id,
        set: { lastSeenAt: new Date(), version, note },
      });
    const [waiting] = await db
      .select({ count: sql<number>`count(*)` })
      .from(analysisJobsTable)
      .where(eq(analysisJobsTable.status, "queued"));
    res.json({ ok: true, queued: Number(waiting?.count ?? 0) });
  } catch (error) {
    if (isMissingAnalysisSchema(error)) { res.status(503).json({ error: SCHEMA_MISSING }); return; }
    throw error;
  }
});

/**
 * POST /worker/analysis/claim
 *
 * Takes the oldest waiting job, or answers that there is nothing to do.
 *
 * One statement, not a SELECT followed by an UPDATE. The inner SELECT takes
 * FOR UPDATE SKIP LOCKED so a second worker skips the row a first is claiming
 * rather than queueing behind it, and the outer UPDATE repeats `status =
 * 'queued'` so that even if the row changed between the two, only one caller
 * can come away with it. Splitting this into two round trips leaves a window
 * in which two machines both believe they own the job, and the cost of that
 * mistake is six GPU-hours run twice.
 */
router.post("/worker/analysis/claim", async (req, res): Promise<void> => {
  const workerId = requireWorker(req, res);
  if (!workerId) return;
  const now = new Date();
  try {
    await sweepStaleJobs(now);
    const result = await db.execute(sql`
      UPDATE analysis_jobs
         SET status = 'claimed',
             worker_id = ${workerId},
             claimed_at = ${now},
             heartbeat_at = ${now},
             started_at = ${now},
             error = NULL,
             attempts = attempts + 1,
             updated_at = ${now}
       WHERE id = (
             SELECT id FROM analysis_jobs
              WHERE status = 'queued'
              ORDER BY created_at ASC, id ASC
              LIMIT 1
              FOR UPDATE SKIP LOCKED
             )
         AND status = 'queued'
      RETURNING id, recording_id, source_recording_ids, match_start_seconds, params, attempts
    `);
    const claimedRow = (result.rows as Array<{
      id: number;
      recording_id: number;
      source_recording_ids: number[];
      match_start_seconds: number;
      params: Record<string, unknown>;
      attempts: number;
    }>)[0];
    const claimed = claimedRow
      ? {
          id: claimedRow.id,
          recordingId: claimedRow.recording_id,
          sourceRecordingIds: claimedRow.source_recording_ids,
          matchStartSeconds: Number(claimedRow.match_start_seconds),
          params: claimedRow.params,
          attempts: claimedRow.attempts,
        }
      : null;

    await db
      .insert(analysisWorkersTable)
      .values({
        id: workerId,
        lastSeenAt: now,
        status: claimed ? "busy" : "idle",
        currentJobId: claimed?.id ?? null,
      })
      .onConflictDoUpdate({
        target: analysisWorkersTable.id,
        set: { lastSeenAt: now, status: claimed ? "busy" : "idle", currentJobId: claimed?.id ?? null },
      });

    if (!claimed) { res.json({ job: null }); return; }
    const found = await loadSources(claimed.sourceRecordingIds);
    const byId = new Map(found.map((row) => [row.id, row]));
    logger.info({ jobId: claimed.id, workerId }, "Analysis job claimed");
    res.json({
      job: {
        id: claimed.id,
        recordingId: claimed.recordingId,
        matchStartSeconds: claimed.matchStartSeconds,
        params: claimed.params,
        attempts: claimed.attempts,
        sources: claimed.sourceRecordingIds
          .map((id) => byId.get(id))
          .filter((row): row is NonNullable<typeof row> => !!row)
          .map(describeSource),
      },
    });
  } catch (error) {
    if (isMissingAnalysisSchema(error)) { res.status(503).json({ error: SCHEMA_MISSING }); return; }
    logger.error({ err: error, workerId }, "Analysis claim failed");
    res.status(500).json({ error: "Could not claim a job." });
  }
});

async function jobHeldBy(id: number, workerId: string): Promise<AnalysisJobRow | null> {
  const [job] = await db.select().from(analysisJobsTable).where(eq(analysisJobsTable.id, id));
  if (!job) return null;
  return job.workerId === workerId ? job : null;
}

/** POST /worker/analysis/:id/heartbeat — stage, progress, still alive. */
router.post("/worker/analysis/:id/heartbeat", async (req, res): Promise<void> => {
  const workerId = requireWorker(req, res);
  if (!workerId) return;
  const id = parseId(req.params.id);
  if (!id) { res.status(400).json({ error: "Invalid job id" }); return; }
  const [job] = await db.select().from(analysisJobsTable).where(eq(analysisJobsTable.id, id));
  if (!job) { res.status(404).json({ error: "No such analysis job" }); return; }
  // Two ways a heartbeat should mean "put your tools down", and both answer the
  // same way so the worker needs one branch: the job has finished or been
  // cancelled underneath it, or it has been reclaimed and another machine is
  // now doing this work. Carrying on in either case duplicates six GPU-hours.
  if (job.workerId !== workerId || !canTransition(job.status, "running")) {
    res.json({
      job: { id: job.id, status: job.status },
      stop: true,
      reason: job.workerId !== workerId
        ? "Another worker holds this job now."
        : `The job is ${job.status}.`,
    });
    return;
  }
  const progress = Number(req.body?.progress);
  const [updated] = await db
    .update(analysisJobsTable)
    .set({
      status: "running",
      stage: typeof req.body?.stage === "string" ? req.body.stage.slice(0, 200) : job.stage,
      progress: Number.isFinite(progress) ? Math.min(100, Math.max(0, progress)) : job.progress,
      heartbeatAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(analysisJobsTable.id, id))
    .returning();
  await db
    .update(analysisWorkersTable)
    .set({ lastSeenAt: new Date(), status: "busy", currentJobId: id })
    .where(eq(analysisWorkersTable.id, workerId));
  res.json({ job: { id: updated.id, status: updated.status }, stop: false });
});

/**
 * PUT /worker/analysis/:id/bundle
 *
 * The finished zip, for one of the job's source recordings. A match split over
 * several hourly recordings comes back as several bundles - the pipeline sees
 * one continuous match, the claim page plays one video - so this is called once
 * per source, and `recordingId` says which.
 *
 * It goes through exactly the same storeUploadBundle the manual admin upload
 * uses. A second path for machine uploads would be a second place for bundle
 * validation to drift.
 */
router.put("/worker/analysis/:id/bundle", bundleUploadSingle, async (req, res): Promise<void> => {
  const workerId = requireWorker(req, res);
  if (!workerId) return;
  const id = parseId(req.params.id);
  if (!id) { res.status(400).json({ error: "Invalid job id" }); return; }
  const job = await jobHeldBy(id, workerId);
  if (!job) { res.status(404).json({ error: "This worker does not hold that job" }); return; }
  if (job.status === "cancelled") { res.status(409).json({ error: "This job was cancelled." }); return; }

  const target = parseId((req.body as Record<string, unknown>)?.recordingId ?? job.recordingId);
  if (!target || !job.sourceRecordingIds.includes(target)) {
    res.status(400).json({ error: "recordingId must be one of the job's source recordings." });
    return;
  }
  if (!req.file?.buffer) { res.status(400).json({ error: "Attach the bundle zip as the 'bundle' field." }); return; }

  const parsed = parseZipBundleDetailed(req.file.buffer);
  if (!parsed.upload) { res.status(400).json({ error: parsed.error ?? "Invalid tracking bundle." }); return; }

  const overrideStart = Number((req.body as Record<string, unknown>)?.videoStartSeconds);
  if (Number.isFinite(overrideStart)) {
    parsed.upload.manifest.videoStartSeconds = Math.max(0, overrideStart);
  }

  try {
    const stored = await storeUploadBundle(target, job.createdBy ?? 0, parsed.upload);
    const landed = [...new Set([...job.bundleRecordingIds, target])];
    await db
      .update(analysisJobsTable)
      .set({ bundleRecordingIds: landed, heartbeatAt: new Date(), updatedAt: new Date() })
      .where(eq(analysisJobsTable.id, id));
    logger.info({ jobId: id, workerId, recordingId: target }, "Analysis worker stored a tracking bundle");
    res.json({ ok: true, recordingId: target, remaining: job.sourceRecordingIds.filter((s) => !landed.includes(s)), stored });
  } catch (error) {
    logger.error({ jobId: id, recordingId: target, err: error }, "Worker bundle upload failed");
    res.status(400).json({ error: (error as Error)?.message ?? "Could not store the bundle." });
  }
});

/** POST /worker/analysis/:id/complete */
router.post("/worker/analysis/:id/complete", async (req, res): Promise<void> => {
  const workerId = requireWorker(req, res);
  if (!workerId) return;
  const id = parseId(req.params.id);
  if (!id) { res.status(400).json({ error: "Invalid job id" }); return; }
  const job = await jobHeldBy(id, workerId);
  if (!job) { res.status(404).json({ error: "This worker does not hold that job" }); return; }
  if (!canTransition(job.status, "succeeded")) {
    res.status(409).json({ error: `A job that is ${job.status} cannot be completed.` });
    return;
  }
  if (job.bundleRecordingIds.length === 0) {
    // Success with no bundle is the failure mode this whole queue exists to
    // make visible: six GPU-hours, a green tick, and nothing to claim.
    res.status(400).json({ error: "No bundle was uploaded for this job, so it cannot be completed." });
    return;
  }
  const now = new Date();
  const [updated] = await db
    .update(analysisJobsTable)
    .set({ status: "succeeded", progress: 100, stage: "done", finishedAt: now, heartbeatAt: now, updatedAt: now, error: null })
    .where(eq(analysisJobsTable.id, id))
    .returning();
  await db
    .update(analysisWorkersTable)
    .set({ lastSeenAt: now, status: "idle", currentJobId: null })
    .where(eq(analysisWorkersTable.id, workerId));
  logger.info({ jobId: id, workerId, bundles: updated.bundleRecordingIds }, "Analysis job finished");
  res.json({ ok: true, job: { id: updated.id, status: updated.status } });
});

/** POST /worker/analysis/:id/fail */
router.post("/worker/analysis/:id/fail", async (req, res): Promise<void> => {
  const workerId = requireWorker(req, res);
  if (!workerId) return;
  const id = parseId(req.params.id);
  if (!id) { res.status(400).json({ error: "Invalid job id" }); return; }
  const job = await jobHeldBy(id, workerId);
  if (!job) { res.status(404).json({ error: "This worker does not hold that job" }); return; }
  if (!canTransition(job.status, "failed")) {
    res.json({ ok: true, job: { id: job.id, status: job.status } });
    return;
  }
  const message = String(req.body?.error ?? "The workstation reported a failure.").slice(0, 2000);
  const now = new Date();
  // Under the attempt limit it goes back to the queue, so a transient failure -
  // a dropped download, a busy GPU - is retried without an operator noticing.
  const retry = job.attempts < MAX_ATTEMPTS;
  const [updated] = await db
    .update(analysisJobsTable)
    .set(retry
      ? { status: "queued", workerId: null, claimedAt: null, heartbeatAt: null, stage: null, error: message, updatedAt: now }
      : { status: "failed", error: message, finishedAt: now, updatedAt: now })
    .where(eq(analysisJobsTable.id, id))
    .returning();
  await db
    .update(analysisWorkersTable)
    .set({ lastSeenAt: now, status: "idle", currentJobId: null })
    .where(eq(analysisWorkersTable.id, workerId));
  logger.warn({ jobId: id, workerId, retry, message }, "Analysis job reported a failure");
  res.json({ ok: true, job: { id: updated.id, status: updated.status }, willRetry: retry });
});

export default router;
