import { and, desc, eq, inArray } from "drizzle-orm";
import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import {
  academiesTable,
  academyMembersTable,
  cameraKitsTable,
  cameraSetupsTable,
  db,
  fieldsTable,
  venuePitchesTable,
  type CameraKit,
  type CameraSetup,
} from "@workspace/db";

import { requireAcademyConsoleUser, type AcademyConsoleUser } from "../lib/academyAccess";
import { workerKeyMatches } from "../lib/analysisJobs";
import {
  KitError,
  SETUP_MINUTES,
  applyCalibration,
  kitRole,
  kitView,
  kitsForUser,
  latestSetups,
  newKitToken,
  pendingCalibrations,
  pitchMeasurements,
  portableEnabled,
  reviewSetup,
  setupView,
  startSetupRecording,
  stopSetupRecording,
  syncSetup,
  type KitRole,
} from "../lib/cameraKits";
import { logger } from "../lib/logger";
import { controlFetch, controlResponse } from "./contabo";

/**
 * Portable cameras (Labs, hidden). Me → Set up a camera, the console's Cameras page,
 * and vps1's autocal worker. Nothing here is reachable for a user the setting is off for.
 */
const router: IRouter = Router();

function intParam(value: string | string[] | undefined): number | null {
  const n = Number(Array.isArray(value) ? value[0] : value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function fail(res: Response, error: unknown, fallback: string): void {
  if (error instanceof KitError) {
    res.status(error.status).json({ error: error.message, code: error.code });
    return;
  }
  logger.warn({ error: (error as Error)?.message }, fallback);
  res.status(500).json({ error: fallback });
}

async function myAcademyIds(userId: number): Promise<number[]> {
  const rows = await db.select({ academyId: academyMembersTable.academyId }).from(academyMembersTable).where(eq(academyMembersTable.userId, userId));
  return [...new Set(rows.map((r) => r.academyId))];
}

/** Signed in, and the Labs switch is on for them. */
async function labsUser(req: Request, res: Response): Promise<AcademyConsoleUser | null> {
  const user = await requireAcademyConsoleUser(req, res);
  if (!user) return null;
  if (!(await portableEnabled(user, await myAcademyIds(user.id)))) {
    res.status(404).json({ error: "Not found" });
    return null;
  }
  return user;
}

async function loadKit(req: Request, res: Response, user: AcademyConsoleUser, need: KitRole = "use"): Promise<{ kit: CameraKit; role: KitRole } | null> {
  const id = intParam(req.params.kitId);
  const [kit] = id ? await db.select().from(cameraKitsTable).where(eq(cameraKitsTable.id, id)) : [];
  if (!kit) { res.status(404).json({ error: "Camera not found" }); return null; }
  const role = await kitRole(user, kit);
  if (!role || (need === "manage" && role !== "manage")) { res.status(403).json({ error: "This camera isn't one of yours." }); return null; }
  return { kit, role };
}

async function loadSetup(req: Request, res: Response, user: AcademyConsoleUser, need: KitRole = "use"): Promise<{ setup: CameraSetup; kit: CameraKit; role: KitRole } | null> {
  const id = intParam(req.params.setupId);
  const [setup] = id ? await db.select().from(cameraSetupsTable).where(eq(cameraSetupsTable.id, id)) : [];
  if (!setup) { res.status(404).json({ error: "Set-up not found" }); return null; }
  const [kit] = await db.select().from(cameraKitsTable).where(eq(cameraKitsTable.id, setup.kitId));
  const role = kit ? await kitRole(user, kit) : null;
  if (!kit || !role || (need === "manage" && role !== "manage")) { res.status(403).json({ error: "This camera isn't one of yours." }); return null; }
  return { setup: await syncSetup(setup), kit, role };
}

// ─── Me → Set up a camera ────────────────────────────────────────────────────

router.get("/kits/access", async (req, res): Promise<void> => {
  const user = await requireAcademyConsoleUser(req, res);
  if (!user) return;
  res.setHeader("Cache-Control", "no-store");
  res.json({ enabled: await portableEnabled(user, await myAcademyIds(user.id)), isAdmin: user.isAdmin });
});

router.get("/kits", async (req, res): Promise<void> => {
  const user = await labsUser(req, res);
  if (!user) return;
  const kits = await kitsForUser(user);
  const latest = await latestSetups(kits.map((k) => k.id));
  res.json({ kits: kits.map((k) => kitView(k, latest.get(k.id), k.role)) });
});

router.get("/kits/by-token/:token", async (req, res): Promise<void> => {
  const user = await labsUser(req, res);
  if (!user) return;
  const token = String(req.params.token ?? "").trim();
  const [kit] = /^[0-9a-f]{24}$/.test(token) ? await db.select().from(cameraKitsTable).where(eq(cameraKitsTable.token, token)) : [];
  if (!kit || kit.archived) { res.status(404).json({ error: "We don't know this sticker." }); return; }
  const role = await kitRole(user, kit);
  if (!role) { res.status(403).json({ error: "This camera belongs to another field or academy." }); return; }
  res.json({ kit: kitView(kit, (await latestSetups([kit.id])).get(kit.id), role) });
});

/** Pitches the kit's owner has, with what was measured there before. */
router.get("/kits/:kitId/places", async (req, res): Promise<void> => {
  const user = await labsUser(req, res);
  if (!user) return;
  const k = await loadKit(req, res, user);
  if (!k) return;
  const pitches = k.kit.academyId
    ? await db.select().from(venuePitchesTable).where(and(eq(venuePitchesTable.academyId, k.kit.academyId), eq(venuePitchesTable.active, true))).orderBy(venuePitchesTable.sortOrder, venuePitchesTable.id)
    : [];
  const measured = await pitchMeasurements(pitches.map((p) => p.id));
  const [academy] = k.kit.academyId ? await db.select({ name: academiesTable.name }).from(academiesTable).where(eq(academiesTable.id, k.kit.academyId)) : [];
  res.json({
    venueName: academy?.name ?? null,
    pitches: pitches.map((p) => ({ id: p.id, name: p.name, nameAr: p.nameAr, size: p.size, lengthM: p.lengthM, widthM: p.widthM, measured: measured.get(p.id) ?? null })),
  });
});

/** Is the camera online, and on which network. Needs vps1's /kit/<cam>/status; says so when it isn't there. */
router.get("/kits/:kitId/status", async (req, res): Promise<void> => {
  const user = await labsUser(req, res);
  if (!user) return;
  const k = await loadKit(req, res, user);
  if (!k) return;
  res.setHeader("Cache-Control", "no-store");
  try {
    const result = await controlFetch(`/kit/${encodeURIComponent(k.kit.cameraId)}/status`, { method: "GET" }, 12_000);
    if (!result.ok) { res.json({ online: false, reason: result.status === 404 ? "unsupported" : "offline" }); return; }
    const body = (result.body ?? {}) as Record<string, unknown>;
    // Connected from the app: vps1 only reaches it through Reolink's cloud, so the live
    // preview is the check, not a status call.
    if (body.reason === "cloud") { res.json({ online: false, reason: "cloud" }); return; }
    res.json({ online: body.online !== false, ssid: typeof body.ssid === "string" ? body.ssid : null, signal: typeof body.signal === "number" ? body.signal : null, battery: typeof body.battery === "number" ? body.battery : null });
  } catch {
    res.json({ online: false, reason: "unreachable" });
  }
});

const setupBody = z.object({
  pitchId: z.number().int().positive().nullable().optional(),
  placeName: z.string().trim().min(1).max(80).nullable().optional(),
  placeSize: z.enum(["5", "6", "7", "8", "9", "11"]).nullable().optional(),
  knownLengthM: z.number().min(10).max(130).nullable().optional(),
  knownWidthM: z.number().min(5).max(100).nullable().optional(),
  mastHeightM: z.number().min(1).max(20),
});

router.post("/kits/:kitId/setups", async (req, res): Promise<void> => {
  const user = await labsUser(req, res);
  if (!user) return;
  const k = await loadKit(req, res, user);
  if (!k) return;
  const body = setupBody.safeParse(req.body ?? {});
  if (!body.success) { res.status(400).json({ error: "Pick the pitch and type the camera's height (1–20 m)." }); return; }
  const d = body.data;
  if (d.pitchId) {
    const [pitch] = await db.select({ academyId: venuePitchesTable.academyId }).from(venuePitchesTable).where(eq(venuePitchesTable.id, d.pitchId));
    if (!pitch || pitch.academyId !== k.kit.academyId) { res.status(400).json({ error: "That pitch isn't one of this camera's." }); return; }
  } else if (!d.placeName) {
    res.status(400).json({ error: "Name the pitch." });
    return;
  }
  const [row] = await db.insert(cameraSetupsTable).values({
    kitId: k.kit.id,
    academyId: k.kit.academyId,
    pitchId: d.pitchId ?? null,
    placeName: d.pitchId ? null : d.placeName ?? null,
    placeSize: d.pitchId ? null : d.placeSize ?? null,
    knownLengthM: d.knownLengthM ?? null,
    knownWidthM: d.knownWidthM ?? null,
    mastHeightM: d.mastHeightM,
    createdBy: user.id,
  }).returning();
  res.status(201).json({ setup: await setupView(row) });
});

router.get("/kits/setups/:setupId", async (req, res): Promise<void> => {
  const user = await labsUser(req, res);
  if (!user) return;
  const s = await loadSetup(req, res, user);
  if (!s) return;
  res.setHeader("Cache-Control", "no-store");
  res.json({ setup: await setupView(s.setup), role: s.role });
});

const patchBody = z.object({
  mastHeightM: z.number().min(1).max(20).optional(),
  viewConfirmed: z.boolean().optional(),
  kind: z.enum(["match", "training", "session"]).optional(),
  title: z.string().trim().max(80).nullable().optional(),
});

router.patch("/kits/setups/:setupId", async (req, res): Promise<void> => {
  const user = await labsUser(req, res);
  if (!user) return;
  const s = await loadSetup(req, res, user);
  if (!s) return;
  const body = patchBody.safeParse(req.body ?? {});
  if (!body.success) { res.status(400).json({ error: "Check the details." }); return; }
  if (s.setup.status !== "setting_up" && body.data.mastHeightM !== undefined) {
    res.status(409).json({ error: "The camera is already recording. Stop it to change the height." });
    return;
  }
  const { viewConfirmed, ...rest } = body.data;
  const [row] = await db.update(cameraSetupsTable).set({ ...rest, ...(viewConfirmed !== undefined ? { viewConfirmedAt: viewConfirmed ? new Date() : null } : {}), updatedAt: new Date() })
    .where(eq(cameraSetupsTable.id, s.setup.id)).returning();
  res.json({ setup: await setupView(row) });
});

/** A still from the camera for the view check. Needs vps1's /kit/<cam>/snapshot. */
router.get("/kits/setups/:setupId/snapshot", async (req, res): Promise<void> => {
  const user = await labsUser(req, res);
  if (!user) return;
  const s = await loadSetup(req, res, user);
  if (!s) return;
  try {
    const upstream = await controlResponse(`/kit/${encodeURIComponent(s.kit.cameraId)}/snapshot`, { method: "GET", headers: { Accept: "image/jpeg" } }, 20_000);
    const type = upstream.headers.get("content-type") ?? "";
    if (upstream.status === 409) { res.status(409).json({ error: "This camera is reached through Reolink's cloud: use the live picture.", reason: "cloud" }); return; }
    if (!upstream.ok || !type.startsWith("image/")) {
      res.status(upstream.status === 404 ? 501 : 502).json({ error: upstream.status === 404 ? "Preview isn't switched on for this camera yet." : "The camera didn't send a picture." });
      return;
    }
    res.setHeader("Content-Type", type);
    res.setHeader("Cache-Control", "no-store");
    res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch {
    res.status(502).json({ error: "The camera didn't answer." });
  }
});

// ─── Low-quality live preview ────────────────────────────────────────────────
// vps1's kit_preview.py: straight to the camera over WireGuard when it can, else through
// Reolink's own cloud relay (~0.5 Mbps, enough for the 1536×432 sub stream). It starts on
// the first request and stops by itself a minute after the last one, so the player's own
// playlist refreshes are what keep it alive.

const PREVIEW_FILE = /^(index\.m3u8|seg_\d{6}\.ts)$/;
type PreviewState = { state: "starting" | "ready" | "failed" | "stopped" | "unsupported"; via: "direct" | "cloud" | null; message: string | null };

function previewState(body: unknown): PreviewState {
  const b = (body ?? {}) as Record<string, unknown>;
  const state = ["starting", "ready", "failed", "stopped"].includes(String(b.state)) ? (b.state as PreviewState["state"]) : "failed";
  return { state, via: b.via === "direct" || b.via === "cloud" ? b.via : null, message: typeof b.message === "string" ? b.message : null };
}

async function previewCall(req: Request, res: Response, method: "POST" | "GET" | "DELETE"): Promise<void> {
  const user = await labsUser(req, res);
  if (!user) return;
  const k = await loadKit(req, res, user);
  if (!k) return;
  res.setHeader("Cache-Control", "no-store");
  try {
    const r = await controlFetch(`/kit/${encodeURIComponent(k.kit.cameraId)}/preview`, { method }, 15_000);
    if (r.status === 404) { res.json({ state: "unsupported", via: null, message: null } satisfies PreviewState); return; }
    if (!r.ok) { res.status(502).json({ error: "The preview didn't start." }); return; }
    res.json(previewState(r.body));
  } catch {
    res.status(502).json({ error: "The preview didn't start." });
  }
}

router.post("/kits/:kitId/preview", (req, res) => previewCall(req, res, "POST"));
router.get("/kits/:kitId/preview", (req, res) => previewCall(req, res, "GET"));
router.delete("/kits/:kitId/preview", (req, res) => previewCall(req, res, "DELETE"));

router.get("/kits/:kitId/preview/:file", async (req, res): Promise<void> => {
  const file = String(req.params.file ?? "");
  if (!PREVIEW_FILE.test(file)) { res.status(404).end(); return; }
  const user = await labsUser(req, res);
  if (!user) return;
  const k = await loadKit(req, res, user);
  if (!k) return;
  try {
    const upstream = await controlResponse(`/kit/${encodeURIComponent(k.kit.cameraId)}/preview/${file}`, { method: "GET" }, 20_000);
    if (!upstream.ok) { res.status(upstream.status === 404 ? 404 : 502).end(); return; }
    res.setHeader("Content-Type", file.endsWith(".m3u8") ? "application/vnd.apple.mpegurl" : "video/mp2t");
    res.setHeader("Cache-Control", "no-store");
    res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch {
    res.status(502).end();
  }
});

const startBody = z.object({
  minutes: z.number().int().refine((m) => (SETUP_MINUTES as readonly number[]).includes(m)),
  kind: z.enum(["match", "training", "session"]).optional(),
  title: z.string().trim().max(80).nullable().optional(),
});

router.post("/kits/setups/:setupId/start", async (req, res): Promise<void> => {
  const user = await labsUser(req, res);
  if (!user) return;
  const s = await loadSetup(req, res, user);
  if (!s) return;
  const body = startBody.safeParse(req.body ?? {});
  if (!body.success) { res.status(400).json({ error: "Pick how long to record." }); return; }
  try {
    if (body.data.kind || body.data.title !== undefined) {
      await db.update(cameraSetupsTable).set({ kind: body.data.kind ?? s.setup.kind, title: body.data.title ?? s.setup.title, updatedAt: new Date() }).where(eq(cameraSetupsTable.id, s.setup.id));
    }
    const row = await startSetupRecording(s.setup, s.kit, user.id, body.data.minutes);
    res.json({ setup: await setupView(row) });
  } catch (error) {
    fail(res, error, "Could not start recording");
  }
});

router.post("/kits/setups/:setupId/stop", async (req, res): Promise<void> => {
  const user = await labsUser(req, res);
  if (!user) return;
  const s = await loadSetup(req, res, user);
  if (!s) return;
  try {
    const row = await stopSetupRecording(s.setup, s.kit, user.id);
    res.json({ setup: await setupView(row) });
  } catch (error) {
    fail(res, error, "Could not stop recording");
  }
});

router.post("/kits/setups/:setupId/cancel", async (req, res): Promise<void> => {
  const user = await labsUser(req, res);
  if (!user) return;
  const s = await loadSetup(req, res, user);
  if (!s) return;
  if (s.setup.status !== "setting_up") { res.status(409).json({ error: "Stop the recording instead." }); return; }
  const [row] = await db.update(cameraSetupsTable).set({ status: "cancelled", updatedAt: new Date() }).where(eq(cameraSetupsTable.id, s.setup.id)).returning();
  res.json({ setup: await setupView(row) });
});

// ─── Console: Cameras ────────────────────────────────────────────────────────

/** Kits and every set-up they've had. An academy's own, or (admins) everything. */
router.get("/kits/manage", async (req, res): Promise<void> => {
  const user = await labsUser(req, res);
  if (!user) return;
  const academyId = intParam(req.query.academyId as string | undefined);
  if (!academyId && !user.isAdmin) { res.status(400).json({ error: "Which field or academy?" }); return; }
  if (academyId && !user.isAdmin) {
    const role = await kitRole(user, { academyId });
    if (role !== "manage") { res.status(403).json({ error: "Only owners and managers see the cameras page." }); return; }
  }
  const kits = await db.select().from(cameraKitsTable)
    .where(academyId ? and(eq(cameraKitsTable.academyId, academyId), eq(cameraKitsTable.archived, false)) : eq(cameraKitsTable.archived, false))
    .orderBy(cameraKitsTable.name);
  const latest = await latestSetups(kits.map((k) => k.id));
  const setups = kits.length
    ? await db.select().from(cameraSetupsTable).where(inArray(cameraSetupsTable.kitId, kits.map((k) => k.id))).orderBy(desc(cameraSetupsTable.createdAt)).limit(100)
    : [];
  const synced = await Promise.all(setups.map((s) => syncSetup(s)));
  res.setHeader("Cache-Control", "no-store");
  res.json({
    kits: kits.map((k) => kitView(k, latest.get(k.id), "manage")),
    setups: await Promise.all(synced.map((s) => setupView(s))),
    canAdd: user.isAdmin || (academyId ? (await kitRole(user, { academyId })) === "manage" : false),
    canAddReplayCamera: user.isAdmin,
  });
});

const kitBody = z.object({
  academyId: z.number().int().positive().nullable().optional(),
  name: z.string().trim().min(1).max(40),
  cameraId: z.string().trim().regex(/^[a-z0-9_-]{2,32}$/i),
  wifiSsid: z.string().trim().max(32).nullable().optional(),
  wifiPassword: z.string().max(63).nullable().optional(),
  localUrl: z.string().trim().url().max(200).nullable().optional(),
});

// ─── Connect a new camera (anyone who manages the academy or field) ──────────────────────
// They set it up in the Reolink app first (password, WiFi), then give us its Reolink ID and
// password here. vps1 keeps the password (0600, never in this database) and reaches the
// camera through Reolink's cloud. Replay's own cameras are camera1-camera9; connected ones
// get camera10 upwards.

const connectBody = z.object({
  academyId: z.number().int().positive(),
  name: z.string().trim().min(1).max(40),
  uid: z.string().trim().transform((u) => u.replace(/[\s-]/g, "").toUpperCase()).pipe(z.string().regex(/^[A-Z0-9]{12,24}$/)),
  user: z.string().trim().regex(/^[A-Za-z0-9_.@-]{1,32}$/).optional(),
  password: z.string().min(1).max(64),
  wifiSsid: z.string().trim().max(32).nullable().optional(),
});
const fixBody = connectBody.pick({ uid: true, user: true, password: true });

async function nextCameraId(): Promise<string> {
  const used = [
    ...(await db.select({ c: fieldsTable.cameraId }).from(fieldsTable)),
    ...(await db.select({ c: cameraKitsTable.cameraId }).from(cameraKitsTable)),
  ];
  let top = 9;
  for (const { c } of used) {
    const m = /^camera(\d+)$/.exec(c ?? "");
    if (m) top = Math.max(top, Number(m[1]));
  }
  return `camera${top + 1}`;
}

/** Hand the camera's details to vps1. An error string means the person has something to fix. */
async function registerWithVps1(cameraId: string, body: { uid: string; user?: string; password: string }): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  try {
    const r = await controlFetch(`/kit/${encodeURIComponent(cameraId)}/register`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uid: body.uid, user: body.user ?? "admin", password: body.password }),
    }, 15_000);
    if (r.ok) return { ok: true };
    const detail = String(((r.body ?? {}) as Record<string, unknown>).detail ?? "");
    if (r.status === 409 && detail === "uid in use") return { ok: false, status: 409, error: "That camera is already connected to Replay." };
    if (r.status === 400 && detail === "uid") return { ok: false, status: 400, error: "That isn't a Reolink camera ID. It's the 16 letters and numbers on the camera's sticker." };
    if (r.status === 400) return { ok: false, status: 400, error: "Check the camera's password." };
    return { ok: false, status: 503, error: "Replay couldn't save the camera right now. Try again in a minute." };
  } catch {
    return { ok: false, status: 503, error: "Replay couldn't save the camera right now. Try again in a minute." };
  }
}

