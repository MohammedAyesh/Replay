/**
 * CRUD for live stream schedules + server-side scheduler.
 *
 * Schedules store a start/end time (HH:MM, Asia/Amman timezone) and an
 * optional set of weekdays.  Every 30 s the scheduler checks whether any
 * enabled schedule should fire and calls the Contabo control server.
 *
 * To prevent double-firing within the same minute, we keep an in-memory
 * Set of "camera:YYYY-MM-DD:HH:MM:action" keys.
 */
import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, liveSchedulesTable, usersTable } from "@workspace/db";
import { getLocalUserId } from "../lib/clerkUserBridge";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const TZ = "Asia/Amman";

const VALID_CAMERAS = ["camera1", "camera2"] as const;
const VALID_DAYS = [
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
] as const;

// ── Auth helper ───────────────────────────────────────────────────────────────

async function requireAdmin(req: Parameters<typeof getLocalUserId>[0]): Promise<boolean> {
  const userId = await getLocalUserId(req);
  if (!userId) return false;
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
  return !!user?.isAdmin;
}

// ── Zod schemas ───────────────────────────────────────────────────────────────

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const CreateScheduleBody = z.object({
  camera: z.enum(VALID_CAMERAS),
  startTime: z.string().regex(TIME_RE, "startTime must be HH:MM (24-hour)"),
  endTime: z.string().regex(TIME_RE, "endTime must be HH:MM (24-hour)"),
  daysOfWeek: z.array(z.enum(VALID_DAYS)).default([]),
  enabled: z.boolean().default(true),
});

const UpdateScheduleBody = z.object({
  camera: z.enum(VALID_CAMERAS).optional(),
  startTime: z.string().regex(TIME_RE).optional(),
  endTime: z.string().regex(TIME_RE).optional(),
  daysOfWeek: z.array(z.enum(VALID_DAYS)).optional(),
  enabled: z.boolean().optional(),
});

function serializeDays(days: string[]): string {
  return days.join(",");
}
function parseDays(raw: string): string[] {
  return raw ? raw.split(",").map((d) => d.trim()).filter(Boolean) : [];
}
function toRow(s: typeof liveSchedulesTable.$inferSelect) {
  return { ...s, daysOfWeek: parseDays(s.daysOfWeek) };
}

// ── Routes ────────────────────────────────────────────────────────────────────

router.get("/admin/live-schedules", async (req, res): Promise<void> => {
  if (!await requireAdmin(req)) { res.status(403).json({ error: "Forbidden" }); return; }
  const rows = await db.select().from(liveSchedulesTable).orderBy(liveSchedulesTable.camera, liveSchedulesTable.startTime);
  res.json(rows.map(toRow));
});

router.post("/admin/live-schedules", async (req, res): Promise<void> => {
  if (!await requireAdmin(req)) { res.status(403).json({ error: "Forbidden" }); return; }
  const body = CreateScheduleBody.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: body.error.message }); return; }
  const [row] = await db.insert(liveSchedulesTable).values({
    camera: body.data.camera,
    startTime: body.data.startTime,
    endTime: body.data.endTime,
    daysOfWeek: serializeDays(body.data.daysOfWeek),
    enabled: body.data.enabled,
  }).returning();
  res.status(201).json(toRow(row));
});

router.patch("/admin/live-schedules/:id", async (req, res): Promise<void> => {
  if (!await requireAdmin(req)) { res.status(403).json({ error: "Forbidden" }); return; }
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const body = UpdateScheduleBody.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: body.error.message }); return; }
  const updates: Partial<typeof liveSchedulesTable.$inferInsert> = {};
  if (body.data.camera !== undefined) updates.camera = body.data.camera;
  if (body.data.startTime !== undefined) updates.startTime = body.data.startTime;
  if (body.data.endTime !== undefined) updates.endTime = body.data.endTime;
  if (body.data.daysOfWeek !== undefined) updates.daysOfWeek = serializeDays(body.data.daysOfWeek);
  if (body.data.enabled !== undefined) updates.enabled = body.data.enabled;
  const [row] = await db.update(liveSchedulesTable).set(updates).where(eq(liveSchedulesTable.id, id)).returning();
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  res.json(toRow(row));
});

