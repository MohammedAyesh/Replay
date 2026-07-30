import { Router, type IRouter } from "express";
import { eq, and, sql } from "drizzle-orm";
import { db, usersTable, followsTable, userClipsTable } from "@workspace/db";
import { getLocalUserId } from "../lib/clerkUserBridge";

const router: IRouter = Router();

async function buildPublicProfile(targetId: number, viewerId: number | null) {
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, targetId));
  if (!user || user.isGuest) return null;

  const [followerResult] = await db
    .select({ count: sql<number>`count(*)` })
    .from(followsTable)
    .where(eq(followsTable.followeeId, targetId));

  const [followingResult] = await db
    .select({ count: sql<number>`count(*)` })
    .from(followsTable)
    .where(eq(followsTable.followerId, targetId));

  // User-created clips live in user_clips; clipsTable is the legacy editorial
  // table and its creator_id is never set by the clip editor, so counting it
  // showed "0 clips" on every creator's profile.
  const [clipResult] = await db
    .select({ count: sql<number>`count(*)` })
    .from(userClipsTable)
    .where(and(
      eq(userClipsTable.userId, targetId),
      eq(userClipsTable.visibility, "public"),
      eq(userClipsTable.isHidden, false),
    ));

  let isFollowing = false;
  if (viewerId && viewerId !== targetId) {
    const [existing] = await db
      .select()
      .from(followsTable)
      .where(and(eq(followsTable.followerId, viewerId), eq(followsTable.followeeId, targetId)));
    isFollowing = !!existing;
  }

  return {
    id: user.id,
    name: user.name,
    position: user.position ?? null,
    age: user.age ?? null,
    followerCount: Number(followerResult?.count ?? 0),
    followingCount: Number(followingResult?.count ?? 0),
    clipCount: Number(clipResult?.count ?? 0),
    isFollowing,
  };
}

router.get("/users/:id", async (req, res): Promise<void> => {
  const targetId = parseInt(req.params.id, 10);
  if (isNaN(targetId)) {
    res.status(400).json({ error: "Invalid user id" });
    return;
  }

  const viewerId = await getLocalUserId(req);
  const profile = await buildPublicProfile(targetId, viewerId);
  if (!profile) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  res.json(profile);
});

async function requireNonGuestViewer(req: Parameters<typeof getLocalUserId>[0]) {
  const viewerId = await getLocalUserId(req);
  if (!viewerId) return null;
  const [viewer] = await db
    .select({ id: usersTable.id, isGuest: usersTable.isGuest })
    .from(usersTable)
    .where(eq(usersTable.id, viewerId));
  if (!viewer || viewer.isGuest) return null;
  return viewerId;
}

router.post("/users/:id/follow", async (req, res): Promise<void> => {
  const targetId = parseInt(req.params.id, 10);
  if (isNaN(targetId)) {
    res.status(400).json({ error: "Invalid user id" });
    return;
  }

  const viewerId = await requireNonGuestViewer(req);
  if (!viewerId) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }

  const [target] = await db.select({ id: usersTable.id, isGuest: usersTable.isGuest }).from(usersTable).where(eq(usersTable.id, targetId));
  if (!target || target.isGuest) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  if (viewerId === targetId) {
    res.status(400).json({ error: "Cannot follow yourself" });
    return;
  }

  await db
    .insert(followsTable)
    .values({ followerId: viewerId, followeeId: targetId })
    .onConflictDoNothing();

  const [followerResult] = await db
    .select({ count: sql<number>`count(*)` })
    .from(followsTable)
    .where(eq(followsTable.followeeId, targetId));

  res.json({ following: true, followerCount: Number(followerResult?.count ?? 0) });
});

router.delete("/users/:id/follow", async (req, res): Promise<void> => {
  const targetId = parseInt(req.params.id, 10);
  if (isNaN(targetId)) {
    res.status(400).json({ error: "Invalid user id" });
    return;
  }

  const viewerId = await requireNonGuestViewer(req);
  if (!viewerId) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }

  const [target] = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.id, targetId));
  if (!target) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  await db
    .delete(followsTable)
    .where(and(eq(followsTable.followerId, viewerId), eq(followsTable.followeeId, targetId)));

  const [followerResult] = await db
    .select({ count: sql<number>`count(*)` })
    .from(followsTable)
    .where(eq(followsTable.followeeId, targetId));

  res.json({ following: false, followerCount: Number(followerResult?.count ?? 0) });
});

export default router;