router.post("/kits/manage/connect", async (req, res): Promise<void> => {
  const user = await labsUser(req, res);
  if (!user) return;
  const body = connectBody.safeParse(req.body ?? {});
  if (!body.success) {
    const uidBad = body.error.issues.some((i) => i.path[0] === "uid");
    res.status(400).json({ error: uidBad ? "That isn't a Reolink camera ID. It's the 16 letters and numbers on the camera's sticker." : "Give the camera a name and its password." });
    return;
  }
  if ((await kitRole(user, { academyId: body.data.academyId })) !== "manage") { res.status(403).json({ error: "Only owners and managers add cameras." }); return; }
  const cameraId = await nextCameraId();
  const saved = await registerWithVps1(cameraId, body.data);
  if (!saved.ok) { res.status(saved.status).json({ error: saved.error }); return; }
  const [row] = await db.insert(cameraKitsTable).values({
    academyId: body.data.academyId, name: body.data.name, cameraId,
    wifiSsid: body.data.wifiSsid || null, token: newKitToken(), createdBy: user.id,
  }).returning();
  logger.info({ kitId: row.id, cameraId, academyId: body.data.academyId, userId: user.id }, "Camera connected from the app");
  res.status(201).json({ kit: kitView(row, null, "manage") });
});

/** Wrong ID or password: type them again. Only for cameras connected from the app. */
router.post("/kits/manage/:kitId/connection", async (req, res): Promise<void> => {
  const user = await labsUser(req, res);
  if (!user) return;
  const k = await loadKit(req, res, user, "manage");
  if (!k) return;
  const m = /^camera(\d+)$/.exec(k.kit.cameraId);
  if (!m || Number(m[1]) < 10) { res.status(409).json({ error: "This is one of Replay's cameras. Ask Replay to change it." }); return; }
  const body = fixBody.safeParse(req.body ?? {});
  if (!body.success) { res.status(400).json({ error: "That isn't a Reolink camera ID. It's the 16 letters and numbers on the camera's sticker." }); return; }
  const saved = await registerWithVps1(k.kit.cameraId, body.data);
  if (!saved.ok) { res.status(saved.status).json({ error: saved.error }); return; }
  res.json({ ok: true });
});

