import { Router, type IRouter } from "express";
import { eq, desc, and } from "drizzle-orm";
import { db, clipsTable, recordingsTable, fieldsTable, savedClipsTable, likesTable } from "@workspace/db";
import {
  GetClipParams,
  GetClipResponse,
  ListClipsResponse,
  ToggleLikeParams,
  ToggleLikeResponse,
} from "@workspace/api-zod";
import { getLocalUserId } from "../lib/clerkUserBridge";

const router: IRouter = Router();

async function buildClip(clipId: number, userId: number | null) {
  const [clip] = await db.select().from(clipsTable).where(eq(clipsTable.id, clipId));
  if (!clip) return null;

  const [recording] = await db.select().from(recordingsTable).where(eq(recordingsTable.id, clip.recordingId));
  const [field] = recording ? await db.select().from(fieldsTable).where(eq(fieldsTable.id, recording.fieldId)) : [null];

  let isLiked = false;
  let isSaved = false;
  if (userId) {
    const [like] = await db
      .select()
      .from(likesTable)
      .where(and(eq(likesTable.userId, userId), eq(likesTable.clipId, clipId)));
    isLiked = !!like;

    const [saved] = await db
      .select()
      .from(savedClipsTable)
      .where(and(eq(savedClipsTable.userId, userId), eq(savedClipsTable.clipId, clipId)));
    isSaved = !!saved;
  }

  return {
    id: clip.id,
    recordingId: clip.recordingId,
    rank: clip.rank,
    momentLabel: clip.momentLabel,
    playerTags: clip.playerTags ?? [],
    likeCount: clip.likeCount,
    isLiked,
    isSaved,
    videoUrl: recording?.videoUrl ?? "",
    bunnyPlaybackUrl: clip.bunnyPlaybackUrl ?? null,
    bunnyVideoId: clip.bunnyVideoId ?? null,
    fieldName: field?.name ?? null,
    court: recording?.court ?? null,
    date: recording?.date ?? null,
  };
}

router.get("/clips", async (req, res): Promise<void> => {
  const userId = await getLocalUserId(req);
  const clips = await db.select().from(clipsTable).orderBy(desc(clipsTable.likeCount), clipsTable.rank);

  const result = await Promise.all(clips.map((c) => buildClip(c.id, userId)));
  res.json(ListClipsResponse.parse(result.filter(Boolean)));
});

router.get("/clips/:id", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = GetClipParams.safeParse({ id: parseInt(raw, 10) });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const userId = await getLocalUserId(req);
  const clip = await buildClip(params.data.id, userId);
  if (!clip) {
    res.status(404).json({ error: "Clip not found" });
    return;
  }

  res.json(GetClipResponse.parse(clip));
});

router.post("/clips/:id/like", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = ToggleLikeParams.safeParse({ id: parseInt(raw, 10) });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const userId = await getLocalUserId(req);
  if (!userId) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }

  const clipId = params.data.id;
  const [clip] = await db.select().from(clipsTable).where(eq(clipsTable.id, clipId));
  if (!clip) {
    res.status(404).json({ error: "Clip not found" });
    return;
  }

  const [existing] = await db
    .select()
    .from(likesTable)
    .where(and(eq(likesTable.userId, userId), eq(likesTable.clipId, clipId)));

  let liked: boolean;
  let newCount: number;

  if (existing) {
    await db
      .delete(likesTable)
      .where(and(eq(likesTable.userId, userId), eq(likesTable.clipId, clipId)));
    newCount = Math.max(0, clip.likeCount - 1);
    liked = false;
  } else {
    await db.insert(likesTable).values({ userId, clipId });
    newCount = clip.likeCount + 1;
    liked = true;
  }

  await db.update(clipsTable).set({ likeCount: newCount }).where(eq(clipsTable.id, clipId));

  res.json(ToggleLikeResponse.parse({ liked, likeCount: newCount }));
});

export default router;
