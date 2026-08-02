import { Router, type IRouter } from "express";
import { BUNNY_API_KEY, BUNNY_CDN_HOSTNAME, BUNNY_LIBRARY_ID, isBunnyConfigured } from "../lib/bunny.js";
import { db, fieldsTable, recordingsTable, recordingSchedulesTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";

/** Returns true if the recording's date+timeSlot falls within any of the provided schedules. */
function matchesSchedule(
  date: string,     // ISO date "YYYY-MM-DD"
  timeSlot: string, // "HH:MM"
  schedules: { dayOfWeek: number | null; startTime: string; endTime: string }[]
): boolean {
  if (schedules.length === 0) return false;
  // Derive day-of-week (0=Sun…6=Sat) from the ISO date string.
  // Appending T12:00:00 avoids timezone-midnight ambiguity.
  const dow = new Date(`${date}T12:00:00`).getDay();
  const [th, tm] = timeSlot.split(":").map(Number);
  if (isNaN(th) || isNaN(tm)) return false;
  const recMins = th * 60 + tm;

  return schedules.some((s) => {
    const dayMatch = s.dayOfWeek == null || s.dayOfWeek === dow;
    const [sh, sm] = s.startTime.split(":").map(Number);
    const [eh, em] = s.endTime.split(":").map(Number);
    return dayMatch && recMins >= sh * 60 + sm && recMins < eh * 60 + em;
  });
}

const router: IRouter = Router();

interface BunnyApiCollection {
  guid?: string;
  name?: string;
  videoCount?: number;
  previewImageUrls?: string[];
}

interface BunnyApiVideo {
  guid?: string;
  title?: string;
  views?: number;
  length?: number;
  status?: number;
}

async function bunnyGet(path: string, req: { log: { warn: (...args: unknown[]) => void } }): Promise<unknown[] | null> {
  const url = `https://video.bunnycdn.com/library/${BUNNY_LIBRARY_ID}/${path}`;
  const res = await fetch(url, {
    headers: { AccessKey: BUNNY_API_KEY, accept: "application/json" },
  });
  if (!res.ok) {
    req.log.warn({ status: res.status, url }, "Bunny API error");
    return null;
  }
  const data = (await res.json()) as { items?: unknown[] } | unknown[];
  return Array.isArray(data) ? data : (data.items ?? []);
}

// List all collections — merged with DB overrides so admin controls apply
router.get("/bunny/collections", async (req, res): Promise<void> => {
  if (!isBunnyConfigured()) {
    res.json([]);
    return;
  }

  const raw = await bunnyGet("collections?page=1&itemsPerPage=100&orderBy=date&includeThumbnails=true", req);
  if (!raw) {
    res.json([]);
    return;
  }

  // Pull DB overrides
  const dbFields = await db.select().from(fieldsTable);
  const dbByGuid = new Map(dbFields.map((f) => [f.bunnyGuid, f]));

  const collections = (raw as BunnyApiCollection[])
    .filter((c) => typeof c.guid === "string" && typeof c.name === "string")
    .map((c) => {
      const guid = c.guid as string;
      const dbField = dbByGuid.get(guid);
      return {
        guid,
        name: dbField?.name ?? (c.name as string),
        videoCount: c.videoCount ?? 0,
        previewImageUrl: dbField?.thumbnailUrl ?? c.previewImageUrls?.[0] ?? null,
        // include DB id so detail pages can link by integer id
        id: dbField?.id ?? null,
        isHidden: dbField?.isHidden ?? false,
        clipsVisible: dbField?.clipsVisible ?? false,
      };
    })
    .filter((c) => !c.isHidden);

  res.json(collections);
});

// All videos across every collection — used by admin Import from Bunny
router.get("/bunny/all-videos", async (req, res): Promise<void> => {
  if (!isBunnyConfigured()) {
    res.json([]);
    return;
  }

  const rawCollections = await bunnyGet(
    "collections?page=1&itemsPerPage=100&orderBy=date",
    req
  );
  if (!rawCollections) {
    res.json([]);
    return;
  }

  const collectionGuids = (rawCollections as BunnyApiCollection[])
    .map((c) => c.guid)
    .filter((g): g is string => typeof g === "string");

  const dbFields = await db.select().from(fieldsTable);
  const fieldNameByGuid = new Map(dbFields.map((f) => [f.bunnyGuid, f.name]));

  const results = await Promise.all(
    collectionGuids.map(async (guid) => {
      const raw = await bunnyGet(
        `videos?collection=${encodeURIComponent(guid)}&page=1&itemsPerPage=100&orderBy=date`,
        req
      );
      if (!raw) return [];
      const collectionName = fieldNameByGuid.get(guid) ?? guid.slice(0, 8);
      return (raw as BunnyApiVideo[])
        .filter((v) => typeof v.guid === "string" && typeof v.title === "string")
        .filter((v) => v.status === undefined || v.status === 4)
        .map((v) => ({
          guid: v.guid as string,
          title: v.title as string,
          collectionName,
          thumbnailUrl: `https://${BUNNY_CDN_HOSTNAME}/${v.guid}/thumbnail.jpg`,
          playbackUrl: `https://${BUNNY_CDN_HOSTNAME}/${v.guid}/playlist.m3u8`,
          views: v.views ?? 0,
          duration: v.length ?? 0,
        }));
    })
  );

  res.json(results.flat());
});

// Videos in a collection
router.get("/bunny/collections/:guid/videos", async (req, res): Promise<void> => {
  const { guid } = req.params;
  if (!guid) {
    res.status(400).json({ error: "Missing collection guid" });
    return;
  }

  if (!isBunnyConfigured()) {
    res.json([]);
    return;
  }

  const raw = await bunnyGet(
    `videos?collection=${encodeURIComponent(guid)}&page=1&itemsPerPage=100&orderBy=date`,
    req
  );
  if (!raw) {
    res.json([]);
    return;
  }

  // Only return recordings that fall within an admin-configured time window.
  // Look up the DB field for this collection.
  const [dbField] = await db
    .select({ id: fieldsTable.id })
    .from(fieldsTable)
    .where(eq(fieldsTable.bunnyGuid, guid));

  if (!dbField) {
    // Field not synced into DB yet — hide everything by default.
    res.json([]);
    return;
  }

  // Fetch schedules and registered recordings for this field in parallel.
  const [schedules, dbRecordings] = await Promise.all([
    db
      .select()
      .from(recordingSchedulesTable)
      .where(eq(recordingSchedulesTable.fieldId, dbField.id)),
    db
      .select({ videoUrl: recordingsTable.videoUrl, date: recordingsTable.date, timeSlot: recordingsTable.timeSlot })
      .from(recordingsTable)
      .where(eq(recordingsTable.fieldId, dbField.id)),
  ]);

  if (schedules.length === 0) {
    // No windows defined yet — show nothing.
    res.json([]);
    return;
  }

  // Build a set of Bunny GUIDs whose recording date+time falls within a window.
  const visibleGuids = new Set<string>();
  for (const r of dbRecordings) {
    if (!r.date || !r.timeSlot) continue;
    if (!matchesSchedule(r.date, r.timeSlot, schedules)) continue;
    try {
      const g = new URL(r.videoUrl).pathname.split("/").filter(Boolean)[0];
      if (g) visibleGuids.add(g);
    } catch { /* ignore malformed URLs */ }
  }

  if (visibleGuids.size === 0) {
    res.json([]);
    return;
  }

  const videos = (raw as BunnyApiVideo[])
    .filter((v) => typeof v.guid === "string" && typeof v.title === "string")
    .filter((v) => v.status === undefined || v.status === 4)
    .filter((v) => visibleGuids.has(v.guid as string))
    .map((v) => ({
      guid: v.guid as string,
      title: v.title as string,
      thumbnailUrl: `https://${BUNNY_CDN_HOSTNAME}/${v.guid}/thumbnail.jpg`,
      playbackUrl: `https://${BUNNY_CDN_HOSTNAME}/${v.guid}/playlist.m3u8`,
      embedUrl: `https://iframe.mediadelivery.net/embed/${BUNNY_LIBRARY_ID}/${v.guid}?autoplay=true&loop=false&muted=false&preload=true`,
      views: v.views ?? 0,
      duration: v.length ?? 0,
    }));

  res.json(videos);
});

export default router;