// ─── Full quality: the user connects a router (WireGuard) or FTP ──────────────────────────
// vps1 makes the tunnel or the FTP login and returns its secret once (router file, FTP
// password). Nothing secret is stored in this database; the response is never cached.

type LinkState = {
  pull: "cli" | "ftp" | null;
  router: { configured: boolean; routerAddress?: string; connected?: boolean; lastSeenSeconds?: number | null; camera?: string | null };
  ftp: { configured: boolean; server?: string; port?: number; user?: string; folder?: string; lastClipSecondsAgo?: number | null; clips?: number; storedGB?: number };
};

async function connectedKit(req: Request, res: Response) {
  const user = await labsUser(req, res);
  if (!user) return null;
  const k = await loadKit(req, res, user, "manage");
  if (!k) return null;
  const m = /^camera(\d+)$/.exec(k.kit.cameraId);
  if (!m || Number(m[1]) < 10) { res.status(409).json({ error: "This is one of Replay's cameras: it's already connected in full quality." }); return null; }
  res.setHeader("Cache-Control", "no-store");
  return k;
}

const vps1Path = (cameraId: string, what: string) => `/kit/${encodeURIComponent(cameraId)}/${what}`;

router.get("/kits/manage/:kitId/link", async (req, res): Promise<void> => {
  const k = await connectedKit(req, res);
  if (!k) return;
  try {
    const r = await controlFetch(vps1Path(k.kit.cameraId, "link"), { method: "GET" }, 15_000);
    if (!r.ok) { res.status(r.status === 404 ? 404 : 502).json({ error: "Couldn't check the camera's connection." }); return; }
    res.json(r.body as LinkState);
  } catch {
    res.status(502).json({ error: "Couldn't check the camera's connection." });
  }
});

