import { Router, type IRouter } from "express";
import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import {
  db,
  clipsTable,
  fieldsTable,
  footageRequestsTable,
  recordingsTable,
  recordingViewsTable,
  recordingTrackingBundlesTable,
  userClipsTable,
  usersTable,
} from "@workspace/db";
import {
  ListAdminOwnerRecordingsResponse,
  GetRecordingParams,
  GetRecordingResponse,
  GetRecordingViewersParams,
  GetRecordingViewersResponse,
  RecordRecordingViewBody,
  RecordRecordingWatchTimeBody,
} from "@workspace/api-zod";
import { getLocalUserId } from "../lib/clerkUserBridge";
import {
  createPublicFootageContext,
  extractBunnyVideoId,
  isPublicRecordingInContext,
} from "../lib/publicFootage";
import {
  BUNNY_CDN_HOSTNAME,
  getBunnyPlaybackUrl,
  getBunnyProxiedPlaybackUrl,
  getBunnyProxiedThumbnailUrl,
  isBunnyConfigured,
  isBunnyStorageConfigured,
} from "../lib/bunny";
import { courtFromCamera } from "../lib/liveAnalysis";
import {
  hasStoragePlaylist,
  hasUhdPlaylist,
  isStreamlessStorageVideoUrl,
  normalizeUhdVideoGuid,
  streamlessStoragePlaylistUrl,
  storageRenditionPlaylistUrl,
  storagePlaybackProxyUrl,
  storageThumbnailProxyUrl,
  uhdPlaybackUrl,
} from "../lib/uhdPlayback";

const router: IRouter = Router();

async function requireAdmin(req: Parameters<typeof getLocalUserId>[0]): Promise<number | null> {
  const userId = await getLocalUserId(req);
  if (!userId) return null;
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
  if (!user?.isAdmin) return null;
  return userId;
}

function toAdminRecording(
  r: typeof recordingsTable.$inferSelect,
  fieldName: string | null,
  hasTrackingBundle = false,
  trackingManifest: {
    segmentCount?: number;
    frameCount?: number;
    videoStartSeconds?: number;
    pitchModel?: {
      calibrationId?: string;
      fittedAt?: string;
      calibratedAspectRatio?: number;
      pitchWidthMetres: number;
      pitchHeightMetres: number;
      grid: Array<Array<unknown>>;
    };
  } | null = null,
) {
  const videoId = extractBunnyVideoId(r.videoUrl);
  const thumbnailUrl = isStreamlessStorageVideoUrl(r.videoUrl)
    ? videoId && isBunnyStorageConfigured() ? storageThumbnailProxyUrl(videoId) : null
    : videoId && isBunnyConfigured() ? getBunnyProxiedThumbnailUrl(videoId) : null;
  return {
    id: r.id,
    fieldId: r.fieldId,
    court: r.court,
    date: r.date,
    timeSlot: r.timeSlot,
    duration: r.duration,
    score: r.score ?? null,
    videoUrl: r.videoUrl,
    thumbnailUrl,
    isVisible: r.isVisible,
    fieldName,
    hasTrackingBundle,
    trackingSegmentCount: trackingManifest?.segmentCount ?? null,
    trackingFrameCoverage: trackingManifest
      ? `0-${Math.max(0, (trackingManifest.frameCount ?? 1) - 1)} (${trackingManifest.frameCount ?? 0} frames)`
      : null,
    trackingVideoStartSeconds: trackingManifest?.videoStartSeconds ?? 0,
    // No trackingPitchModel here on purpose: a stored per-recording model is
    // no longer what applies. The camera's model is attached at read time and
    // a stale stored one is stripped, so reporting the manifest's copy would
    // name a calibration that is not in use. Ask /admin/cameras instead.
  };
}

// ─── Admin: recordings ─────────────────────────────────────────────────────────
// Backs the "link a field video" flow in the admin Academies tab: an admin
// picks a Bunny video already surfaced for a field and this turns it into a
// recordingsTable row, which can then be linked to an academy the same way a
// manually-entered recording would be.

