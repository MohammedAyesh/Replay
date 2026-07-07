import { Router, type IRouter } from "express";
import { eq, sql } from "drizzle-orm";
import { db, fieldsTable, clipsTable, recordingsTable } from "@workspace/db";
import {
  GetFieldParams,
  GetFieldResponse,
  ListFieldsResponse,
  GetFieldRecordingsParams,
  GetFieldRecordingsResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/fields", async (req, res): Promise<void> => {
  const fields = await db.select().from(fieldsTable).orderBy(fieldsTable.name);

  const fieldsWithCounts = await Promise.all(
    fields.map(async (f) => {
      const recordings = await db.select().from(recordingsTable).where(eq(recordingsTable.fieldId, f.id));
      const clips = await db
        .select({ count: sql<number>`count(*)` })
        .from(clipsTable)
        .innerJoin(recordingsTable, eq(clipsTable.recordingId, recordingsTable.id))
        .where(eq(recordingsTable.fieldId, f.id));
      const clipCount = Number(clips[0]?.count ?? 0);
      return {
        id: f.id,
        name: f.name,
        location: f.location,
        courts: f.courts,
        weight: f.weight,
        latitude: f.latitude ?? null,
        longitude: f.longitude ?? null,
        clipCount,
        lastRecordedAt: f.lastRecordedAt ? f.lastRecordedAt.toISOString() : null,
      };
    })
  );

  res.json(ListFieldsResponse.parse(fieldsWithCounts));
});

router.get("/fields/:id", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = GetFieldParams.safeParse({ id: parseInt(raw, 10) });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [field] = await db.select().from(fieldsTable).where(eq(fieldsTable.id, params.data.id));
  if (!field) {
    res.status(404).json({ error: "Field not found" });
    return;
  }

  const clips = await db
    .select({ count: sql<number>`count(*)` })
    .from(clipsTable)
    .innerJoin(recordingsTable, eq(clipsTable.recordingId, recordingsTable.id))
    .where(eq(recordingsTable.fieldId, field.id));

  res.json(
    GetFieldResponse.parse({
      id: field.id,
      name: field.name,
      location: field.location,
      courts: field.courts,
      weight: field.weight,
      latitude: field.latitude ?? null,
      longitude: field.longitude ?? null,
      clipCount: Number(clips[0]?.count ?? 0),
      lastRecordedAt: field.lastRecordedAt ? field.lastRecordedAt.toISOString() : null,
    })
  );
});

router.get("/fields/:id/recordings", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = GetFieldRecordingsParams.safeParse({ id: parseInt(raw, 10) });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const recordings = await db
    .select()
    .from(recordingsTable)
    .where(eq(recordingsTable.fieldId, params.data.id))
    .orderBy(recordingsTable.date);

  const [field] = await db.select().from(fieldsTable).where(eq(fieldsTable.id, params.data.id));

  res.json(
    GetFieldRecordingsResponse.parse(
      recordings.map((r) => ({
        id: r.id,
        fieldId: r.fieldId,
        court: r.court,
        date: r.date,
        timeSlot: r.timeSlot,
        duration: r.duration,
        score: r.score ?? null,
        videoUrl: r.videoUrl,
        highlightMoment: r.highlightMoment ?? null,
        fieldName: field?.name ?? null,
      }))
    )
  );
});

export default router;