router.delete("/admin/live-schedules/:id", async (req, res): Promise<void> => {
  if (!await requireAdmin(req)) { res.status(403).json({ error: "Forbidden" }); return; }
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  await db.delete(liveSchedulesTable).where(eq(liveSchedulesTable.id, id));
  res.status(204).send();
});

export default router;

// ── Scheduler ─────────────────────────────────────────────────────────────────

/** Keys we've already fired this minute — prevents double-trigger on the 30-s tick. */
const fired = new Set<string>();

/** Drop fired keys that are no longer for the current minute, to avoid unbounded growth. */
setInterval(() => {
  const now = getNow();
  const current = `${now.date}:${now.hhmm}`;
  for (const key of fired) {
    // key format: "camera:YYYY-MM-DD:HH:MM:action" — five colon-separated parts,
    // so the minute is parts 1..3. The old `${parts[1]}:${parts[2]}` produced
    // "2026-07-30:14" and never matched "2026-07-30:14:30", which emptied the
    // whole set every tick — including the current minute's keys. With the
    // dedupe gone, a cleanup landing between the scheduler's two 30 s ticks let
    // the same schedule fire twice, and live.sh wipes Bunny on start, so
    // viewers saw the stream reset mid-match.
    const parts = key.split(":");
    const keyMinute = parts.slice(1, 4).join(":");
    if (keyMinute !== current) fired.delete(key);
  }
}, 60_000);

function getNow() {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
    weekday: "long",
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map((p) => [p.type, p.value]));
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  const hhmm = `${parts.hour}:${parts.minute}`;
  const weekday = (parts.weekday ?? "").toLowerCase() as typeof VALID_DAYS[number];
  return { date, hhmm, weekday };
}

async function controlFetch(path: string, opts: RequestInit = {}) {
  let base = (process.env.CONTABO_CONTROL_URL ?? "").trim();
  if (base && !/^https?:\/\//i.test(base)) base = `http://${base}`;
  base = base.replace(/\/$/, "");
  if (!base) return;
  const key = process.env.CONTABO_CONTROL_KEY ?? "";
  try {
    const res = await fetch(`${base}${path}`, {
      ...opts,
      headers: {
        "Content-Type": "application/json",
        "X-Api-Key": key,
        ...(opts.headers as Record<string, string> ?? {}),
      },
      signal: AbortSignal.timeout(10_000),
    });
    const body = await res.json().catch(() => null);
    logger.info({ path, status: res.status, body }, "Scheduler: control fetch");
  } catch (err) {
    logger.warn({ path, err }, "Scheduler: control fetch failed");
  }
}

async function runScheduler() {
  const now = getNow();
  let schedules: typeof liveSchedulesTable.$inferSelect[];
  try {
    schedules = await db.select().from(liveSchedulesTable).where(eq(liveSchedulesTable.enabled, true));
  } catch (err) {
    logger.warn({ err }, "Scheduler: could not load schedules");
    return;
  }

  const due = schedules.filter((s) => {
    const days = parseDays(s.daysOfWeek);
    // If daysOfWeek is empty, applies every day
    return days.length === 0 || days.includes(now.weekday);
  });

  // Every stop across all schedules is issued before any start.
  //
  // The query has no ORDER BY, and the old loop evaluated start-then-stop per
  // row. With back-to-back blocks on one camera (18:00-20:00 and 20:00-22:00),
  // if Postgres happened to return the later row first the scheduler fired
  // start then stop at 20:00 and left the camera dark for the whole second
  // block, with nothing to re-fire until 22:00.
  for (const action of ["stop", "start"] as const) {
    for (const s of due) {
      const t = action === "start" ? s.startTime : s.endTime;
      if (t !== now.hhmm) continue;
      const key = `${s.camera}:${now.date}:${now.hhmm}:${action}`;
      if (fired.has(key)) continue;
      fired.add(key);
      logger.info({ camera: s.camera, action, time: now.hhmm }, "Scheduler: firing");
      await controlFetch(`/live/${action}/${s.camera}`, { method: "POST" });
    }
  }
}

// Kick off immediately on import, then every 30 s
runScheduler().catch(() => {});
setInterval(() => runScheduler().catch(() => {}), 30_000);
