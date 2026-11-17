export type UhdPlaybackPreference = "8k" | "4k" | "hd";

export const UHD_PLAYBACK_PREFERENCE_KEY = "replay.playback-quality";
export const UHD_HEVC_CODEC = "hvc1.1.6.L153.B0";
export const UHD_AVC_CODEC = "avc1.640033";
const UHD_VIDEO_CONTENT_TYPE = `video/mp4; codecs="${UHD_HEVC_CODEC}"`;
const UHD_HLS_CONTENT_TYPE = `application/vnd.apple.mpegurl; codecs="${UHD_HEVC_CODEC}"`;
const UHD_AVC_VIDEO_CONTENT_TYPE = `video/mp4; codecs="${UHD_AVC_CODEC}"`;
const UHD_AVC_HLS_CONTENT_TYPE = `application/vnd.apple.mpegurl; codecs="${UHD_AVC_CODEC}"`;

function browserStorage(): Pick<Storage, "getItem" | "setItem"> | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readUhdPlaybackPreference(
  storage: Pick<Storage, "getItem"> | null = browserStorage(),
): UhdPlaybackPreference {
  try {
    const saved = storage?.getItem(UHD_PLAYBACK_PREFERENCE_KEY);
    return saved === "hd" || saved === "8k" ? saved : "4k";
  } catch {
    return "4k";
  }
}

/** Whether the viewer ever picked a quality. With none picked, the best the phone plays smoothly wins (8K first). */
export function hasSavedPlaybackPreference(
  storage: Pick<Storage, "getItem"> | null = browserStorage(),
): boolean {
  try {
    const saved = storage?.getItem(UHD_PLAYBACK_PREFERENCE_KEY);
    return saved === "8k" || saved === "4k" || saved === "hd";
  } catch {
    return false;
  }
}

/**
 * The original's 8K, straight from the Storage pull zone, for any recording (not only
 * streamless ones). Checks the phone first, so most phones never ask for the playlist.
 */
export async function canUse8kDirect(
  url: string | null | undefined,
  mediaCapabilities?: MediaCapabilitiesLike | null,
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  if (!url || !(await canDecode8k(mediaCapabilities))) return false;
  return isUhdPlaylistAvailable(url, fetcher);
}

export function writeUhdPlaybackPreference(
  preference: UhdPlaybackPreference,
  storage: Pick<Storage, "setItem"> | null = browserStorage(),
): void {
  try {
    storage?.setItem(UHD_PLAYBACK_PREFERENCE_KEY, preference);
  } catch {
    // Playback remains usable when browser storage is disabled or full.
  }
}

export function uhdPlaybackUrlForSource(
  source: { kind: "bunny"; videoId: string } | { kind: "ownerShare"; token: string },
  isLive = false,
): string | null {
  return storagePlaybackUrlForSource(source, "4k", isLive);
}

export function storagePlaybackUrlForSource(
  source: { kind: "bunny"; videoId: string } | { kind: "ownerShare"; token: string },
  rendition: "8k" | "4k" | "h264",
  isLive = false,
): string | null {
  if (isLive) return null;
  if (source.kind === "ownerShare") {
    return /^(?:[a-f0-9]{32}|[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}|s-[a-f0-9]{32})$/i.test(source.token)
      ? `/w/${source.token}/${rendition}.m3u8`
      : null;
  }
  if (rendition !== "4k") return storagePlaybackUrlForGuid(source.videoId, rendition);
  return uhdPlaybackUrlForGuid(source.videoId);
}

export function storagePlaybackUrlForGuid(
  videoGuid: string | null | undefined,
  rendition: "8k" | "4k" | "h264",
): string | null {
  const guid = videoGuid?.trim() ?? "";
  if (!/^(?:[0-9a-f]{32}|[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})$/i.test(guid)) {
    return null;
  }
  if (rendition === "4k") return uhdPlaybackUrlForGuid(guid);
  return `/api/hls-proxy/storage/${encodeURIComponent(guid)}/${rendition}.m3u8`;
}

export function uhdPlaybackUrlForGuid(videoGuid: string | null | undefined): string | null {
  const guid = videoGuid?.trim() ?? "";
  if (!/^(?:[0-9a-f]{32}|[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})$/i.test(guid)) {
    return null;
  }
  return `/api/hls-proxy/uhd/${encodeURIComponent(guid)}.m3u8`;
}

