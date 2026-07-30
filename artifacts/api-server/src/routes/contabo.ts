import { Router, type IRouter } from "express";
import crypto from "crypto";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { getLocalUserId } from "../lib/clerkUserBridge";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// ─── Env / secrets ───────────────────────────────────────────────────────────

const CONTROL_URL = () => {
  let url = process.env.CONTABO_CONTROL_URL?.trim() ?? "";
  if (url && !/^https?:\/\//i.test(url)) url = `http://${url}`;
  return url.replace(/\/$/, "");
};
const CONTROL_KEY = () => process.env.CONTABO_CONTROL_KEY ?? "";
const ADMIN_PASSWORD = () => process.env.ADMIN_PASSWORD ?? "";

function missingSecrets(): string[] {
  const missing: string[] = [];
  if (!process.env.CONTABO_CONTROL_URL) missing.push("CONTABO_CONTROL_URL");
  if (!process.env.CONTABO_CONTROL_KEY) missing.push("CONTABO_CONTROL_KEY");
  if (!process.env.ADMIN_PASSWORD)      missing.push("ADMIN_PASSWORD");
  return missing;
}

// ─── Auth helpers ─────────────────────────────────────────────────────────────

async function requireAdmin(req: Parameters<typeof getLocalUserId>[0]): Promise<number | null> {
  const userId = await getLocalUserId(req);
  if (!userId) return null;
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
  if (!user?.isAdmin) return null;
  return userId;
}

/** Middleware: must be DB admin AND supply the correct ADMIN_PASSWORD header */
/**
 * Admin flag + the live-control password.
 *
 * `allowUnconfigured` exists for GET /config only: that route is how the
 * console discovers the password has not been set up yet, so it must answer
 * rather than 503. It still enforces the password whenever one IS configured —
 * the unlock screen verifies the password purely by watching for a 401 from
 * /config, so exempting it entirely would let any wrong password unlock the
 * console and then fail on every subsequent button.
 */
function contaboAuth(opts: { allowUnconfigured?: boolean } = {}) {
  return async function requireContaboAuth(
    req: import("express").Request,
    res: import("express").Response,
    next: import("express").NextFunction,
  ): Promise<void> {
    const adminId = await requireAdmin(req);
    if (!adminId) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    const suppliedPw = (req.headers["x-admin-password"] as string | undefined) ?? "";
    const expectedPw = ADMIN_PASSWORD();

    if (!expectedPw) {
      if (opts.allowUnconfigured) {
        next();
        return;
      }
      // No password configured — the second factor is not usable, so refuse
      // rather than silently downgrading to admin-flag-only.
      res.status(503).json({ error: "Control server not configured", missing: missingSecrets() });
      return;
    }
    if (!timingSafeEqualStr(suppliedPw, expectedPw)) {
      res.status(401).json({ error: "Bad admin password" });
      return;
    }

    next();
  };
}

const requireContaboAuth = contaboAuth();

/** Constant-time string compare, so the password cannot be recovered byte-by-byte. */
function timingSafeEqualStr(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// ─── In-memory recording request log ─────────────────────────────────────────

interface RecordingJob {
  id: string;
  camera: string;
  title: string;
  startTime: string;
  duration: number;
  submittedAt: string;
  status: string;
  jobId?: string;
  controlResponse?: unknown;
}

const recordingJobs: RecordingJob[] = [];

// ─── Control-server proxy helper ──────────────────────────────────────────────

async function controlFetch(
  path: string,
  opts: RequestInit = {},
  timeoutMs = 15_000,
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const base = CONTROL_URL();
  const key  = CONTROL_KEY();

  // Every other outbound call in this codebase is bounded; this one was not, so
  // a control API that accepts the connection and never answers (hung ffmpeg,
  // camera off WiFi) held the admin's request open until the platform edge
  // timeout, and each retry added another.
  const res = await fetch(`${base}${path}`, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      "X-Api-Key": key,
      ...(opts.headers as Record<string, string> ?? {}),
    },
    signal: AbortSignal.timeout(timeoutMs),
  });

  let body: unknown = null;
  const ct = res.headers.get("content-type") ?? "";
  try {
    body = ct.includes("application/json") ? await res.json() : await res.text();
  } catch { /* non-JSON body */ }

  return { ok: res.ok, status: res.status, body };
}

// ─── Routes ───────────────────────────────────────────────────────────────────

