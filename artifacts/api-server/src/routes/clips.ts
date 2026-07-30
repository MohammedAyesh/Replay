import { Router, type IRouter } from "express";
import { eq, desc, and, sql } from "drizzle-orm";
import { db, clipsTable, recordingsTable, fieldsTable, savedClipsTable, likesTable, usersTable, academiesTable, clipSettingsTable } from "@workspace/db";
import {
  GetClipParams,
  GetClipResponse,
  ListClipsResponse,
  ToggleLikeParams,
  ToggleLikeResponse,
} from "@workspace/api-zod";
import { getLocalUserId } from "../lib/clerkUserBridge";
import { getBunnyPlaybackUrl, isBunnyConfigured } from "../lib/bunny";
import { introPlaybackPath } from "./clipIntro";

const router: IRouter = Router();

/**
 * Per-request lookup tables, so the list endpoint does not repeat the same two
 * queries once per clip. Built once by the caller; omitted for single-clip
 * routes, where buildClip falls back to querying directly.
 */
interface ClipLookups {
  academyByField: Map<number, { id: number; introVideoUrl: string | null }>;
  globalIntro: string | null;
}

async function loadClipLookups(): Promise<ClipLookups> {
  const [academies, settings] = await Promise.all([
    db.select({ id: academiesTable.id, fieldId: academiesTable.fieldId, introVideoUrl: academiesTable.introVideoUrl }).from(academiesTable),
    db.select().from(clipSettingsTable).limit(1),
  ]);
  const academyByField = new Map<number, { id: number; introVideoUrl: string | null }>();
  // A field could in principle back more than one academy; the first match
  // wins, matching the assumption the rest of the app makes.
  for (const a of academies) {
    if (!academyByField.has(a.fieldId)) {
      academyByField.set(a.fieldId, { id: a.id, introVideoUrl: a.introVideoUrl ?? null });
    }
  }
  return { academyByField, globalIntro: settings[0]?.introVideoUrl ?? null };
}

async function buildClip(clipId: number, userId: number | null, lookups?: ClipLookups) {
  const [clip] = await db.select().from(clipsTable).where(eq(clipsTable.id, clipId));
  if (!clip) return null;

  const [recording] = await db.select().from(recordingsTable).where(eq(recordingsTable.id, clip.recordingId));
  const [field] = recording ? await db.select().from(fieldsTable).where(eq(fieldsTable.id, recording.fieldId)) : [null];

  let isLiked = false;
  let isSaved = false;
  if (userId) {
    const [like] = await db
      .select()
      .from(likesTable)
      .where(and(eq(likesTable.userId, userId), eq(likesTable.clipId, clipId)));
    isLiked = !!like;

    const [saved] = await db
      .select()
      .from(savedClipsTable)
      .where(and(eq(savedClipsTable.userId, userId), eq(savedClipsTable.clipId, clipId)));
    isSaved = !!saved;
  }

  // Derive Bunny playback URL from videoId when Bunny is configured,
  // falling back to the stored URL, then the legacy videoUrl.
  let bunnyPlaybackUrl = clip.bunnyPlaybackUrl ?? null;
  if (clip.bunnyVideoId && isBunnyConfigured()) {
    bunnyPlaybackUrl = getBunnyPlaybackUrl(clip.bunnyVideoId);
  }

  let creatorId: number | null = null;
  let creatorName: string | null = null;
  let creatorPosition: string | null = null;
  if (clip.creatorId) {
    const [creator] = await db
      .select({ id: usersTable.id, name: usersTable.name, position: usersTable.position })
      .from(usersTable)
      .where(eq(usersTable.id, clip.creatorId));
    if (creator) {
      creatorId = creator.id;
      creatorName = creator.name;
      creatorPosition = creator.position ?? null;
    }
  }

  // This clip predates any direct academy association (that column only
  // exists on user_clips), so it's derived here from the recording's field.
  // A field could in principle back more than one academy; we take the first
  // match, which is fine for the common one-academy-per-field case this was
  // built for.
  //
  // The intro follows the same precedence as the exporter
  // (resolveIntroVideoUrl in userClips.ts): the academy's own intro first, the
  // global clip_settings intro as the fallback. Reporting academy-only here
  // meant a globally-branded clip played without its intro while the exported
  // MP4 had one.
  const view = lookups ?? await loadClipLookups();
  let academyId: number | null = null;
  let introVideoUrl: string | null = null;
  if (field) {
    const academy = view.academyByField.get(field.id);
    if (academy) {
      academyId = academy.id;
      introVideoUrl = academy.introVideoUrl;
    }
  }
  // Proxy path, not the storage URL — see routes/clipIntro.ts.
  const introPlayback = introPlaybackPath(academyId, !!(introVideoUrl ?? view.globalIntro));

  return {
    id: clip.id,
    recordingId: clip.recordingId,
    rank: clip.rank,
    momentLabel: clip.momentLabel,
    playerTags: clip.playerTags ?? [],
    likeCount: clip.likeCount,
    isLiked,
    isSaved,
    videoUrl: recording?.videoUrl ?? "",
    bunnyPlaybackUrl,
    bunnyVideoId: clip.bunnyVideoId ?? null,
    fieldName: field?.name ?? null,
    court: recording?.court ?? null,
    date: recording?.date ?? null,
    creatorId,
    creatorName,
    creatorPosition,
    startTime: parseFloat(clip.startTime ?? "0"),
    endTime: parseFloat(clip.endTime ?? "1"),
    cropPath: (clip.cropPath ?? []) as { t: number; x: number; y: number; w: number; h: number }[],
    academyId,
    introVideoUrl: introPlayback,
  };
}