router.get("/admin/recordings", async (req, res): Promise<void> => {
  const adminId = await requireAdmin(req);
  if (!adminId) { res.status(403).json({ error: "Forbidden" }); return; }

  const rows = await db
    .select({
      recording: recordingsTable,
      fieldName: fieldsTable.name,
       hasTrackingBundle: recordingTrackingBundlesTable.id,
       trackingManifest: recordingTrackingBundlesTable.manifest,
    })
    .from(recordingsTable)
    .leftJoin(fieldsTable, eq(recordingsTable.fieldId, fieldsTable.id))
    .leftJoin(
      recordingTrackingBundlesTable,
      eq(recordingTrackingBundlesTable.recordingId, recordingsTable.id),
    )
    .orderBy(desc(recordingsTable.createdAt));

  const ownerRequests = await db.select({
    id: footageRequestsTable.id,
    videoId: footageRequestsTable.videoId,
    cameraId: footageRequestsTable.cameraId,
    startLocal: footageRequestsTable.startLocal,
    shareToken: footageRequestsTable.shareToken,
  }).from(footageRequestsTable)
    .where(and(
      isNull(footageRequestsTable.academyId),
      inArray(footageRequestsTable.status, ["ready", "partial"]),
      isNotNull(footageRequestsTable.videoId),
    ));
  const ownerTitlesByVideoId = new Map<string, string>();
  for (const ownerRequest of ownerRequests) {
    if (!/^s-[a-f0-9]{32}$/i.test(ownerRequest.shareToken ?? "") || !ownerRequest.videoId) continue;
    ownerTitlesByVideoId.set(
      ownerRequest.videoId.toLowerCase(),
      `${courtFromCamera(ownerRequest.cameraId)}_owner-${ownerRequest.id}_${ownerRequest.startLocal.trim().replace(/\s+/g, "_")}`,
    );
  }

  const response: Array<ReturnType<typeof toAdminRecording> & {
    uhdPlaybackUrl: string | null;
    hasUhdPlayback: boolean;
    has8kPlayback: boolean;
    ownerBookingTitle: string | null;
  }> = [];
  for (let offset = 0; offset < rows.length; offset += 8) {
    const batch = await Promise.all(rows.slice(offset, offset + 8).map(async ({
      recording, fieldName, hasTrackingBundle, trackingManifest,
    }) => {
      const videoId = extractBunnyVideoId(recording.videoUrl ?? "");
      const streamlessStorage = isStreamlessStorageVideoUrl(recording.videoUrl);
      const [hasUhdPlayback, has8kPlayback] = videoId
        ? await Promise.all([
          hasUhdPlaylist(videoId),
          streamlessStorage ? hasStoragePlaylist(videoId, "8k") : Promise.resolve(false),
        ])
        : [false, false];
      return {
        ...toAdminRecording(recording, fieldName ?? null, hasTrackingBundle !== null, trackingManifest),
        uhdPlaybackUrl: uhdPlaybackUrl(videoId),
        hasUhdPlayback,
        has8kPlayback,
        ownerBookingTitle: videoId ? ownerTitlesByVideoId.get(videoId.toLowerCase()) ?? null : null,
      };
    }));
    response.push(...batch);
  }
  res.json(response);
});

router.get("/admin/owner-recordings", async (req, res): Promise<void> => {
  const adminId = await requireAdmin(req);
  if (!adminId) { res.status(403).json({ error: "Forbidden" }); return; }

  const rows = await db
    .select({
      request: footageRequestsTable,
      fieldName: fieldsTable.name,
    })
    .from(footageRequestsTable)
    .innerJoin(fieldsTable, eq(footageRequestsTable.fieldId, fieldsTable.id))
    .where(and(
      isNull(footageRequestsTable.academyId),
      eq(footageRequestsTable.status, "ready"),
      isNotNull(footageRequestsTable.videoId),
    ))
    .orderBy(desc(footageRequestsTable.readyAt), desc(footageRequestsTable.createdAt));

  const response = (await Promise.all(rows.map(async ({ request, fieldName }) => {
    if (!/^s-[a-f0-9]{32}$/i.test(request.shareToken ?? "")) return [];
    const videoId = normalizeUhdVideoGuid(request.videoId);
    if (!videoId) return [];
    const playbackUrl = await streamlessStoragePlaylistUrl(storageRenditionPlaylistUrl(videoId, "h264"));
    return [{
      id: request.id,
      fieldId: request.fieldId,
      fieldName,
      startLocal: request.startLocal,
      endLocal: request.endLocal,
      requestedSeconds: request.requestedSeconds,
      deliveredSeconds: request.deliveredSeconds,
      readyAt: request.readyAt?.toISOString() ?? null,
      videoId,
      thumbnailUrl: storageThumbnailProxyUrl(videoId),
      playbackUrl: playbackUrl ?? "",
    }];
  }))).flat();

  res.json(ListAdminOwnerRecordingsResponse.parse(response));
});

