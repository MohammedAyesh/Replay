import { Router, type IRouter } from "express";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import {
  CreateClaimMatchCorrectionBody,
  GetClaimMatchResponse,
  GetClaimMatchParams,
  ReplaceTrackingBundleBody,
  UpdateClaimMatchProgressBody,
} from "@workspace/api-zod";
import {
  db,
  usersTable,
  recordingsTable,
  fieldsTable,
  recordingTrackingBundlesTable,
  claimMatchProgressTable,
  claimMatchCorrectionsTable,
  type TrackingBundlePayload,
  type ClaimEarnedClip,
} from "@workspace/db";
import { getLocalUserId } from "../lib/clerkUserBridge";
import { getBunnyProxiedPlaybackUrl } from "../lib/bunny";

const router: IRouter = Router();

function parseId(value: string | string[]): number | null {
  const raw = Array.isArray(value) ? value[0] : value;
  const id = Number.parseInt(raw, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

async function requireAccountUser(req: Parameters<typeof getLocalUserId>[0]): Promise<number | null> {
  const userId = await getLocalUserId(req);
  if (!userId) return null;
  const [user] = await db
    .select({ id: usersTable.id, isGuest: usersTable.isGuest })
    .from(usersTable)
    .where(eq(usersTable.id, userId));
  return user && !user.isGuest ? user.id : null;
}

async function requireAdmin(req: Parameters<typeof getLocalUserId>[0]): Promise<number | null> {
  const userId = await getLocalUserId(req);
  if (!userId) return null;
  const [user] = await db
    .select({ id: usersTable.id, isAdmin: usersTable.isAdmin })
    .from(usersTable)
    .where(eq(usersTable.id, userId));
  return user?.isAdmin ? user.id : null;
}

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : {};
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
      return Number(value);
    }
  }
  return undefined;
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.trim() !== "");
}

/**
 * The canonical bundle is intentionally small and regular, while this
 * normalizer accepts the common names emitted by tracking pipelines
 * (fps/video_fps, bbox/boundingBox, track_id, and so on). This means an
 * operator can upload Mohammed's JSON directly without hand-editing it.
 */
