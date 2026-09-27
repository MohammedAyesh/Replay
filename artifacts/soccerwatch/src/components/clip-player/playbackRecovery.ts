export type PlaybackSourceStage = "direct" | "proxy" | "fallback";

export type PlaybackSnapshot = {
  paused: boolean;
  currentTime: number;
  seeking: boolean;
};

export type RecoveryDecision =
  | { type: "switch-source"; stage: "proxy" | "fallback" }
  | { type: "retry-current" }
  | { type: "error" };

export function initialPlaybackSourceStage(options: {
  hlsSupported: boolean;
  nativeHlsSupported: boolean;
  isLive: boolean;
  proxySrc?: string;
  src?: string;
}): PlaybackSourceStage {
  return !options.isLive
    && !options.hlsSupported
    && options.nativeHlsSupported
    && Boolean(options.proxySrc && options.proxySrc !== options.src)
    ? "proxy"
    : "direct";
}

export async function decidePlaybackRecovery(options: {
  currentStage: PlaybackSourceStage;
  hasProxy: boolean;
  fallbackSrc?: string;
  currentRetryAttempted: boolean;
  isFallbackAvailable?: (url: string) => Promise<boolean>;
}): Promise<RecoveryDecision> {
  if (options.currentStage === "direct" && options.hasProxy) {
    return { type: "switch-source", stage: "proxy" };
  }

  if (options.currentStage !== "fallback" && options.fallbackSrc) {
    const probe = options.isFallbackAvailable ?? isFallbackSourceAvailable;
    if (await probe(options.fallbackSrc)) {
      return { type: "switch-source", stage: "fallback" };
    }
  }

  return options.currentRetryAttempted
    ? { type: "error" }
    : { type: "retry-current" };
}

export async function isFallbackSourceAvailable(
  url: string,
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  const controller = new AbortController();
  try {
    const response = await fetcher(url, {
      headers: { Range: "bytes=0-0" },
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
  const normalDelayMs = options.normalDelayMs ?? 20_000;
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