import { Router, type IRouter } from "express";
import { eq, sql } from "drizzle-orm";
import { db, savedClipsTable, likesTable, recordingsTable, clipsTable, usersTable } from "@workspace/db";
import { GetAccountStatsResponse, UpdateProfileResponse } from "@workspace/api-zod";
import { getLocalUserId, getLocalUserRecord } from "../lib/clerkUserBridge";

const router: IRouter = Router();

router.patch("/account/profile", async (req, res): Promise<void> => {
  const userId = await getLocalUserId(req);
  if (!userId) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }

  const { name, phone, position, age, gender } = req.body;
  const [updated] = await db
    .update(usersTable)
    .set({ name, phone, position, age, gender, profileComplete: true })
    .where(eq(usersTable.id, userId))
    .returning();

  if (!updated) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  res.json(UpdateProfileResponse.parse({
    id: updated.id,
    name: updated.name,
    email: updated.email,
    isGuest: updated.isGuest,
    phone: updated.phone ?? null,
    position: updated.position ?? null,
    age: updated.age ?? null,
    gender: updated.gender ?? null,
    profileComplete: updated.profileComplete,
  }));
});

router.get("/account/stats", async (req, res): Promise<void> => {
  const userId = await getLocalUserId(req);
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
