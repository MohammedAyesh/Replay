import { Router, type IRouter } from "express";
import { eq, and, asc, desc, inArray, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import {
  db,
  usersTable,
  followsTable,
  userClipsTable,
  recordingsTable,
  fieldsTable,
  recordingTrackingBundlesTable,
  recordingTrackingSegmentsTable,
  claimMatchCorrectionsTable,
  claimMatchIdentityBindingsTable,
  claimMatchOffPitchSpansTable,
  type TrackingManifest,
  type TrackingSegmentPayload,
  type ClaimMatchComputedPlayerStats,
} from "@workspace/db";
import { GetPublicPlayerStatsResponse } from "@workspace/api-zod";
import { getLocalAccountUserId, getLocalUserId, unauthenticatedResponse } from "../lib/clerkUserBridge";
import { isRecordingVisible } from "../lib/recordingVisibility";
import { readClaimSegment } from "../lib/claimMatchStorage";
import { deriveClaimState } from "./claimMatch";
import { normaliseOffPitchSpans } from "./claimOffPitch";

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

async function readFullBundleSegments(bundleId: number): Promise<TrackingSegmentPayload[]> {
  const rows = await db
    .select()
    .from(recordingTrackingSegmentsTable)
    .where(eq(recordingTrackingSegmentsTable.bundleId, bundleId))
    .orderBy(asc(recordingTrackingSegmentsTable.segmentIndex));
  const segments: TrackingSegmentPayload[] = [];
  for (const row of rows) {
    const body = await readClaimSegment(row.objectPath);
    segments.push(JSON.parse(body.toString("utf8")) as TrackingSegmentPayload);
  }
  return segments;
}

function roundStat(value: number): number {
  return Math.round(value * 100) / 100;
}

function timestampForFingerprint(value: Date | string | null | undefined): string {
  if (value instanceof Date) return value.toISOString();
  return typeof value === "string" ? value : "";
}

async function publicStatsInputFingerprint(
  userId: number,
  recordingId: number,
  bundleFingerprint: string,
): Promise<string> {
  const [correctionMeta, offPitchMeta] = await Promise.all([
    db
      .select({
        count: sql<number>`count(*)`,
        latestAt: sql<Date | null>`max(${claimMatchCorrectionsTable.updatedAt})`,
      })
      .from(claimMatchCorrectionsTable)
      .where(and(
        eq(claimMatchCorrectionsTable.userId, userId),
        eq(claimMatchCorrectionsTable.recordingId, recordingId),
      )),
    db
      .select({
        count: sql<number>`count(*)`,
        latestAt: sql<Date | null>`max(${claimMatchOffPitchSpansTable.createdAt})`,
      })
      .from(claimMatchOffPitchSpansTable)
      .where(and(
        eq(claimMatchOffPitchSpansTable.userId, userId),
        eq(claimMatchOffPitchSpansTable.recordingId, recordingId),
      )),
  ]);
  const input = [
    bundleFingerprint,
    Number(correctionMeta[0]?.count ?? 0),
    timestampForFingerprint(correctionMeta[0]?.latestAt),
    Number(offPitchMeta[0]?.count ?? 0),
    timestampForFingerprint(offPitchMeta[0]?.latestAt),
  ];
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

function isComputedPlayerStats(value: unknown): value is ClaimMatchComputedPlayerStats {
  if (!value || typeof value !== "object") return false;
  const stats = value as Partial<ClaimMatchComputedPlayerStats>;
  return typeof stats.minutesPlayed === "number"
    && (stats.distanceMetres === null || typeof stats.distanceMetres === "number")
    && typeof stats.humanVouchedSeconds === "number"
    && typeof stats.inferredSeconds === "number"
    && typeof stats.offPitchSeconds === "number"
    && !!stats.heatmap
    && (stats.heatmap.coordinateSpace === "pitch" || stats.heatmap.coordinateSpace === "camera")
    && Array.isArray(stats.heatmap.cells);
}

router.get("/users/:id/stats", async (req, res): Promise<void> => {
  const targetId = parseInt(req.params.id, 10);
  if (isNaN(targetId)) {
    res.status(400).json({ error: "Invalid user id" });
    return;
  }

  const [target] = await db
    .select({ id: usersTable.id, isGuest: usersTable.isGuest })
    .from(usersTable)
    .where(eq(usersTable.id, targetId));
  if (!target || target.isGuest) {
    res.status(404).json({ error: "Player not found" });
    return;
  }

  const [bindings, reviewClaims] = await Promise.all([
    db
      .select()
      .from(claimMatchIdentityBindingsTable)
      .where(and(
        eq(claimMatchIdentityBindingsTable.userId, targetId),
        eq(claimMatchIdentityBindingsTable.state, "confirmed"),
      ))
      .orderBy(desc(claimMatchIdentityBindingsTable.updatedAt)),
    db
      .select({ id: claimMatchIdentityBindingsTable.id })
      .from(claimMatchIdentityBindingsTable)
      .where(and(
        eq(claimMatchIdentityBindingsTable.userId, targetId),
        inArray(claimMatchIdentityBindingsTable.state, ["disputed", "needs_resolution"]),
      )),
  ]);

  const matches: Array<{
    recordingId: number;
    title: string;
    date: string;
    minutesPlayed: number;
    distanceMetres: number | null;
    humanVouchedSeconds: number;
    inferredSeconds: number;
    offPitchSeconds: number;
    heatmap: {
      coordinateSpace: "pitch" | "camera";
      cells: Array<{ x: number; y: number; weight: number }>;
    };
  }> = [];

  for (const binding of bindings) {
    const [row] = await db
      .select({
        recording: recordingsTable,
        fieldName: fieldsTable.name,
        bundle: recordingTrackingBundlesTable,
      })
      .from(recordingsTable)
      .leftJoin(fieldsTable, eq(fieldsTable.id, recordingsTable.fieldId))
      .innerJoin(
        recordingTrackingBundlesTable,
        eq(recordingTrackingBundlesTable.id, binding.trackingBundleId),
      )
      .where(eq(recordingsTable.id, binding.recordingId));

    if (!row?.bundle?.manifest || !(await isRecordingVisible(row.recording))) continue;

    const bundleFingerprint = binding.bundleFingerprint || "legacy";
    const inputFingerprint = await publicStatsInputFingerprint(
      targetId,
      binding.recordingId,
      bundleFingerprint,
    );
    let computedStats = binding.computedStats;
    const hasFreshStats = binding.statsInputFingerprint === inputFingerprint
      && isComputedPlayerStats(computedStats);

    if (!hasFreshStats) {
      const [corrections, offPitchRows, fullSegments] = await Promise.all([
        db
          .select()
          .from(claimMatchCorrectionsTable)
          .where(and(
            eq(claimMatchCorrectionsTable.userId, targetId),
            eq(claimMatchCorrectionsTable.recordingId, binding.recordingId),
          ))
          .orderBy(desc(claimMatchCorrectionsTable.createdAt)),
        db
          .select()
          .from(claimMatchOffPitchSpansTable)
          .where(and(
            eq(claimMatchOffPitchSpansTable.userId, targetId),
            eq(claimMatchOffPitchSpansTable.recordingId, binding.recordingId),
          )),
        readFullBundleSegments(binding.trackingBundleId),
      ]);
      const manifest = row.bundle.manifest as TrackingManifest;
      const stateSegments = manifest.summary?.segments?.length
        ? manifest.summary.segments
        : fullSegments;
      const derived = deriveClaimState(
        manifest,
        stateSegments,
        corrections,
        fullSegments,
        normaliseOffPitchSpans(offPitchRows, manifest.duration),
      );
      computedStats = {
        minutesPlayed: derived.playerStats.minutesPlayed,
        distanceMetres: derived.playerStats.distanceMetres,
        humanVouchedSeconds: roundStat(derived.humanVouchedSeconds),
        inferredSeconds: roundStat(derived.inferredSeconds),
        offPitchSeconds: roundStat(derived.offPitchSeconds),
        heatmap: derived.playerStats.heatmap,
      };
      await db
        .update(claimMatchIdentityBindingsTable)
        .set({
          computedStats,
          statsComputedAt: new Date(),
          statsInputFingerprint: inputFingerprint,
        })
        .where(eq(claimMatchIdentityBindingsTable.id, binding.id));
    }
    if (!isComputedPlayerStats(computedStats)) continue;
    matches.push({
      recordingId: binding.recordingId,
      title: row.fieldName ? `${row.fieldName} · ${row.recording.court}` : row.recording.court,
      date: row.recording.date,
      minutesPlayed: computedStats.minutesPlayed,
      distanceMetres: computedStats.distanceMetres,
      humanVouchedSeconds: computedStats.humanVouchedSeconds,
      inferredSeconds: computedStats.inferredSeconds,
      offPitchSeconds: computedStats.offPitchSeconds,
      heatmap: computedStats.heatmap,
    });
  }

  matches.sort((a, b) => b.date.localeCompare(a.date) || b.recordingId - a.recordingId);
  const totalDistanceMetres = matches.every((match) => match.distanceMetres !== null)
    ? roundStat(matches.reduce((sum, match) => sum + (match.distanceMetres ?? 0), 0))
    : null;

  res.json(GetPublicPlayerStatsResponse.parse({
    matches,
    totals: {
      totalMatchesClaimed: matches.length,
      totalMinutesPlayed: roundStat(matches.reduce((sum, match) => sum + match.minutesPlayed, 0)),
      totalDistanceMetres,
      totalHumanVouchedSeconds: roundStat(matches.reduce((sum, match) => sum + match.humanVouchedSeconds, 0)),
      totalInferredSeconds: roundStat(matches.reduce((sum, match) => sum + match.inferredSeconds, 0)),
      totalOffPitchSeconds: roundStat(matches.reduce((sum, match) => sum + match.offPitchSeconds, 0)),
    },
    excludedClaimCount: reviewClaims.length,
  }));
});

async function requireNonGuestViewer(req: Parameters<typeof getLocalAccountUserId>[0]) {
  const viewerId = await getLocalAccountUserId(req);
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
    unauthenticatedResponse(res, req);
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
    unauthenticatedResponse(res, req);
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
