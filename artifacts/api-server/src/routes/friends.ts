import { Router, type Request, type Response } from "express";
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod/v4";
import {
  db, friendshipsTable, matchPlayersTable, matchRoomsTable, usersTable,
} from "@workspace/db";
import { getLocalAccountUserId, unauthenticatedResponse } from "../lib/clerkUserBridge";
import { avatarUrlFor, publicBaseUrl } from "../lib/matchRooms";
import { acceptedFriendshipBetween, blockedEitherWay, friendshipBetween } from "../lib/friends";
import { DELETED_PLAYER_EMAIL } from "../lib/accountDeletion";

const router = Router();
const codeAlphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const requestTimes = new Map<number, number[]>();
const requestBody = z.object({ userId: z.number().int().positive() });

async function account(req: Request, res: Response): Promise<number | null> {
  const id = await getLocalAccountUserId(req);
  if (!id) { unauthenticatedResponse(res, req); return null; }
  return id;
}
function idParam(req: Request, key: string): number | null {
  const n = Number(req.params[key]);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}
function newCode(): string {
  let result = "";
  for (let i = 0; i < 8; i += 1) result += codeAlphabet[Math.floor(Math.random() * codeAlphabet.length)];
  return result;
}
function validTarget(user: { isGuest: boolean; isDisabled: boolean; email: string }): boolean {
  return !user.isGuest && !user.isDisabled && user.email !== DELETED_PLAYER_EMAIL;
}
function userItem(user: { id: number; name: string; avatarPath: string | null; position: string | null }, extra: Record<string, unknown> = {}) {
  return { ...extra, userId: user.id, name: user.name, avatarUrl: avatarUrlFor(user.id, user.avatarPath), position: user.position ?? null };
}

router.get("/friends", async (req, res): Promise<void> => {
  const viewer = await account(req, res); if (!viewer) return;
  const rows = await db.select({
    friendship: friendshipsTable,
    user: usersTable,
  }).from(friendshipsTable).innerJoin(usersTable, or(
    and(eq(friendshipsTable.userLowId, viewer), eq(usersTable.id, friendshipsTable.userHighId)),
    and(eq(friendshipsTable.userHighId, viewer), eq(usersTable.id, friendshipsTable.userLowId)),
  )).where(or(eq(friendshipsTable.userLowId, viewer), eq(friendshipsTable.userHighId, viewer)))
    .orderBy(desc(friendshipsTable.createdAt));
  const map = (kind: "friends" | "incoming" | "outgoing") => rows.filter(({ friendship }) =>
    kind === "friends" ? friendship.status === "accepted" : friendship.status === "pending" &&
      (kind === "incoming" ? friendship.requestedBy !== viewer : friendship.requestedBy === viewer),
  ).map(({ friendship, user }) => userItem(user, {
    requestId: friendship.id, since: friendship.respondedAt ?? friendship.createdAt,
  }));
  res.json({ friends: map("friends"), incoming: map("incoming"), outgoing: map("outgoing") });
});

router.get("/friends/suggestions", async (req, res): Promise<void> => {
  const viewer = await account(req, res); if (!viewer) return;
  const cutoff = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
  const viewerRows = await db.select({ matchId: matchPlayersTable.matchId }).from(matchPlayersTable)
    .innerJoin(matchRoomsTable, eq(matchRoomsTable.id, matchPlayersTable.matchId))
    .where(and(eq(matchPlayersTable.userId, viewer), inArray(matchPlayersTable.rsvp, ["in", "maybe"]), sql`${matchRoomsTable.createdAt} >= ${cutoff}`));
  const matchIds = Array.from(new Set(viewerRows.map((r) => r.matchId)));
  if (!matchIds.length) { res.json([]); return; }
  const candidates = await db.select({ user: usersTable, matchId: matchPlayersTable.matchId }).from(matchPlayersTable)
    .innerJoin(usersTable, eq(usersTable.id, matchPlayersTable.userId))
    .where(and(inArray(matchPlayersTable.matchId, matchIds), inArray(matchPlayersTable.rsvp, ["in", "maybe"]),
      sql`${usersTable.id} <> ${viewer}`, eq(usersTable.isGuest, false), eq(usersTable.isDisabled, false),
      sql`${usersTable.email} <> ${DELETED_PLAYER_EMAIL}`));
  const shared = new Map<number, { user: typeof candidates[number]["user"]; matchIds: Set<number> }>();
  for (const { user, matchId } of candidates) {
    let item = shared.get(user.id);
    if (!item) {
      item = { user, matchIds: new Set<number>() };
      shared.set(user.id, item);
    }
    item.matchIds.add(matchId);
  }
  const ranked = Array.from(shared.values()).sort((a, b) => b.matchIds.size - a.matchIds.size);
  const result = [];
  for (const { user, matchIds: sharedMatchIds } of ranked) {
    if (await blockedEitherWay(viewer, user.id) || await friendshipBetween(viewer, user.id)) continue;
    result.push(userItem(user, { matchesTogether: sharedMatchIds.size }));
    if (result.length >= 20) break;
  }
  res.json(result);
});