router.get("/clips", async (req, res): Promise<void> => {
  const userId = await getLocalUserId(req);
  const clips = await db.select().from(clipsTable).orderBy(desc(clipsTable.likeCount), clipsTable.rank);

  const lookups = await loadClipLookups();
  const result = await Promise.all(clips.map((c) => buildClip(c.id, userId, lookups)));
  res.json(ListClipsResponse.parse(result.filter(Boolean)));
});

router.get("/clips/:id", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = GetClipParams.safeParse({ id: parseInt(raw, 10) });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const userId = await getLocalUserId(req);
  const clip = await buildClip(params.data.id, userId);
  if (!clip) {
    res.status(404).json({ error: "Clip not found" });
    return;
  }

  res.json(GetClipResponse.parse(clip));
});

router.post("/clips/:id/like", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = ToggleLikeParams.safeParse({ id: parseInt(raw, 10) });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const userId = await getLocalUserId(req);
  if (!userId) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }

  const clipId = params.data.id;
  const [clip] = await db.select().from(clipsTable).where(eq(clipsTable.id, clipId));
  if (!clip) {
    res.status(404).json({ error: "Clip not found" });
    return;
  }

  const [existing] = await db
    .select()
    .from(likesTable)
    .where(and(eq(likesTable.userId, userId), eq(likesTable.clipId, clipId)));

  let liked: boolean;

  if (existing) {
    await db
      .delete(likesTable)
      .where(and(eq(likesTable.userId, userId), eq(likesTable.clipId, clipId)));
    liked = false;
  } else {
    await db.insert(likesTable).values({ userId, clipId });
    liked = true;
  }

  // Recount from the likes table rather than writing back
  // `clip.likeCount ± 1` read earlier in this handler: two users liking the
  // same clip at once both read N and both wrote N + 1, losing a like every
  // time. Same fix already applied to user_clips.
  const [{ count: newCount }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(likesTable)
    .where(eq(likesTable.clipId, clipId));

  await db.update(clipsTable).set({ likeCount: newCount }).where(eq(clipsTable.id, clipId));

  res.json(ToggleLikeResponse.parse({ liked, likeCount: newCount }));
});

export default router;
