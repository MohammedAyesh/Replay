/**
 * Matches — public current-match lookup + admin CRUD + in-process scheduler.
 *
 * The scheduler ticks every 30 s (Asia/Amman).  When a match's scheduledStart
 * is reached it starts the camera1 live stream and marks the match live.  At
 * scheduledEnd it stops the stream (unless another match is still live on
 * camera1) and marks the match ended.
 *
 * VAR visibility is derived from the clock at request time, not from the
 * stored status column, so it stays correct even when the scheduler missed a
 * tick due to a Repl sleep.
 *
 * controlFetch returns a boolean: true = the control server acknowledged the
 * request (2xx) or the control URL is not configured (no-op).  The scheduler
 * only marks a match as fired / updates DB status on success; on failure the
 * match stays unfired so the next 30-s tick retries automatically.
 */
import { Router, type IRouter } from "express";
import { eq, and, lte, gte, ne } from "drizzle-orm";
import { z } from "zod";
import { db, fieldsTable, matchesTable, usersTable } from "@workspace/db";
import { getLocalUserId } from "../lib/clerkUserBridge";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// ── Auth helper (local copy — same pattern as admin, academies, contabo) ──────

async function requireAdmin(
  req: Parameters<typeof getLocalUserId>[0],
): Promise<number | null> {
  const userId = await getLocalUserId(req);
  if (!userId) return null;
  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, userId));
  if (!user?.isAdmin) return null;
  return userId;
}

// ── Control-API fetch helper (local copy — same structure as liveSchedules) ───
//
// Returns true when the call was not needed (control URL unconfigured) or when
// the server responded with a 2xx.  Returns false on network errors or non-2xx
// responses so the caller can decide whether to retry.