/**
 * GET /admin/contabo/config
 * Returns which required secrets are missing and whether the server is reachable.
 * Used by the frontend on mount to show a setup warning.
 */
router.get("/admin/contabo/config", contaboAuth({ allowUnconfigured: true }) as import("express").RequestHandler, async (_req, res): Promise<void> => {
  const missing = missingSecrets();
  res.json({ configured: missing.length === 0, missing });
});

/**
 * GET /admin/contabo/status/:camera
 * Proxy: GET {CONTROL_URL}/live/status/{camera}
 * Expected control-server response: { live: boolean, startedAt?: string, viewers?: number, ... }
 */
router.get("/admin/contabo/status/:camera", requireContaboAuth as import("express").RequestHandler, async (req, res): Promise<void> => {
  const missing = missingSecrets();
  if (missing.length > 0) {
    res.status(503).json({ error: "Control server not configured", missing });
    return;
  }

  const camera = req.params.camera as string;
  if (!["camera1", "camera2"].includes(camera)) {
    res.status(400).json({ error: "Invalid camera" });
    return;
  }

  try {
    const result = await controlFetch(`/live/status/${camera}`, { method: "GET" });
    logger.info({ camera, ok: result.ok, status: result.status, body: result.body }, "Control server status");
    res.status(result.ok ? 200 : result.status).json(result.body);
  } catch (err) {
    logger.error({ err }, "Failed to reach control server");
    res.status(502).json({ error: "Control server unreachable" });
  }
});

/**
 * POST /admin/contabo/live/start/:camera
 * Proxy: POST {CONTROL_URL}/live/start/{camera}
 */
router.post("/admin/contabo/live/start/:camera", requireContaboAuth as import("express").RequestHandler, async (req, res): Promise<void> => {
  const missing = missingSecrets();
  if (missing.length > 0) {
    res.status(503).json({ error: "Control server not configured", missing });
    return;
  }

  const camera = req.params.camera as string;
  if (!["camera1", "camera2"].includes(camera)) {
    res.status(400).json({ error: "Invalid camera" });
    return;
  }

  try {
    const result = await controlFetch(`/live/start/${camera}`, {
      method: "POST",
      body: JSON.stringify(req.body ?? {}),
    });
    logger.info({ camera, ok: result.ok }, "Live start");
    res.status(result.ok ? 200 : result.status).json(result.body);
  } catch (err) {
    logger.error({ err }, "Failed to reach control server");
    res.status(502).json({ error: "Control server unreachable" });
  }
});

/**
 * POST /admin/contabo/live/stop/:camera
 * Proxy: POST {CONTROL_URL}/live/stop/{camera}
 */
router.post("/admin/contabo/live/stop/:camera", requireContaboAuth as import("express").RequestHandler, async (req, res): Promise<void> => {
  const missing = missingSecrets();
  if (missing.length > 0) {
    res.status(503).json({ error: "Control server not configured", missing });
    return;
  }

  const camera = req.params.camera as string;
  if (!["camera1", "camera2"].includes(camera)) {
    res.status(400).json({ error: "Invalid camera" });
    return;
  }

  try {
    const result = await controlFetch(`/live/stop/${camera}`, {
      method: "POST",
      body: JSON.stringify(req.body ?? {}),
    });
    logger.info({ camera, ok: result.ok }, "Live stop");
    res.status(result.ok ? 200 : result.status).json(result.body);
  } catch (err) {
    logger.error({ err }, "Failed to reach control server");
    res.status(502).json({ error: "Control server unreachable" });
  }
});

/**
 * POST /admin/contabo/record/:camera
 * Body: { startTime: string, duration: number, title: string }
 * Proxy: POST {CONTROL_URL}/record/{camera}
 * Stores the job locally so /recordings can list it.
 */
