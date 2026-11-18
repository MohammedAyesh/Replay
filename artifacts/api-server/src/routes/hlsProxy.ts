/**
 * Compatibility endpoints for older playback URLs.
 *
 * They retain the existing media-access checks but redirect to Bunny. Playback
 * manifests, segments, and MP4 bytes must never be relayed through this API.
 */
import { Router, type IRouter, type Response as ExpressResponse } from "express";
import { canViewBunnyVideo, extractBunnyVideoId } from "../lib/publicFootage";
import { storagePullZoneBase } from "../lib/bunny";
import {
  getStoragePlaylist,
  getUhdPlaylist,
  normalizeUhdVideoGuid,
  storageH264Or4kSource,
  storageRenditionPlaylistUrl,
} from "../lib/uhdPlayback";

const router: IRouter = Router();
const ALLOWED_HOSTNAME_RE = /^[a-zA-Z0-9-]+\.b-cdn\.net$|^video\.bunnycdn\.com$/;

function isBunnyUrl(raw: string): boolean {
  try {
    return ALLOWED_HOSTNAME_RE.test(new URL(raw).hostname);
  } catch {
    return false;
  }
}

async function isAuthorizedMediaRequest(
  req: Parameters<typeof canViewBunnyVideo>[0],
  raw: string,
): Promise<boolean> {
  const videoId = extractBunnyVideoId(raw);
  return Boolean(videoId && await canViewBunnyVideo(req, videoId));
}

function isProgressiveMp4Fallback(raw: string): boolean {
  try {
    return /\/(?:play_720p\.mp4|original)$/i.test(new URL(raw).pathname);
  } catch {
    return false;
  }
}

function redirectToCdn(res: ExpressResponse, url: string): void {
  res.set("Cache-Control", "private, no-store").redirect(302, url);
}

router.get("/hls-proxy/storage/:videoGuid/thumb.jpg", async (req, res): Promise<void> => {
  const rawGuid = Array.isArray(req.params.videoGuid) ? req.params.videoGuid[0] : req.params.videoGuid;
  const guid = normalizeUhdVideoGuid(rawGuid);
  if (!guid || !await canViewBunnyVideo(req, guid)) {
    res.status(404).type("text/plain").send("Media not found");
    return;
  }
  redirectToCdn(res, `${storagePullZoneBase()}/vod/${guid}/thumb.jpg`);
});

router.get("/hls-proxy/storage/:videoGuid/:rendition.m3u8", async (req, res): Promise<void> => {
  const rawGuid = Array.isArray(req.params.videoGuid) ? req.params.videoGuid[0] : req.params.videoGuid;
  const rawRendition = Array.isArray(req.params.rendition) ? req.params.rendition[0] : req.params.rendition;
  const guid = normalizeUhdVideoGuid(rawGuid);
  if (!guid || (rawRendition !== "h264" && rawRendition !== "4k")) {
    res.status(404).type("text/plain").send("Media not found");
    return;
  }
  if (!await canViewBunnyVideo(req, guid)) {
    res.status(404).type("text/plain").send("Media not found");
    return;
  }

  try {
    let playlistUrl: string;
    if (rawRendition === "h264") {
      // H.264 is preferred; the direct 4K playlist is used only when H.264 is
      // absent. No 8K URL is ever offered for Storage recordings.
      const source = await storageH264Or4kSource(guid);
      if (!source) {
        res.status(404).type("text/plain").send("H.264 or 4K recording not found");
        return;
      }
      playlistUrl = source.url;
    } else {
      const playlist = await getStoragePlaylist(guid, "4k");
      if (!playlist) {
        res.status(404).type("text/plain").send("4K recording not found");
        return;
      }
      playlistUrl = storageRenditionPlaylistUrl(guid, "4k");
    }
    redirectToCdn(res, playlistUrl);
  } catch (error) {
    req.log?.warn({ err: error, videoGuid: guid, rendition: rawRendition }, "Bunny Storage playlist check failed");
    res.status(502).type("text/plain").send("Recording unavailable");
  }
});

router.get("/hls-proxy/uhd/:videoGuid.m3u8", async (req, res): Promise<void> => {
  const rawGuid = Array.isArray(req.params.videoGuid) ? req.params.videoGuid[0] : req.params.videoGuid;
  const guid = normalizeUhdVideoGuid(rawGuid);
  if (!guid || !await canViewBunnyVideo(req, guid)) {
    res.status(404).type("text/plain").send("Media not found");
    return;
  }

  try {
    const playlist = await getUhdPlaylist(guid);
    if (!playlist) {
      res.status(404).type("text/plain").send("4K recording not found");
      return;
    }
    redirectToCdn(res, storageRenditionPlaylistUrl(guid, "4k"));
  } catch (error) {
    req.log?.warn({ err: error, videoGuid: guid }, "Bunny Storage 4K playlist check failed");
    res.status(502).type("text/plain").send("4K recording unavailable");
  }
});

router.get("/hls-proxy/manifest", async (req, res): Promise<void> => {
  const raw = typeof req.query.url === "string" ? req.query.url : "";
  if (!raw || !isBunnyUrl(raw)) {
    res.status(400).send("Missing or disallowed url");
    return;
  }
  if (!await isAuthorizedMediaRequest(req, raw)) {
    res.status(404).send("Media not found");
    return;
  }
  redirectToCdn(res, raw);
});

router.get("/hls-proxy/mp4", async (req, res): Promise<void> => {
  const raw = typeof req.query.url === "string" ? req.query.url : "";
  if (!raw || !isBunnyUrl(raw) || !isProgressiveMp4Fallback(raw)) {
    res.status(400).send("Missing or disallowed url");
    return;
  }
  if (!await isAuthorizedMediaRequest(req, raw)) {
    res.status(404).send("Media not found");
    return;
  }
  redirectToCdn(res, raw);
});

router.get("/hls-proxy/segment", async (req, res): Promise<void> => {
  const raw = typeof req.query.url === "string" ? req.query.url : "";
  if (!raw || !isBunnyUrl(raw)) {
    res.status(400).send("Missing or disallowed url");
    return;
  }
  if (!await isAuthorizedMediaRequest(req, raw)) {
    res.status(404).send("Media not found");
    return;
  }
  redirectToCdn(res, raw);
});

export default router;