/** Resolve a 4K playlist for a Bunny Stream URL, including our proxied form. */
export function uhdPlaybackUrlForStreamUrl(streamUrl: string | null | undefined): string | null {
  if (!streamUrl) return null;
  try {
    let parsed = new URL(streamUrl, typeof window === "undefined" ? "https://replayjo.com" : window.location.origin);
    const ownerShareMatch = parsed.pathname.match(/^\/w\/((?:[a-f0-9]{32}|[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}|s-[a-f0-9]{32}))\/manifest\.m3u8$/i);
    if (ownerShareMatch) {
      return `/w/${ownerShareMatch[1]}/4k.m3u8`;
    }
    const upstream = parsed.searchParams.get("url");
    if (upstream) parsed = new URL(upstream);
    if (!parsed.hostname.endsWith(".b-cdn.net") && parsed.hostname !== "video.bunnycdn.com") return null;
    const storageMatch = parsed.pathname.match(/\/vod\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/(?:8k|4k|h264)\.m3u8$/i);
    if (storageMatch?.[1]) return uhdPlaybackUrlForGuid(storageMatch[1]);
    const match = parsed.pathname.match(/\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/(?:playlist|video)\.m3u8$/i);
    return uhdPlaybackUrlForGuid(match?.[1]);
  } catch {
    return null;
  }
}

