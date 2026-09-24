/**
 * Shared DVR-capable HLS player.
 *
 * Used by:
 *  - The Live page (full DVR window, no windowSeconds)
 *  - The VAR tab on the Field Detail page (5-minute window, retryOnNetworkError)
 *
 * Props:
 *  url                  — HLS manifest URL
 *  label                — overlay label (e.g. "Camera 1", "VAR")
 *  windowSeconds        — optional: clamp the scrubber's low end to
 *                         max(seekable.start, seekable.end - windowSeconds)
 *  retryOnNetworkError  — when true, fatal network errors (e.g. 404 while the
 *                         stream isn't running) show a "Waiting for stream"
 *                         state and auto-retry after 5 s instead of showing a
 *                         permanent error banner.
 *
 * The component is a forwardRef so the parent can hold a ref to the underlying
 * <video> element and drive review controls (seek, playbackRate, etc.).
 */
import React, {
  useEffect,
  useRef,
  useState,
  forwardRef,
  useImperativeHandle,
  type CSSProperties,
} from "react";
import Hls from "hls.js";
import { capPlaybackQuality } from "../lib/hlsQuality";
import { RotateCcw } from "lucide-react";

/** Non-recoverable: the only error that survives a successful fragment load. */
const FATAL_ERROR = "This camera is currently unavailable.";

export interface HlsPlayerProps {
  url: string;
  label: string;
  windowSeconds?: number;
  /** Seconds from the live edge that still count as live for this rendition. */
  liveEdgeToleranceSeconds?: number;
  retryOnNetworkError?: boolean;
  /** Let a parent render a custom VAR control surface. */
  showDvrControls?: boolean;
  showStatusOverlays?: boolean;
  controls?: boolean;
  /** Use fragment/program-date-time clock data for callers that need a wall clock. */
  useProgramDateTime?: boolean;
  /** Recover short buffered holes and playlist sequence resets for live review. */
  recoverLiveDiscontinuities?: boolean;
  videoClassName?: string;
  videoStyle?: CSSProperties;
  onPlaybackState?: (state: {
    ready: boolean;
    waiting: boolean;
    hasFirstSegment: boolean;
    error: string | null;
  }) => void;
  onManifestFailure?: (reason: string) => void;
  onTimelineChange?: (timeline: {
    position: number;
    liveEdge: number;
    /** HLS.js's configured live sync target, when the HLS engine exposes it. */
    liveSyncPosition?: number;
    /**
     * Low end of the reviewable window, already clamped to `windowSeconds`.
     *
     * Emitted because a scrubber cannot be drawn without it: the caller knows
     * where the handle is and where live is, but not how far back the footage
     * actually goes, and guessing that is how a slider ends up letting someone
     * seek into an empty buffer.
     */
    start: number;
    programTime?: number;
    windowStartProgramTime?: number;
    liveEdgeProgramTime?: number;
  }) => void;
}

export type TimelineFragment = {
  start: number;
  duration: number;
  programDateTime?: number | null;
};

export function programTimeAtPosition(
  fragments: TimelineFragment[],
  position: number,
): number | undefined {
  let wallStart: number | undefined;
  for (const fragment of fragments) {
    if (Number.isFinite(fragment.programDateTime)) {
      wallStart = fragment.programDateTime as number;
    }
    if (wallStart == null) continue;
    const fragmentEnd = fragment.start + fragment.duration;
    if (position >= fragment.start && position <= fragmentEnd) {
      return wallStart + (position - fragment.start) * 1000;
    }
    wallStart += fragment.duration * 1000;
  }
  return undefined;
}

export function programTimeAtPlaylistEnd(fragments: TimelineFragment[]): number | undefined {
  let wallEnd: number | undefined;
  for (const fragment of fragments) {
    if (Number.isFinite(fragment.programDateTime)) {
      wallEnd = fragment.programDateTime as number;
    }
    if (wallEnd == null) continue;
    wallEnd += fragment.duration * 1000;
  }
  return wallEnd;
}

