import { Router, type IRouter } from "express";
import { and, eq, sql } from "drizzle-orm";
import {
  db,
  fieldsTable,
  clipsTable,
  recordingsTable,
  recordingTrackingBundlesTable,
  claimMatchProgressTable,
  claimMatchIdentityBindingsTable,
} from "@workspace/db";
import {
  GetFieldParams,
  GetFieldResponse,
  ListFieldsResponse,
  GetFieldRecordingsParams,
  GetFieldRecordingsResponse,
} from "@workspace/api-zod";
import { getLocalUserRecord } from "../lib/clerkUserBridge";

const router: IRouter = Router();

router.get("/fields", async (req, res): Promise<void> => {
  const fields = (await db.select().from(fieldsTable).orderBy(fieldsTable.name)).filter((f) => !f.isHidden);

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
        thumbnailUrl: f.thumbnailUrl ?? null,
        latitude: f.latitude ?? null,
        longitude: f.longitude ?? null,
        clipCount,
        lastRecordedAt: f.lastRecordedAt ? f.lastRecordedAt.toISOString() : null,
        clipsVisible: f.clipsVisible,
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
      thumbnailUrl: field.thumbnailUrl ?? null,
      latitude: field.latitude ?? null,
      longitude: field.longitude ?? null,
      clipCount: Number(clips[0]?.count ?? 0),
      lastRecordedAt: field.lastRecordedAt ? field.lastRecordedAt.toISOString() : null,
      clipsVisible: field.clipsVisible,
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

  const viewer = await getLocalUserRecord(req);
  const viewerId = viewer && !viewer.isGuest ? viewer.id : null;
  const viewerProgressJoin = viewerId
    ? and(eq(claimMatchProgressTable.userId, viewerId), eq(claimMatchProgressTable.recordingId, recordingsTable.id))
    : sql`false`;
  const viewerBindingJoin = viewerId
    ? and(eq(claimMatchIdentityBindingsTable.userId, viewerId), eq(claimMatchIdentityBindingsTable.recordingId, recordingsTable.id))
    : sql`false`;

  const recordings = await db
    .select({
      recording: recordingsTable,
      hasTrackingBundle: recordingTrackingBundlesTable.id,
      viewerProgressId: claimMatchProgressTable.id,
      viewerClaimState: claimMatchIdentityBindingsTable.state,
    })
    .from(recordingsTable)
    .where(eq(recordingsTable.fieldId, params.data.id))
    .leftJoin(
      recordingTrackingBundlesTable,
      eq(recordingTrackingBundlesTable.recordingId, recordingsTable.id),
    )
    .leftJoin(claimMatchProgressTable, viewerProgressJoin)
    .leftJoin(claimMatchIdentityBindingsTable, viewerBindingJoin)
    .orderBy(recordingsTable.date);

  const [field] = await db.select().from(fieldsTable).where(eq(fieldsTable.id, params.data.id));

  res.json(
    GetFieldRecordingsResponse.parse(
      recordings.map(({ recording, hasTrackingBundle, viewerProgressId, viewerClaimState }) => ({
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
        hasTracking: hasTrackingBundle !== null,
        viewerHasClaim: viewerClaimState !== null,
        viewerClaimState: viewerClaimState ?? (viewerProgressId !== null ? "in_progress" : null),
      }))
    )
  );
});

export default router;
