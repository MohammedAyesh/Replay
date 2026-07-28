import { Router, type IRouter } from "express";
import { db, fieldsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { BUNNY_API_KEY, BUNNY_CDN_HOSTNAME, BUNNY_LIBRARY_ID, isBunnyConfigured } from "../lib/bunny.js";

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

  const videos = raw
    .filter((v) => typeof v.guid === "string" && typeof v.title === "string")
    .filter((v) => v.status === undefined || v.status === 4)
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
