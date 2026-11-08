import { canPlayDirect, withDirectSegments } from "@/lib/directSegments";

/**
 * Where the player is reading from, in the order it tries them:
 * "cdn" (the app's playlist with segments straight from Bunny), then "proxy"
 * (the same playlist with every segment relayed), then "fallback" (the MP4).
 * "direct" is the bare `src`, used for live and for players given no proxy.
 */
export type PlaybackSourceStage = "checking" | "uhd" | "cdn" | "direct" | "proxy" | "fallback";

export const PLAYBACK_STALL_TIMEOUT_MS = 8_000;

export type PlaybackSnapshot = {
  paused: boolean;
  currentTime: number;
  seeking: boolean;
};

export type RecoveryDecision =
  | { type: "switch-source"; stage: "cdn" | "direct" | "proxy" | "fallback" }
  | { type: "retry-current" }
  | { type: "error" };

/** The CDN-segment playlist for a recording, or null (live, or nothing to ask). */
export function cdnPlaybackSource(options: {
  isLive: boolean;
  proxySrc?: string;
  src?: string;
}): string | null {
  if (options.isLive) return null;
  const playlist = options.proxySrc ?? options.src;
  return playlist && canPlayDirect(playlist) ? withDirectSegments(playlist) : null;
}

export function initialPlaybackSourceStage(options: {
  isLive: boolean;
  proxySrc?: string;
  src?: string;
}): PlaybackSourceStage {
  if (cdnPlaybackSource(options)) return "cdn";
  return !options.isLive && Boolean(options.proxySrc && options.proxySrc !== options.src)
    ? "proxy"
    : "direct";
}

export function summarizeFatalHlsError(error: {
  type?: unknown;
  details?: unknown;
  reason?: unknown;
  response?: { code?: unknown };
}): string {
  const parts = [error.type, error.details, error.reason]
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
    .map((part) => part.trim());
  if (typeof error.response?.code === "number" && Number.isFinite(error.response.code)) {
    parts.push(`HTTP ${error.response.code}`);
  }
  const summary = parts.join(" · ") || "Unspecified hls.js error";
  return summary.length > 160 ? `${summary.slice(0, 157)}…` : summary;
}

export async function decidePlaybackRecovery(options: {
  currentStage: PlaybackSourceStage;
  hasCdn?: boolean;
  hasProxy: boolean;
  fallbackSrc?: string;
  currentRetryAttempted: boolean;
  isFallbackAvailable?: (url: string) => Promise<boolean>;
}): Promise<RecoveryDecision> {
  // A failure in the original HEVC file silently falls back to the first
  // Stream stage. It does not spend a retry on a source the browser failed.
  if (options.currentStage === "uhd") {
    return { type: "switch-source", stage: options.hasCdn ? "cdn" : options.hasProxy ? "proxy" : "direct" };
  }
  if (options.currentStage === "checking") return { type: "retry-current" };

  // A CDN failure (Referer refused, a CORS or network fault) goes straight to
  // the relayed playlist, with no retry of the CDN first.
  if (options.currentStage === "cdn") {
    return { type: "switch-source", stage: options.hasProxy ? "proxy" : "direct" };
  }
  if (options.currentStage === "direct" && options.hasProxy) {
    return { type: "switch-source", stage: "proxy" };
  }

  // Give the active HLS source one short retry before falling through to the
  // progressive MP4. A switch to the fallback begins a fresh per-source retry.
  if (!options.currentRetryAttempted) {
    return { type: "retry-current" };
  }

  if (options.currentStage !== "fallback" && options.fallbackSrc) {
    const probe = options.isFallbackAvailable ?? isFallbackSourceAvailable;
    if (await probe(options.fallbackSrc)) {
      return { type: "switch-source", stage: "fallback" };
    }
  }

  return { type: "error" };
}