for (const what of ["router", "ftp"] as const) {
  router.post(`/kits/manage/:kitId/${what}`, async (req, res): Promise<void> => {
    const k = await connectedKit(req, res);
    if (!k) return;
    try {
      const r = await controlFetch(vps1Path(k.kit.cameraId, what), { method: "POST" }, 30_000);
      if (!r.ok) { res.status(503).json({ error: "Replay couldn't set this up right now. Try again in a minute." }); return; }
      logger.info({ kitId: k.kit.id, cameraId: k.kit.cameraId, what }, "Kit full-quality link issued");
      res.json(r.body);
    } catch {
      res.status(503).json({ error: "Replay couldn't set this up right now. Try again in a minute." });
    }
  });
  router.delete(`/kits/manage/:kitId/${what}`, async (req, res): Promise<void> => {
    const k = await connectedKit(req, res);
    if (!k) return;
    try {
      const r = await controlFetch(vps1Path(k.kit.cameraId, what), { method: "DELETE" }, 30_000);
      if (!r.ok) { res.status(502).json({ error: "Couldn't disconnect it. Try again." }); return; }
      res.json({ ok: true });
    } catch {
      res.status(502).json({ error: "Couldn't disconnect it. Try again." });
    }
  });
}

/** Kits are Replay hardware: only admins add them (with the camera name vps1 knows). */
router.post("/kits/manage", async (req, res): Promise<void> => {
  const user = await labsUser(req, res);
  if (!user) return;
  if (!user.isAdmin) { res.status(403).json({ error: "Ask Replay to add a camera to your account." }); return; }
  const body = kitBody.safeParse(req.body ?? {});
  if (!body.success) { res.status(400).json({ error: "Give the kit a name and the camera's name on the server (e.g. camera3)." }); return; }
  const [row] = await db.insert(cameraKitsTable).values({ ...body.data, academyId: body.data.academyId ?? null, token: newKitToken(), createdBy: user.id }).returning();
  res.status(201).json({ kit: kitView(row, null, "manage") });
});

