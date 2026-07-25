import { Router, type IRouter } from "express";
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
async function requireContaboAuth(
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
    // No password set yet — allow (will show config warning in /config)
  } else if (suppliedPw !== expectedPw) {
    res.status(401).json({ error: "Bad admin password" });
    return;
  }

  next();
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
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const base = CONTROL_URL();
  const key  = CONTROL_KEY();

  const res = await fetch(`${base}${path}`, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      "X-Api-Key": key,
      ...(opts.headers as Record<string, string> ?? {}),
    },
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
router.get("/admin/contabo/config", requireContaboAuth as import("express").RequestHandler, async (_req, res): Promise<void> => {
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
    if (!result.ok) {
      logger.warn({ camera, status: result.status }, "Control server status error");
    }
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

export default router;
