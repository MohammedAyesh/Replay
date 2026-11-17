/**
 * Portable cameras (Labs, hidden): kits, set-ups and their calibration.
 *
 * A set-up is one kit at one pitch from mounting to stop. It books the kit's
 * camera through the same footage ledger as every other recording (on the kit's
 * hidden field), and when the footage and its analysis are in, vps1 measures the
 * pitch (autocal) and posts the result here. Whoever set up the mast typed its
 * height; nothing here assumes one.
 *
 * Whether the size can be trusted is decided here, not on vps1: within 3% of the
 * pitch's saved size (and the owner lets us) it is used straight away; otherwise
 * it waits for the owner on the Cameras page and stats show "pitch not confirmed".
 */
import crypto from "node:crypto";
import { and, desc, eq, inArray, like } from "drizzle-orm";
import {
  analysisJobsTable,
  cameraKitsTable,
  cameraSetupsTable,
  db,
  fieldsTable,
  footageRequestsTable,
  recordingsTable,
  venuePitchesTable,
  type CameraKit,
  type CameraSetup,
  type FootageRequest,
  type KitCalibration,
  type TrackingPitchModel,
} from "@workspace/db";

import { academyRolesForUser } from "./academyAccess";
import { cancelFootageRequest, createFootageRequest, startCameraJob } from "./footageBooking";
import { logger } from "./logger";
import { parsePitchModel } from "./pitchModel";
import { getSettingValue } from "./settings";
import { TRUSTED } from "./cameraKitModels";
import { ammanLocal, wallMinutes } from "./venues/core";

export const PORTABLE_SETTING = "labs.portableCameras";
/** Agreement with the saved size that is used without asking. */
export const AUTO_APPROVE_TOLERANCE = 0.03;
/** A recording shorter than this after Stop is not worth pulling. */
const MIN_RECORDING_MINUTES = 2;
export const SETUP_MINUTES = [60, 90, 120, 180, 240] as const;

export type KitUser = { id: number; isAdmin: boolean };
export type KitRole = "manage" | "use";

export class KitError extends Error {
  constructor(message: string, readonly status = 400, readonly code?: string) {
    super(message);
  }
}

// ─── Access ──────────────────────────────────────────────────────────────────

/** Hidden for now: admins, plus whoever an admin switched it on for (user, academy or field rule). */
export async function portableEnabled(user: KitUser, academyIds: number[] = []): Promise<boolean> {
  if (user.isAdmin) return true;
  try {
    if (await getSettingValue<boolean>(PORTABLE_SETTING, { userId: user.id }) === true) return true;
    for (const academyId of academyIds) {
      if (await getSettingValue<boolean>(PORTABLE_SETTING, { userId: user.id, academyId }) === true) return true;
    }
  } catch (error) {
    logger.warn({ error: (error as Error).message }, "Could not read the portable cameras setting; treating it as off");
  }
  return false;
}

/** Owners and managers run a kit's page; coaches can set it up and record. */
export async function kitRole(user: KitUser, kit: Pick<CameraKit, "academyId">): Promise<KitRole | null> {
  if (user.isAdmin) return "manage";
  if (kit.academyId == null) return null;
  const roles = await academyRolesForUser(user.id, kit.academyId);
  if (roles.includes("owner") || roles.includes("manager")) return "manage";
  return roles.length ? "use" : null;
}

export function newKitToken(): string {
  return crypto.randomBytes(12).toString("hex");
}

// ─── Wall time ───────────────────────────────────────────────────────────────