function normalizeBundle(input: unknown): unknown {
  const source = asRecord(input);
  const metadata = asRecord(source.metadata ?? source.video);
  const dimensions = asRecord(source.dimensions ?? metadata.dimensions);
  const frameRate = firstNumber(source.frameRate, source.fps, source.videoFps, metadata.frameRate, metadata.fps);
  const frameCount = firstNumber(source.frameCount, source.frames, metadata.frameCount, metadata.frames);
  const duration = firstNumber(source.duration, source.videoDuration, metadata.duration, metadata.videoDuration);
  const width = firstNumber(source.width, source.videoWidth, dimensions.width, metadata.width);
  const height = firstNumber(source.height, source.videoHeight, dimensions.height, metadata.height);
  const matchOffset = firstNumber(
    source.matchOffset,
    source.match_offset,
    source.offset,
    metadata.matchOffset,
    metadata.offset,
  ) ?? 0;

  const rawTracks = Array.isArray(source.tracks)
    ? source.tracks
    : Array.isArray(source.players)
      ? source.players
      : [];
  const tracks = rawTracks.map((rawTrack, index) => {
    const track = asRecord(rawTrack);
    const id = firstString(track.id, track.trackId, track.track_id, track.playerId) ?? `track-${index + 1}`;
    const rawBoxes = Array.isArray(track.boxes)
      ? track.boxes
      : Array.isArray(track.bboxes)
        ? track.bboxes
        : Array.isArray(track.boundingBoxes)
          ? track.boundingBoxes
          : Array.isArray(track.detections)
            ? track.detections
            : [];
    const boxes = rawBoxes.map((rawBox, boxIndex) => {
      const box = asRecord(rawBox);
      const xywh = Array.isArray(box.bbox) ? box.bbox : Array.isArray(box.xywh) ? box.xywh : null;
      return {
        frame: Math.max(0, Math.round(firstNumber(box.frame, box.frameIndex, box.index, boxIndex) ?? boxIndex)),
        x: firstNumber(box.x, box.left, xywh?.[0]) ?? 0,
        y: firstNumber(box.y, box.top, xywh?.[1]) ?? 0,
        w: Math.max(0, firstNumber(box.w, box.width, xywh?.[2]) ?? 0),
        h: Math.max(0, firstNumber(box.h, box.height, xywh?.[3]) ?? 0),
      };
    });
    return {
      id,
      label: firstString(track.label, track.name, track.playerName) ?? null,
      startFrame: Math.max(0, Math.round(firstNumber(track.startFrame, track.start, boxes[0]?.frame) ?? 0)),
      endFrame: Math.max(
        0,
        Math.round(firstNumber(track.endFrame, track.end, boxes[boxes.length - 1]?.frame, frameCount) ?? 0),
      ),
      boxes,
    };
  });

  const rawCrossings = Array.isArray(source.crossings)
    ? source.crossings
    : Array.isArray(source.trackCrossings)
      ? source.trackCrossings
      : Array.isArray(source.identityCrossings)
        ? source.identityCrossings
        : [];
  const crossings = rawCrossings.map((rawCrossing) => {
    const crossing = asRecord(rawCrossing);
    return {
      frame: Math.max(0, Math.round(firstNumber(crossing.frame, crossing.frameIndex, crossing.atFrame) ?? 0)),
      trackId: firstString(crossing.trackId, crossing.track_id, crossing.fromTrackId, crossing.from) ?? "",
      otherTrackId: firstString(
        crossing.otherTrackId,
        crossing.other_track_id,
        crossing.toTrackId,
        crossing.to,
      ) ?? "",
      ...(firstNumber(crossing.confidence) !== undefined
        ? { confidence: firstNumber(crossing.confidence) }
        : {}),
    };
  });

  const rawSpans = Array.isArray(source.inPlaySpans)
    ? source.inPlaySpans
    : Array.isArray(source.in_play_spans)
      ? source.in_play_spans
      : Array.isArray(source.playSpans)
        ? source.playSpans
        : [];
  const inPlaySpans = rawSpans.map((rawSpan) => {
    const span = asRecord(rawSpan);
    return {
      start: Math.max(0, firstNumber(span.start, span.startSeconds, span.from) ?? 0),
      end: Math.max(0, firstNumber(span.end, span.endSeconds, span.to) ?? 0),
    };
  });

  const rawEvents = Array.isArray(source.events)
    ? source.events
    : [
        ...(Array.isArray(source.goals) ? source.goals : []),
        ...(Array.isArray(source.shots) ? source.shots : []),
        ...(Array.isArray(source.kickoffs) ? source.kickoffs : []),
      ];
  const events = rawEvents.map((rawEvent) => {
    const event = asRecord(rawEvent);
    return {
      type: firstString(event.type, event.eventType, event.kind) ?? "moment",
      time: Math.max(0, firstNumber(event.time, event.timeSeconds, event.timestamp, event.at) ?? 0),
      label: firstString(event.label, event.title, event.name) ?? null,
      clipId: firstString(event.clipId, event.clip_id) ?? null,
    };
  });

  return {
    version: Math.max(1, Math.round(firstNumber(source.version) ?? 1)),
    label: firstString(source.label, source.name, metadata.label) ?? "Match tracking",
    width: Math.max(1, Math.round(width ?? 1920)),
    height: Math.max(1, Math.round(height ?? 1080)),
    frameRate: frameRate ?? 25,
    frameCount: Math.max(1, Math.round(frameCount ?? Math.max(1, (duration ?? 1) * (frameRate ?? 25)))),
    duration: duration ?? 1,
    matchOffset,
    tracks,
    crossings,
    inPlaySpans,
    events,
  };
}

function parseBundle(input: unknown): TrackingBundlePayload | null {
  const normalized = normalizeBundle(input);
  const result = ReplaceTrackingBundleBody.safeParse(normalized);
  return result.success ? result.data as TrackingBundlePayload : null;
}

function recordingIdFromRequest(value: string | string[]): number | null {
  const id = parseId(value);
  return id;
}

function toRecording(
  recording: typeof recordingsTable.$inferSelect,
  fieldName: string | null,
) {
  let clientVideoUrl = recording.videoUrl;
  try {
    const parsed = new URL(recording.videoUrl);
    if (parsed.hostname.endsWith(".b-cdn.net") && parsed.pathname.endsWith(".m3u8")) {
      clientVideoUrl = `/api/hls-proxy/manifest?url=${encodeURIComponent(recording.videoUrl)}`;
    }
  } catch {
    // Non-URL sources (for example an internal MP4) are already browser-safe.
  }
  return {
    id: recording.id,
    fieldId: recording.fieldId,
    court: recording.court,
    date: recording.date,
    timeSlot: recording.timeSlot,
    duration: recording.duration,
    score: recording.score ?? null,
    videoUrl: clientVideoUrl,
    highlightMoment: recording.highlightMoment ?? null,
    fieldName,
  };
}