router.get("/admin/recordings/:id/viewers", async (req, res): Promise<void> => {
  const adminId = await requireAdmin(req);
  if (!adminId) { res.status(403).json({ error: "Forbidden" }); return; }
  const parsedParams = GetRecordingViewersParams.safeParse({ id: req.params.id });
  if (!parsedParams.success) {
    res.status(400).json({ error: "Invalid recording id" });
    return;
  }
  const recordingId = parsedParams.data.id;
  const [recording] = await db.select({ id: recordingsTable.id, videoUrl: recordingsTable.videoUrl }).from(recordingsTable)
    .where(eq(recordingsTable.id, recordingId));
  if (!recording) { res.status(404).json({ error: "Recording not found" }); return; }

  const viewers = await db.select({
    userId: usersTable.id,
    name: usersTable.name,
    email: usersTable.email,
    isGuest: usersTable.isGuest,
    viewCount: recordingViewsTable.viewCount,
    watchedSeconds: recordingViewsTable.watchedSeconds,
    firstViewedAt: recordingViewsTable.firstViewedAt,
    lastViewedAt: recordingViewsTable.lastViewedAt,
  }).from(recordingViewsTable)
    .innerJoin(usersTable, eq(usersTable.id, recordingViewsTable.viewerUserId))
    .where(eq(recordingViewsTable.recordingId, recordingId))
    .orderBy(desc(recordingViewsTable.lastViewedAt));
  const videoId = extractBunnyVideoId(recording.videoUrl ?? "");
  const clips = videoId
    ? await db.select({ userId: userClipsTable.userId, total: sql<number>`count(*)::int` })
      .from(userClipsTable)
      .where(eq(userClipsTable.videoId, videoId))
      .groupBy(userClipsTable.userId)
    : [];
  const clipsByUser = new Map(clips.map((row) => [row.userId, row.total]));
  res.json(GetRecordingViewersResponse.parse(viewers.map((viewer) => ({
    ...viewer,
    name: viewer.isGuest ? "Guest" : viewer.name,
    email: viewer.isGuest ? null : viewer.email,
    clipCount: clipsByUser.get(viewer.userId) ?? 0,
  }))));
});

router.post("/recording-views", async (req, res): Promise<void> => {
  const viewerId = await getLocalUserId(req);
  if (!viewerId) { res.status(401).json({ error: "Sign in required" }); return; }
  const parsedBody = RecordRecordingViewBody.safeParse(req.body);
  if (!parsedBody.success) {
    res.status(400).json({ error: parsedBody.error.message });
    return;
  }
  const { fieldId, videoId } = parsedBody.data;
  const [viewer] = await db.select({ isGuest: usersTable.isGuest }).from(usersTable)
    .where(eq(usersTable.id, viewerId));
  if (!viewer) { res.status(204).end(); return; }

  const [field] = await db.select().from(fieldsTable).where(eq(fieldsTable.id, fieldId));
  if (!field) { res.status(404).json({ error: "Recording not found" }); return; }
  const candidates = await db.select().from(recordingsTable).where(eq(recordingsTable.fieldId, fieldId));
  const recording = candidates.find((candidate) =>
    extractBunnyVideoId(candidate.videoUrl)?.toLowerCase() === videoId.toLowerCase(),
  );
  if (!recording) { res.status(204).end(); return; }
  const context = await createPublicFootageContext(req, [fieldId]);
  if (!isPublicRecordingInContext(recording, field, context)) {
    res.status(404).json({ error: "Recording not found" });
    return;
  }
  await db.insert(recordingViewsTable).values({ recordingId: recording.id, viewerUserId: viewerId })
    .onConflictDoUpdate({
      target: [recordingViewsTable.recordingId, recordingViewsTable.viewerUserId],
      set: {
        viewCount: sql`${recordingViewsTable.viewCount} + 1`,
        lastViewedAt: new Date(),
      },
    });
  res.status(204).end();
});

