import { Router, type IRouter } from "express";
import { eq, sql } from "drizzle-orm";
import { db, savedClipsTable, likesTable, recordingsTable, clipsTable } from "@workspace/db";
import { GetAccountStatsResponse } from "@workspace/api-zod";
import { getUserId } from "./auth";

const router: IRouter = Router();

router.get("/account/stats", async (req, res): Promise<void> => {
  const userId = getUserId(req);
  if (!userId) {
    res.json(GetAccountStatsResponse.parse({ savedClips: 0, likesGiven: 0, fieldsVisited: 0 }));
    return;
  }

  const [savedResult] = await db
    .select({ count: sql<number>`count(*)` })
    .from(savedClipsTable)
    .where(eq(savedClipsTable.userId, userId));

  const [likesResult] = await db
    .select({ count: sql<number>`count(*)` })
    .from(likesTable)
    .where(eq(likesTable.userId, userId));

  // Fields visited = distinct fields from saved clips
  const savedClips = await db.select().from(savedClipsTable).where(eq(savedClipsTable.userId, userId));
  const fieldIds = new Set<number>();
  for (const sc of savedClips) {
    const [clip] = await db.select().from(clipsTable).where(eq(clipsTable.id, sc.clipId));
    if (clip) {
      const [rec] = await db.select().from(recordingsTable).where(eq(recordingsTable.id, clip.recordingId));
      if (rec) fieldIds.add(rec.fieldId);
    }
  }

  res.json(
    GetAccountStatsResponse.parse({
      savedClips: Number(savedResult?.count ?? 0),
      likesGiven: Number(likesResult?.count ?? 0),
      fieldsVisited: fieldIds.size,
    })
  );
});

export default router;