export async function isFallbackSourceAvailable(
  url: string,
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  const controller = new AbortController();
  try {
    const response = await fetcher(url, {
      // Match the smallest bounded request known to work on large Bunny MP4s.
      headers: { Range: "bytes=0-65535" },
      signal: controller.signal,
    });
    const available = response.ok;
    try {
      await response.body?.cancel();
    } catch {
      // The body may already be closed by the server or abort signal.
    }
    return available;
  } catch {
    return false;
  } finally {
    controller.abort();
  }
}

export function playbackPositionForRestore(currentTime: number, lastKnown: number): number {
  if (Number.isFinite(currentTime) && currentTime > 0) return currentTime;
  if (Number.isFinite(lastKnown) && lastKnown > 0) return lastKnown;
  return Number.isFinite(currentTime) && currentTime >= 0 ? currentTime : 0;
}

export function clampPlaybackPosition(position: number, duration: number): number {
  const safePosition = Number.isFinite(position) ? Math.max(0, position) : 0;
  return Number.isFinite(duration) && duration > 0
    ? Math.min(safePosition, duration)
    : safePosition;
}

export type SeekDragState = {
  dragging: boolean;
  initialValue: number | null;
  pendingValue: number | null;
  suppressValue: number | null;
};

export function createSeekDragState(): SeekDragState {
  return {
    dragging: false,
    initialValue: null,
    pendingValue: null,
    suppressValue: null,
  };
}

export function beginSeekDrag(state: SeekDragState, value: number): void {
  state.dragging = true;
  state.initialValue = value;
  state.pendingValue = value;
  state.suppressValue = null;
}

export function changeSeekValue(
  state: SeekDragState,
  value: number,
): { previewValue: number; seekValue: number | null } {
  if (state.dragging) {
    state.pendingValue = value;
    return { previewValue: value, seekValue: null };
  }

  if (state.suppressValue === value) {
    state.suppressValue = null;
    return { previewValue: value, seekValue: null };
  }

  state.suppressValue = null;
  return { previewValue: value, seekValue: value };
}

export function endSeekDrag(state: SeekDragState): number | null {
  if (!state.dragging) return null;

  const pendingValue = state.pendingValue;
  const changed = pendingValue != null && pendingValue !== state.initialValue;
  state.dragging = false;
  state.initialValue = null;
  state.pendingValue = null;

  if (!changed || pendingValue == null) return null;
  state.suppressValue = pendingValue;
  return pendingValue;
}

export function createPlaybackWatchdog(options: {
  getSnapshot: () => PlaybackSnapshot;
  onStalled: () => void;
  onProgress: () => void;
  normalDelayMs?: number;
  seekDelayMs?: number;
}) {
  const normalDelayMs = options.normalDelayMs ?? PLAYBACK_STALL_TIMEOUT_MS;
  const seekDelayMs = options.seekDelayMs ?? 45_000;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending = false;

  const clearTimer = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  const arm = (delayMs: number) => {
    clearTimer();
    if (!pending) return;

    const snapshot = options.getSnapshot();
    if (snapshot.paused) return;
    const startPosition = snapshot.currentTime;
    timer = setTimeout(() => {
      timer = null;
      const current = options.getSnapshot();
      if (current.paused) return;
      if (current.currentTime > startPosition + 0.02) {
        pending = false;
        options.onProgress();
        return;
      }
      pending = false;
      options.onStalled();
    }, delayMs);
  };

  return {
    waiting() {
      pending = true;
      const snapshot = options.getSnapshot();
      arm(snapshot.seeking ? seekDelayMs : normalDelayMs);
    },
    seeking() {
      pending = true;
      arm(seekDelayMs);
    },
    progress() {
      pending = false;
      clearTimer();
      options.onProgress();
    },
    pause() {
      clearTimer();
    },
    resume() {
      if (!pending) return;
      const snapshot = options.getSnapshot();
      arm(snapshot.seeking ? seekDelayMs : normalDelayMs);
    },
    dispose() {
      pending = false;
      clearTimer();
    },
  };
}