router.post("/recording-views/watch-time", async (req, res): Promise<void> => {
  const viewerId = await getLocalUserId(req);
  if (!viewerId) { res.status(401).json({ error: "Sign in required" }); return; }
  const parsedBody = RecordRecordingWatchTimeBody.safeParse(req.body);
  if (!parsedBody.success) {
    res.status(400).json({ error: parsedBody.error.message });
    return;
  }
  const { fieldId, videoId, seconds } = parsedBody.data;
  const [viewer] = await db.select({ isGuest: usersTable.isGuest }).from(usersTable)
    .where(eq(usersTable.id, viewerId));
  if (!viewer) { res.status(204).end(); return; }
  const [field] = await db.select().from(fieldsTable).where(eq(fieldsTable.id, fieldId));
  if (!field) { res.status(404).json({ error: "Recording not found" }); return; }
  const candidates = await db.select().from(recordingsTable).where(eq(recordingsTable.fieldId, fieldId));
  const recording = candidates.find((candidate) =>
    extractBunnyVideoId(candidate.videoUrl)?.toLowerCase() === videoId.toLowerCase(),
  );
  if (!recording) { res.status(204).end(); return; }
  const context = await createPublicFootageContext(req, [fieldId]);
  if (!isPublicRecordingInContext(recording, field, context)) {
    res.status(404).json({ error: "Recording not found" });
    return;
  }
  await db.insert(recordingViewsTable).values({
    recordingId: recording.id,
    viewerUserId: viewerId,
    viewCount: 0,
    watchedSeconds: seconds,
  }).onConflictDoUpdate({
    target: [recordingViewsTable.recordingId, recordingViewsTable.viewerUserId],
    set: {
      watchedSeconds: sql`${recordingViewsTable.watchedSeconds} + ${seconds}`,
      lastViewedAt: new Date(),
    },
  });
  res.status(204).end();
});

router.post("/admin/recordings", async (req, res): Promise<void> => {
  const adminId = await requireAdmin(req);
  if (!adminId) { res.status(403).json({ error: "Forbidden" }); return; }

  const { fieldId, court, date, timeSlot, duration, score, videoUrl } = req.body as {
    fieldId?: number; court?: string; date?: string; timeSlot?: string;
    duration?: string; score?: string | null; videoUrl?: string;
  };

  if (!fieldId || !court?.trim() || !date?.trim() || !timeSlot?.trim() || !duration?.trim() || !videoUrl?.trim()) {
    res.status(400).json({ error: "fieldId, court, date, timeSlot, duration, and videoUrl are required" });
    return;
  }

  const [field] = await db.select().from(fieldsTable).where(eq(fieldsTable.id, fieldId));
  if (!field) { res.status(404).json({ error: "Field not found" }); return; }

  const [recording] = await db
    .insert(recordingsTable)
    .values({
      fieldId,
      court: court.trim(),
      date: date.trim(),
      timeSlot: timeSlot.trim(),
      duration: duration.trim(),
      score: score?.trim() || null,
      videoUrl: videoUrl.trim(),
    })
    .returning();

  res.status(201).json(toAdminRecording(recording, field.name, false));
});

router.get("/recordings/:id", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = GetRecordingParams.safeParse({ id: parseInt(raw, 10) });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [recording] = await db.select().from(recordingsTable).where(eq(recordingsTable.id, params.data.id));
  if (!recording) {
    res.status(404).json({ error: "Recording not found" });
    return;
  }

  const [field] = await db.select().from(fieldsTable).where(eq(fieldsTable.id, recording.fieldId));
  if (!field) {
    res.status(404).json({ error: "Recording not found" });
    return;
  }
  const context = await createPublicFootageContext(req, [field.id]);
  if (!isPublicRecordingInContext(recording, field, context)) {
    res.status(404).json({ error: "Recording not found" });
    return;
  }

  res.json(
    GetRecordingResponse.parse({
      id: recording.id,
      fieldId: recording.fieldId,
      court: recording.court,
      date: recording.date,
      timeSlot: recording.timeSlot,
      duration: recording.duration,
      score: recording.score ?? null,
      videoUrl: recording.videoUrl,
      highlightMoment: recording.highlightMoment ?? null,
      fieldName: field?.name ?? null,
    })
  );
});

/**
 * A deliberately small, anonymous media feed for the guided product demo.
 *
 * Only the explicitly named venue's publicly visible recordings are eligible.
 * Exclude all owner/VAR footage-request dates before returning playback URLs.
 * No player, creator, roster, or identity data is selected or returned.
 */