router.post("/admin/contabo/record/:camera", requireContaboAuth as import("express").RequestHandler, async (req, res): Promise<void> => {
  const missing = missingSecrets();
  if (missing.length > 0) {
    res.status(503).json({ error: "Control server not configured", missing });
    return;
  }

  const camera = req.params.camera as string;
  if (!["camera1", "camera2"].includes(camera)) {
    res.status(400).json({ error: "Invalid camera" });
    return;
  }

  const { startTime, duration, title } = req.body as {
    startTime?: string;
    duration?: number;
    title?: string;
  };

  if (!startTime || !duration || !title) {
    res.status(400).json({ error: "startTime, duration, and title are required" });
    return;
  }

  const jobLocalId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  let controlResponse: unknown = null;
  let jobStatus = "submitted";
  let controlJobId: string | undefined;

  try {
    const result = await controlFetch(`/record/${camera}`, {
      method: "POST",
      body: JSON.stringify({ startTime, duration, title }),
    });

    controlResponse = result.body;

    if (!result.ok) {
      jobStatus = "error";
    } else {
      jobStatus = "queued";
      // Try to extract a job ID from the control server response
      if (result.body && typeof result.body === "object") {
        const body = result.body as Record<string, unknown>;
        controlJobId = (body.jobId ?? body.id ?? body.job_id) as string | undefined;
      }
    }
  } catch (err) {
    logger.error({ err }, "Failed to reach control server for recording");
    jobStatus = "error";
    controlResponse = { error: "Control server unreachable" };
  }

  const job: RecordingJob = {
    id: jobLocalId,
    camera,
    title,
    startTime,
    duration,
    submittedAt: new Date().toISOString(),
    status: jobStatus,
    jobId: controlJobId,
    controlResponse,
  };

  recordingJobs.unshift(job);
  // Keep last 50 jobs in memory
  if (recordingJobs.length > 50) recordingJobs.splice(50);

  res.status(jobStatus === "error" ? 502 : 201).json(job);
});

/**
 * GET /admin/contabo/recordings
 * Returns in-memory recording job list, optionally refreshing status from the control server.
 */
router.get("/admin/contabo/recordings", requireContaboAuth as import("express").RequestHandler, async (_req, res): Promise<void> => {
  // Try to refresh status for pending jobs from the control server
  if (CONTROL_URL() && CONTROL_KEY()) {
    await Promise.allSettled(
      recordingJobs
        .filter((j) => j.jobId && (j.status === "queued" || j.status === "processing"))
        .map(async (j) => {
          try {
            const result = await controlFetch(`/record/${j.camera}/${j.jobId}`, { method: "GET" });
            if (result.ok && result.body && typeof result.body === "object") {
              const body = result.body as Record<string, unknown>;
              if (body.status) j.status = String(body.status);
              j.controlResponse = result.body;
            }
          } catch { /* ignore — keep last known status */ }
        })
    );
  }

  res.json(recordingJobs);
});

// ─── FTP instant-footage route ────────────────────────────────────────────────

/**
 * GET /admin/contabo/ftp/:cam/available
 * Proxy: GET {CONTROL_URL}/ftp/{cam}/available
 * Returns what is instantly servable from footage already pushed to the VPS.
 * Response: { cam, clips: [{ start, end, seconds, bytes }], earliest, latest, note }
 * start/end are "YYYY-MM-DD HH:MM:SS" Amman local time (UTC+3).
 */
router.get("/admin/contabo/ftp/:cam/available", requireContaboAuth as import("express").RequestHandler, async (req, res): Promise<void> => {
  const missing = missingSecrets();
  if (missing.length > 0) { res.status(503).json({ error: "Control server not configured", missing }); return; }

  const cam = req.params.cam as string;
  if (!["camera1", "camera2"].includes(cam)) { res.status(400).json({ error: "Invalid camera" }); return; }

  try {
    const result = await controlFetch(`/ftp/${cam}/available`);
    res.status(result.ok ? 200 : result.status).json(result.body);
  } catch (err) {
    logger.error({ err }, "Failed to reach control server (ftp available)");
    res.status(502).json({ error: "Control server unreachable" });
  }
});

// ─── SD-card 4K pull routes ───────────────────────────────────────────────────

/**
 * GET /admin/contabo/sd/:cam/available?date=YYYY-MM-DD
 * Proxy: GET {CONTROL_URL}/sd/{cam}/available?date=...
 * Returns which hours of footage actually exist on the SD card for that date.
 * All times are Amman local (UTC+3). Response: { cam, date, totalSegments,
 * hours: [{ hour, segments, bytes }] }
 */
router.get("/admin/contabo/sd/:cam/available", requireContaboAuth as import("express").RequestHandler, async (req, res): Promise<void> => {
  const missing = missingSecrets();
  if (missing.length > 0) { res.status(503).json({ error: "Control server not configured", missing }); return; }

  const cam = req.params.cam as string;
  if (!["camera1", "camera2"].includes(cam)) { res.status(400).json({ error: "Invalid camera" }); return; }

  const date = req.query.date as string | undefined;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    res.status(400).json({ error: "date query param must be YYYY-MM-DD" });
    return;
  }

  try {
    const result = await controlFetch(`/sd/${cam}/available?date=${date}`);
    res.status(result.ok ? 200 : result.status).json(result.body);
  } catch (err) {
    logger.error({ err }, "Failed to reach control server (sd available)");
    res.status(502).json({ error: "Control server unreachable" });
  }
});

