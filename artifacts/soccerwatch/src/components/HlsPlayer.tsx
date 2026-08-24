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
import React, { useEffect, useRef, useState, forwardRef, useImperativeHandle } from "react";
import Hls from "hls.js";
import { RotateCcw } from "lucide-react";

/** Non-recoverable: the only error that survives a successful fragment load. */
const FATAL_ERROR = "This camera is currently unavailable.";

export interface HlsPlayerProps {
  url: string;
  label: string;
  windowSeconds?: number;
  retryOnNetworkError?: boolean;
  onTimelineChange?: (timeline: {
    position: number;
    liveEdge: number;
    programTime?: number;
  }) => void;
}

export const HlsPlayer = forwardRef<HTMLVideoElement, HlsPlayerProps>(
  function HlsPlayer({
    url,
    label,
    windowSeconds,
    retryOnNetworkError = false,
    onTimelineChange,
  }, forwardedRef) {
    const videoRef = useRef<HTMLVideoElement>(null);
    const programAnchorRef = useRef<{ mediaTime: number; wallTime: number } | null>(null);

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
        hls.loadSource(url);
        hls.attachMedia(el);

        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          setReady(true);
          setWaiting(false);
          el.play().catch(() => {});
        });
        hls.on(Hls.Events.LEVEL_UPDATED, (_event, data) => {
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

        const clearTransientError = () =>
          setError((e) => (e === FATAL_ERROR ? e : null));
        hls.on(Hls.Events.FRAG_BUFFERED, clearTransientError);
        el.addEventListener("playing", clearTransientError);

        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (!data.fatal) return;
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
            if (retryOnNetworkError) {
              // Stream not running — wait and retry
              setWaiting(true);
              setError(null);
              hls.destroy();
              retryTimer = setTimeout(() => setRetryAttempt((a) => a + 1), 5_000);
            } else {
              setError("Live connection interrupted. Reconnecting…");
              hls.startLoad();
            }
          } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            setError("Recovering video…");
            hls.recoverMediaError();
          } else {
            setError(FATAL_ERROR);
            hls.destroy();
          }
        });

        return () => {
          el.removeEventListener("playing", clearTransientError);
          if (retryTimer) clearTimeout(retryTimer);
          hls.destroy();
        };
      } else if (el.canPlayType("application/vnd.apple.mpegurl")) {
        // Native HLS (Safari / iOS)
        el.src = url;

        const onMetadata = () => {
          setReady(true);
          setWaiting(false);
          el.play().catch(() => {});
        };
        const onError = () => {
          if (retryOnNetworkError) {
            setWaiting(true);
            setError(null);
            retryTimer = setTimeout(() => {
              el.src = url;
              el.load();
              setRetryAttempt((a) => a + 1);
            }, 5_000);
          } else {
            setError("This camera is currently unavailable.");
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
        };
      }

      return undefined;
      // retryAttempt in deps causes the effect to re-run after a scheduled retry
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [url, retryAttempt, retryOnNetworkError]);

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
        onTimelineChange?.({
          position: el.currentTime,
          liveEdge: rawEnd,
          programTime: anchor
            ? anchor.wallTime + (el.currentTime - anchor.mediaTime) * 1000
            : undefined,
        });
      };

      updateTimeline();
      const timer = window.setInterval(updateTimeline, 1_000);
      el.addEventListener("timeupdate", updateTimeline);
      return () => {
        window.clearInterval(timer);
        el.removeEventListener("timeupdate", updateTimeline);
      };
    }, [url, ready, windowSeconds, onTimelineChange]);

    const hasDvrWindow = timeline.end - timeline.start > 3;
    const isLive = hasDvrWindow && timeline.end - timeline.position < 8;

    const goLive = () => {
      const el = videoRef.current;
      if (!el || !el.seekable.length) return;
      el.currentTime = el.seekable.end(el.seekable.length - 1) - 1;
      el.play().catch(() => {});
    };

    return (
      <div className="relative rounded-2xl overflow-hidden bg-zinc-900 border border-zinc-800">
        {/* Label + live/replay badge */}
        <div className="absolute top-3 start-3 z-10 flex items-center gap-1.5">
          <span className="flex items-center gap-1.5 px-2 py-1 rounded-full bg-black/70 backdrop-blur-sm text-xs font-semibold text-white">
            <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
            {label}
          </span>
          {ready && (
            <span className="px-2 py-1 rounded-full bg-black/70 text-[10px] font-semibold text-white">
              {isLive ? "LIVE" : "REPLAY"}
            </span>
          )}
        </div>

        <video
          ref={videoRef}
          className="w-full aspect-video bg-black"
          playsInline
          muted
          controls
        />

        {/* DVR scrubber */}
        {hasDvrWindow && (
          <div className="bg-zinc-950 px-3 py-2 space-y-1.5">
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
              className="w-full accent-red-500"
            />
            <div className="flex items-center justify-between text-[10px] text-zinc-400">
              <span>
                {isLive ? "Live edge" : "Rewound in available window"}
              </span>
              {!isLive && (
                <button
                  type="button"
                  onClick={goLive}
                  className="inline-flex items-center gap-1 text-red-400 hover:text-red-300 font-semibold"
                >
                  <RotateCcw className="w-3 h-3" />
                  Go live
                </button>
              )}
            </div>
          </div>
        )}

        {/* Loading overlay */}
        {!ready && !waiting && (
          <div className="absolute inset-0 flex items-center justify-center bg-zinc-950/60">
            <div className="w-6 h-6 rounded-full border-2 border-primary border-t-transparent animate-spin" />
          </div>
        )}

        {/* Waiting-for-stream overlay (retryOnNetworkError mode only) */}
        {waiting && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-zinc-950/80">
            <div className="w-6 h-6 rounded-full border-2 border-zinc-500 border-t-transparent animate-spin" />
            <p className="text-zinc-400 text-sm font-medium">Waiting for stream…</p>
            <p className="text-zinc-600 text-xs">Retrying automatically</p>
          </div>
        )}

        {/* Error toast */}
        {error && (
          <div className="absolute inset-x-0 bottom-12 flex justify-center px-3">
            <span className="rounded-lg bg-black/80 px-3 py-2 text-xs text-white">
              {error}
            </span>
          </div>
        )}
      </div>
    );
  },
);