router.post("/friends/requests", async (req, res): Promise<void> => {
  const viewer = await account(req, res); if (!viewer) return;
  const parsed = requestBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid user id" }); return; }
  const targetId = parsed.data.userId;
  if (targetId === viewer) { res.status(400).json({ error: "Cannot befriend yourself" }); return; }
  const [target] = await db.select().from(usersTable).where(eq(usersTable.id, targetId));
  if (!target || !validTarget(target)) { res.status(404).json({ error: "User not found" }); return; }
  if (await blockedEitherWay(viewer, targetId)) { res.status(403).json({ error: "Blocked", reason: "blocked" }); return; }
  const existing = await friendshipBetween(viewer, targetId);
  if (existing?.status === "accepted") { res.status(409).json({ error: "Already friends", reason: "already_friends" }); return; }
  if (existing?.status === "pending") {
    if (existing.requestedBy !== viewer) {
      const [accepted] = await db.update(friendshipsTable).set({ status: "accepted", respondedAt: new Date() })
        .where(eq(friendshipsTable.id, existing.id)).returning();
      res.status(201).json({ requestId: accepted.id, status: "accepted" }); return;
    }
    res.status(409).json({ error: "Already requested", reason: "already_requested" }); return;
  }
  const now = Date.now();
  const recent = (requestTimes.get(viewer) ?? []).filter((at) => now - at < 86400000);
  if (recent.length >= 30) { res.status(429).json({ error: "Rate limited", reason: "rate_limited" }); return; }
  const [pending] = await db.select({ n: sql<number>`count(*)` }).from(friendshipsTable)
    .where(and(eq(friendshipsTable.requestedBy, viewer), eq(friendshipsTable.status, "pending")));
  if (Number(pending?.n ?? 0) >= 100) { res.status(429).json({ error: "Too many pending", reason: "too_many_pending" }); return; }
  let created;
  try {
    [created] = await db.insert(friendshipsTable).values({
      userLowId: Math.min(viewer, targetId), userHighId: Math.max(viewer, targetId), requestedBy: viewer,
    }).returning();
  } catch (error: unknown) {
    if ((error as { code?: string })?.code !== "23505") throw error;
    const raced = await friendshipBetween(viewer, targetId);
    if (raced?.status === "accepted") {
      res.status(409).json({ error: "Already friends", reason: "already_friends" }); return;
    }
    if (raced?.requestedBy === viewer) {
      res.status(409).json({ error: "Already requested", reason: "already_requested" }); return;
    }
    if (raced) {
      const [accepted] = await db.update(friendshipsTable).set({ status: "accepted", respondedAt: new Date() })
        .where(eq(friendshipsTable.id, raced.id)).returning();
      res.status(201).json({ requestId: accepted.id, status: "accepted" }); return;
    }
    throw error;
  }
  recent.push(now); requestTimes.set(viewer, recent);
  res.status(201).json({ requestId: created.id, status: "pending" });
});

