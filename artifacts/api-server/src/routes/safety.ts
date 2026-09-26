import { Router, type Request, type Response } from "express";
import { and, count, desc, eq, or, sql } from "drizzle-orm";
import { z } from "zod/v4";
import {
  contentReportsTable,
  db,
  followsTable,
  friendshipsTable,
  userBlocksTable,
  userClipsTable,
  usersTable,
} from "@workspace/db";
import {
  getLocalAccountUserId,
  getLocalUserRecord,
  unauthenticatedResponse,
} from "../lib/clerkUserBridge";
import { avatarUrlFor } from "../lib/matchRooms";
import { shareCardPath } from "../lib/shareCard";
import { isBlockedEitherWay } from "../lib/safety";

const router = Router();
const reportReasons = ["nudity", "violence", "harassment", "hate", "spam", "personal_info", "im_in_this_clip", "other"] as const;
const reportBody = z.object({
  targetType: z.enum(["user_clip", "user"]),
  targetId: z.number().int().positive(),
  reason: z.enum(reportReasons),
  note: z.string().max(500).optional(),
});
const reportTimes = new Map<number, number[]>();

async function account(req: Request, res: Response): Promise<number | null> {
  const id = await getLocalAccountUserId(req);
  if (!id) {
    unauthenticatedResponse(res, req);
    return null;
  }
  return id;
}

function baseUrl(req: Request): string {
  const proto = (req.headers["x-forwarded-proto"] as string)?.split(",")[0] || req.protocol || "https";
  const host = (req.headers["x-forwarded-host"] as string)?.split(",")[0] || req.get("host") || "";
  return (process.env.PUBLIC_SHARE_BASE_URL || process.env.PUBLIC_BASE_URL || `${proto}://${host}`).replace(/\/$/, "");
}