router.patch("/kits/manage/:kitId", async (req, res): Promise<void> => {
  const user = await labsUser(req, res);
  if (!user) return;
  const k = await loadKit(req, res, user, "manage");
  if (!k) return;
  const body = kitBody.partial().extend({ archived: z.boolean().optional() }).safeParse(req.body ?? {});
  if (!body.success) { res.status(400).json({ error: "Check the details." }); return; }
  const { academyId, cameraId, archived, ...rest } = body.data;
  const adminOnly = user.isAdmin ? { ...(academyId !== undefined ? { academyId } : {}), ...(cameraId ? { cameraId } : {}), ...(archived !== undefined ? { archived } : {}) } : {};
  const [row] = await db.update(cameraKitsTable).set({ ...rest, ...adminOnly, updatedAt: new Date() }).where(eq(cameraKitsTable.id, k.kit.id)).returning();
  res.json({ kit: kitView(row, null, "manage") });
});

/**
 * Change the WiFi the camera joins (Reolink SetWifi through vps1). Only works while the
 * camera is online; it drops off this network and joins the new one.
 */
router.post("/kits/manage/:kitId/wifi", async (req, res): Promise<void> => {
  const user = await labsUser(req, res);
  if (!user) return;
  const k = await loadKit(req, res, user, "manage");
  if (!k) return;
  const body = z.object({ ssid: z.string().trim().min(1).max(32), password: z.string().min(8).max(63) }).safeParse(req.body ?? {});
  if (!body.success) { res.status(400).json({ error: "WiFi name, and a password of at least 8 characters." }); return; }
  try {
    const result = await controlFetch(`/kit/${encodeURIComponent(k.kit.cameraId)}/wifi`, { method: "POST", body: JSON.stringify(body.data) }, 30_000);
    if (!result.ok) {
      res.status(result.status === 404 ? 501 : 502).json({ error: result.status === 404 ? "Changing WiFi isn't switched on for this camera yet." : "The camera didn't take the change. Is it online?" });
      return;
    }
    const [row] = await db.update(cameraKitsTable).set({ wifiSsid: body.data.ssid, wifiPassword: body.data.password, updatedAt: new Date() }).where(eq(cameraKitsTable.id, k.kit.id)).returning();
    res.json({ kit: kitView(row, null, "manage") });
  } catch {
    res.status(502).json({ error: "The camera didn't answer." });
  }
});

