import { Router, type IRouter } from "express";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import {
  db,
  claimMatchIdentityBindingsTable,
  claimMatchOffPitchSpansTable,
  recordingTrackingBundlesTable,
  recordingsTable,
  usersTable,
} from "@workspace/db";
import { getLocalAccountUserId, unauthenticatedResponse } from "../lib/clerkUserBridge";
import { isRecordingVisible } from "../lib/recordingVisibility";

export type OffPitchSpan = {
  fromSeconds: number;
  toSeconds: number;
};

function finite(value: number): boolean {
  return Number.isFinite(value);
}

/**
 * Clamp, discard empty/invalid intervals, sort, and merge overlapping or
 * touching spans. All values remain in tracking-time seconds.
 */
export function normaliseOffPitchSpans(
  spans: readonly OffPitchSpan[],
  duration: number,
): OffPitchSpan[] {
  const safeDuration = Math.max(0, finite(duration) ? duration : 0);
  const sorted = spans
    .filter((span) => finite(span.fromSeconds) && finite(span.toSeconds))
    .map((span) => ({
      fromSeconds: Math.max(0, Math.min(safeDuration, span.fromSeconds)),
      toSeconds: Math.max(0, Math.min(safeDuration, span.toSeconds)),
    }))
    .filter((span) => span.toSeconds > span.fromSeconds)
    .sort((a, b) => a.fromSeconds - b.fromSeconds || a.toSeconds - b.toSeconds);
  const merged: OffPitchSpan[] = [];
  for (const span of sorted) {
    const previous = merged.at(-1);
    if (!previous || span.fromSeconds > previous.toSeconds) {
      merged.push({ ...span });
    } else {
      previous.toSeconds = Math.max(previous.toSeconds, span.toSeconds);
    }
  }
  return merged;
}

/**
 * Remove excluded spans from a set of half-open tracking-time intervals.
 * The returned intervals use the same field names as off-pitch spans so the
 * function can also be used for coverage, attribution, and metric windows.
 */
export function subtractSpans(
  spans: readonly OffPitchSpan[],
  excluded: readonly OffPitchSpan[],
): OffPitchSpan[] {
  const exclusions = [...excluded]
    .filter((span) => finite(span.fromSeconds) && finite(span.toSeconds) && span.toSeconds > span.fromSeconds)
    .sort((a, b) => a.fromSeconds - b.fromSeconds || a.toSeconds - b.toSeconds);
  const result: OffPitchSpan[] = [];
  for (const source of spans) {
    if (!finite(source.fromSeconds) || !finite(source.toSeconds) || source.toSeconds <= source.fromSeconds) continue;
    let cursor = source.fromSeconds;
    for (const blocked of exclusions) {
      if (blocked.toSeconds <= cursor) continue;
      if (blocked.fromSeconds >= source.toSeconds) break;
      if (blocked.fromSeconds > cursor) {
        result.push({ fromSeconds: cursor, toSeconds: Math.min(blocked.fromSeconds, source.toSeconds) });
      }
      cursor = Math.max(cursor, blocked.toSeconds);
      if (cursor >= source.toSeconds) break;
    }
    if (cursor < source.toSeconds) result.push({ fromSeconds: cursor, toSeconds: source.toSeconds });
  }
  return result;
}

export function totalSeconds(spans: readonly OffPitchSpan[]): number {
  return Math.round(
    spans
      .filter((span) => finite(span.fromSeconds) && finite(span.toSeconds) && span.toSeconds > span.fromSeconds)
      .reduce((total, span) => total + span.toSeconds - span.fromSeconds, 0) * 100,
  ) / 100;
}

/**
 * Return the existing spans that overlap a candidate by a positive amount.
 * Touching endpoints are not conflicts.
 */
export function offPitchConflicts(
  spans: readonly OffPitchSpan[],
  candidate: OffPitchSpan,
): OffPitchSpan[] {
  return spans.filter((span) =>
    finite(span.fromSeconds)
    && finite(span.toSeconds)
    && span.toSeconds > span.fromSeconds
    && candidate.toSeconds > span.fromSeconds
    && candidate.fromSeconds < span.toSeconds,
  );
}

const router: IRouter = Router();
const offPitchBody = z.object({
  clientId: z.string().min(1),
  fromSeconds: z.number().finite(),
  toSeconds: z.number().finite(),
  confirmConflict: z.boolean().optional(),
});