/**
 * POST /admin/contabo/hq/:cam?source=ftp|sd&start=...&end=...&title=...
 * Proxy: POST {CONTROL_URL}/record-hq/{cam}?source=...&start=...&end=...&title=...
 * source defaults to "ftp" (fast — assembles from footage already on the VPS).
 * source="sd" pulls from the camera's SD card (slow, especially on camera 1).
 * start/end are "YYYY-MM-DD HH:MM:SS" Amman local time.
 * Returns { status, cam, jobId, poll }
 */
router.post("/admin/contabo/hq/:cam", requireContaboAuth as import("express").RequestHandler, async (req, res): Promise<void> => {
  const missing = missingSecrets();
  if (missing.length > 0) { res.status(503).json({ error: "Control server not configured", missing }); return; }

  const cam = req.params.cam as string;
  if (!["camera1", "camera2"].includes(cam)) { res.status(400).json({ error: "Invalid camera" }); return; }

  const source = (req.query.source as string | undefined) ?? "ftp";
  if (!["ftp", "sd"].includes(source)) {
    res.status(400).json({ error: "source must be 'ftp' or 'sd'" });
    return;
  }

  const start = req.query.start as string | undefined;
  const end   = req.query.end   as string | undefined;
  const title = req.query.title as string | undefined;

  if (!start || !end || !title) {
    res.status(400).json({ error: "start, end, and title query params are required" });
    return;
  }

  try {
    const qs = `source=${source}&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&title=${encodeURIComponent(title)}`;
    const result = await controlFetch(`/record-hq/${cam}?${qs}`, { method: "POST" });
    logger.info({ cam, source, start, end, title, ok: result.ok }, "Footage request queued");
    res.status(result.ok ? 200 : result.status).json(result.body);
  } catch (err) {
    logger.error({ err }, "Failed to reach control server (hq queue)");
    res.status(502).json({ error: "Control server unreachable" });
  }
});

/**
 * GET /admin/contabo/hq/:cam/:jobId
 * Proxy: GET {CONTROL_URL}/record-hq/{cam}/{jobId}
 * Job status. Status field: queued → searching → downloading → waiting_for_camera
 * → assembling → uploading → done | failed.
 * While downloading: segments, bytesExpected, bytesDownloaded, note.
 * When done: videoId, playback (Bunny HLS URL). When failed: error string.
 */
router.get("/admin/contabo/hq/:cam/:jobId", requireContaboAuth as import("express").RequestHandler, async (req, res): Promise<void> => {
  const missing = missingSecrets();
  if (missing.length > 0) { res.status(503).json({ error: "Control server not configured", missing }); return; }

  const cam   = req.params.cam   as string;
  const jobId = req.params.jobId as string;

  if (!["camera1", "camera2"].includes(cam)) { res.status(400).json({ error: "Invalid camera" }); return; }

  try {
    // 30 s — assembling/uploading stages can take a moment to respond.
    const result = await controlFetch(`/record-hq/${cam}/${jobId}`, {}, 30_000);
    res.status(result.ok ? 200 : result.status).json(result.body);
  } catch (err) {
    logger.error({ err, cam, jobId }, "Failed to reach control server (hq status)");
    res.status(502).json({ error: "Control server unreachable" });
  }
});

/**
 * GET /admin/contabo/hq
 * Proxy: GET {CONTROL_URL}/record-hq
 * All past SD-pull jobs, newest first. Response: { jobs: [...] }
 */
router.get("/admin/contabo/hq", requireContaboAuth as import("express").RequestHandler, async (_req, res): Promise<void> => {
  const missing = missingSecrets();
  if (missing.length > 0) { res.status(503).json({ error: "Control server not configured", missing }); return; }

  try {
    const result = await controlFetch("/record-hq");
    res.status(result.ok ? 200 : result.status).json(result.body);
  } catch (err) {
    logger.error({ err }, "Failed to reach control server (hq list)");
    res.status(502).json({ error: "Control server unreachable" });
  }
});

export default router;