router.post("/kits/setups/:setupId/review", async (req, res): Promise<void> => {
  const user = await labsUser(req, res);
  if (!user) return;
  const s = await loadSetup(req, res, user, "manage");
  if (!s) return;
  const body = z.object({ action: z.enum(["approve", "use_saved", "remeasure"]) }).safeParse(req.body ?? {});
  if (!body.success) { res.status(400).json({ error: "Approve, use the saved size, or measure again." }); return; }
  try {
    const row = await reviewSetup(s.setup, body.data.action, user.id);
    res.json({ setup: await setupView(row) });
  } catch (error) {
    fail(res, error, "Could not save the review");
  }
});

// ─── vps1 autocal worker ─────────────────────────────────────────────────────

function workerOk(req: Request, res: Response): boolean {
  const expected = process.env.ANALYSIS_WORKER_KEY ?? "";
  if (!expected) { res.status(503).json({ error: "This deployment has no ANALYSIS_WORKER_KEY set." }); return false; }
  if (!workerKeyMatches(expected, req.header("x-worker-key"))) { res.status(401).json({ error: "Bad worker key" }); return false; }
  return true;
}

router.get("/worker/kit-setups/pending", async (req, res): Promise<void> => {
  if (!workerOk(req, res)) return;
  try {
    res.json({ setups: await pendingCalibrations() });
  } catch (error) {
    fail(res, error, "Could not list set-ups");
  }
});

