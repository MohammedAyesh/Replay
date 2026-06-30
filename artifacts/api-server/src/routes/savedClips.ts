import { Router, type IRouter } from "express";
import { eq, and } from "drizzle-orm";
import { db, savedClipsTable, clipsTable, recordingsTable, fieldsTable, likesTable } from "@workspace/db";
import {
  SaveClipParams,
  UnsaveClipParams,
  ListSavedClipsResponse,
} from "@workspace/api-zod";
import { getLocalUserId } from "../lib/clerkUserBridge";

const router: IRouter = Router();

router.get("/saved-clips", async (req, res): Promise<void> => {
  const userId = await getLocalUserId(req);
  if (!userId) {
    res.json([]);
    return;
  }

  const saved = await db.select().from(savedClipsTable).where(eq(savedClipsTable.userId, userId));

  const result = await Promise.all(
    saved.map(async (s) => {
      const [clip] = await db.select().from(clipsTable).where(eq(clipsTable.id, s.clipId));
      if (!clip) return null;

      const [recording] = await db.select().from(recordingsTable).where(eq(recordingsTable.id, clip.recordingId));
      const [field] = recording ? await db.select().from(fieldsTable).where(eq(fieldsTable.id, recording.fieldId)) : [null];

      const [like] = await db
        .select()
        .from(likesTable)
        .where(and(eq(likesTable.userId, userId), eq(likesTable.clipId, s.clipId)));

      return {
        id: clip.id,
        recordingId: clip.recordingId,
        rank: clip.rank,
        momentLabel: clip.momentLabel,
        playerTags: clip.playerTags ?? [],
        likeCount: clip.likeCount,
        isLiked: !!like,
        isSaved: true,
        videoUrl: recording?.videoUrl ?? "",
        bunnyPlaybackUrl: clip.bunnyPlaybackUrl ?? null,
        bunnyVideoId: clip.bunnyVideoId ?? null,
        fieldName: field?.name ?? null,
        court: recording?.court ?? null,
        date: recording?.date ?? null,
      };
    })
  );

  res.json(ListSavedClipsResponse.parse(result.filter(Boolean)));
});

router.put("/saved-clips/:clipId", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.clipId) ? req.params.clipId[0] : req.params.clipId;
  const params = SaveClipParams.safeParse({ clipId: parseInt(raw, 10) });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const userId = await getLocalUserId(req);
  if (!userId) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }

  await db
    .insert(savedClipsTable)
    .values({ userId, clipId: params.data.clipId })
    .onConflictDoNothing();

  res.json({ ok: true });
});

router.delete("/saved-clips/:clipId", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.clipId) ? req.params.clipId[0] : req.params.clipId;
  const params = UnsaveClipParams.safeParse({ clipId: parseInt(raw, 10) });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const userId = await getLocalUserId(req);
  if (!userId) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }

  await db
    .delete(savedClipsTable)
    .where(and(eq(savedClipsTable.userId, userId), eq(savedClipsTable.clipId, params.data.clipId)));

  res.json({ ok: true });
});

export default router;
