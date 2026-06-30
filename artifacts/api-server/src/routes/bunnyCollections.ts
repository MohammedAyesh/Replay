import { Router, type IRouter } from "express";
import { BUNNY_API_KEY, BUNNY_CDN_HOSTNAME, BUNNY_LIBRARY_ID, isBunnyConfigured } from "../lib/bunny.js";

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

// List all collections
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

  const collections = (raw as BunnyApiCollection[])
    .filter((c) => typeof c.guid === "string" && typeof c.name === "string")
    .map((c) => ({
      guid: c.guid as string,
      name: c.name as string,
      videoCount: c.videoCount ?? 0,
      previewImageUrl: c.previewImageUrls?.[0] ?? null,
    }));

  res.json(collections);
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

  const videos = (raw as BunnyApiVideo[])
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