function idParam(req: Request, name: string): number | null {
  const value = Array.isArray(req.params[name]) ? req.params[name][0] : req.params[name];
  const id = Number.parseInt(String(value), 10);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

router.post("/reports", async (req, res): Promise<void> => {
  const reporterId = await account(req, res);
  if (!reporterId) return;
  const parsed = reportBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid report" }); return; }
  const now = Date.now();
  const recent = (reportTimes.get(reporterId) ?? []).filter((at) => now - at < 24 * 60 * 60 * 1000);
  if (recent.length >= 20) { res.status(429).json({ error: "Too many reports", reason: "rate_limited" }); return; }

  const { targetType, targetId, reason, note } = parsed.data;
  let targetUserId: number;
  if (targetType === "user_clip") {
    const [clip] = await db.select({ id: userClipsTable.id, userId: userClipsTable.userId })
      .from(userClipsTable).where(eq(userClipsTable.id, targetId));
    if (!clip) { res.status(404).json({ error: "Clip not found" }); return; }
    if (clip.userId === reporterId) { res.status(400).json({ error: "Cannot report yourself", reason: "self" }); return; }
    targetUserId = clip.userId;
  } else {
    const [target] = await db.select({ id: usersTable.id, isGuest: usersTable.isGuest })
      .from(usersTable).where(eq(usersTable.id, targetId));
    if (!target || target.isGuest) { res.status(404).json({ error: "User not found" }); return; }
    if (target.id === reporterId) { res.status(400).json({ error: "Cannot report yourself", reason: "self" }); return; }
    targetUserId = target.id;
  }
  const [inserted] = await db.insert(contentReportsTable).values({
    reporterUserId: reporterId, targetType, targetId, targetUserId, reason, note: note ?? null,
  }).onConflictDoNothing({ target: [contentReportsTable.reporterUserId, contentReportsTable.targetType, contentReportsTable.targetId] }).returning();
  if (!inserted) { res.status(409).json({ error: "Already reported", reason: "already_reported" }); return; }
  recent.push(now); reportTimes.set(reporterId, recent);
  let hidden = false;
  if (targetType === "user_clip") {
    const [open] = await db.select({ n: count() }).from(contentReportsTable).where(and(
      eq(contentReportsTable.targetType, targetType), eq(contentReportsTable.targetId, targetId),
      eq(contentReportsTable.status, "open"),
    ));
    hidden = reason === "nudity" || Number(open?.n ?? 0) >= 3;
    if (hidden) await db.update(userClipsTable).set({ isHidden: true, hiddenReason: "reports" }).where(eq(userClipsTable.id, targetId));
  }
  res.status(201).json({ ok: true, hidden });
});

router.post("/blocks/:userId", async (req, res): Promise<void> => {
  const blockerId = await account(req, res); if (!blockerId) return;
  const blockedId = idParam(req, "userId");
  if (!blockedId) { res.status(400).json({ error: "Invalid user id" }); return; }
  if (blockedId === blockerId) { res.status(400).json({ error: "Cannot block yourself" }); return; }
  const [target] = await db.select({ id: usersTable.id, isGuest: usersTable.isGuest }).from(usersTable).where(eq(usersTable.id, blockedId));
  if (!target || target.isGuest) { res.status(404).json({ error: "User not found" }); return; }
  await db.transaction(async (tx) => {
    await tx.insert(userBlocksTable).values({ blockerId, blockedId }).onConflictDoNothing();
    await tx.delete(followsTable).where(or(
      and(eq(followsTable.followerId, blockerId), eq(followsTable.followeeId, blockedId)),
      and(eq(followsTable.followerId, blockedId), eq(followsTable.followeeId, blockerId)),
    ));
    const low = Math.min(blockerId, blockedId), high = Math.max(blockerId, blockedId);
    await tx.delete(friendshipsTable).where(and(eq(friendshipsTable.userLowId, low), eq(friendshipsTable.userHighId, high)));
  });
  res.json({ ok: true });
});

router.delete("/blocks/:userId", async (req, res): Promise<void> => {
  const blockerId = await account(req, res); if (!blockerId) return;
  const blockedId = idParam(req, "userId");
  if (!blockedId) { res.status(400).json({ error: "Invalid user id" }); return; }
  await db.delete(userBlocksTable).where(and(eq(userBlocksTable.blockerId, blockerId), eq(userBlocksTable.blockedId, blockedId)));
  res.json({ ok: true });
});

router.get("/blocks", async (req, res): Promise<void> => {
  const blockerId = await account(req, res); if (!blockerId) return;
  const rows = await db.select({
    userId: usersTable.id, name: usersTable.name, avatarPath: usersTable.avatarPath,
    blockedAt: userBlocksTable.createdAt,
  }).from(userBlocksTable).innerJoin(usersTable, eq(usersTable.id, userBlocksTable.blockedId))
    .where(eq(userBlocksTable.blockerId, blockerId)).orderBy(desc(userBlocksTable.createdAt));
  res.json(rows.map((row) => ({ userId: row.userId, name: row.name, avatarUrl: avatarUrlFor(row.userId, row.avatarPath), blockedAt: row.blockedAt.toISOString() })));
});

async function requireAdmin(req: Request, res: Response): Promise<number | null> {
  const user = await getLocalUserRecord(req);
  if (!user) { unauthenticatedResponse(res, req); return null; }
  if (!user.isAdmin) { res.status(403).json({ error: "Forbidden" }); return null; }
  return user.id;
}

async function reportRows(status: "open" | "history", req: Request) {
  const rows = await db.select({
    report: contentReportsTable, reporter: { id: usersTable.id, name: usersTable.name },
    targetUser: { id: sql<number>`target_user.id`, name: sql<string>`target_user.name`, isDisabled: sql<boolean>`target_user.is_disabled` },
    clip: userClipsTable,
  }).from(contentReportsTable)
    .leftJoin(usersTable, eq(contentReportsTable.reporterUserId, usersTable.id))
    .leftJoin(sql`users target_user`, sql`target_user.id = ${contentReportsTable.targetUserId}`)
    .leftJoin(userClipsTable, and(eq(contentReportsTable.targetType, "user_clip"), eq(contentReportsTable.targetId, userClipsTable.id)))
    .where(status === "open" ? eq(contentReportsTable.status, "open") : sql`${contentReportsTable.status} <> 'open'`)
    .orderBy(desc(contentReportsTable.createdAt));
  const base = baseUrl(req);
  return Promise.all(rows.map(async (row) => {
    const [open] = await db.select({ n: count() }).from(contentReportsTable).where(and(
      eq(contentReportsTable.targetType, row.report.targetType), eq(contentReportsTable.targetId, row.report.targetId), eq(contentReportsTable.status, "open"),
    ));
    return {
      id: row.report.id, targetType: row.report.targetType, targetId: row.report.targetId, reason: row.report.reason,
      note: row.report.note, status: row.report.status, createdAt: row.report.createdAt, reviewedAt: row.report.reviewedAt,
      actionTaken: row.report.actionTaken, reporter: row.reporter?.id ? row.reporter : null,
      targetUser: row.targetUser?.id ? row.targetUser : null, openReportsForTarget: Number(open?.n ?? 0),
      ...(row.clip ? { clip: {
        title: row.clip.title, visibility: row.clip.visibility, isHidden: row.clip.isHidden,
        hiddenReason: row.clip.hiddenReason, matchCode: row.clip.matchCode, footageRequestId: row.clip.footageRequestId,
        posterUrl: row.clip.posterPath ? `${base}${shareCardPath(row.clip.id)}/poster.jpg` : null,
      } } : {}),
    };
  }));
}

router.get("/admin/reports/open", async (req, res): Promise<void> => {
  if (!await requireAdmin(req, res)) return;
  res.json(await reportRows("open", req));
});
router.get("/admin/reports/history", async (req, res): Promise<void> => {
  if (!await requireAdmin(req, res)) return;
  res.json(await reportRows("history", req));
});

const resolveBody = z.object({ action: z.enum(["dismiss", "hide_clip", "unhide_clip", "remove_from_clip", "disable_user"]) });
router.post("/admin/reports/:id/resolve", async (req, res): Promise<void> => {
  const adminId = await requireAdmin(req, res); if (!adminId) return;
  const id = idParam(req, "id"); const parsed = resolveBody.safeParse(req.body);
  if (!id || !parsed.success) { res.status(400).json({ error: "Invalid resolution" }); return; }
  const [report] = await db.select().from(contentReportsTable).where(eq(contentReportsTable.id, id));
  if (!report) { res.status(404).json({ error: "Report not found" }); return; }
  const action = parsed.data.action;
  if (["hide_clip", "unhide_clip", "remove_from_clip"].includes(action) && report.targetType !== "user_clip") {
    res.status(400).json({ error: "This action requires a clip report", reason: "invalid_action" });
    return;
  }
  const status = action === "dismiss" ? "dismissed" : "actioned";
  const problem = await db.transaction(async (tx) => {
    if (action === "disable_user") {
      if (report.targetUserId === null) return "target_missing";
      const [target] = await tx.select({ isAdmin: usersTable.isAdmin }).from(usersTable)
        .where(eq(usersTable.id, report.targetUserId));
      if (!target) return "target_missing";
      if (target.isAdmin) return "admin_target";
      await tx.update(usersTable).set({ isDisabled: true }).where(eq(usersTable.id, report.targetUserId));
    } else if (action !== "dismiss") {
      const [clip] = await tx.select({ id: userClipsTable.id }).from(userClipsTable)
        .where(eq(userClipsTable.id, report.targetId));
      if (!clip) return "target_missing";
      const updates = action === "hide_clip" ? { isHidden: true, hiddenReason: "admin" as const }
        : action === "remove_from_clip" ? { isHidden: true, hiddenReason: "removal_request" as const }
          : { isHidden: false, hiddenReason: null };
      await tx.update(userClipsTable).set(updates).where(eq(userClipsTable.id, report.targetId));
    }
    await tx.update(contentReportsTable)
      .set({ status, reviewedBy: adminId, reviewedAt: new Date(), actionTaken: action })
      .where(and(
        eq(contentReportsTable.targetType, report.targetType),
        eq(contentReportsTable.targetId, report.targetId),
        eq(contentReportsTable.status, "open"),
      ));
    return null;
  });
  if (problem === "admin_target") {
    res.status(409).json({ error: "Cannot disable an administrator", reason: "admin_target" });
    return;
  }
  if (problem === "target_missing") {
    res.status(404).json({ error: "Report target not found", reason: "target_not_found" });
    return;
  }
  res.json({ ok: true });
});

export default router;