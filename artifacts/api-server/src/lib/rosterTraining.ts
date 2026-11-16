import { desc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db, recordingTrackingBundlesTable } from "@workspace/db";
import { readClaimSegment, writeClaimSegment } from "./claimMatchStorage";

/**
 * Give a recording's latest analysis the training block (kit groups, timeline, drills and games)
 * that the pipeline computed afterwards on the CPU, without re-running the analysis. Only the
 * roster file's `training` entry changes; players, tracks and every saved link stay as they are.
 * The previous roster file is kept in storage and returned, so it can be put back.
 */
export async function attachRosterTraining(recordingId: number, training: Record<string, unknown>): Promise<
  { ok: true; bundleId: number; matchRosterPath: string; previousMatchRosterPath: string | null } | { ok: false; status: number; error: string }
> {
  const [bundle] = await db.select({ id: recordingTrackingBundlesTable.id, manifest: recordingTrackingBundlesTable.manifest })
    .from(recordingTrackingBundlesTable)
    .where(eq(recordingTrackingBundlesTable.recordingId, recordingId))
    .orderBy(desc(recordingTrackingBundlesTable.id))
    .limit(1);
  if (!bundle) return { ok: false, status: 404, error: "This recording has no analysis" };
  const previous = bundle.manifest.matchRosterPath ?? null;
  let roster: Record<string, unknown> = { v: 1, players: [] };
  if (previous) {
    try {
      roster = JSON.parse((await readClaimSegment(previous)).toString("utf8")) as Record<string, unknown>;
    } catch {
      return { ok: false, status: 502, error: "The analysis's roster could not be read" };
    }
  }
  const stored = await writeClaimSegment(`${recordingId}/${randomUUID()}-match-roster.json.gz`, { ...roster, training });
  await db.update(recordingTrackingBundlesTable)
    .set({ manifest: { ...bundle.manifest, matchRosterPath: stored.objectPath } })
    .where(eq(recordingTrackingBundlesTable.id, bundle.id));
  return { ok: true, bundleId: bundle.id, matchRosterPath: stored.objectPath, previousMatchRosterPath: previous };
}

/** The pipeline's training block must carry its drill/game split to be worth attaching. */
export function isTrainingBlock(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const t = value as Record<string, unknown>;
  return Array.isArray(t.segments) && Array.isArray(t.games) && t.segments.length <= 1000 && t.games.length <= 200
    && t.segments.every((s) => s && typeof s === "object" && Number.isFinite((s as { start: unknown }).start) && Number.isFinite((s as { end: unknown }).end) && typeof (s as { label: unknown }).label === "string");
}