function toProgress(row: typeof claimMatchProgressTable.$inferSelect | null, recordingId: number) {
  return {
    recordingId,
    currentTrackId: row?.currentTrackId ?? null,
    stage: row?.stage ?? "find",
    confirmedFromSeconds: row?.confirmedFromSeconds ?? 0,
    currentPositionSeconds: row?.currentPositionSeconds ?? 0,
    claimedPercent: row?.claimedPercent ?? 0,
    clipsUnlocked: row?.clipsUnlocked ?? 0,
    correctionCount: row?.correctionCount ?? 0,
    completed: row?.completed ?? false,
    earnedClips: row?.earnedClips ?? [],
    updatedAt: row?.updatedAt.toISOString() ?? new Date().toISOString(),
  };
}

function toCorrection(row: typeof claimMatchCorrectionsTable.$inferSelect) {
  return {
    id: row.id,
    clientId: row.clientId,
    recordingId: row.recordingId,
    momentSeconds: row.momentSeconds,
    rejectedTrackId: row.rejectedTrackId ?? null,
    chosenTrackId: row.chosenTrackId,
    answerMethod: row.answerMethod,
    questionCount: row.questionCount,
    undone: row.undone,
    createdAt: row.createdAt.toISOString(),
  };
}

async function getRecordingBundle(recordingId: number) {
  const [row] = await db
    .select({
      recording: recordingsTable,
      fieldName: fieldsTable.name,
      bundle: recordingTrackingBundlesTable,
    })
    .from(recordingsTable)
    .leftJoin(fieldsTable, eq(fieldsTable.id, recordingsTable.fieldId))
    .leftJoin(
      recordingTrackingBundlesTable,
      eq(recordingTrackingBundlesTable.recordingId, recordingsTable.id),
    )
    .where(eq(recordingsTable.id, recordingId));
  return row ?? null;
}

// The demo deliberately resolves to the first real uploaded bundle. It never
// manufactures a recording or synthetic player metrics, so Mohammed's sample
// can be opened through one stable URL after an admin uploads it.
router.get("/claim-match/demo", async (req, res): Promise<void> => {
  const userId = await requireAccountUser(req);
  if (!userId) {
    res.status(401).json({ error: "Authenticated account required" });
    return;
  }
  const [bundle] = await db
    .select({ recordingId: recordingTrackingBundlesTable.recordingId })
    .from(recordingTrackingBundlesTable)
    .orderBy(asc(recordingTrackingBundlesTable.recordingId))
    .limit(1);
  if (!bundle) {
    res.status(404).json({ error: "No tracking bundle has been uploaded yet" });
    return;
  }
  res.redirect(307, `/api/recordings/${bundle.recordingId}/claim-match`);
});

function getMomentClips(
  bundle: TrackingBundlePayload,
  momentSeconds: number,
  existing: ClaimEarnedClip[],
): ClaimEarnedClip[] {
  const newClips = bundle.events
    .filter((event) => ["goal", "shot", "kickoff", "second-half", "second_half"].includes(event.type.toLowerCase()))
    .filter((event) => Math.abs(event.time - momentSeconds) <= 12)
    .map((event) => ({
      id: event.clipId ?? `claim-${event.type}-${Math.round(event.time)}`,
      title: event.label ?? `${event.type.replace(/[-_]/g, " ")} at ${formatMoment(event.time)}`,
      momentSeconds: event.time,
      kind: event.type,
      status: "ready",
    }));
  const byId = new Map(existing.map((clip) => [clip.id, clip]));
  for (const clip of newClips) byId.set(clip.id, clip);
  return Array.from(byId.values()).sort((a, b) => a.momentSeconds - b.momentSeconds);
}

