import { Router, type Request, type Response } from "express";
import { and, asc, desc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import {
  db, usersTable, fieldsTable, userClipsTable, footageRequestsTable,
  matchRoomsTable, matchPlayersTable, weeklyHighlightsTable,
  highlightClipsTable, highlightNoticesTable, claimMatchProgressTable, recordingsTable,
} from "@workspace/db";
import { getLocalUserId, unauthenticatedResponse } from "../lib/clerkUserBridge";
import { chooseHomeHighlight, currentReplayWeekStart, type HomeHighlightCandidate } from "../lib/weeklyHighlights";

const router = Router();
const validEvent = (value: unknown): value is "goal" | "assist" | "save" | "tackle" =>
  value === "goal" || value === "assist" || value === "save" || value === "tackle";
const validId = (value: unknown) => Number.isInteger(value) && Number(value) > 0;
const addDays = (day: string, n: number) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const isSaturday = (day: string) => new Date(`${day}T12:00:00Z`).getUTCDay() === 6;
const uniqueClips = <T extends { id: number }>(clips: T[]) =>
  [...new Map(clips.map((clip) => [clip.id, clip])).values()];

async function signedUser(req: Request, res: Response) {
  const id = await getLocalUserId(req);
  if (!id) { unauthenticatedResponse(res, req); return null; }
  const [user] = await db.select({ id: usersTable.id, isAdmin: usersTable.isAdmin, isGuest: usersTable.isGuest })
    .from(usersTable).where(eq(usersTable.id, id)).limit(1);
  if (!user || user.isGuest) { res.status(401).json({ error: "Sign in required" }); return null; }
  return user;
}

async function adminUser(req: Request, res: Response) {
  const user = await signedUser(req, res);
  if (user && !user.isAdmin) { res.status(403).json({ error: "Forbidden" }); return null; }
  return user;
}

async function getPayload(id: number) {
  const [highlight] = await db.select({
    id: weeklyHighlightsTable.id, userId: weeklyHighlightsTable.userId, fieldId: weeklyHighlightsTable.fieldId,
    weekStart: weeklyHighlightsTable.weekStart, title: weeklyHighlightsTable.title, clipCount: weeklyHighlightsTable.clipCount,
    durationSec: weeklyHighlightsTable.durationSec, status: weeklyHighlightsTable.status, publishedAt: weeklyHighlightsTable.publishedAt,
    fieldName: fieldsTable.name,
  }).from(weeklyHighlightsTable).innerJoin(fieldsTable, eq(fieldsTable.id, weeklyHighlightsTable.fieldId))
    .where(eq(weeklyHighlightsTable.id, id)).limit(1);
  if (!highlight) return null;
  const clips = await db.select({
    position: highlightClipsTable.position, clipId: userClipsTable.id, eventType: highlightClipsTable.eventType,
    minute: highlightClipsTable.minute, youX: highlightClipsTable.youX, youY: highlightClipsTable.youY,
    title: userClipsTable.title, startTime: userClipsTable.startTime, endTime: userClipsTable.endTime,
    matchCode: matchRoomsTable.code, clipMatchCode: userClipsTable.matchCode, matchDate: footageRequestsTable.startLocal,
    availableUntil: footageRequestsTable.shareExpiresAt,
  }).from(highlightClipsTable).innerJoin(userClipsTable, eq(userClipsTable.id, highlightClipsTable.clipId))
    .leftJoin(footageRequestsTable, eq(footageRequestsTable.id, userClipsTable.footageRequestId))
    .leftJoin(matchRoomsTable, eq(matchRoomsTable.footageRequestId, footageRequestsTable.id))
    .where(eq(highlightClipsTable.highlightId, id)).orderBy(asc(highlightClipsTable.position));
  return {
    ...highlight, kind: highlight.userId == null ? "field" : "personal", weekEnd: addDays(highlight.weekStart, 6),
    clips: clips.map((clip) => ({
      ...clip, matchCode: clip.matchCode ?? clip.clipMatchCode, videoUrl: `/api/user-clips/${clip.clipId}/playback`,
      previewUrl: `/api/user-clips/${clip.clipId}/playback`,
      matchDate: clip.matchDate?.slice(0, 10) ?? null,
      availableUntil: clip.availableUntil?.toISOString() ?? null,
    })),
  };
}

router.get("/highlights/home", async (req, res): Promise<void> => {
  const user = await signedUser(req, res);
  if (!user) return;
  const current = currentReplayWeekStart(new Date());
  const from = addDays(current, -7);
  const personalRows = await db.select({ id: weeklyHighlightsTable.id, weekStart: weeklyHighlightsTable.weekStart })
    .from(weeklyHighlightsTable).where(and(eq(weeklyHighlightsTable.userId, user.id), eq(weeklyHighlightsTable.status, "published"), gte(weeklyHighlightsTable.weekStart, from), lte(weeklyHighlightsTable.weekStart, current)))
    .orderBy(desc(weeklyHighlightsTable.weekStart)).limit(1);
  const personal: HomeHighlightCandidate | null = personalRows[0] ? { ...personalRows[0], kind: "personal" } : null;
  const latestMatch = await db.select({ fieldId: matchRoomsTable.fieldId }).from(matchPlayersTable)
    .innerJoin(matchRoomsTable, eq(matchRoomsTable.id, matchPlayersTable.matchId))
    .innerJoin(footageRequestsTable, eq(footageRequestsTable.id, matchRoomsTable.footageRequestId))
    .where(eq(matchPlayersTable.userId, user.id)).orderBy(desc(footageRequestsTable.startLocal)).limit(1);
  let field: HomeHighlightCandidate | null = null;
  if (latestMatch[0]) {
    const row = await db.select({ id: weeklyHighlightsTable.id, weekStart: weeklyHighlightsTable.weekStart })
      .from(weeklyHighlightsTable).where(and(isNull(weeklyHighlightsTable.userId), eq(weeklyHighlightsTable.fieldId, latestMatch[0].fieldId), eq(weeklyHighlightsTable.status, "published"), gte(weeklyHighlightsTable.weekStart, from), lte(weeklyHighlightsTable.weekStart, current)))
      .orderBy(desc(weeklyHighlightsTable.weekStart)).limit(1);
    field = row[0] ? { ...row[0], kind: "field" } : null;
  }
  const chosen = chooseHomeHighlight(personal, field, current);
  res.json(chosen ? await getPayload(chosen.id) : null);
});

router.get("/highlights/:id", async (req, res): Promise<void> => {
  const user = await signedUser(req, res);
  if (!user) return;
  const id = Number(req.params.id);
  const payload = Number.isInteger(id) ? await getPayload(id) : null;
  if (!payload || payload.status !== "published" || (payload.userId != null && payload.userId !== user.id && !user.isAdmin)) {
    res.status(404).json({ error: "Highlight not found" }); return;
  }
  res.json(payload);
});

router.get("/admin/weekly-highlights/candidates", async (req, res): Promise<void> => {
  if (!await adminUser(req, res)) return;
  const weekStart = String(req.query.weekStart ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart) || !isSaturday(weekStart)) { res.status(400).json({ error: "weekStart must be a Saturday" }); return; }
  const weekEnd = addDays(weekStart, 6);
  const participants = await db.select({
    userId: matchPlayersTable.userId, userName: usersTable.name, fieldId: matchRoomsTable.fieldId,
    fieldName: fieldsTable.name, requestId: footageRequestsTable.id,
  }).from(matchPlayersTable).innerJoin(matchRoomsTable, eq(matchRoomsTable.id, matchPlayersTable.matchId))
    .innerJoin(footageRequestsTable, eq(footageRequestsTable.id, matchRoomsTable.footageRequestId))
    .innerJoin(fieldsTable, eq(fieldsTable.id, matchRoomsTable.fieldId))
    .innerJoin(usersTable, eq(usersTable.id, matchPlayersTable.userId))
    .where(and(gte(footageRequestsTable.startLocal, weekStart), lte(footageRequestsTable.startLocal, `${weekEnd}T23:59:59`), eq(matchPlayersTable.rsvp, "in")));
  const playerIds = [...new Set(participants.map((p) => p.userId).filter((id): id is number => id != null))];
  const clipRows = playerIds.length ? await db.select({
    id: userClipsTable.id, userId: userClipsTable.userId, title: userClipsTable.title,
    startTime: userClipsTable.startTime, endTime: userClipsTable.endTime, exportedUrl: userClipsTable.exportedUrl,
    fieldId: footageRequestsTable.fieldId, fieldName: fieldsTable.name, requestId: footageRequestsTable.id,
  }).from(userClipsTable).innerJoin(footageRequestsTable, eq(footageRequestsTable.id, userClipsTable.footageRequestId))
    .innerJoin(fieldsTable, eq(fieldsTable.id, footageRequestsTable.fieldId))
    .where(and(inArray(userClipsTable.userId, playerIds), gte(footageRequestsTable.startLocal, weekStart), lte(footageRequestsTable.startLocal, `${weekEnd}T23:59:59`), eq(userClipsTable.isHidden, false), eq(userClipsTable.exportStatus, "done"))) : [];
  const fieldClipRows = await db.select({
    id: userClipsTable.id, title: userClipsTable.title, startTime: userClipsTable.startTime,
    endTime: userClipsTable.endTime, exportedUrl: userClipsTable.exportedUrl,
    fieldId: footageRequestsTable.fieldId, fieldName: fieldsTable.name,
  }).from(userClipsTable).innerJoin(footageRequestsTable, eq(footageRequestsTable.id, userClipsTable.footageRequestId))
    .innerJoin(fieldsTable, eq(fieldsTable.id, footageRequestsTable.fieldId))
    .where(and(gte(footageRequestsTable.startLocal, weekStart), lte(footageRequestsTable.startLocal, `${weekEnd}T23:59:59`), eq(userClipsTable.isHidden, false), eq(userClipsTable.exportStatus, "done")));
  // Clips saved directly from a recording page don't have a footageRequestId.
  // Match their source video to that week's recording so they can be selected
  // for the player and field highlights too.
  const recordingClipRows = await db.select({
    id: userClipsTable.id, userId: userClipsTable.userId, title: userClipsTable.title,
    startTime: userClipsTable.startTime, endTime: userClipsTable.endTime, exportedUrl: userClipsTable.exportedUrl,
    fieldId: recordingsTable.fieldId, fieldName: fieldsTable.name, requestId: sql<number>`0`,
  }).from(userClipsTable)
    .innerJoin(recordingsTable, sql`${recordingsTable.videoUrl} LIKE '%' || ${userClipsTable.videoId} || '%'`)
    .innerJoin(fieldsTable, eq(fieldsTable.id, recordingsTable.fieldId))
    .where(and(
      isNull(userClipsTable.footageRequestId),
      gte(recordingsTable.date, weekStart),
      lte(recordingsTable.date, weekEnd),
      eq(userClipsTable.isHidden, false),
      eq(userClipsTable.exportStatus, "done"),
    ));
  const progressRows = await db.select({
    userId: claimMatchProgressTable.userId, earnedClips: claimMatchProgressTable.earnedClips,
    fieldId: recordingsTable.fieldId, fieldName: fieldsTable.name,
  }).from(claimMatchProgressTable).innerJoin(recordingsTable, eq(recordingsTable.id, claimMatchProgressTable.recordingId))
    .innerJoin(fieldsTable, eq(fieldsTable.id, recordingsTable.fieldId))
    .where(and(gte(recordingsTable.date, weekStart), lte(recordingsTable.date, weekEnd)));
  const momentIds = [...new Set(progressRows.flatMap((r) => r.earnedClips.map((c) => c.userClipId).filter((id): id is number => typeof id === "number")))];
  const momentClips = momentIds.length ? await db.select().from(userClipsTable)
    .where(and(inArray(userClipsTable.id, momentIds), eq(userClipsTable.isHidden, false), eq(userClipsTable.exportStatus, "done"))) : [];
  const momentRows = momentClips.flatMap((clip) => {
    const progress = progressRows.find((row) => row.userId === clip.userId && row.earnedClips.some((earned) => earned.userClipId === clip.id));
    return progress && clip.exportedUrl ? [{ id: clip.id, userId: clip.userId, title: clip.title, startTime: clip.startTime, endTime: clip.endTime, exportedUrl: clip.exportedUrl, fieldId: progress.fieldId, fieldName: progress.fieldName, requestId: 0 }] : [];
  });
  const playerClipRows = uniqueClips([...clipRows, ...recordingClipRows, ...momentRows]);
  const players = playerIds.map((userId) => {
    const p = participants.find((x) => x.userId === userId)!;
    return { userId, name: p.userName, clips: playerClipRows.filter((c) => c.userId === userId && c.exportedUrl).map((c) => ({ ...c, durationSec: Math.max(0, Math.round(Number(c.endTime) - Number(c.startTime))) })) };
  });
  const fieldCandidateRows = uniqueClips([...fieldClipRows, ...recordingClipRows, ...momentRows]).filter((clip) => clip.exportedUrl);
  const savedRows = await db.select().from(weeklyHighlightsTable).where(eq(weeklyHighlightsTable.weekStart, weekStart));
  const saved = await Promise.all(savedRows.map(async (row) => ({
    userId: row.userId, fieldId: row.fieldId,
    clips: await db.select({ clipId: highlightClipsTable.clipId, eventType: highlightClipsTable.eventType, minute: highlightClipsTable.minute, youX: highlightClipsTable.youX, youY: highlightClipsTable.youY })
      .from(highlightClipsTable).where(eq(highlightClipsTable.highlightId, row.id)).orderBy(asc(highlightClipsTable.position)),
  })));
  res.json({
    weekStart, weekEnd, players,
    fields: [...new Map(fieldCandidateRows.map((c) => [c.fieldId, { id: c.fieldId, name: c.fieldName, clips: fieldCandidateRows.filter((x) => x.fieldId === c.fieldId).map((x) => ({ ...x, durationSec: Math.max(0, Math.round(Number(x.endTime) - Number(x.startTime))) })) }])).values()],
    saved,
  });
});