const calibrationBody = z.object({
  ok: z.boolean(),
  error: z.string().max(500).nullable().optional(),
  lengthM: z.number().positive().max(200).nullable().optional(),
  widthM: z.number().positive().max(150).nullable().optional(),
  tiltDeg: z.number().nullable().optional(),
  rollDeg: z.number().nullable().optional(),
  linesPx: z.number().nullable().optional(),
  circleAspectPct: z.number().nullable().optional(),
  statureM: z.number().nullable().optional(),
  warnings: z.array(z.string().max(300)).max(20).optional(),
  overlayUrl: z.string().url().max(500).nullable().optional(),
  pitchModel: z.unknown().optional(),
});

router.post("/worker/kit-setups/:setupId/calibration", async (req, res): Promise<void> => {
  if (!workerOk(req, res)) return;
  const id = intParam(req.params.setupId);
  const [setup] = id ? await db.select().from(cameraSetupsTable).where(eq(cameraSetupsTable.id, id)) : [];
  if (!setup) { res.status(404).json({ error: "Set-up not found" }); return; }
  if (setup.status !== "measuring") { res.status(409).json({ error: `Set-up is ${setup.status}, not measuring` }); return; }
  const body = calibrationBody.safeParse(req.body ?? {});
  if (!body.success) { res.status(400).json({ error: "Bad calibration" }); return; }
  try {
    const row = await applyCalibration(setup, body.data);
    res.json({ status: row.status, warnings: row.calibration?.warnings ?? [] });
  } catch (error) {
    fail(res, error, "Could not save the calibration");
  }
});

export default router;