function formatMoment(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

router.get("/recordings/:id/claim-match", async (req, res): Promise<void> => {
  const userId = await requireAccountUser(req);
  if (!userId) {
    res.status(401).json({ error: "Authenticated account required" });
    return;
  }
  const params = GetClaimMatchParams.safeParse({ id: recordingIdFromRequest(req.params.id) });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const row = await getRecordingBundle(params.data.id);
  if (!row?.bundle) {
    res.status(404).json({ error: "Recording or tracking bundle not found" });
    return;
  }
  const [progress] = await db
    .select()
    .from(claimMatchProgressTable)
    .where(and(
      eq(claimMatchProgressTable.userId, userId),
      eq(claimMatchProgressTable.recordingId, params.data.id),
    ));
  const corrections = await db
    .select()
    .from(claimMatchCorrectionsTable)
    .where(and(
      eq(claimMatchCorrectionsTable.userId, userId),
      eq(claimMatchCorrectionsTable.recordingId, params.data.id),
    ))
    .orderBy(desc(claimMatchCorrectionsTable.createdAt));

  res.json(GetClaimMatchResponse.parse({
    recording: toRecording(row.recording, row.fieldName ?? null),
    bundle: row.bundle.payload,
    progress: toProgress(progress ?? null, params.data.id),
    corrections: corrections.map(toCorrection),
  }));
});

router.patch("/recordings/:id/claim-match", async (req, res): Promise<void> => {
  const userId = await requireAccountUser(req);
  if (!userId) {
    res.status(401).json({ error: "Authenticated account required" });
    return;
  }
  const params = GetClaimMatchParams.safeParse({ id: recordingIdFromRequest(req.params.id) });
  const body = UpdateClaimMatchProgressBody.safeParse(req.body);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const row = await getRecordingBundle(params.data.id);
  if (!row?.bundle) {
    res.status(404).json({ error: "Recording or tracking bundle not found" });
    return;
  }
  const earnedClips = body.data.earnedClips ?? [];
  const [saved] = await db
    .insert(claimMatchProgressTable)
    .values({
      userId,
      recordingId: params.data.id,
      currentTrackId: body.data.currentTrackId ?? null,
      stage: body.data.stage,
      confirmedFromSeconds: body.data.confirmedFromSeconds,
      currentPositionSeconds: body.data.currentPositionSeconds,
      claimedPercent: body.data.claimedPercent,
      clipsUnlocked: body.data.clipsUnlocked,
      completed: body.data.completed,
      earnedClips,
    })
    .onConflictDoUpdate({
      target: [claimMatchProgressTable.userId, claimMatchProgressTable.recordingId],
      set: {
        currentTrackId: body.data.currentTrackId ?? null,
        stage: body.data.stage,
        confirmedFromSeconds: body.data.confirmedFromSeconds,
        currentPositionSeconds: body.data.currentPositionSeconds,
        claimedPercent: body.data.claimedPercent,
        clipsUnlocked: body.data.clipsUnlocked,
        completed: body.data.completed,
        earnedClips,
        updatedAt: new Date(),
      },
    })
    .returning();
  res.json(toProgress(saved, params.data.id));
});

router.post("/recordings/:id/claim-match/corrections", async (req, res): Promise<void> => {
  const userId = await requireAccountUser(req);
  if (!userId) {
    res.status(401).json({ error: "Authenticated account required" });
    return;
  }
  const params = GetClaimMatchParams.safeParse({ id: recordingIdFromRequest(req.params.id) });
  const body = CreateClaimMatchCorrectionBody.safeParse(req.body);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const row = await getRecordingBundle(params.data.id);
  if (!row?.bundle) {
    res.status(404).json({ error: "Recording or tracking bundle not found" });
    return;
  }
  const trackIds = new Set(row.bundle.payload.tracks.map((track) => track.id));
  if (
    !trackIds.has(body.data.chosenTrackId) ||
    (body.data.rejectedTrackId !== undefined &&
      body.data.rejectedTrackId !== null &&
      !trackIds.has(body.data.rejectedTrackId))
  ) {
    res.status(400).json({ error: "Correction references an unknown track" });
    return;
  }

  const [existing] = await db
    .select()
    .from(claimMatchCorrectionsTable)
    .where(and(
      eq(claimMatchCorrectionsTable.userId, userId),
      eq(claimMatchCorrectionsTable.recordingId, params.data.id),
      eq(claimMatchCorrectionsTable.clientId, body.data.clientId),
    ));
  if (existing) {
    res.status(200).json(toCorrection(existing));
    return;
  }

  const [progress] = await db
    .select()
    .from(claimMatchProgressTable)
    .where(and(
      eq(claimMatchProgressTable.userId, userId),
      eq(claimMatchProgressTable.recordingId, params.data.id),
    ));
  const earnedClips = getMomentClips(row.bundle.payload, body.data.momentSeconds, progress?.earnedClips ?? []);
  const [created] = await db
    .insert(claimMatchCorrectionsTable)
    .values({
      userId,
      recordingId: params.data.id,
      clientId: body.data.clientId,
      momentSeconds: body.data.momentSeconds,
      rejectedTrackId: body.data.rejectedTrackId,
      chosenTrackId: body.data.chosenTrackId,
      answerMethod: body.data.answerMethod,
      questionCount: body.data.questionCount,
    })
    .returning();
  await db
    .insert(claimMatchProgressTable)
    .values({
      userId,
      recordingId: params.data.id,
      currentTrackId: body.data.chosenTrackId,
      stage: "following",
      confirmedFromSeconds: body.data.momentSeconds,
      currentPositionSeconds: body.data.momentSeconds,
      claimedPercent: Math.min(100, (body.data.momentSeconds / row.bundle.payload.duration) * 100),
      clipsUnlocked: earnedClips.length,
      correctionCount: 1,
      completed: false,
      earnedClips,
    })
    .onConflictDoUpdate({
      target: [claimMatchProgressTable.userId, claimMatchProgressTable.recordingId],
      set: {
        currentTrackId: body.data.chosenTrackId,
        stage: "following",
        confirmedFromSeconds: body.data.momentSeconds,
        currentPositionSeconds: body.data.momentSeconds,
        claimedPercent: sql`LEAST(100, GREATEST(${claimMatchProgressTable.claimedPercent}, ${(body.data.momentSeconds / row.bundle.payload.duration) * 100}))`,
        clipsUnlocked: earnedClips.length,
        correctionCount: sql`${claimMatchProgressTable.correctionCount} + 1`,
        earnedClips,
        updatedAt: new Date(),
      },
    });

  res.status(201).json(toCorrection(created));
});

router.delete("/claim-match/corrections/:correctionId", async (req, res): Promise<void> => {
  const userId = await requireAccountUser(req);
  if (!userId) {
    res.status(401).json({ error: "Authenticated account required" });
    return;
  }
  const correctionId = parseId(req.params.correctionId);
  if (!correctionId) {
    res.status(400).json({ error: "Invalid correction id" });
    return;
  }
  const [correction] = await db
    .select()
    .from(claimMatchCorrectionsTable)
    .where(eq(claimMatchCorrectionsTable.id, correctionId));
  if (!correction) {
    res.status(404).json({ error: "Correction not found" });
    return;
  }
  if (correction.userId !== userId) {
    res.status(403).json({ error: "Correction belongs to another user" });
    return;
  }
  if (!correction.undone) {
    await db
      .update(claimMatchCorrectionsTable)
      .set({ undone: true })
      .where(eq(claimMatchCorrectionsTable.id, correctionId));
    await db
      .update(claimMatchProgressTable)
      .set({
        correctionCount: sql`GREATEST(0, ${claimMatchProgressTable.correctionCount} - 1)`,
        updatedAt: new Date(),
      })
      .where(and(
        eq(claimMatchProgressTable.userId, userId),
        eq(claimMatchProgressTable.recordingId, correction.recordingId),
      ));
  }
  res.json(toCorrection({ ...correction, undone: true }));
});

router.put("/admin/recordings/:id/tracking-bundle", async (req, res): Promise<void> => {
  const adminId = await requireAdmin(req);
  if (!adminId) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const recordingId = parseId(req.params.id);
  if (!recordingId) {
    res.status(400).json({ error: "Invalid recording id" });
    return;
  }
  const [recording] = await db
    .select({ id: recordingsTable.id })
    .from(recordingsTable)
    .where(eq(recordingsTable.id, recordingId));
  if (!recording) {
    res.status(404).json({ error: "Recording not found" });
    return;
  }
  const bundle = parseBundle(req.body);
  if (!bundle) {
    res.status(400).json({
      error: "Invalid tracking bundle. Include dimensions, frame rate, duration, tracks, crossings, in-play spans, and events.",
    });
    return;
  }
  const [saved] = await db
    .insert(recordingTrackingBundlesTable)
    .values({ recordingId, payload: bundle, uploadedBy: adminId })
    .onConflictDoUpdate({
      target: recordingTrackingBundlesTable.recordingId,
      set: { payload: bundle, uploadedBy: adminId, updatedAt: new Date() },
    })
    .returning();
  res.json({
    recordingId,
    label: bundle.label,
    duration: bundle.duration,
    trackCount: bundle.tracks.length,
    crossingCount: bundle.crossings.length,
    uploadedAt: saved.updatedAt.toISOString(),
  });
});

export default router;