export type BufferedRange = { start: number; end: number };

export function findBufferedHoleStart(
  currentTime: number,
  ranges: BufferedRange[],
  maxAheadSeconds = 5,
): number | null {
  if (!Number.isFinite(currentTime)) return null;
  for (const range of ranges) {
    if (currentTime >= range.start && currentTime <= range.end) return null;
    if (range.start > currentTime && range.start - currentTime <= maxAheadSeconds) {
      return range.start;
    }
  }
  return null;
}

export const HlsPlayer = forwardRef<HTMLVideoElement, HlsPlayerProps>(
  function HlsPlayer({
    url,
    label,
    windowSeconds,
    liveEdgeToleranceSeconds = 8,
    retryOnNetworkError = false,
    showDvrControls = true,
    showStatusOverlays = true,
    controls = true,
    useProgramDateTime = false,
    recoverLiveDiscontinuities = false,
    videoClassName,
    videoStyle,
    onPlaybackState,
    onManifestFailure,
    onTimelineChange,
  }, forwardedRef) {
    const videoRef = useRef<HTMLVideoElement>(null);
    const programAnchorRef = useRef<{ mediaTime: number; wallTime: number } | null>(null);
    const levelDetailsRef = useRef<{ fragments: TimelineFragment[]; startSN: number } | null>(null);
    const mediaSequenceRef = useRef<number | null>(null);
    const hlsRef = useRef<Hls | null>(null);

    // Expose the internal video element via forwardRef
    useImperativeHandle(forwardedRef, () => videoRef.current!, []);

    const [ready, setReady] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [waiting, setWaiting] = useState(false); // stream not running yet (retryOnNetworkError mode)
    const [timeline, setTimeline] = useState({ start: 0, end: 0, position: 0 });
    const [retryAttempt, setRetryAttempt] = useState(0);

    // ── HLS setup ──────────────────────────────────────────────────────────────
    useEffect(() => {
      const el = videoRef.current;
      if (!el) return;

      setReady(false);
      setError(null);
      setWaiting(false);
      setTimeline({ start: 0, end: 0, position: 0 });
      programAnchorRef.current = null;
      levelDetailsRef.current = null;
      mediaSequenceRef.current = null;
      hlsRef.current = null;
      onPlaybackState?.({
        ready: false,
        waiting: false,
        hasFirstSegment: false,
        error: null,
      });

      let retryTimer: ReturnType<typeof setTimeout> | null = null;

      if (Hls.isSupported()) {
        const hls = new Hls({
          enableWorker: false,
          liveSyncDurationCount: 10,
          maxLiveSyncPlaybackRate: 1.05,
          liveMaxLatencyDurationCount: 20,
          maxBufferLength: 40,
          maxMaxBufferLength: 60,
          backBufferLength: 90,
        });
        hlsRef.current = hls;
        // Live is ordinary playback: same ceiling as VOD.
        capPlaybackQuality(hls);
        hls.loadSource(url);
        hls.attachMedia(el);

        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          setReady(true);
          setWaiting(false);
          onPlaybackState?.({
            ready: true,
            waiting: false,
            hasFirstSegment: false,
            error: null,
          });
          el.play().catch(() => {});
        });
        hls.on(Hls.Events.LEVEL_UPDATED, (_event, data) => {
          levelDetailsRef.current = data.details;
          const mediaSequence = data.details.startSN;
          const previousMediaSequence = mediaSequenceRef.current;
          if (
            recoverLiveDiscontinuities
            && previousMediaSequence != null
            && mediaSequence < previousMediaSequence
          ) {
            const seekableEnd = el.seekable.length
              ? el.seekable.end(el.seekable.length - 1)
              : null;
            const liveSyncPosition = hls.liveSyncPosition;
            const restartPosition = typeof liveSyncPosition === "number" && Number.isFinite(liveSyncPosition)
              ? liveSyncPosition
              : typeof seekableEnd === "number" && Number.isFinite(seekableEnd)
                ? Math.max(0, seekableEnd - 1)
                : -1;
            hls.loadSource(url);
            hls.startLoad(restartPosition);
            if (restartPosition >= 0) el.currentTime = restartPosition;
          }
          mediaSequenceRef.current = mediaSequence;

          const fragment = data.details?.fragments?.find(
            (candidate: { programDateTime?: number | null }) =>
              Number.isFinite(candidate.programDateTime),
          );
          if (fragment && Number.isFinite(fragment.programDateTime)) {
            programAnchorRef.current = {
              mediaTime: fragment.start,
              wallTime: fragment.programDateTime as number,
            };
          }
        });

        const clearTransientError = () => {
          setError((e) => (e === FATAL_ERROR ? e : null));
          onPlaybackState?.({
            ready: true,
            waiting: false,
            hasFirstSegment: true,
            error: null,
          });
        };
        hls.on(Hls.Events.FRAG_BUFFERED, clearTransientError);
        el.addEventListener("playing", clearTransientError);

        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (!data.fatal) return;
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
            if (onManifestFailure?.("fatal HLS network error")) {
              hls.destroy();
              return;
            }
            if (retryOnNetworkError) {
              // Stream not running — wait and retry
              setWaiting(true);
              setError(null);
              onPlaybackState?.({
                ready: false,
                waiting: true,
                hasFirstSegment: false,
                error: null,
              });
              hls.destroy();
              retryTimer = setTimeout(() => setRetryAttempt((a) => a + 1), 5_000);
            } else {
              setError("Live connection interrupted. Reconnecting…");
              onPlaybackState?.({
                ready: true,
                waiting: false,
                hasFirstSegment: true,
                error: "Live connection interrupted. Reconnecting…",
              });
              hls.startLoad();
            }
          } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            setError("Recovering video…");
            onPlaybackState?.({
              ready: true,
              waiting: false,
              hasFirstSegment: true,
              error: "Recovering video…",
            });
            hls.recoverMediaError();
          } else {
            if (onManifestFailure?.("fatal HLS error")) {
              hls.destroy();
              return;
            }
            setError(FATAL_ERROR);
            onPlaybackState?.({
              ready: false,
              waiting: false,
              hasFirstSegment: false,
              error: FATAL_ERROR,
            });
            hls.destroy();
          }
        });

        return () => {
          el.removeEventListener("playing", clearTransientError);
          if (retryTimer) clearTimeout(retryTimer);
          hls.destroy();
          hlsRef.current = null;
        };
      } else if (el.canPlayType("application/vnd.apple.mpegurl")) {
        // Native HLS (Safari / iOS)
        el.src = url;

        const onMetadata = () => {
          setReady(true);
          setWaiting(false);
          onPlaybackState?.({
            ready: true,
            waiting: false,
            hasFirstSegment: true,
            error: null,
          });
          el.play().catch(() => {});
        };
        const onError = () => {
          if (onManifestFailure?.("native HLS error")) {
            return;
          }
          if (retryOnNetworkError) {
            setWaiting(true);
            setError(null);
            onPlaybackState?.({
              ready: false,
              waiting: true,
              hasFirstSegment: false,
              error: null,
            });
            retryTimer = setTimeout(() => {
              el.src = url;
              el.load();
              setRetryAttempt((a) => a + 1);
            }, 5_000);
          } else {
            setError("This camera is currently unavailable.");
            onPlaybackState?.({
              ready: false,
              waiting: false,
              hasFirstSegment: false,
              error: "This camera is currently unavailable.",
            });
          }
        };

        el.addEventListener("loadedmetadata", onMetadata);
        el.addEventListener("error", onError);
        return () => {
          el.removeEventListener("loadedmetadata", onMetadata);
          el.removeEventListener("error", onError);
          if (retryTimer) clearTimeout(retryTimer);
          el.removeAttribute("src");
          el.load();
          hlsRef.current = null;
        };
      }

      return undefined;
      // retryAttempt in deps causes the effect to re-run after a scheduled retry
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [url, retryAttempt, retryOnNetworkError, onPlaybackState, onManifestFailure, recoverLiveDiscontinuities]);

    // ── Timeline polling ───────────────────────────────────────────────────────
    useEffect(() => {
      const el = videoRef.current;
      if (!el) return;

      const updateTimeline = () => {
        if (!el.seekable.length) return;
        const rawStart = el.seekable.start(0);
        const rawEnd = el.seekable.end(el.seekable.length - 1);
        // Clamp start to keep the scrubber within the requested window
        const start =
          windowSeconds != null
            ? Math.max(rawStart, rawEnd - windowSeconds)
            : rawStart;
        setTimeline({ start, end: rawEnd, position: el.currentTime });
        const anchor = programAnchorRef.current;
        const hls = hlsRef.current;
        const details = levelDetailsRef.current;
        const fragments = details?.fragments ?? [];
        const playingDate = useProgramDateTime ? hls?.playingDate?.getTime() : undefined;
        const currentProgramTime = useProgramDateTime
          ? (typeof playingDate === "number" && Number.isFinite(playingDate)
            ? playingDate
            : programTimeAtPosition(fragments, el.currentTime))
          : anchor
            ? anchor.wallTime + (el.currentTime - anchor.mediaTime) * 1000
            : undefined;
        const liveEdgeProgramTime = useProgramDateTime
          ? programTimeAtPlaylistEnd(fragments)
          : undefined;
        const windowStartProgramTime = useProgramDateTime
          ? programTimeAtPosition(fragments, start)
          : undefined;
        const liveSyncPosition = hls?.liveSyncPosition;
        onTimelineChange?.({
          position: el.currentTime,
          liveEdge: rawEnd,
          start,
          liveSyncPosition: typeof liveSyncPosition === "number" && Number.isFinite(liveSyncPosition)
            ? liveSyncPosition
            : undefined,
          programTime: currentProgramTime,
          windowStartProgramTime,
          liveEdgeProgramTime,
        });
      };

      updateTimeline();
      const timer = window.setInterval(updateTimeline, 1_000);
      el.addEventListener("timeupdate", updateTimeline);
      return () => {
        window.clearInterval(timer);
        el.removeEventListener("timeupdate", updateTimeline);
      };
    }, [url, ready, useProgramDateTime, windowSeconds, onTimelineChange]);

    useEffect(() => {
      if (!recoverLiveDiscontinuities) return;
      const el = videoRef.current;
      if (!el) return;
      let lastHoleStart: number | null = null;
      let lastSeekingAt = Number.NEGATIVE_INFINITY;

      const recoverBufferedHole = () => {
        if (
          el.seeking
          || Date.now() - lastSeekingAt < 5_000
          || el.paused
          || el.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA
        ) return;
        if (!Number.isFinite(el.currentTime) || !el.buffered.length) return;
        const ranges: BufferedRange[] = [];
        for (let index = 0; index < el.buffered.length; index += 1) {
          ranges.push({ start: el.buffered.start(index), end: el.buffered.end(index) });
        }
        const nextRangeStart = findBufferedHoleStart(el.currentTime, ranges);
        if (nextRangeStart == null) {
          lastHoleStart = null;
          return;
        }
        if (lastHoleStart != null && Math.abs(lastHoleStart - nextRangeStart) < 0.25) return;
        lastHoleStart = nextRangeStart;
        el.currentTime = nextRangeStart;
        if (!el.paused) el.play().catch(() => {});
      };

      const onSeeking = () => {
        lastSeekingAt = Date.now();
        lastHoleStart = null;
      };

      recoverBufferedHole();
      const timer = window.setInterval(recoverBufferedHole, 500);
      el.addEventListener("seeking", onSeeking);
      el.addEventListener("timeupdate", recoverBufferedHole);
      el.addEventListener("progress", recoverBufferedHole);
      el.addEventListener("waiting", recoverBufferedHole);
      el.addEventListener("stalled", recoverBufferedHole);
      return () => {
        window.clearInterval(timer);
        el.removeEventListener("seeking", onSeeking);
        el.removeEventListener("timeupdate", recoverBufferedHole);
        el.removeEventListener("progress", recoverBufferedHole);
        el.removeEventListener("waiting", recoverBufferedHole);
        el.removeEventListener("stalled", recoverBufferedHole);
      };
    }, [url, recoverLiveDiscontinuities]);

    const hasDvrWindow = timeline.end - timeline.start > 3;
    const isLive = hasDvrWindow && timeline.end - timeline.position < liveEdgeToleranceSeconds;

    const goLive = () => {
      const el = videoRef.current;
      if (!el || !el.seekable.length) return;
      el.currentTime = el.seekable.end(el.seekable.length - 1) - 1;
      el.play().catch(() => {});
    };

    return (
      <div className="relative rounded-2xl overflow-hidden bg-surface border border-line">
        {/* Label + live/replay badge */}
        <div className="absolute top-3 start-3 z-10 flex items-center gap-1.5">
          <span className="flex items-center gap-1.5 px-2 py-1 rounded-full bg-black/70 backdrop-blur-sm text-xs font-semibold text-text">
            <span className="w-1.5 h-1.5 rounded-full bg-live animate-pulse" />
            {label}
          </span>
          {ready && (
            <span className="px-2 py-1 rounded-full bg-black/70 text-[10px] font-semibold text-text">
              {isLive ? "LIVE" : "REPLAY"}
            </span>
          )}
        </div>

        <video
          ref={videoRef}
          className={`w-full aspect-video bg-void${videoClassName ? ` ${videoClassName}` : ""}`}
          style={videoStyle}
          playsInline
          muted
          controls={controls}
        />

        {/* DVR scrubber */}
        {showDvrControls && (
          hasDvrWindow && (
            <div className="bg-void px-3 py-2 space-y-1.5">
            <input
              aria-label={`${label} timeline`}
              type="range"
              min={timeline.start}
              max={timeline.end}
              step="0.1"
              value={Math.min(
                Math.max(timeline.position, timeline.start),
                timeline.end,
              )}
              onChange={(event) => {
                const next = Number(event.target.value);
                if (videoRef.current) videoRef.current.currentTime = next;
                setTimeline((current) => ({ ...current, position: next }));
              }}
              className="w-full accent-live"
            />
            <div className="flex items-center justify-between text-[10px] text-muted-text">
              <span>
                {isLive ? "Live edge" : "Rewound in available window"}
              </span>
              {!isLive && (
                <button
                  type="button"
                  onClick={goLive}
                  className="inline-flex items-center gap-1 text-muted-text hover:text-text font-semibold"
                >
                  <RotateCcw className="w-3 h-3" />
                  Go live
                </button>
              )}
            </div>
            </div>
          )
        )}

        {/* Loading overlay */}
        {showStatusOverlays && !ready && !waiting && (
          <div className="absolute inset-0 flex items-center justify-center bg-void/60">
            <div className="w-6 h-6 rounded-full border-2 border-primary border-t-transparent animate-spin" />
          </div>
        )}

        {/* Waiting-for-stream overlay (retryOnNetworkError mode only) */}
        {showStatusOverlays && waiting && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-void/80">
            <div className="w-6 h-6 rounded-full border-2 border-muted-text border-t-transparent animate-spin" />
            <p className="text-muted-text text-sm font-medium">Waiting for stream…</p>
            <p className="text-muted-text text-xs">Retrying automatically</p>
          </div>
        )}

        {/* Error toast */}
        {showStatusOverlays && error && (
          <div className="absolute inset-x-0 bottom-12 flex justify-center px-3">
            <span className="rounded-lg border border-line bg-surface/90 px-3 py-2 text-xs text-text">
              {error}
            </span>
          </div>
        )}
      </div>
    );
  },
);
