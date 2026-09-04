import { timingSafeEqual } from "node:crypto";
import type { AnalysisJobParams, AnalysisJobStatus } from "@workspace/db";

/**
 * The analysis queue's rules, with no database in them.
 *
 * Everything here is a decision the queue has to make - is this job still
 * alive, may this transition happen, what does the worker need in order to
 * fetch the footage - and every one of them is a decision that is much easier
 * to get wrong than to test. The route module does the SQL; this module says
 * what the SQL should be doing.
 */

/**
 * How long a claimed job may go without a heartbeat before it is treated as
 * abandoned and offered to the next worker.
 *
 * Fifteen minutes is not a guess about network jitter - the worker heartbeats
 * every thirty seconds, so a fifteen-minute silence is a machine that has
 * rebooted, slept, or been killed. It is deliberately far longer than a stage
 * boundary: the pipeline spends nearly an hour inside a single chunk, and a
 * job reclaimed from a worker that is still grinding away would be run twice.
 */
export const STALE_HEARTBEAT_MS = 15 * 60 * 1000;

/**
 * A job that has failed this many times stays failed. Without this, a job that
 * kills the worker on load - a corrupt source, an out-of-memory model - would
 * be handed to the machine again the moment it came back, forever.
 */
export const MAX_ATTEMPTS = 3;

/** How long since a ping before the console should call the workstation offline. */
export const WORKER_OFFLINE_MS = 3 * 60 * 1000;

export const ACTIVE_STATUSES: AnalysisJobStatus[] = ["queued", "claimed", "running"];

export function isActiveStatus(status: AnalysisJobStatus): boolean {
  return ACTIVE_STATUSES.includes(status);
}

export function isTerminalStatus(status: AnalysisJobStatus): boolean {
  return !isActiveStatus(status);
}

/**
 * Which transitions are legal. Written out rather than inferred, because the
 * interesting cases are the ones that must NOT happen: a cancelled job must
 * never come back to life when a worker that was mid-run reports progress, and
 * a succeeded job must never be reopened by a late heartbeat from the worker
 * that produced it.
 */
const ALLOWED: Record<AnalysisJobStatus, AnalysisJobStatus[]> = {
  queued: ["claimed", "cancelled", "failed"],
  claimed: ["running", "queued", "failed", "cancelled", "succeeded"],
  running: ["running", "succeeded", "failed", "queued", "cancelled"],
  succeeded: [],
  failed: ["queued"],
  cancelled: ["queued"],
};

export function canTransition(from: AnalysisJobStatus, to: AnalysisJobStatus): boolean {
  return ALLOWED[from]?.includes(to) ?? false;
}

export type ReclaimCandidate = {
  id: number;
  status: AnalysisJobStatus;
  attempts: number;
  heartbeatAt: Date | null;
  claimedAt: Date | null;
};

export type ReclaimDecision =
  | { action: "requeue"; reason: string }
  | { action: "fail"; reason: string }
  | { action: "leave" };

/**
 * What to do with a job whose worker has gone quiet.
 *
 * The distinction that matters: a job under its attempt limit goes back to the
 * queue, and a job that has already burned its attempts is failed with a
 * message that says so. Silently requeuing forever looks identical, from the
 * console, to a queue that is working.
 */
export function reclaimDecision(job: ReclaimCandidate, now: Date): ReclaimDecision {
  if (job.status !== "claimed" && job.status !== "running") return { action: "leave" };
  const last = job.heartbeatAt ?? job.claimedAt;
  if (!last) return { action: "leave" };
  const silentFor = now.getTime() - last.getTime();
  if (silentFor < STALE_HEARTBEAT_MS) return { action: "leave" };
  const minutes = Math.round(silentFor / 60000);
  if (job.attempts >= MAX_ATTEMPTS) {
    return {
      action: "fail",
      reason: `The workstation stopped reporting ${minutes} minutes ago, after ${job.attempts} attempts. Not retrying again.`,
    };
  }
  return {
    action: "requeue",
    reason: `The workstation stopped reporting ${minutes} minutes ago; the job went back in the queue.`,
  };
}

export function isWorkerOnline(lastSeenAt: Date | null | undefined, now: Date): boolean {
  if (!lastSeenAt) return false;
  return now.getTime() - lastSeenAt.getTime() < WORKER_OFFLINE_MS;
}

/**
 * Constant-time comparison of the worker key. The worker key is a bearer
 * secret on an endpoint that hands out work and accepts bundles, so it gets
 * the same treatment as a password: no early return on the first wrong byte,
 * and no comparison at all when the server has not been given a key, because
 * an unset key must never mean "everything matches".
 */
