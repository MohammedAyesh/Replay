import { Router, type IRouter } from "express";
import { db, fieldsTable, recordingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { BUNNY_API_KEY, BUNNY_CDN_HOSTNAME, BUNNY_LIBRARY_ID, isBunnyConfigured, isExcludedBunnyVideoTitle } from "../lib/bunny.js";
import {
  createPublicFootageContext,
  extractBunnyVideoId,
  isPublicBunnyVideoInContext,
  parseRecordingTitleTimestamp,
} from "../lib/publicFootage";

const router: IRouter = Router();

interface BunnyApiItem {
  guid?: string;
  title?: string;
  views?: number;
  length?: number;
  status?: number;
}

router.get("/fields/:id/videos", async (req, res): Promise<void> => {
  const fieldId = parseInt(req.params.id, 10);
  if (isNaN(fieldId)) {
    res.status(400).json({ error: "Invalid field id" });
    return;
  }

  const [field] = await db.select().from(fieldsTable).where(eq(fieldsTable.id, fieldId));
  if (!field) {
    res.status(404).json({ error: "Field not found" });
    return;
  }

  const context = await createPublicFootageContext(req, [field.id]);
  if (!context.isAdmin && field.isHidden) {
    res.status(404).json({ error: "Field not found" });
    return;
  }

  if (!isBunnyConfigured()) {
    res.json([]);
    return;
  }

  // Videos are titled cam{N}_..., never the field's human-readable name, so a
  // text search against field.name (the previous approach here) matches
  // nothing — or worse, matches an unrelated video that happens to share a
  // word. field.bunnyGuid is the field's actual Bunny Collection, so query
  // by exact collection membership instead, same as /bunny/collections/:guid/videos.
  if (!field.bunnyGuid) {
    res.json([]);
    return;
  }

  const url = `https://video.bunnycdn.com/library/${BUNNY_LIBRARY_ID}/videos?collection=${encodeURIComponent(field.bunnyGuid)}&page=1&itemsPerPage=100&orderBy=date`;

  const bunnyRes = await fetch(url, {
    headers: {
      AccessKey: BUNNY_API_KEY,
      accept: "application/json",
    },
  });

  if (!bunnyRes.ok) {
    req.log.warn({ status: bunnyRes.status }, "Bunny API error fetching videos");
    res.json([]);
    return;
  }

  const data = (await bunnyRes.json()) as { items?: BunnyApiItem[] } | BunnyApiItem[];
  const raw: BunnyApiItem[] = Array.isArray(data) ? data : (data.items ?? []);

  const importedRecordings = await db
    .select({
      videoUrl: recordingsTable.videoUrl,
      date: recordingsTable.date,
      timeSlot: recordingsTable.timeSlot,
      isVisible: recordingsTable.isVisible,
    })
    .from(recordingsTable)
    .where(eq(recordingsTable.fieldId, field.id));
  const visibleGuids = new Set(
    importedRecordings
      .filter((recording) => recording.isVisible)
      .filter((recording) => context.isAdmin || (
        (context.schedulesByField.get(field.id) ?? []).length > 0
        && (recording.date && recording.timeSlot)
      ))
      .filter((recording) => context.isAdmin || isPublicBunnyVideoInContext(
        field,
        extractBunnyVideoId(recording.videoUrl) ?? "",
        "",
        context,
        recording.date,
        recording.timeSlot,
      ))
      .map((recording) => extractBunnyVideoId(recording.videoUrl))
      .filter((videoId): videoId is string => Boolean(videoId))
  );

  const videos = raw
    .filter((v) => typeof v.guid === "string" && typeof v.title === "string")
    .filter((v) => !isExcludedBunnyVideoTitle(v.title))
    .filter((v) => v.status === undefined || v.status === 4)
    .filter((v) => {
      const guid = v.guid as string;
      if (context.isAdmin) return true;
      if (visibleGuids.has(guid)) return true;
      const timestamp = parseRecordingTitleTimestamp(v.title as string);
      return Boolean(
        timestamp
        && isPublicBunnyVideoInContext(field, guid, v.title as string, context, timestamp.date, timestamp.timeSlot)
      );
    })
    .map((v) => ({
      guid: v.guid as string,
      title: v.title as string,
      thumbnailUrl: `https://${BUNNY_CDN_HOSTNAME}/${v.guid}/thumbnail.jpg`,
      playbackUrl: `https://${BUNNY_CDN_HOSTNAME}/${v.guid}/playlist.m3u8`,
      views: v.views ?? 0,
      duration: v.length ?? 0,
    }));

  res.json(videos);
});

export default router;