const saveOrPublishHighlights = async (req: Request, res: Response): Promise<void> => {
  if (!await adminUser(req, res)) return;
  const isPublishing = req.path.endsWith("/publish");
  const { weekStart, personal = [], fields = [] } = req.body ?? {};
  if (typeof weekStart !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(weekStart) || !isSaturday(weekStart) || !Array.isArray(personal) || !Array.isArray(fields)) { res.status(400).json({ error: "Invalid publish payload" }); return; }
  const all = [...personal.map((x: any) => ({ ...x, kind: "personal" })), ...fields.map((x: any) => ({ ...x, kind: "field" }))];
  if (all.some((x: any) => !validId(x.userId ?? x.fieldId) || !validId(x.fieldId) || !Array.isArray(x.clips) || x.clips.length < 1 || x.clips.length > (x.kind === "personal" ? 3 : 1) || new Set(x.clips.map((c: any) => c.clipId)).size !== x.clips.length || x.clips.some((c: any) => !validId(c.clipId) || !validEvent(c.eventType) || (c.minute != null && (!Number.isInteger(c.minute) || c.minute < 0 || c.minute > 180)) || (c.youX != null && (typeof c.youX !== "number" || c.youX < 0 || c.youX > 1)) || (c.youY != null && (typeof c.youY !== "number" || c.youY < 0 || c.youY > 1))))) { res.status(400).json({ error: "Choose 1–3 personal clips and one goal per field." }); return; }
  const published = await db.transaction(async (tx) => {
    const output: number[] = [];
    for (const group of all as any[]) {
      const userId = group.kind === "personal" ? group.userId : null;
      const fieldId = group.kind === "personal" ? group.fieldId : group.fieldId;
      const [field] = await tx.select({ name: fieldsTable.name }).from(fieldsTable).where(eq(fieldsTable.id, fieldId)).limit(1);
      if (!field) throw new Error("Field not found");
      const ids = group.clips.map((c: any) => c.clipId);
      const clips = await tx.select().from(userClipsTable).where(and(inArray(userClipsTable.id, ids), eq(userClipsTable.isHidden, false), eq(userClipsTable.exportStatus, "done")));
      if (clips.length !== ids.length || clips.some((c) => (group.kind === "personal" && c.userId !== userId) || !c.exportedUrl)) throw new Error("A selected clip is unavailable or not owned by the player.");
      const duration = clips.reduce((sum, c) => sum + Math.max(0, Math.round(Number(c.endTime) - Number(c.startTime))), 0);
      const title = userId == null ? `Best goal at ${field.name}` : `Your week in ${duration} sec`;
      const existing = await tx.select({ id: weeklyHighlightsTable.id }).from(weeklyHighlightsTable)
        .where(and(eq(weeklyHighlightsTable.weekStart, weekStart), eq(weeklyHighlightsTable.fieldId, fieldId), userId == null ? isNull(weeklyHighlightsTable.userId) : eq(weeklyHighlightsTable.userId, userId))).limit(1);
      let id = existing[0]?.id;
      if (id) await tx.update(weeklyHighlightsTable).set({ title, clipCount: ids.length, durationSec: duration, status: isPublishing ? "published" : "draft", publishedAt: isPublishing ? new Date() : null }).where(eq(weeklyHighlightsTable.id, id));
      else [{ id }] = await tx.insert(weeklyHighlightsTable).values({ userId, fieldId, weekStart, title, clipCount: ids.length, durationSec: duration, status: isPublishing ? "published" : "draft", publishedAt: isPublishing ? new Date() : null }).returning({ id: weeklyHighlightsTable.id });
      await tx.delete(highlightClipsTable).where(eq(highlightClipsTable.highlightId, id!));
      for (let i = 0; i < group.clips.length; i++) {
        const pick = group.clips[i];
        const clip = clips.find((c) => c.id === pick.clipId)!;
        const url = `/api/user-clips/${clip.id}/playback`;
        await tx.insert(highlightClipsTable).values({ highlightId: id!, position: i, clipId: clip.id, eventType: pick.eventType, minute: Number.isInteger(pick.minute) ? pick.minute : null, videoUrl: url, previewUrl: url, youX: pick.youX ?? null, youY: pick.youY ?? null });
      }
      if (isPublishing && userId != null) {
        await tx.insert(highlightNoticesTable).values({ userId, highlightId: id!, message: "Your week on Replay is ready ▶" }).onConflictDoUpdate({ target: [highlightNoticesTable.userId, highlightNoticesTable.highlightId], set: { status: "queued", message: "Your week on Replay is ready ▶" } });
      }
      output.push(id!);
    }
    return output;
  });
  if (isPublishing) {
    const notices = await db.select({
      id: highlightNoticesTable.id, userId: highlightNoticesTable.userId, userName: usersTable.name,
      highlightId: highlightNoticesTable.highlightId, message: highlightNoticesTable.message,
      status: highlightNoticesTable.status,
    }).from(highlightNoticesTable).innerJoin(usersTable, eq(usersTable.id, highlightNoticesTable.userId))
      .where(inArray(highlightNoticesTable.highlightId, published));
    res.json({ published, notices: notices.map((notice) => ({ ...notice, url: `/week/${notice.highlightId}` })) });
  } else res.json({ saved: published });
};
router.post("/admin/weekly-highlights/publish", saveOrPublishHighlights);
router.post("/admin/weekly-highlights/save", saveOrPublishHighlights);

router.get("/admin/weekly-highlights/notices", async (req, res): Promise<void> => {
  if (!await adminUser(req, res)) return;
  const rows = await db.select({ id: highlightNoticesTable.id, userId: highlightNoticesTable.userId, userName: usersTable.name, highlightId: highlightNoticesTable.highlightId, message: highlightNoticesTable.message, status: highlightNoticesTable.status })
    .from(highlightNoticesTable).innerJoin(usersTable, eq(usersTable.id, highlightNoticesTable.userId)).orderBy(desc(highlightNoticesTable.createdAt)).limit(100);
  res.json(rows.map((r) => ({ ...r, url: `/week/${r.highlightId}` })));
});

router.post("/admin/weekly-highlights/notices/:id/copied", async (req, res): Promise<void> => {
  if (!await adminUser(req, res)) return;
  const id = Number(req.params.id);
  if (!validId(id)) { res.status(400).json({ error: "Invalid notice id" }); return; }
  const [row] = await db.update(highlightNoticesTable).set({ status: "copied" }).where(eq(highlightNoticesTable.id, id)).returning({ id: highlightNoticesTable.id });
  if (!row) { res.status(404).json({ error: "Notice not found" }); return; }
  res.json({ ok: true });
});

export default router;