export function isStreamlessStorageUrl(value: string | null | undefined): boolean {
  if (!value) return false;
  try {
    const parsed = new URL(value, typeof window === "undefined" ? "https://replayjo.com" : window.location.origin);
    const nested = parsed.searchParams.get("url");
    if (nested && nested !== value && isStreamlessStorageUrl(nested)) return true;
    return /\/vod\/(?:[0-9a-f]{32}|[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})\/(?:8k|4k|h264)\.m3u8$/i.test(parsed.pathname)
      || /^\/api\/hls-proxy\/storage\/(?:[0-9a-f]{32}|[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})\/(?:8k|4k|h264)\.m3u8$/i.test(parsed.pathname)
      || /^\/w\/s-[a-f0-9]{32}\/manifest\.m3u8$/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

type MediaCapabilitiesLike = {
  decodingInfo: (configuration: MediaDecodingConfiguration) => Promise<MediaCapabilitiesDecodingInfo>;
};

export async function canDecodeUhd(
  video: Pick<HTMLVideoElement, "canPlayType">,
  mediaCapabilities?: MediaCapabilitiesLike | null,
): Promise<boolean> {
  try {
    const hlsCodecSupport = video.canPlayType(UHD_HLS_CONTENT_TYPE);
    const mp4CodecSupport = video.canPlayType(UHD_VIDEO_CONTENT_TYPE);
    const nativeCodecLikely = hlsCodecSupport === "probably" || mp4CodecSupport === "probably";
    const capabilities = mediaCapabilities === undefined
      ? (typeof navigator === "undefined" ? null : navigator.mediaCapabilities)
      : mediaCapabilities;
    if (!capabilities?.decodingInfo) return nativeCodecLikely;
    const result = await capabilities.decodingInfo({
      type: "media-source",
      video: {
        contentType: UHD_VIDEO_CONTENT_TYPE,
        width: 4096,
        height: 1152,
        bitrate: 10_000_000,
        framerate: 20,
      },
    });
    return result.supported && result.smooth;
  } catch {
    return false;
  }
}

/**
 * 8K is an explicit opt-in, never an automatic upgrade. Require the browser's
 * MediaCapabilities result to say both supported and smooth at native 8K size.
 */
export async function canDecode8k(
  mediaCapabilities?: MediaCapabilitiesLike | null,
): Promise<boolean> {
  try {
    const capabilities = mediaCapabilities === undefined
      ? (typeof navigator === "undefined" ? null : navigator.mediaCapabilities)
      : mediaCapabilities;
    if (!capabilities?.decodingInfo) return false;
    const result = await capabilities.decodingInfo({
      type: "media-source",
      video: {
        contentType: UHD_VIDEO_CONTENT_TYPE,
        width: 7680,
        height: 2160,
        bitrate: 40_000_000,
        framerate: 20,
      },
    });
    return result.supported && result.smooth;
  } catch {
    return false;
  }
}

export async function isUhdPlaylistAvailable(
  url: string,
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const response = await fetcher(url, { credentials: "include", cache: "no-store" });
    const available = response.ok;
    try { await response.body?.cancel(); } catch { /* closed by the response */ }
    return available;
  } catch {
    return false;
  }
}

/** The players' shared capability + playlist check for non-interactive exports. */
export async function canUseUhdPlayback(
  video: Pick<HTMLVideoElement, "canPlayType">,
  url: string | null | undefined,
  mediaCapabilities?: MediaCapabilitiesLike | null,
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  if (!url) return false;
  if (!(await isUhdPlaylistAvailable(url, fetcher))) return false;
  if (
    (await canDecodeUhd(video, mediaCapabilities))
    || (await canDecodeUhdAvc(video, mediaCapabilities))
  ) return true;
  return false;
}

export async function canUse8kPlayback(
  video: Pick<HTMLVideoElement, "canPlayType">,
  url: string | null | undefined,
  mediaCapabilities?: MediaCapabilitiesLike | null,
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  if (!url || !(await isUhdPlaylistAvailable(url, fetcher))) return false;
  // A "probably" from canPlayType alone does not establish smooth 8K decode.
  void video;
  return canDecode8k(mediaCapabilities);
}

export async function canUseH264Playback(
  video: Pick<HTMLVideoElement, "canPlayType">,
  url: string | null | undefined,
  mediaCapabilities?: MediaCapabilitiesLike | null,
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  if (!url || !(await isUhdPlaylistAvailable(url, fetcher))) return false;
  return canDecodeUhdAvc(video, mediaCapabilities);
}

async function canDecodeUhdAvc(
  video: Pick<HTMLVideoElement, "canPlayType">,
  mediaCapabilities?: MediaCapabilitiesLike | null,
): Promise<boolean> {
  try {
    const nativeHls = video.canPlayType("application/vnd.apple.mpegurl") !== "";
    if (nativeHls) {
      return video.canPlayType(UHD_AVC_HLS_CONTENT_TYPE) !== ""
        || video.canPlayType(UHD_AVC_VIDEO_CONTENT_TYPE) !== "";
    }
    const capabilities = mediaCapabilities === undefined
      ? (typeof navigator === "undefined" ? null : navigator.mediaCapabilities)
      : mediaCapabilities;
    if (!capabilities?.decodingInfo) return false;
    const result = await capabilities.decodingInfo({
      type: "media-source",
      video: {
        contentType: UHD_AVC_VIDEO_CONTENT_TYPE,
        width: 3840,
        height: 1080,
        bitrate: 10_000_000,
        framerate: 20,
      },
    });
    return result.supported && result.smooth;
  } catch {
    return false;
  }
}

export type UhdStallGuard = {
  waiting: () => void;
  recovered: () => void;
  dispose: () => void;
};

type UhdTimerHandle = ReturnType<typeof setTimeout> | number;

export function createUhdStallGuard(options: {
  onRepeatedStall: () => void;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => UhdTimerHandle;
  clearTimer?: (timer: UhdTimerHandle) => void;
  stallThresholdMs?: number;
  windowMs?: number;
}): UhdStallGuard {
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? setTimeout;
  const clearTimer = options.clearTimer ?? clearTimeout;
  const threshold = options.stallThresholdMs ?? 2_000;
  const windowMs = options.windowMs ?? 60_000;
  let timer: UhdTimerHandle | null = null;
  let waiting = false;
  let countedThisWait = false;
  let disposed = false;
  let longStalls: number[] = [];

  const clear = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };

  return {
    waiting() {
      if (disposed || waiting) return;
      waiting = true;
      countedThisWait = false;
      timer = setTimer(() => {
        timer = null;
        if (disposed || !waiting || countedThisWait) return;
        countedThisWait = true;
        const at = now();
        longStalls = longStalls.filter((time) => at - time <= windowMs);
        longStalls.push(at);
        if (longStalls.length >= 2) {
          disposed = true;
          clear();
          options.onRepeatedStall();
        }
      }, threshold);
    },
    recovered() {
      waiting = false;
      countedThisWait = false;
      clear();
    },
    dispose() {
      disposed = true;
      waiting = false;
      clear();
    },
  };
}

export const RECORDED_PLAYBACK_STAGE_ORDER = ["uhd", "cdn", "proxy", "fallback"] as const;

export function stageAfterUhd(hasCdn: boolean, hasProxy: boolean): "cdn" | "proxy" | "direct" {
  if (hasCdn) return "cdn";
  return hasProxy ? "proxy" : "direct";
}