router.get("/demo/media", async (req, res): Promise<void> => {
  const rows = await db
    .select({
      recording: recordingsTable,
      field: fieldsTable,
    })
    .from(recordingsTable)
    .innerJoin(fieldsTable, eq(fieldsTable.id, recordingsTable.fieldId))
    .where(eq(fieldsTable.name, "Jordan Galaxy"))
    .orderBy(desc(recordingsTable.createdAt))
    .limit(120);

  if (rows.length === 0) {
    res.json({ panorama: null, clips: [] });
    return;
  }

  const fieldIds = [...new Set(rows.map((row) => row.field.id))];
  const requests = await db
    .select({
      fieldId: footageRequestsTable.fieldId,
      startLocal: footageRequestsTable.startLocal,
      videoId: footageRequestsTable.videoId,
    })
    .from(footageRequestsTable)
    .where(inArray(footageRequestsTable.fieldId, fieldIds));

  const context = await createPublicFootageContext(req, fieldIds);
  // This is a public showcase, even when the viewer happens to be an admin.
  // Do not let an admin session bypass the field/date visibility schedule.
  const publicContext = { ...context, isAdmin: false };
  const bookingVideoIds = new Set(
    requests.map((request) => request.videoId).filter((id): id is string => Boolean(id)),
  );
  const safeRows = rows.filter(({ recording, field }) => {
    if (!isPublicRecordingInContext(recording, field, publicContext)) return false;
    if (!recording.videoUrl) return false;

    const recordingVideoId = extractBunnyVideoId(recording.videoUrl);
    if (recordingVideoId && bookingVideoIds.has(recordingVideoId)) return false;

    // Recordings do not carry a request FK. When a request has no stored video
    // id, we cannot reliably distinguish its footage. Exclude every recording
    // on a booked field/date, even if another request has a different video id.
    return !requests.some((request) =>
      request.fieldId === recording.fieldId
      && request.startLocal.slice(0, 10) === recording.date,
    );
  });

  if (safeRows.length === 0) {
    res.json({ panorama: null, clips: [] });
    return;
  }

  const safeRecordingIds = safeRows.map((row) => row.recording.id);
  const safeRecordingById = new Map(safeRows.map((row) => [row.recording.id, row]));
  const clipRows = await db
    .select({
      id: clipsTable.id,
      recordingId: clipsTable.recordingId,
      bunnyVideoId: clipsTable.bunnyVideoId,
      bunnyPlaybackUrl: clipsTable.bunnyPlaybackUrl,
      momentLabel: clipsTable.momentLabel,
      startTime: clipsTable.startTime,
      endTime: clipsTable.endTime,
    })
    .from(clipsTable)
    .where(inArray(clipsTable.recordingId, safeRecordingIds))
    .orderBy(desc(clipsTable.id))
    .limit(8);

  const toDemoMedia = async (source: string, preferredVideoId?: string | null) => {
    let videoId = preferredVideoId ?? null;
    if (isStreamlessStorageVideoUrl(source)) {
      videoId ??= extractBunnyVideoId(source);
      const directUrl = await streamlessStoragePlaylistUrl(source);
      return {
        src: directUrl ?? "",
        rawSrc: directUrl ?? "",
        poster: videoId && isBunnyStorageConfigured() ? storageThumbnailProxyUrl(videoId) : null,
      };
    }
    if (!videoId) {
      try {
        const parsed = new URL(source);
        if (parsed.hostname.toLowerCase() === BUNNY_CDN_HOSTNAME.toLowerCase()) {
          videoId = extractBunnyVideoId(source);
        }
      } catch {
        // A relative or malformed URL can still be a directly playable video.
      }
    }
    if (videoId?.startsWith("live:")) videoId = null;
    if (videoId) {
      return {
        src: getBunnyProxiedPlaybackUrl(videoId),
        rawSrc: getBunnyPlaybackUrl(videoId),
        poster: getBunnyProxiedThumbnailUrl(videoId),
      };
    }
    return { src: source, rawSrc: source, poster: null };
  };

  const first = safeRows[0];
  const panorama = {
    id: first.recording.id,
    ...await toDemoMedia(first.recording.videoUrl),
    date: first.recording.date,
    timeSlot: first.recording.timeSlot,
  };

  const clipResults = await Promise.all(clipRows.map(async (clip) => {
    const sourceRecording = safeRecordingById.get(clip.recordingId);
    if (!sourceRecording) return null;
    const hasDedicatedPlayback = Boolean(clip.bunnyPlaybackUrl || clip.bunnyVideoId);
    const media = await toDemoMedia(
      clip.bunnyPlaybackUrl ?? sourceRecording.recording.videoUrl,
      clip.bunnyVideoId,
    );
    return {
      id: clip.id,
      title: clip.momentLabel,
      ...media,
      date: sourceRecording.recording.date,
      timeSlot: sourceRecording.recording.timeSlot,
      startTime: Number(clip.startTime),
      endTime: Number(clip.endTime),
      playbackStartTime: hasDedicatedPlayback ? undefined : Number(clip.startTime),
      playbackEndTime: hasDedicatedPlayback ? undefined : Number(clip.endTime),
    };
  }));
  const clips = clipResults.filter((clip) => clip !== null);

  res.json({ panorama, clips });
});

export default router;