export function workerKeyMatches(expected: string, provided: unknown): boolean {
  if (!expected) return false;
  if (typeof provided !== "string" || provided.length === 0) return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export type SourceRecordingInput = {
  id: number;
  court: string | null;
  date: string | null;
  timeSlot: string | null;
  duration: string | null;
  videoUrl: string | null;
};

export type SourceDescriptor = {
  recordingId: number;
  /** Bunny Stream video guid, pulled out of the playback URL. */
  videoGuid: string | null;
  videoUrl: string;
  /**
   * The Bunny Stream title this recording was imported under, rebuilt from the
   * columns the import wrote it from. The workstation's existing fetch path
   * takes a title, so handing it one keeps that path unchanged.
   */
  title: string | null;
  durationSeconds: number | null;
};

/**
 * Bunny playback URLs are `https://<cdn>/<guid>/playlist.m3u8`. The guid is the
 * only durable handle on the video, so it is extracted once here rather than
 * re-parsed by every consumer.
 */
export function bunnyGuidFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const match = /^https?:\/\/[^/]+\/([0-9a-f-]{36})\//i.exec(url);
  return match ? match[1] : null;
}

/** "12:34" and "1:02:03" both appear in this column, and so does "". */
export function durationToSeconds(duration: string | null | undefined): number | null {
  if (!duration) return null;
  const parts = duration.split(":").map((part) => Number.parseInt(part, 10));
  if (parts.some((part) => !Number.isFinite(part))) return null;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

export function bunnyTitleFor(recording: SourceRecordingInput): string | null {
  if (!recording.court || !recording.date || !recording.timeSlot) return null;
  return `${recording.court}_${recording.date}_${recording.timeSlot}`;
}

export function describeSource(recording: SourceRecordingInput): SourceDescriptor {
  return {
    recordingId: recording.id,
    videoGuid: bunnyGuidFromUrl(recording.videoUrl),
    videoUrl: recording.videoUrl ?? "",
    title: bunnyTitleFor(recording),
    durationSeconds: durationToSeconds(recording.duration),
  };
}

export type SourceValidation =
  | { ok: true; ordered: SourceDescriptor[] }
  | { ok: false; error: string };

/**
 * Resolve the requested ids against what the database actually returned, in the
 * order the operator asked for.
 *
 * The order is taken from the request and never from the query result. This is
 * the whole reason the function exists: `WHERE id IN (...)` returns rows in
 * whatever order Postgres finds convenient, and an operator who picks the 21:00
 * hour before the 20:00 hour - because that is when the match started - would
 * otherwise silently get them the other way round.
 */
export function validateSources(
  requestedIds: number[],
  found: SourceRecordingInput[],
): SourceValidation {
  if (requestedIds.length === 0) {
    return { ok: false, error: "Choose at least one recording to analyse." };
  }
  const seen = new Set<number>();
  for (const id of requestedIds) {
    if (seen.has(id)) {
      return { ok: false, error: `Recording ${id} is listed twice. Each recording can only appear once.` };
    }
    seen.add(id);
  }
  const byId = new Map(found.map((row) => [row.id, row]));
  const missing = requestedIds.filter((id) => !byId.has(id));
  if (missing.length) {
    return { ok: false, error: `No such recording: ${missing.join(", ")}.` };
  }
  const ordered = requestedIds.map((id) => describeSource(byId.get(id)!));
  const withoutVideo = ordered.filter((source) => !source.videoUrl);
  if (withoutVideo.length) {
    return {
      ok: false,
      error: `These recordings have no video to analyse: ${withoutVideo.map((s) => s.recordingId).join(", ")}.`,
    };
  }
  return { ok: true, ordered };
}

/**
 * The match start has to land inside the footage. A kick-off past the end of
 * the concatenated source produces a bundle whose every box is drawn against
 * nothing, hours later, with no error anywhere.
 */
export function validateMatchStart(
  matchStartSeconds: number,
  sources: SourceDescriptor[],
): string | null {
  if (!Number.isFinite(matchStartSeconds) || matchStartSeconds < 0) {
    return "The match start must be zero or more seconds into the first recording.";
  }
  const known = sources.filter((source) => source.durationSeconds !== null);
  if (known.length !== sources.length) return null; // unknown lengths: trust the operator
  const total = known.reduce((sum, source) => sum + (source.durationSeconds ?? 0), 0);
  if (matchStartSeconds >= total) {
    return `The match start (${Math.round(matchStartSeconds)}s) is past the end of the selected footage (${Math.round(total)}s).`;
  }
  return null;
}

export function normaliseParams(input: unknown): AnalysisJobParams {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const params = { ...(input as Record<string, unknown>) } as AnalysisJobParams;
  if (params.chunkSeconds !== undefined) {
    const value = Number(params.chunkSeconds);
    if (!Number.isFinite(value) || value < 60 || value > 3600) {
      delete params.chunkSeconds;
    } else {
      params.chunkSeconds = Math.round(value);
    }
  }
  if (params.maxChunks !== undefined) {
    const value = Number(params.maxChunks);
    if (!Number.isFinite(value) || value < 1 || value > 64) {
      delete params.maxChunks;
    } else {
      params.maxChunks = Math.round(value);
    }
  }
  return params;
}

/**
 * Queue position, one-based, counting only jobs still waiting. A running job is
 * position 0 - it is not waiting for anything.
 */
export function queuePosition(
  job: { id: number; status: AnalysisJobStatus },
  queuedIdsOldestFirst: number[],
): number | null {
  if (job.status !== "queued") return null;
  const index = queuedIdsOldestFirst.indexOf(job.id);
  return index === -1 ? null : index + 1;
}
