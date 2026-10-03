/**
 * PATCH /admin/recordings/:id/match-window
 *
 * Tell Replay where the match is on a recording: "this match starts at
 * 1460 s" when the previous booking's game ran over into the footage
 * (recording 392). Body `{ startSeconds: number|null, endSeconds?: number|null,
 * why?: string }`, tracking-clock seconds; `startSeconds: null` clears it.
 *
 * The window is written to manifest.provenance.matchWindow (lib/matchWindow.ts
 * says what reads it). Provenance is outside trackingBundleFingerprint, so
 * this never invalidates a claim, an identity map or a client's saved state.
 * After the write every cache that summed the old window is dropped and every
 * claim on the recording is re-derived.
 */
import { Router, type IRouter } from "express";
import { eq, sql } from "drizzle-orm";
import {
  SetRecordingMatchWindowBody,
  SetRecordingMatchWindowParams,
  SetRecordingMatchWindowResponse,
} from "@workspace/api-zod";
import { db, recordingTrackingBundlesTable, usersTable, type TrackingManifest } from "@workspace/db";

import { getLocalUserId } from "../lib/clerkUserBridge";
import { playCache } from "../lib/matchPlayLoad";
import { invalidateMatchStatsCacheForRecording } from "../lib/matchStatsCache";
import { queueMatchStatsCacheForRecording } from "../lib/matchStatsCacheJobs";
import { parseStoredMatchWindow, type StoredMatchWindow } from "../lib/matchWindow";
import { logger } from "../lib/logger";
import { resyncChainClaimsForRecording } from "./claimChain";

const router: IRouter = Router();

async function requireAdmin(req: Parameters<typeof getLocalUserId>[0]): Promise<number | null> {
  const userId = await getLocalUserId(req);
  if (!userId) return null;
  const [user] = await db
    .select({ id: usersTable.id, isAdmin: usersTable.isAdmin })
    .from(usersTable)
    .where(eq(usersTable.id, userId));
  return user?.isAdmin ? user.id : null;
}

class WindowError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** The window an admin asked for, checked against the bundle's duration. Null clears. */
export function adminMatchWindow(
  body: { startSeconds: number | null; endSeconds?: number | null; why?: string },
  duration: number,
  adminId: number,
  now = new Date(),
): StoredMatchWindow | null {
  if (body.startSeconds === null) return null;
  const start = body.startSeconds;
  const end = body.endSeconds ?? null;
  if (!Number.isFinite(start) || start < 0) throw new WindowError(400, "startSeconds must be 0 or more");
  if (!Number.isFinite(duration) || duration <= 0) throw new WindowError(400, "This bundle has no usable duration");
  if (start >= duration) throw new WindowError(400, `startSeconds must be before the end of the tracked footage (${duration} s)`);
  if (end !== null) {
    if (!Number.isFinite(end) || end <= start) throw new WindowError(400, "endSeconds must be after startSeconds");
    if (end > duration) throw new WindowError(400, `endSeconds must be at most the tracked duration (${duration} s)`);
  }
  const why = body.why?.trim();
  return {
    startSeconds: start,
    endSeconds: end,
    source: "admin",
    setBy: adminId,
    setAt: now.toISOString(),
    ...(why ? { why } : {}),
  };
}

router.patch("/admin/recordings/:id/match-window", async (req, res): Promise<void> => {
  const adminId = await requireAdmin(req);
  if (!adminId) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const params = SetRecordingMatchWindowParams.safeParse(req.params);
  if (!params.success || !Number.isSafeInteger(params.data.id) || params.data.id <= 0) {
    res.status(400).json({ error: "Invalid recording id" });
    return;
  }
  const recordingId = params.data.id;
  const body = SetRecordingMatchWindowBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  let saved: { manifest: TrackingManifest; updatedAt: Date } | null;
  try {
    // Read-modify-write of the one manifest blob every claim also rewrites:
    // lock the row and re-read inside the lock, as claimChain's writers do,
    // or a claimant's tap landing between our read and write would be lost.
    saved = await db.transaction(async (tx) => {
      const [found] = await tx
        .select({ id: recordingTrackingBundlesTable.id })
        .from(recordingTrackingBundlesTable)
        .where(eq(recordingTrackingBundlesTable.recordingId, recordingId));
      if (!found) return null;
      await tx.execute(sql`select id from ${recordingTrackingBundlesTable} where id = ${found.id} for update`);
      const [bundle] = await tx
        .select({ id: recordingTrackingBundlesTable.id, manifest: recordingTrackingBundlesTable.manifest })
        .from(recordingTrackingBundlesTable)
        .where(eq(recordingTrackingBundlesTable.id, found.id));
      if (!bundle) return null;
      const window = adminMatchWindow(body.data, bundle.manifest.duration, adminId);
      const { matchWindow: _previous, ...provenance } = bundle.manifest.provenance ?? {};
      const manifest: TrackingManifest = {
        ...bundle.manifest,
        provenance: { ...provenance, ...(window ? { matchWindow: window } : {}) },
      };
      // updatedAt moves so every manifest-keyed cache (the play cache, the
      // claim segment cache) reloads; the fingerprint, built from tracks
      // alone, does not move, so no claim or saved page state goes stale.
      const [row] = await tx
        .update(recordingTrackingBundlesTable)
        .set({ manifest, updatedAt: new Date() })
        .where(eq(recordingTrackingBundlesTable.id, bundle.id))
        .returning({ manifest: recordingTrackingBundlesTable.manifest, updatedAt: recordingTrackingBundlesTable.updatedAt });
      return row ?? null;
    });
  } catch (error) {
    if (error instanceof WindowError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    throw error;
  }
  if (!saved) {
    res.status(404).json({ error: "Tracking bundle not found" });
    return;
  }

  playCache.delete(recordingId);
  await invalidateMatchStatsCacheForRecording(recordingId);
  let resyncedClaims = 0;
  try {
    resyncedClaims = await resyncChainClaimsForRecording(req, recordingId);
  } catch (error) {
    logger.warn({ recordingId, err: error }, "Could not re-derive claims after a match window change");
  }
  queueMatchStatsCacheForRecording(recordingId);

  const stored = parseStoredMatchWindow(saved.manifest.provenance?.matchWindow);
  logger.info({
    recordingId,
    adminId,
    matchWindow: stored,
    resyncedClaims,
  }, "Recording match window changed");
  res.json(SetRecordingMatchWindowResponse.parse({
    recordingId,
    duration: saved.manifest.duration,
    matchWindow: stored
      ? { ...stored, endSeconds: stored.endSeconds ?? null }
      : null,
    resyncedClaims,
    updatedAt: saved.updatedAt.toISOString(),
  }));
});

export default router;