function parseId(value: string | string[]): number | null {
  const raw = Array.isArray(value) ? value[0] : value;
  const id = Number.parseInt(raw, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

async function requireAccountUser(req: Parameters<typeof getLocalAccountUserId>[0]): Promise<number | null> {
  const userId = await getLocalAccountUserId(req);
  if (!userId) return null;
  const [user] = await db
    .select({ id: usersTable.id, isGuest: usersTable.isGuest })
    .from(usersTable)
    .where(eq(usersTable.id, userId));
  return user && !user.isGuest ? user.id : null;
}

async function getVisibleBundle(recordingId: number) {
  const [row] = await db
    .select({ recording: recordingsTable, bundle: recordingTrackingBundlesTable })
    .from(recordingsTable)
    .leftJoin(recordingTrackingBundlesTable, eq(recordingTrackingBundlesTable.recordingId, recordingsTable.id))
    .where(eq(recordingsTable.id, recordingId));
  if (!row || !row.bundle || !(await isRecordingVisible(row.recording))) return null;
  return row;
}

function toResponse(row: typeof claimMatchOffPitchSpansTable.$inferSelect) {
  return {
    id: row.id,
    clientId: row.clientId,
    fromSeconds: row.fromSeconds,
    toSeconds: row.toSeconds,
    createdAt: row.createdAt.toISOString(),
  };
}

router.post("/recordings/:id/claim-match/off-pitch", async (req, res): Promise<void> => {
  const userId = await requireAccountUser(req);
  if (!userId) {
    unauthenticatedResponse(res, req, "Authenticated account required");
    return;
  }
  const recordingId = parseId(req.params.id);
  const body = offPitchBody.safeParse(req.body);
  if (!recordingId || !body.success) {
    res.status(400).json({ error: body.success ? "Invalid recording id" : body.error.message });
    return;
  }
  const row = await getVisibleBundle(recordingId);
  if (!row?.bundle?.manifest) {
    res.status(404).json({ error: "Recording or tracking bundle not found" });
    return;
  }
  const bundle = row.bundle;

  const [existing] = await db
    .select()
    .from(claimMatchOffPitchSpansTable)
    .where(and(
      eq(claimMatchOffPitchSpansTable.userId, userId),
      eq(claimMatchOffPitchSpansTable.recordingId, recordingId),
      eq(claimMatchOffPitchSpansTable.clientId, body.data.clientId),
    ));
  if (existing) {
    res.status(200).json(toResponse(existing));
    return;
  }

  if (body.data.fromSeconds < 0 || body.data.toSeconds <= body.data.fromSeconds) {
    res.status(400).json({ error: "Off-pitch span must have a positive duration inside tracking time" });
    return;
  }
  const duration = Math.max(bundle.manifest.duration, 0);
  const [candidate] = normaliseOffPitchSpans([body.data], duration);
  if (!candidate) {
    res.status(400).json({ error: "Off-pitch span does not intersect the tracked duration" });
    return;
  }

  const bindings = await db
    .select({
      id: claimMatchIdentityBindingsTable.id,
      userId: claimMatchIdentityBindingsTable.userId,
      personId: claimMatchIdentityBindingsTable.personId,
      vouchedFragments: claimMatchIdentityBindingsTable.vouchedFragments,
    })
    .from(claimMatchIdentityBindingsTable)
    .where(eq(claimMatchIdentityBindingsTable.recordingId, recordingId));
  const conflicts = bindings.flatMap((binding) => {
    const owned = (binding.vouchedFragments ?? []).map((fragment) => ({
      fromSeconds: fragment.fromFrame / Math.max(bundle.manifest.frameRate, 0.001),
      toSeconds: (fragment.toFrame + 1) / Math.max(bundle.manifest.frameRate, 0.001),
    }));
    return offPitchConflicts(owned, candidate).map((span) => ({
      bindingId: binding.id,
      userId: binding.userId,
      personId: binding.personId,
      fromSeconds: span.fromSeconds,
      toSeconds: span.toSeconds,
    }));
  });
  if (conflicts.length > 0 && !body.data.confirmConflict) {
    res.status(409).json({
      error: "off-pitch-conflict",
      message: "This period overlaps vouched identity fragments. Confirm the conflict explicitly before saving it.",
      conflicts,
      requiresExplicitConflictRelease: true,
    });
    return;
  }

  const [created] = await db
    .insert(claimMatchOffPitchSpansTable)
    .values({
      userId,
      recordingId,
      clientId: body.data.clientId,
      fromSeconds: candidate.fromSeconds,
      toSeconds: candidate.toSeconds,
    })
    .returning();
  res.status(201).json(toResponse(created));
});

router.delete("/recordings/:id/claim-match/off-pitch/:clientId", async (req, res): Promise<void> => {
  const userId = await requireAccountUser(req);
  if (!userId) {
    unauthenticatedResponse(res, req, "Authenticated account required");
    return;
  }
  const recordingId = parseId(req.params.id);
  const clientId = Array.isArray(req.params.clientId) ? req.params.clientId[0] : req.params.clientId;
  if (!recordingId || !clientId) {
    res.status(400).json({ error: "Invalid off-pitch span id" });
    return;
  }
  const [existing] = await db
    .select()
    .from(claimMatchOffPitchSpansTable)
    .where(and(
      eq(claimMatchOffPitchSpansTable.userId, userId),
      eq(claimMatchOffPitchSpansTable.recordingId, recordingId),
      eq(claimMatchOffPitchSpansTable.clientId, clientId),
    ));
  if (!existing) {
    res.status(404).json({ error: "Off-pitch span not found" });
    return;
  }
  await db
    .delete(claimMatchOffPitchSpansTable)
    .where(eq(claimMatchOffPitchSpansTable.id, existing.id));
  res.json({ deleted: true, clientId });
});

export default router;