import { Router, type IRouter } from "express";
import { eq, desc } from "drizzle-orm";
import { db, recordingsTable, fieldsTable, usersTable } from "@workspace/db";
import { GetRecordingParams, GetRecordingResponse } from "@workspace/api-zod";
import { getLocalUserId } from "../lib/clerkUserBridge";

const router: IRouter = Router();

async function requireAdmin(req: Parameters<typeof getLocalUserId>[0]): Promise<number | null> {
  const userId = await getLocalUserId(req);
  if (!userId) return null;
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
  if (!user?.isAdmin) return null;
  return userId;
}

function toAdminRecording(r: typeof recordingsTable.$inferSelect, fieldName: string | null) {
  return {
    id: r.id,
    fieldId: r.fieldId,
    court: r.court,
    date: r.date,
    timeSlot: r.timeSlot,
    duration: r.duration,
    score: r.score ?? null,
    videoUrl: r.videoUrl,
    fieldName,
  };
}

// ─── Admin: recordings ─────────────────────────────────────────────────────────
// Backs the "link a field video" flow in the admin Academies tab: an admin
// picks a Bunny video already surfaced for a field and this turns it into a
// recordingsTable row, which can then be linked to an academy the same way a
// manually-entered recording would be.

router.get("/admin/recordings", async (req, res): Promise<void> => {
  const adminId = await requireAdmin(req);
  if (!adminId) { res.status(403).json({ error: "Forbidden" }); return; }

  const rows = await db
    .select({ recording: recordingsTable, fieldName: fieldsTable.name })
    .from(recordingsTable)
    .leftJoin(fieldsTable, eq(recordingsTable.fieldId, fieldsTable.id))
    .orderBy(desc(recordingsTable.createdAt));

  res.json(rows.map(({ recording, fieldName }) => toAdminRecording(recording, fieldName ?? null)));
});

router.post("/admin/recordings", async (req, res): Promise<void> => {
  const adminId = await requireAdmin(req);
  if (!adminId) { res.status(403).json({ error: "Forbidden" }); return; }

  const { fieldId, court, date, timeSlot, duration, score, videoUrl } = req.body as {
    fieldId?: number; court?: string; date?: string; timeSlot?: string;
    duration?: string; score?: string | null; videoUrl?: string;
  };

  if (!fieldId || !court?.trim() || !date?.trim() || !timeSlot?.trim() || !duration?.trim() || !videoUrl?.trim()) {
    res.status(400).json({ error: "fieldId, court, date, timeSlot, duration, and videoUrl are required" });
    return;
  }

  const [field] = await db.select().from(fieldsTable).where(eq(fieldsTable.id, fieldId));
  if (!field) { res.status(404).json({ error: "Field not found" }); return; }

  const [recording] = await db
    .insert(recordingsTable)
    .values({
      fieldId,
      court: court.trim(),
      date: date.trim(),
      timeSlot: timeSlot.trim(),
      duration: duration.trim(),
      score: score?.trim() || null,
      videoUrl: videoUrl.trim(),
    })
    .returning();

  res.status(201).json(toAdminRecording(recording, field.name));
});

router.get("/recordings/:id", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = GetRecordingParams.safeParse({ id: parseInt(raw, 10) });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [recording] = await db.select().from(recordingsTable).where(eq(recordingsTable.id, params.data.id));
  if (!recording) {
    res.status(404).json({ error: "Recording not found" });
    return;
  }

  const [field] = await db.select().from(fieldsTable).where(eq(fieldsTable.id, recording.fieldId));

  res.json(
    GetRecordingResponse.parse({
      id: recording.id,
      fieldId: recording.fieldId,
      court: recording.court,
      date: recording.date,
      timeSlot: recording.timeSlot,
      duration: recording.duration,
      score: recording.score ?? null,
      videoUrl: recording.videoUrl,
      highlightMoment: recording.highlightMoment ?? null,
      fieldName: field?.name ?? null,
    })
  );
});

export default router;
