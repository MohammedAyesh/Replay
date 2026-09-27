import { Router, type IRouter } from "express";
import { BUNNY_API_KEY, BUNNY_CDN_HOSTNAME, BUNNY_LIBRARY_ID, getBunnyProxiedThumbnailUrl, isBunnyConfigured, isBunnyVideoPlayable, isExcludedBunnyVideoTitle } from "../lib/bunny.js";
import { db, fieldsTable, recordingsTable, recordingSchedulesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  createPublicFootageContext,
  isPublicBunnyCollectionVideo,
} from "../lib/publicFootage";
import { getLocalUserRecord } from "../lib/clerkUserBridge";

const router: IRouter = Router();

interface BunnyApiCollection {
  guid?: string;
  name?: string;
  videoCount?: number;
  previewImageUrls?: string[];
}

const COLLECTIONS_CACHE_TTL_MS = 60 * 1000;
let collectionsCache: unknown[] | null = null;
let collectionsCacheTimestamp = 0;

interface BunnyApiVideo {
  guid?: string;
  title?: string;
  views?: number;
  length?: number;
  status?: number;
  availableResolutions?: string;
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

function getProxiedPreviewImageUrl(previewImageUrl: string | null): string | null {
  if (!previewImageUrl) return null;

  const url = new URL(previewImageUrl);
  const videoId = url.pathname.split("/").filter(Boolean)[0];
  if (!videoId) return null;

  const generatedProxyUrl = getBunnyProxiedThumbnailUrl(videoId);
  const generatedRawUrl = `https://${BUNNY_CDN_HOSTNAME}/${videoId}/thumbnail.jpg`;
  return generatedProxyUrl.replace(
    encodeURIComponent(generatedRawUrl),
    encodeURIComponent(previewImageUrl),
  );
}

// List all collections — merged with DB overrides so admin controls apply
router.get("/bunny/collections", async (req, res): Promise<void> => {
  if (!isBunnyConfigured()) {
    res.json([]);
    return;
  }

  const now = Date.now();
  let raw: unknown[] | null;
  if (collectionsCache !== null && now - collectionsCacheTimestamp < COLLECTIONS_CACHE_TTL_MS) {
    raw = collectionsCache;
  } else {
    raw = await bunnyGet("collections?page=1&itemsPerPage=100&orderBy=date&includeThumbnails=true", req);
    if (!raw) {
      res.json([]);
      return;
    }
    collectionsCache = raw;
    collectionsCacheTimestamp = Date.now();
  }

  // Pull DB overrides
  const dbFields = await db.select().from(fieldsTable);
  const context = await createPublicFootageContext(req, dbFields.map((field) => field.id));
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
        previewImageUrl: getProxiedPreviewImageUrl(dbField?.thumbnailUrl ?? c.previewImageUrls?.[0] ?? null),
        // include DB id so detail pages can link by integer id
        id: dbField?.id ?? null,
        isHidden: dbField?.isHidden ?? false,
        clipsVisible: dbField?.clipsVisible ?? false,
      };
    })
     .filter((c) => context.isAdmin || !c.isHidden);

  res.json(collections);
});

// All videos across every collection — used by admin Import from Bunny
router.get("/bunny/all-videos", async (req, res): Promise<void> => {
  const viewer = await getLocalUserRecord(req);
  if (!viewer?.isAdmin) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

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
        .filter((v) => !isExcludedBunnyVideoTitle(v.title))
        .filter(isBunnyVideoPlayable)
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
    .select()
    .from(fieldsTable)
    .where(eq(fieldsTable.bunnyGuid, guid));

  if (!dbField) {
    // Field not synced into DB yet — hide everything by default.
    res.json([]);
    return;
  }

  // Fetch schedules and registered recordings in parallel. Registered rows are
  // kept for compatibility with older imported titles, but visibility must not
  // depend on the admin having manually run "Import from Bunny" first.
  const context = await createPublicFootageContext(req, [dbField.id]);
  const [schedules, dbRecordings] = await Promise.all([
    db
      .select()
      .from(recordingSchedulesTable)
      .where(eq(recordingSchedulesTable.fieldId, dbField.id)),
    db
      .select()
      .from(recordingsTable)
      .where(eq(recordingsTable.fieldId, dbField.id)),
  ]);

  if (schedules.length === 0) {
    // No windows defined yet — show nothing.
    res.json([]);
    return;
  }

  const videos = (raw as BunnyApiVideo[])
    .filter((v) => typeof v.guid === "string" && typeof v.title === "string")
    .filter((v) => !isExcludedBunnyVideoTitle(v.title))
    .filter(isBunnyVideoPlayable)
    .filter((v) => isPublicBunnyCollectionVideo(
      dbField,
      v.guid as string,
      v.title as string,
      context,
      dbRecordings,
    ))
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
