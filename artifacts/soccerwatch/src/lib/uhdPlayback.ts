export type UhdPlaybackPreference = "4k" | "hd";

export const UHD_PLAYBACK_PREFERENCE_KEY = "replay.playback-quality";
export const UHD_HEVC_CODEC = "hvc1.1.6.L153.B0";
const UHD_VIDEO_CONTENT_TYPE = `video/mp4; codecs="${UHD_HEVC_CODEC}"`;
const UHD_HLS_CONTENT_TYPE = `application/vnd.apple.mpegurl; codecs="${UHD_HEVC_CODEC}"`;

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
    return storage?.getItem(UHD_PLAYBACK_PREFERENCE_KEY) === "hd" ? "hd" : "4k";
  } catch {
    return "4k";
  }
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
  if (isLive) return null;
  if (source.kind === "ownerShare") {
    return /^[a-f0-9]{32}$/i.test(source.token) ? `/w/${source.token}/4k.m3u8` : null;
  }
  return uhdPlaybackUrlForGuid(source.videoId);
}

export function uhdPlaybackUrlForGuid(videoGuid: string | null | undefined): string | null {
  const guid = videoGuid?.trim() ?? "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(guid)) {
    return null;
  }
  return `/api/hls-proxy/uhd/${encodeURIComponent(guid)}.m3u8`;
}

type MediaCapabilitiesLike = {
  decodingInfo: (configuration: MediaDecodingConfiguration) => Promise<MediaCapabilitiesDecodingInfo>;
};

export async function canDecodeUhd(
  video: Pick<HTMLVideoElement, "canPlayType">,
  mediaCapabilities?: MediaCapabilitiesLike | null,
): Promise<boolean> {
  try {
    const nativeHls = video.canPlayType("application/vnd.apple.mpegurl") !== "";
    if (nativeHls) {
      return video.canPlayType(UHD_HLS_CONTENT_TYPE) !== ""
        || video.canPlayType(UHD_VIDEO_CONTENT_TYPE) !== "";
    }
    const capabilities = mediaCapabilities === undefined
      ? (typeof navigator === "undefined" ? null : navigator.mediaCapabilities)
      : mediaCapabilities;
    if (!capabilities?.decodingInfo) return false;
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