router.post("/friends/requests/:id/accept", async (req, res): Promise<void> => {
  const viewer = await account(req, res); if (!viewer) return;
  const id = idParam(req, "id"); if (!id) { res.status(400).json({ error: "Invalid request id" }); return; }
  const [request] = await db.select().from(friendshipsTable).where(eq(friendshipsTable.id, id));
  if (!request || request.status !== "pending"
    || request.requestedBy === viewer
    || (request.userLowId !== viewer && request.userHighId !== viewer)) {
    res.status(404).json({ error: "Request not found" }); return;
  }
  const other = request.requestedBy;
  if (await blockedEitherWay(viewer, other)) { res.status(403).json({ error: "Blocked", reason: "blocked" }); return; }
  const [updated] = await db.update(friendshipsTable).set({ status: "accepted", respondedAt: new Date() }).where(eq(friendshipsTable.id, id)).returning();
  res.json({ requestId: updated.id, status: "accepted" });
});
router.post("/friends/requests/:id/decline", async (req, res): Promise<void> => {
  const viewer = await account(req, res); if (!viewer) return;
  const id = idParam(req, "id"); if (!id) { res.status(400).json({ error: "Invalid request id" }); return; }
  const [request] = await db.select().from(friendshipsTable).where(and(eq(friendshipsTable.id, id), eq(friendshipsTable.status, "pending")));
  if (!request || request.requestedBy === viewer
    || (request.userLowId !== viewer && request.userHighId !== viewer)) {
    res.status(404).json({ error: "Request not found" }); return;
  }
  await db.delete(friendshipsTable).where(eq(friendshipsTable.id, id)); res.json({ ok: true });
});
router.delete("/friends/:userId", async (req, res): Promise<void> => {
  const viewer = await account(req, res); if (!viewer) return;
  const target = idParam(req, "userId"); if (!target) { res.status(400).json({ error: "Invalid user id" }); return; }
  await db.delete(friendshipsTable).where(and(eq(friendshipsTable.userLowId, Math.min(viewer, target)), eq(friendshipsTable.userHighId, Math.max(viewer, target))));
  res.json({ ok: true });
});

async function makeLink(req: Request, res: Response, viewer: number, reset: boolean): Promise<void> {
  const [user] = await db.select({ friendCode: usersTable.friendCode }).from(usersTable).where(eq(usersTable.id, viewer));
  if (!reset && user?.friendCode) { res.json({ code: user.friendCode, url: `${publicBaseUrl(req)}/f/${user.friendCode}` }); return; }
  for (let i = 0; i < 8; i += 1) {
    const code = newCode();
    try {
      const [updated] = await db.update(usersTable).set({ friendCode: code }).where(and(
        eq(usersTable.id, viewer),
        ...(reset ? [] : [isNull(usersTable.friendCode)]),
      ))
        .returning({ friendCode: usersTable.friendCode });
      if (updated) { res.json({ code, url: `${publicBaseUrl(req)}/f/${code}` }); return; }
      if (!reset) {
        const [winner] = await db.select({ friendCode: usersTable.friendCode }).from(usersTable)
          .where(eq(usersTable.id, viewer));
        if (winner?.friendCode) {
          res.json({ code: winner.friendCode, url: `${publicBaseUrl(req)}/f/${winner.friendCode}` }); return;
        }
      }
    } catch (error: unknown) {
      if ((error as { code?: string })?.code !== "23505") throw error;
      // A unique-code collision is safe to retry with another generated code.
    }
  }
  res.status(500).json({ error: "Could not create link" });
}
router.get("/friends/link", async (req, res): Promise<void> => { const viewer = await account(req, res); if (viewer) await makeLink(req, res, viewer, false); });
router.post("/friends/link/reset", async (req, res): Promise<void> => { const viewer = await account(req, res); if (viewer) await makeLink(req, res, viewer, true); });
router.get("/friends/link/:code", async (req, res): Promise<void> => {
  const code = String(req.params.code).toUpperCase();
  const [user] = await db.select().from(usersTable).where(eq(usersTable.friendCode, code));
  if (!user || !validTarget(user)) { res.status(404).json({ error: "User not found" }); return; }
  res.json(userItem(user));
});
router.post("/friends/link/:code/accept", async (req, res): Promise<void> => {
  const viewer = await account(req, res); if (!viewer) return;
  const [target] = await db.select().from(usersTable).where(eq(usersTable.friendCode, String(req.params.code).toUpperCase()));
  if (!target || !validTarget(target)) { res.status(404).json({ error: "User not found" }); return; }
  if (target.id === viewer) { res.status(400).json({ error: "Cannot befriend yourself" }); return; }
  if (await blockedEitherWay(viewer, target.id)) { res.status(403).json({ error: "Blocked", reason: "blocked" }); return; }
  const existing = await friendshipBetween(viewer, target.id);
  if (existing?.status === "accepted") { res.status(409).json({ error: "Already friends", reason: "already_friends" }); return; }
  if (existing) await db.update(friendshipsTable).set({ status: "accepted", respondedAt: new Date() }).where(eq(friendshipsTable.id, existing.id));
  else await db.insert(friendshipsTable).values({ userLowId: Math.min(viewer, target.id), userHighId: Math.max(viewer, target.id), requestedBy: viewer, status: "accepted", respondedAt: new Date() });
  res.status(201).json({ status: "accepted" });
});

export default router;