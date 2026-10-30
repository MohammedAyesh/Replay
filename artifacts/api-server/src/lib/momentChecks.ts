import { and, eq } from "drizzle-orm";
import { db, claimMomentChecksTable } from "@workspace/db";
import type { ClaimedPart } from "./matchPlay";
import { isMissingRelationError } from "./settings";

export type MomentVerdict = "yes" | "no" | "skip";
export type MomentCheck = { verdict: MomentVerdict; cut: ClaimedPart | null };

/** One claimant's "Is this you?" answers on a recording, by moment id. Empty before the table exists. */
export async function momentChecksFor(userId: number, recordingId: number): Promise<Map<string, MomentCheck>> {
  const out = new Map<string, MomentCheck>();
  try {
    const rows = await db.select().from(claimMomentChecksTable).where(and(
      eq(claimMomentChecksTable.userId, userId),
      eq(claimMomentChecksTable.recordingId, recordingId),
    ));
    for (const r of rows) {
      if (r.verdict !== "yes" && r.verdict !== "no" && r.verdict !== "skip") continue;
      const cut = r.verdict === "no" && r.trackId && r.fromFrame !== null && r.toFrame !== null
        ? { trackId: r.trackId, fromFrame: r.fromFrame, toFrame: r.toFrame }
        : null;
      out.set(r.momentId, { verdict: r.verdict, cut });
    }
  } catch (error) {
    // The table arrives with migration 0039; until then nobody has answered.
    // Any other failure must not read as "no answers": a claim re-sync would
    // then drop his "not me" cuts and bring back held-back moments.
    if (!isMissingRelationError(error)) throw error;
  }
  return out;
}

export async function saveMomentCheck(userId: number, recordingId: number, momentId: string, verdict: MomentVerdict, cut: ClaimedPart | null): Promise<void> {
  const values = {
    userId, recordingId, momentId, verdict,
    trackId: cut?.trackId ?? null, fromFrame: cut?.fromFrame ?? null, toFrame: cut?.toFrame ?? null,
  };
  await db.insert(claimMomentChecksTable).values(values).onConflictDoUpdate({
    target: [claimMomentChecksTable.userId, claimMomentChecksTable.recordingId, claimMomentChecksTable.momentId],
    set: { verdict, trackId: values.trackId, fromFrame: values.fromFrame, toFrame: values.toFrame, updatedAt: new Date() },
  });
}

/**
 * Forget one claimant's "Is this you?" answers on a recording.
 *
 * Called by Start over. A "Not me" is stored as a cut that every later save
 * re-applies, so without this a mis-swipe would still cut the new claim, and a
 * goal the player wrongly turned down could never come back.
 */
export async function clearMomentChecks(userId: number, recordingId: number): Promise<void> {
  try {
    await db.delete(claimMomentChecksTable).where(and(
      eq(claimMomentChecksTable.userId, userId),
      eq(claimMomentChecksTable.recordingId, recordingId),
    ));
  } catch (error) {
    // Before migration 0039 there is nothing to forget.
    if (!isMissingRelationError(error)) throw error;
  }
}