export async function controlFetch(
  path: string,
  opts: RequestInit = {},
): Promise<boolean> {
  let base = (process.env.CONTABO_CONTROL_URL ?? "").trim();
  if (base && !/^https?:\/\//i.test(base)) base = `http://${base}`;
  base = base.replace(/\/$/, "");
  if (!base) return true; // Not configured — silently skip, treat as success
  const key = process.env.CONTABO_CONTROL_KEY ?? "";
  try {
    const res = await fetch(`${base}${path}`, {
      ...opts,
      headers: {
        "Content-Type": "application/json",
        "X-Api-Key": key,
        ...((opts.headers as Record<string, string>) ?? {}),
      },
      signal: AbortSignal.timeout(10_000),
    });
    const body = await res.json().catch(() => null);
    logger.info(
      { path, status: res.status, body },
      "Matches: control fetch",
    );
    return res.ok;
  } catch (err) {
    logger.warn({ path, err }, "Matches: control fetch failed");
    return false;
  }
}

// ── Serialisation ─────────────────────────────────────────────────────────────

function matchToJson(m: typeof matchesTable.$inferSelect) {
  return {
    id: m.id,
    fieldId: m.fieldId,
    title: m.title,
    scheduledStart: m.scheduledStart.toISOString(),
    scheduledEnd: m.scheduledEnd.toISOString(),
    status: m.status,
    autoStartLive: m.autoStartLive,
    liveStartedAt: m.liveStartedAt?.toISOString() ?? null,
    liveStoppedAt: m.liveStoppedAt?.toISOString() ?? null,
    createdAt: m.createdAt.toISOString(),
  };
}

// ── Public endpoint ───────────────────────────────────────────────────────────

/**
 * GET /matches/current?collectionGuid=<guid>
 *
 * Returns { match, cameraId, varEnabled } for the given Bunny collection.
 * varEnabled is true only when cameraId === "camera1" AND now falls within a
 * non-cancelled match's scheduled window (clock-based, not from status column).
 * No authentication required.
 */
router.get("/matches/current", async (req, res): Promise<void> => {
  const collectionGuid =
    typeof req.query.collectionGuid === "string"
      ? req.query.collectionGuid
      : null;
  if (!collectionGuid) {
    res.status(400).json({ error: "collectionGuid is required" });
    return;
  }

  const [field] = await db
    .select()
    .from(fieldsTable)
    .where(eq(fieldsTable.bunnyGuid, collectionGuid));

  if (!field) {
    res.json({ match: null, cameraId: null, varEnabled: false });
    return;
  }

  const now = new Date();
  const [currentMatch] = await db
    .select()
    .from(matchesTable)
    .where(
      and(
        eq(matchesTable.fieldId, field.id),
        ne(matchesTable.status, "cancelled"),
        lte(matchesTable.scheduledStart, now),
        gte(matchesTable.scheduledEnd, now),
      ),
    )
    .limit(1);

  const cameraId = field.cameraId ?? null;
  const varEnabled = cameraId === "camera1" && !!currentMatch;

  res.json({
    match: currentMatch ? matchToJson(currentMatch) : null,
    cameraId,
    varEnabled,
  });
});

// ── Admin endpoints ───────────────────────────────────────────────────────────

router.get("/admin/matches", async (req, res): Promise<void> => {
  const adminId = await requireAdmin(req);
  if (!adminId) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const rows = await db
    .select({
      match: matchesTable,
      fieldName: fieldsTable.name,
      fieldCameraId: fieldsTable.cameraId,
    })
    .from(matchesTable)
    .innerJoin(fieldsTable, eq(matchesTable.fieldId, fieldsTable.id))
    .orderBy(matchesTable.scheduledStart);

  res.json(
    rows.map(({ match, fieldName, fieldCameraId }) => ({
      ...matchToJson(match),
      fieldName,
      fieldCameraId: fieldCameraId ?? null,
    })),
  );
});

const CreateMatchBody = z.object({
  fieldId: z.number().int().positive(),
  title: z.string().min(1),
  scheduledStart: z.string().datetime({ offset: true }),
  scheduledEnd: z.string().datetime({ offset: true }),
  autoStartLive: z.boolean().default(true),
});

/**
 * POST /admin/matches
 * Rejects if the target field's camera_id is not "camera1".
 */
router.post("/admin/matches", async (req, res): Promise<void> => {
  const adminId = await requireAdmin(req);
  if (!adminId) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const body = CreateMatchBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const [field] = await db
    .select()
    .from(fieldsTable)
    .where(eq(fieldsTable.id, body.data.fieldId));
  if (!field) {
    res.status(404).json({ error: "Field not found" });
    return;
  }
  if (field.cameraId !== "camera1") {
    res.status(400).json({
      error:
        "VAR is only available on fields with camera1. This field has no camera1 assignment.",
    });
    return;
  }

  if (new Date(body.data.scheduledEnd) <= new Date(body.data.scheduledStart)) {
    res.status(400).json({ error: "scheduledEnd must be after scheduledStart" });
    return;
  }

  const [row] = await db
    .insert(matchesTable)
    .values({
      fieldId: body.data.fieldId,
      title: body.data.title,
      scheduledStart: new Date(body.data.scheduledStart),
      scheduledEnd: new Date(body.data.scheduledEnd),
      autoStartLive: body.data.autoStartLive,
    })
    .returning();

  res.status(201).json(matchToJson(row));
});

/**
 * PATCH /admin/matches/:id — currently only supports action=cancel.
 *
 * If the match is currently active (now falls within its scheduled window,
 * auto_start_live was set, and no other match is also live on camera1), the
 * live stream is stopped before responding.  This prevents the stream from
 * being left running indefinitely after an admin cancels a match mid-game.
 */
router.patch("/admin/matches/:id", async (req, res): Promise<void> => {
  const adminId = await requireAdmin(req);
  if (!adminId) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const { action } = req.body as { action?: string };
  if (action !== "cancel") {
    res.status(400).json({ error: "Only action=cancel is supported" });
    return;
  }

  // Read the current match state before mutating
  const [existing] = await db
    .select()
    .from(matchesTable)
    .where(eq(matchesTable.id, id));
  if (!existing) {
    res.status(404).json({ error: "Match not found" });
    return;
  }
  if (existing.status === "cancelled") {
    res.status(409).json({ error: "Match is already cancelled" });
    return;
  }

  const now = new Date();

  // A match is considered "currently active" if auto-start was requested and
  // the clock is inside the scheduled window (regardless of stored status,
  // because the scheduler may have been sleeping).
  const isCurrentlyActive =
    existing.autoStartLive &&
    now >= existing.scheduledStart &&
    now < existing.scheduledEnd &&
    existing.status !== "ended";

  // Cancel in DB
  const [row] = await db
    .update(matchesTable)
    .set({ status: "cancelled" })
    .where(eq(matchesTable.id, id))
    .returning();

  if (isCurrentlyActive) {
    // Only stop the stream when no other auto-started match is still live on
    // camera1.  Manual matches (autoStartLive=false) don't own the stream, so
    // they must not block the stop.  The join is against the already-updated
    // table, so this match now has status='cancelled' and is excluded
    // automatically.
    const [otherActive] = await db
      .select()
      .from(matchesTable)
      .where(
        and(
          ne(matchesTable.id, id),
          ne(matchesTable.status, "cancelled"),
          eq(matchesTable.autoStartLive, true),
          lte(matchesTable.scheduledStart, now),
          gte(matchesTable.scheduledEnd, now),
        ),
      )
      .limit(1);

    if (!otherActive) {
      const stopped = await controlFetch("/live/stop/camera1", {
        method: "POST",
      });
      if (stopped) {
        await db
          .update(matchesTable)
          .set({ liveStoppedAt: now })
          .where(eq(matchesTable.id, id));
        row.liveStoppedAt = now;
      } else {
        logger.warn(
          { matchId: id },
          "Matches cancel: stream stop control call failed — stream may still be running",
        );
      }
    } else {
      logger.info(
        { matchId: id, otherMatchId: otherActive.id },
        "Matches cancel: another match still active — not stopping stream",
      );
    }

    // Prevent the scheduler from attempting stop/start for this match again
    firedEnd.add(id);
    firedStart.delete(id);
  }

  res.json(matchToJson(row));
});

export default router;

// ── Scheduler ─────────────────────────────────────────────────────────────────
//
// Mirrors the pattern in liveSchedules.ts.  In-memory Sets track which match
// IDs we have already fired start/end for, so a 30-s double-tick does not
// double-call the VPS.  IMPORTANT: the Sets are intentionally exported so
// tests can reset them between runs.
//
// On controlFetch failure the match is NOT added to the fired set and the DB
// is NOT updated, so the next 30-s tick will retry.

/** Match IDs for which we've already started the live stream this process. */
export const firedStart = new Set<number>();
/** Match IDs for which we've already stopped the live stream this process. */
export const firedEnd = new Set<number>();

export async function runMatchScheduler(now: Date = new Date()) {
  let matches: (typeof matchesTable.$inferSelect)[];
  try {
    // Load all non-ended, non-cancelled matches so we can check overlap.
    matches = await db
      .select()
      .from(matchesTable)
      .where(
        and(ne(matchesTable.status, "cancelled"), ne(matchesTable.status, "ended")),
      );
  } catch (err) {
    logger.warn({ err }, "Matches scheduler: could not load matches");
    return;
  }

  // Process ends before starts (mirrors liveSchedules pattern — stop before
  // start prevents a race where a new match fires start then the previous
  // match fires stop and wipes the stream).
  for (const match of matches) {
    if (now >= match.scheduledEnd && !firedEnd.has(match.id)) {
      logger.info(
        { matchId: match.id, title: match.title },
        "Matches scheduler: ending match",
      );

      // Only stop the stream when THIS match owns it (autoStartLive=true).
      // A manual match (autoStartLive=false) never started the stream, so it
      // must never stop it either.
      if (match.autoStartLive) {
        // Don't stop if another auto-started match is still in its window.
        // Manual matches (autoStartLive=false) don't "own" the stream, so they
        // don't count as a reason to keep it running.
        const otherActive = matches.find(
          (m) =>
            m.id !== match.id &&
            m.autoStartLive &&
            now >= m.scheduledStart &&
            now < m.scheduledEnd &&
            m.status !== "cancelled",
        );

        if (otherActive) {
          logger.info(
            { matchId: match.id, otherMatchId: otherActive.id },
            "Matches scheduler: skipping stream stop — another auto-started match still live",
          );
        } else {
          const ok = await controlFetch("/live/stop/camera1", {
            method: "POST",
          });
          if (!ok) {
            logger.warn(
              { matchId: match.id },
              "Matches scheduler: stop control call failed — will retry next tick",
            );
            continue; // Don't mark fired — let the next tick retry
          }
        }
      }

      firedEnd.add(match.id);
      await db
        .update(matchesTable)
        .set({ status: "ended", liveStoppedAt: now })
        .where(eq(matchesTable.id, match.id));
    }
  }

  for (const match of matches) {
    if (
      match.autoStartLive &&
      now >= match.scheduledStart &&
      now < match.scheduledEnd &&
      !firedStart.has(match.id)
    ) {
      logger.info(
        { matchId: match.id, title: match.title },
        "Matches scheduler: starting match",
      );

      const ok = await controlFetch("/live/start/camera1", { method: "POST" });
      if (!ok) {
        logger.warn(
          { matchId: match.id },
          "Matches scheduler: start control call failed — will retry next tick",
        );
        continue; // Don't mark fired — let the next tick retry
      }

      firedStart.add(match.id);
      await db
        .update(matchesTable)
        .set({ status: "live", liveStartedAt: now })
        .where(eq(matchesTable.id, match.id));
    }
  }
}

// Kick off immediately on import, then every 30 s — same cadence as liveSchedules.
// Guard suppressed in test environments so imports don't fire live DB/VPS calls.
if (process.env.NODE_ENV !== "test") {
  runMatchScheduler().catch(() => {});
  setInterval(() => runMatchScheduler().catch(() => {}), 30_000);
}