function wallFromMinutes(minutes: number): string {
  const d = new Date(minutes * 60_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** The window a set-up records: from this minute, for `minutes`. */
export function recordingWindow(now: Date, minutes: number): { startLocal: string; endLocal: string; seconds: number } {
  const start = wallMinutes(ammanLocal(now));
  return { startLocal: wallFromMinutes(start), endLocal: wallFromMinutes(start + minutes), seconds: minutes * 60 };
}

// ─── Kits ────────────────────────────────────────────────────────────────────

/**
 * The field the kit's recordings are filed under. A camera that already has a field (a fixed
 * camera taken off its pole) keeps it, so no second field ever shares a camera; a new camera
 * gets a hidden one. Decided once.
 */
export async function ensureKitField(kit: CameraKit): Promise<number> {
  if (kit.fieldId) return kit.fieldId;
  const [existing] = await db.select({ id: fieldsTable.id }).from(fieldsTable).where(eq(fieldsTable.cameraId, kit.cameraId)).orderBy(fieldsTable.id).limit(1);
  if (existing) {
    await db.update(cameraKitsTable).set({ fieldId: existing.id, updatedAt: new Date() }).where(eq(cameraKitsTable.id, kit.id));
    return existing.id;
  }
  const [field] = await db.insert(fieldsTable).values({
    name: `${kit.name} (portable)`,
    location: "",
    isHidden: true,
    cameraId: kit.cameraId,
  }).returning({ id: fieldsTable.id });
  await db.update(cameraKitsTable).set({ fieldId: field.id, updatedAt: new Date() }).where(eq(cameraKitsTable.id, kit.id));
  return field.id;
}

export async function kitsForUser(user: KitUser): Promise<Array<CameraKit & { role: KitRole }>> {
  const kits = await db.select().from(cameraKitsTable).where(eq(cameraKitsTable.archived, false)).orderBy(cameraKitsTable.name);
  const out: Array<CameraKit & { role: KitRole }> = [];
  for (const kit of kits) {
    const role = await kitRole(user, kit);
    if (role) out.push({ ...kit, role });
  }
  return out;
}

export async function latestSetups(kitIds: number[]): Promise<Map<number, CameraSetup>> {
  const map = new Map<number, CameraSetup>();
  if (!kitIds.length) return map;
  const rows = await db.select().from(cameraSetupsTable)
    .where(inArray(cameraSetupsTable.kitId, kitIds))
    .orderBy(desc(cameraSetupsTable.createdAt));
  for (const row of rows) if (!map.has(row.kitId)) map.set(row.kitId, row);
  return map;
}

// ─── Set-up state ────────────────────────────────────────────────────────────

/** Keep a set-up's status in step with its footage: a finished window moves on to measuring. */
export async function syncSetup(setup: CameraSetup, now = new Date()): Promise<CameraSetup> {
  if (setup.status !== "recording") return setup;
  let request: FootageRequest | undefined;
  if (setup.footageRequestId) {
    [request] = await db.select().from(footageRequestsTable).where(eq(footageRequestsTable.id, setup.footageRequestId));
  }
  let next: CameraSetup["status"] | null = null;
  if (request?.status === "failed" || request?.status === "cancelled") next = "failed";
  else if (request && (request.status === "ready" || request.status === "partial")) next = "measuring";
  else if (setup.endsAt && setup.endsAt.getTime() < now.getTime() - 60 * 60_000 && !request) next = "failed";
  if (!next) return setup;
  const [row] = await db.update(cameraSetupsTable)
    .set({ status: next, reviewNote: next === "failed" ? (request?.message ?? "The recording did not come through.") : setup.reviewNote, updatedAt: now })
    .where(and(eq(cameraSetupsTable.id, setup.id), eq(cameraSetupsTable.status, "recording")))
    .returning();
  return row ?? setup;
}

/** Called when a footage request completes (routes/owner.ts). */
export async function markKitFootageReady(requestId: number): Promise<void> {
  await db.update(cameraSetupsTable)
    .set({ status: "measuring", updatedAt: new Date() })
    .where(and(eq(cameraSetupsTable.footageRequestId, requestId), eq(cameraSetupsTable.status, "recording")));
}

/** Start recording now for `minutes`, on the kit's camera and hidden field. */
export async function startSetupRecording(setup: CameraSetup, kit: CameraKit, userId: number, minutes: number, now = new Date()): Promise<CameraSetup> {
  if (setup.status !== "setting_up") throw new KitError("This set-up is already recording.", 409);
  const busy = await db.select({ id: cameraSetupsTable.id }).from(cameraSetupsTable)
    .where(and(eq(cameraSetupsTable.kitId, kit.id), eq(cameraSetupsTable.status, "recording")));
  if (busy.length) throw new KitError("This camera is already recording somewhere. Stop that first.", 409, "kit_busy");
  const fieldId = await ensureKitField(kit);
  const window = recordingWindow(now, minutes);
  const request = await createFootageRequest({
    fieldId,
    cameraId: kit.cameraId,
    requestedBy: userId,
    startLocal: window.startLocal,
    endLocal: window.endLocal,
    requestedSeconds: window.seconds,
    rateFils: 0,
    academyId: setup.academyId,
    status: "scheduled",
  }, { startJob: false });
  await startCameraJob(request, kit.cameraId, { pan: false });
  const [started] = await db.select().from(footageRequestsTable).where(eq(footageRequestsTable.id, request.id));
  const failed = started?.status === "failed";
  const [row] = await db.update(cameraSetupsTable).set({
    status: failed ? "failed" : "recording",
    startedAt: now,
    endsAt: new Date(now.getTime() + minutes * 60_000),
    startLocal: window.startLocal,
    endLocal: window.endLocal,
    footageRequestId: request.id,
    reviewNote: failed ? (started?.message ?? "The camera didn't answer.") : null,
    updatedAt: now,
  }).where(eq(cameraSetupsTable.id, setup.id)).returning();
  if (failed) throw new KitError(started?.message ?? "The camera didn't answer. Check it's online and try again.", 502, "camera_unreachable");
  return row;
}

/**
 * Stop early: the booked window is cancelled on vps1 and the part that was played
 * is pulled from the SD card as a past window, so nothing recorded is lost.
 */
export async function stopSetupRecording(setup: CameraSetup, kit: CameraKit, userId: number, now = new Date()): Promise<CameraSetup> {
  if (setup.status !== "recording" || !setup.startLocal) throw new KitError("This set-up isn't recording.", 409);
  const [request] = setup.footageRequestId
    ? await db.select().from(footageRequestsTable).where(eq(footageRequestsTable.id, setup.footageRequestId))
    : [];
  if (request && (request.status === "ready" || request.status === "partial")) {
    const [row] = await db.update(cameraSetupsTable).set({ status: "measuring", stoppedAt: now, updatedAt: now }).where(eq(cameraSetupsTable.id, setup.id)).returning();
    return row;
  }
  if (request) {
    const result = await cancelFootageRequest(request, { message: "Stopped early from the camera set-up" });
    if ("error" in result) logger.warn({ setupId: setup.id, error: result.error }, "Could not cancel the set-up's booking");
  }
  const played = wallMinutes(ammanLocal(now)) - wallMinutes(setup.startLocal);
  if (!Number.isFinite(played) || played < MIN_RECORDING_MINUTES) {
    const [row] = await db.update(cameraSetupsTable).set({ status: "cancelled", stoppedAt: now, footageRequestId: request?.id ?? null, updatedAt: now })
      .where(eq(cameraSetupsTable.id, setup.id)).returning();
    return row;
  }
  const fieldId = await ensureKitField(kit);
  const endLocal = wallFromMinutes(wallMinutes(setup.startLocal) + played);
  const pull = await createFootageRequest({
    fieldId,
    cameraId: kit.cameraId,
    requestedBy: userId,
    startLocal: setup.startLocal,
    endLocal,
    requestedSeconds: played * 60,
    rateFils: 0,
    academyId: setup.academyId,
    status: "queued",
  });
  const [row] = await db.update(cameraSetupsTable).set({
    footageRequestId: pull.id,
    endLocal,
    endsAt: now,
    stoppedAt: now,
    status: pull.status === "failed" ? "failed" : "recording",
    reviewNote: pull.status === "failed" ? (pull.message ?? "The camera didn't answer.") : null,
    updatedAt: now,
  }).where(eq(cameraSetupsTable.id, setup.id)).returning();
  return row;
}

// ─── Calibration ─────────────────────────────────────────────────────────────

export type CalibrationInput = {
  ok: boolean;
  error?: string | null;
  lengthM?: number | null;
  widthM?: number | null;
  tiltDeg?: number | null;
  rollDeg?: number | null;
  linesPx?: number | null;
  circleAspectPct?: number | null;
  statureM?: number | null;
  warnings?: string[];
  overlayUrl?: string | null;
  pitchModel?: unknown;
};

export function sizeDisagreement(measured: { lengthM: number; widthM: number }, known: { lengthM: number; widthM: number }): number {
  return Math.max(
    Math.abs(measured.lengthM - known.lengthM) / known.lengthM,
    Math.abs(measured.widthM - known.widthM) / known.widthM,
  );
}

export async function knownSize(setup: CameraSetup): Promise<{ lengthM: number; widthM: number; autoApprove: boolean } | null> {
  if (setup.knownLengthM && setup.knownWidthM) return { lengthM: setup.knownLengthM, widthM: setup.knownWidthM, autoApprove: true };
  if (!setup.pitchId) return null;
  const [pitch] = await db.select().from(venuePitchesTable).where(eq(venuePitchesTable.id, setup.pitchId));
  if (!pitch?.lengthM || !pitch.widthM) return null;
  return { lengthM: pitch.lengthM, widthM: pitch.widthM, autoApprove: pitch.autoApproveSize };
}

/** What a posted measurement means for the set-up: used straight away, or wait for the owner. */
export function decide(
  input: CalibrationInput,
  known: { lengthM: number; widthM: number; autoApprove: boolean } | null,
): { status: "measured" | "needs_look"; reasons: string[] } {
  const reasons: string[] = [];
  if (!input.ok || !input.lengthM || !input.widthM) {
    reasons.push(input.error?.trim() || "We couldn't measure the pitch from this recording.");
    return { status: "needs_look", reasons };
  }
  for (const w of input.warnings ?? []) if (w.trim()) reasons.push(w.trim());
  if (known) {
    const off = sizeDisagreement({ lengthM: input.lengthM, widthM: input.widthM }, known);
    if (off > AUTO_APPROVE_TOLERANCE) {
      reasons.push(`Measured ${input.lengthM.toFixed(1)} × ${input.widthM.toFixed(1)} m, saved ${known.lengthM} × ${known.widthM} m (${Math.round(off * 100)}% off).`);
    } else if (!known.autoApprove) {
      reasons.push("You asked to approve every measurement yourself.");
    }
  }
  return { status: reasons.length ? "needs_look" : "measured", reasons };
}

export async function applyCalibration(setup: CameraSetup, input: CalibrationInput, now = new Date()): Promise<CameraSetup> {
  let model: TrackingPitchModel | null = null;
  if (input.pitchModel != null) {
    const parsed = parsePitchModel(input.pitchModel);
    if (parsed.error || !parsed.model) throw new KitError(parsed.error ?? "Invalid pitch model");
    model = parsed.model;
  }
  const verdict = decide({ ...input, ok: input.ok && model != null }, await knownSize(setup));
  const calibration: KitCalibration = {
    lengthM: input.lengthM ?? null,
    widthM: input.widthM ?? null,
    mastHeightM: setup.mastHeightM,
    tiltDeg: input.tiltDeg ?? null,
    rollDeg: input.rollDeg ?? null,
    linesPx: input.linesPx ?? null,
    circleAspectPct: input.circleAspectPct ?? null,
    statureM: input.statureM ?? null,
    warnings: verdict.reasons,
    overlayUrl: input.overlayUrl ?? null,
    source: "autocal",
  };
  const [row] = await db.update(cameraSetupsTable).set({
    status: verdict.status,
    calibration,
    pitchModel: model,
    measuredLengthM: input.lengthM ?? null,
    measuredWidthM: input.widthM ?? null,
    updatedAt: now,
  }).where(eq(cameraSetupsTable.id, setup.id)).returning();
  return row;
}

/** The measured model stretched to the saved size: same lines, the owner's metres. */
export function rescaleModel(model: TrackingPitchModel, from: { lengthM: number; widthM: number }, to: { lengthM: number; widthM: number }, now = new Date()): TrackingPitchModel {
  const sx = to.lengthM / from.lengthM;
  const sy = to.widthM / from.widthM;
  return {
    ...model,
    calibrationId: `${model.calibrationId}-saved-size`,
    fittedAt: now.toISOString(),
    pitchWidthMetres: model.pitchWidthMetres * sx,
    pitchHeightMetres: model.pitchHeightMetres * sy,
    grid: model.grid.map((r) => r.map((p) => ({ x: p.x * sx, y: p.y * sy }))),
  };
}

export async function reviewSetup(
  setup: CameraSetup,
  action: "approve" | "use_saved" | "remeasure",
  userId: number,
  now = new Date(),
): Promise<CameraSetup> {
  if (!["measured", "needs_look", "approved"].includes(setup.status)) throw new KitError("There's nothing to review yet.", 409);
  if (action === "remeasure") {
    const [row] = await db.update(cameraSetupsTable).set({ status: "measuring", reviewedBy: userId, reviewedAt: now, updatedAt: now })
      .where(eq(cameraSetupsTable.id, setup.id)).returning();
    return row;
  }
  if (!setup.pitchModel) throw new KitError("There's no measurement to approve. Measure again.", 409);
  let model = setup.pitchModel;
  if (action === "use_saved") {
    const known = await knownSize(setup);
    if (!known || !setup.measuredLengthM || !setup.measuredWidthM) throw new KitError("This pitch has no saved size.", 409);
    model = rescaleModel(model, { lengthM: setup.measuredLengthM, widthM: setup.measuredWidthM }, known, now);
  }
  const [row] = await db.update(cameraSetupsTable).set({
    status: "approved",
    pitchModel: model,
    reviewedBy: userId,
    reviewedAt: now,
    updatedAt: now,
  }).where(eq(cameraSetupsTable.id, setup.id)).returning();
  return row;
}

// ─── Views ───────────────────────────────────────────────────────────────────

export async function pitchMeasurements(pitchIds: number[]): Promise<Map<number, { lengthM: number; widthM: number; setups: number; mastHeightM: number; at: string }>> {
  const out = new Map<number, { lengthM: number; widthM: number; setups: number; mastHeightM: number; at: string }>();
  if (!pitchIds.length) return out;
  let rows: CameraSetup[];
  try {
    rows = await db.select().from(cameraSetupsTable).where(and(
      inArray(cameraSetupsTable.pitchId, pitchIds),
      inArray(cameraSetupsTable.status, [...TRUSTED]),
    )).orderBy(desc(cameraSetupsTable.createdAt));
  } catch {
    return out;
  }
  for (const s of rows) {
    if (!s.pitchId || !s.measuredLengthM || !s.measuredWidthM) continue;
    const seen = out.get(s.pitchId);
    if (seen) { seen.setups += 1; continue; }
    out.set(s.pitchId, { lengthM: s.measuredLengthM, widthM: s.measuredWidthM, setups: 1, mastHeightM: s.mastHeightM, at: s.createdAt.toISOString() });
  }
  return out;
}

export function kitView(kit: CameraKit, latest?: CameraSetup | null, role?: KitRole) {
  return {
    id: kit.id,
    name: kit.name,
    cameraId: kit.cameraId,
    academyId: kit.academyId,
    wifiSsid: kit.wifiSsid,
    wifiPassword: kit.wifiPassword,
    localUrl: kit.localUrl,
    token: role === "manage" ? kit.token : undefined,
    role: role ?? null,
    latest: latest ? { id: latest.id, status: latest.status, placeName: latest.placeName, pitchId: latest.pitchId, createdAt: latest.createdAt.toISOString(), startedAt: latest.startedAt?.toISOString() ?? null, endsAt: latest.endsAt?.toISOString() ?? null } : null,
  };
}

export async function setupView(setup: CameraSetup) {
  const [kit] = await db.select().from(cameraKitsTable).where(eq(cameraKitsTable.id, setup.kitId));
  const [pitch] = setup.pitchId ? await db.select().from(venuePitchesTable).where(eq(venuePitchesTable.id, setup.pitchId)) : [];
  const [request] = setup.footageRequestId ? await db.select().from(footageRequestsTable).where(eq(footageRequestsTable.id, setup.footageRequestId)) : [];
  const known = await knownSize(setup);
  return {
    id: setup.id,
    kitId: setup.kitId,
    kitName: kit?.name ?? null,
    cameraId: kit?.cameraId ?? null,
    academyId: setup.academyId,
    pitchId: setup.pitchId,
    pitchName: pitch?.name ?? setup.placeName,
    pitchNameAr: pitch?.nameAr ?? null,
    placeSize: pitch?.size ?? setup.placeSize,
    knownLengthM: known?.lengthM ?? null,
    knownWidthM: known?.widthM ?? null,
    mastHeightM: setup.mastHeightM,
    kind: setup.kind,
    title: setup.title,
    status: setup.status,
    viewConfirmedAt: setup.viewConfirmedAt?.toISOString() ?? null,
    startedAt: setup.startedAt?.toISOString() ?? null,
    endsAt: setup.endsAt?.toISOString() ?? null,
    stoppedAt: setup.stoppedAt?.toISOString() ?? null,
    startLocal: setup.startLocal,
    endLocal: setup.endLocal,
    footage: request ? { id: request.id, status: request.status, progress: request.progress, message: request.message, videoId: request.videoId } : null,
    calibration: setup.calibration ?? null,
    measuredLengthM: setup.measuredLengthM,
    measuredWidthM: setup.measuredWidthM,
    hasModel: setup.pitchModel != null,
    reviewNote: setup.reviewNote,
    reviewedAt: setup.reviewedAt?.toISOString() ?? null,
    createdBy: setup.createdBy,
    createdAt: setup.createdAt.toISOString(),
    wifiSsid: kit?.wifiSsid ?? null,
    wifiPassword: kit?.wifiPassword ?? null,
    localUrl: kit?.localUrl ?? null,
  };
}

// ─── Worker (vps1 autocal) ───────────────────────────────────────────────────

/** Set-ups whose footage is in and whose pitch is still to be measured. */
export async function pendingCalibrations() {
  const setups = await db.select().from(cameraSetupsTable).where(eq(cameraSetupsTable.status, "measuring")).orderBy(cameraSetupsTable.updatedAt).limit(20);
  const out = [];
  for (const s of setups) {
    const [kit] = await db.select().from(cameraKitsTable).where(eq(cameraKitsTable.id, s.kitId));
    const [request] = s.footageRequestId ? await db.select().from(footageRequestsTable).where(eq(footageRequestsTable.id, s.footageRequestId)) : [];
    if (!kit || !request?.videoId) continue;
    const [recording] = await db.select({ id: recordingsTable.id }).from(recordingsTable)
      .where(like(recordingsTable.videoUrl, `%/${request.videoId}/%`))
      .orderBy(desc(recordingsTable.id)).limit(1);
    const jobs = recording ? await db.select({ id: analysisJobsTable.id, status: analysisJobsTable.status })
      .from(analysisJobsTable).where(eq(analysisJobsTable.recordingId, recording.id)).orderBy(desc(analysisJobsTable.id)).limit(1) : [];
    const known = await knownSize(s);
    out.push({
      setupId: s.id,
      cameraId: kit.cameraId,
      videoId: request.videoId,
      startLocal: request.startLocal,
      endLocal: request.endLocal,
      mastHeightM: s.mastHeightM,
      knownLengthM: known?.lengthM ?? null,
      knownWidthM: known?.widthM ?? null,
      recordingId: recording?.id ?? null,
      analysisJobId: jobs[0]?.id ?? null,
      analysisStatus: jobs[0]?.status ?? null,
    });
  }
  return out;
}

