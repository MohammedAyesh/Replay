import { Router, type IRouter } from "express";
import { eq, and, desc } from "drizzle-orm";
import { db, userClipsTable } from "@workspace/db";
import {
  CreateUserClipBody,
  CreateUserClipResponse,
  ListUserClipsResponse,
  DeleteUserClipParams,
} from "@workspace/api-zod";
import { getLocalUserId } from "../lib/clerkUserBridge";
import { getBunnyPlaybackUrl, getBunnyThumbnailUrl, isBunnyConfigured } from "../lib/bunny";

const router: IRouter = Router();

router.post("/user-clips", async (req, res): Promise<void> => {
  const userId = await getLocalUserId(req);
  if (!userId) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }

  const body = CreateUserClipBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const { videoId, title, startTime, endTime, cropX, cropY, cropW, cropH } = body.data;

  const [row] = await db
    .insert(userClipsTable)
    .values({
      userId,
      videoId,
      title,
      startTime: String(startTime),
      endTime: String(endTime),
      cropX: String(cropX),
      cropY: String(cropY),
      cropW: String(cropW),
      cropH: String(cropH),
    })
    .returning();

  const thumbnailUrl = isBunnyConfigured() ? getBunnyThumbnailUrl(row.videoId) : null;
  const playbackUrl = isBunnyConfigured() ? getBunnyPlaybackUrl(row.videoId) : null;

  res.status(201).json(
    CreateUserClipResponse.parse({
      id: row.id,
      userId: row.userId,
      videoId: row.videoId,
      title: row.title,
      startTime: parseFloat(row.startTime),
      endTime: parseFloat(row.endTime),
      cropX: parseFloat(row.cropX),
      cropY: parseFloat(row.cropY),
      cropW: parseFloat(row.cropW),
      cropH: parseFloat(row.cropH),
      thumbnailUrl,
      playbackUrl,
      createdAt: row.createdAt.toISOString(),
    })
  );
});

router.get("/user-clips", async (req, res): Promise<void> => {
  const userId = await getLocalUserId(req);
  if (!userId) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }

  const rows = await db
    .select()
    .from(userClipsTable)
    .where(eq(userClipsTable.userId, userId))
    .orderBy(desc(userClipsTable.createdAt));

  const result = rows.map((row) => ({
    id: row.id,
    userId: row.userId,
    videoId: row.videoId,
    title: row.title,
    startTime: parseFloat(row.startTime),
    endTime: parseFloat(row.endTime),
    cropX: parseFloat(row.cropX),
    cropY: parseFloat(row.cropY),
    cropW: parseFloat(row.cropW),
    cropH: parseFloat(row.cropH),
    thumbnailUrl: isBunnyConfigured() ? getBunnyThumbnailUrl(row.videoId) : null,
    playbackUrl: isBunnyConfigured() ? getBunnyPlaybackUrl(row.videoId) : null,
    createdAt: row.createdAt.toISOString(),
  }));

  res.json(ListUserClipsResponse.parse(result));
});

router.delete("/user-clips/:id", async (req, res): Promise<void> => {
  const userId = await getLocalUserId(req);
  if (!userId) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }

  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = DeleteUserClipParams.safeParse({ id: parseInt(raw, 10) });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [existing] = await db
    .select()
    .from(userClipsTable)
    .where(eq(userClipsTable.id, params.data.id));

  if (!existing) {
    res.status(404).json({ error: "Clip not found" });
    return;
  }

  if (existing.userId !== userId) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  await db
    .delete(userClipsTable)
    .where(and(eq(userClipsTable.id, params.data.id), eq(userClipsTable.userId, userId)));

  res.json({ ok: true });
});

export default router;
