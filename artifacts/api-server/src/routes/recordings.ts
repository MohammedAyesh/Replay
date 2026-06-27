import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, recordingsTable, fieldsTable } from "@workspace/db";
import { GetRecordingParams, GetRecordingResponse } from "@workspace/api-zod";

const router: IRouter = Router();

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
