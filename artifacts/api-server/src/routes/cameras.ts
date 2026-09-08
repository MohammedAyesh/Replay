/**
 * Cameras, and the calibration each one owns.
 *
 * The pitch model used to be uploaded per recording, into that recording's
 * tracking manifest. That meant the same grid re-uploaded for every night's
 * footage, and a calibration discovered to be wrong could only be fixed one
 * recording at a time -- against a 14-day retention window, which usually
 * meant not at all.
 *
 * A camera on a mast sees the same pitch the same way every night, so the
 * calibration belongs to the camera. Upload it once here and every recording
 * that camera has ever shot, and every one it ever will, reads it.
 *
 * A camera exists here as soon as a field names one. `fields.camera_id` is
 * nullable free text with no foreign key, and this route follows it rather
 * than constraining it: the listing is the union of the rows in `cameras` and
 * every distinct camera any field names, so a newly-wired field shows up
 * immediately with no model rather than not showing up at all.
 */
import { Router, type IRouter } from "express";
import { eq, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import {
  camerasTable,
  db,
  fieldsTable,
  recordingTrackingBundlesTable,
  recordingsTable,
  usersTable,
} from "@workspace/db";

import { getLocalUserId } from "../lib/clerkUserBridge";
import { parsePitchModel, pitchModelSummary } from "../lib/pitchModel";
import { logger } from "../lib/logger";

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

/** A camera id is a bare name like "camera1"; keep it URL- and path-safe. */
const CameraId = z.string().trim().min(1).max(64).regex(
  /^[A-Za-z0-9._-]+$/,
  "A camera id may contain only letters, digits, dots, dashes and underscores",
);

const PitchModelBody = z.object({
  // Accepted either bare or wrapped, because the fitting tools emit both and
  // an admin uploading a file should not have to know which they have.
  pitchModel: z.unknown().optional(),
}).passthrough();

router.get("/admin/cameras", async (req, res): Promise<void> => {
  const adminId = await requireAdmin(req);
  if (!adminId) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const [rows, fieldRows] = await Promise.all([
    db.select().from(camerasTable),
    db
      .select({
        cameraId: fieldsTable.cameraId,
        fieldId: fieldsTable.id,
        fieldName: fieldsTable.name,
      })
      .from(fieldsTable)
      .where(isNotNull(fieldsTable.cameraId)),
  ]);

  const byId = new Map<string, {
    id: string;
    name: string;
    pitchModel: ReturnType<typeof pitchModelSummary>;
    pitchModelUpdatedAt: string | null;
    fields: Array<{ id: number; name: string }>;
  }>();
  for (const row of rows) {
    byId.set(row.id, {
      id: row.id,
      name: row.name || row.id,
      pitchModel: pitchModelSummary(row.pitchModel ?? undefined),
      pitchModelUpdatedAt: row.pitchModelUpdatedAt?.toISOString() ?? null,
      fields: [],
    });
  }
  for (const field of fieldRows) {
    const id = field.cameraId?.trim();
    if (!id) continue;
    // A field naming a camera that has no row yet is still a camera. It is
    // listed with no model rather than left invisible, because invisible is
    // how a field ends up with no metres and nobody noticing.
    const existing = byId.get(id) ?? {
      id,
      name: id,
      pitchModel: null,
      pitchModelUpdatedAt: null,
      fields: [] as Array<{ id: number; name: string }>,
    };
    existing.fields.push({ id: field.fieldId, name: field.fieldName });
    byId.set(id, existing);
  }

  const cameras = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  const counts = await db
    .select({
      cameraId: fieldsTable.cameraId,
      recordings: sql<number>`count(${recordingTrackingBundlesTable.id})`,
    })
    .from(recordingTrackingBundlesTable)
    .innerJoin(recordingsTable, eq(recordingsTable.id, recordingTrackingBundlesTable.recordingId))
    .innerJoin(fieldsTable, eq(fieldsTable.id, recordingsTable.fieldId))
    .groupBy(fieldsTable.cameraId);
  const bundleCounts = new Map(counts.map((row) => [row.cameraId ?? "", Number(row.recordings)]));

  res.json({
    cameras: cameras.map((camera) => ({
      ...camera,
      trackedRecordings: bundleCounts.get(camera.id) ?? 0,
    })),
  });
});

router.put("/admin/cameras/:id/pitch-model", async (req, res): Promise<void> => {
  const adminId = await requireAdmin(req);
  if (!adminId) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const id = CameraId.safeParse(req.params.id);
  if (!id.success) {
    res.status(400).json({ error: id.error.issues[0]?.message ?? "Invalid camera id" });
    return;
  }
  const body = PitchModelBody.safeParse(req.body ?? {});
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  // A file exported by a fitting tool may be the model itself or may wrap it.
  const source = body.data.pitchModel ?? req.body;
  const parsed = parsePitchModel(source);
  if (parsed.error || !parsed.model) {
    res.status(400).json({ error: parsed.error ?? "Invalid pitch model" });
    return;
  }

  const values = {
    id: id.data,
    name: id.data,
    pitchModel: parsed.model,
    pitchModelUpdatedAt: new Date(),
    pitchModelUpdatedBy: adminId,
    updatedAt: new Date(),
  };
  const [saved] = await db
    .insert(camerasTable)
    .values(values)
    .onConflictDoUpdate({
      target: camerasTable.id,
      // Not `name`: a camera someone has renamed keeps its name.
      set: {
        pitchModel: values.pitchModel,
        pitchModelUpdatedAt: values.pitchModelUpdatedAt,
        pitchModelUpdatedBy: values.pitchModelUpdatedBy,
        updatedAt: values.updatedAt,
      },
    })
    .returning();

  logger.info({
    cameraId: id.data,
    calibrationId: parsed.model.calibrationId,
    adminId,
  }, "camera pitch model replaced");
  res.json({
    id: saved.id,
    name: saved.name || saved.id,
    pitchModel: pitchModelSummary(saved.pitchModel ?? undefined),
    pitchModelUpdatedAt: saved.pitchModelUpdatedAt?.toISOString() ?? null,
  });
});

router.delete("/admin/cameras/:id/pitch-model", async (req, res): Promise<void> => {
  const adminId = await requireAdmin(req);
  if (!adminId) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const id = CameraId.safeParse(req.params.id);
  if (!id.success) {
    res.status(400).json({ error: id.error.issues[0]?.message ?? "Invalid camera id" });
    return;
  }
  const [saved] = await db
    .update(camerasTable)
    .set({
      pitchModel: null,
      pitchModelUpdatedAt: null,
      pitchModelUpdatedBy: null,
      updatedAt: new Date(),
    })
    .where(eq(camerasTable.id, id.data))
    .returning();
  if (!saved) {
    res.status(404).json({ error: "No such camera" });
    return;
  }
  logger.info({ cameraId: id.data, adminId }, "camera pitch model removed");
  res.json({
    id: saved.id,
    name: saved.name || saved.id,
    pitchModel: null,
    pitchModelUpdatedAt: null,
  });
});

export default router;
