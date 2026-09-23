import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  Circle,
  Flag,
  Maximize,
  Minimize,
  Pause,
  Play,
  RotateCcw,
} from "lucide-react";
import { HlsPlayer, type HlsPlayerProps } from "@/components/HlsPlayer";
import { FrameSizeSlider } from "@/components/panorama/FrameSizeSlider";
import { usePanoramaFrame, maxZoomFor } from "@/hooks/use-panorama-frame";
import { usePanoramaFullscreen } from "@/hooks/use-pinch-zoom";
import { frameToVideoStyle } from "@/lib/cropFrame";
import { useFullscreenVideo } from "@/lib/fullscreen-video";
import { cn } from "@/lib/utils";
import { useTranslation } from "@/i18n";

export interface VarMark {
  atUtcMs: number;
  kind: string;
}

export interface VarPlayerProps {
  src: string;
  fallbackSrc?: string;
  hevcSrc?: string;
  title: string;
  onMark?: (atUtcMs: number) => void;
  onCurrentTimeChange?: (atUtcMs: number | null) => void;
  seekToUtcMs?: number | null;
  marks?: VarMark[];
  minStartUtcMs?: number;
}

type VarTimeline = NonNullable<Parameters<NonNullable<HlsPlayerProps["onTimelineChange"]>>[0]>;
type PlayerState = {
  ready: boolean;
  waiting: boolean;
  hasFirstSegment: boolean;
  error: string | null;
};

const FRAME_SECONDS = 1 / 20;
const DEFAULT_PLAYER_STATE: PlayerState = {
  ready: false,
  waiting: false,
  hasFirstSegment: false,
  error: null,
};

export function getVarManifestUrl(src: string, variant: "hls" | "hevc"): string {
  if (variant === "hls") return src;
  return src.replace(/\/hls(\/playlist\.m3u8(?:\?.*)?)$/, "/hevc$1");
}

export function getVarLiveEdgeTarget(liveEdge: number, liveSyncPosition?: number): number {
  return typeof liveSyncPosition === "number" && Number.isFinite(liveSyncPosition)
    ? liveSyncPosition
    : liveEdge;
}

export function formatVarWallClock(atUtcMs: number): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Amman",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 2,
    hour12: false,
  }).formatToParts(new Date(atUtcMs));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.hour}:${values.minute}:${values.second}.${values.fractionalSecond}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isHevcSupported(): boolean {
  if (typeof window === "undefined" || typeof MediaSource === "undefined") return false;
  return MediaSource.isTypeSupported('video/mp4; codecs="hvc1.1.6.L153.B0"');
}

export function VarPlayer({
  src,
  fallbackSrc,
  hevcSrc,
  title,
  onMark,
  onCurrentTimeChange,
  seekToUtcMs,
  marks = [],
  minStartUtcMs,
}: VarPlayerProps) {
  const { t } = useTranslation();
  const copy = t.varPlayer;
  const panelRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const {
    frameBoxRef,
    frame,
    frameZoom,
    selectedRatio,
    draggedRef,
    applyFrameChange,
    setSourceAspect,
    handleFramePointerDown,
    handleFramePointerMove,
    handleFramePointerUp,
  } = usePanoramaFrame();
  const { isFullscreen, isCssFullscreen, toggleFullscreen } = usePanoramaFullscreen(panelRef);
  const { setFullscreenVideo } = useFullscreenVideo();
  const [variant, setVariant] = useState<"hls" | "hevc">("hls");
  const [usingProxy, setUsingProxy] = useState(false);
  const [timeline, setTimeline] = useState<VarTimeline | null>(null);
  const [playerState, setPlayerState] = useState<PlayerState>(DEFAULT_PLAYER_STATE);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [scrub, setScrub] = useState<number | null>(null);
  const [pictureStalled, setPictureStalled] = useState(false);
  const [showControls, setShowControls] = useState(true);
  const lastSeekTargetRef = useRef<number | null>(null);
  const lastLiveEdgeRef = useRef<number | null>(null);
  const autoLiveEdgeStartedRef = useRef(false);
  const userScrubbedRef = useRef(false);
  const hasMediaRef = useRef(false);
  const fallbackWarningRef = useRef(false);
  const controlsTimerRef = useRef<number | null>(null);
  const stallTimerRef = useRef<number | null>(null);
  const hevcSupported = useMemo(isHevcSupported, []);
  const cdnManifestUrl = useMemo(
    () => variant === "hevc" ? hevcSrc ?? getVarManifestUrl(src, variant) : src,
    [hevcSrc, src, variant],
  );
  const proxyManifestUrl = useMemo(
    () => fallbackSrc
      ? (variant === "hevc" ? getVarManifestUrl(fallbackSrc, variant) : fallbackSrc)
      : null,
    [fallbackSrc, variant],
  );
  const manifestUrl = usingProxy && proxyManifestUrl ? proxyManifestUrl : cdnManifestUrl;

  useEffect(() => {
    setFullscreenVideo(isFullscreen);
    return () => setFullscreenVideo(false);
  }, [isFullscreen, setFullscreenVideo]);

  useEffect(() => {
    setUsingProxy(false);
    fallbackWarningRef.current = false;
  }, [src, fallbackSrc]);

  const fallbackToProxy = useCallback((reason: string): boolean => {
    if (!proxyManifestUrl || usingProxy || cdnManifestUrl === proxyManifestUrl) return false;
    if (!fallbackWarningRef.current) {
      fallbackWarningRef.current = true;
      console.warn("[VarPlayer] CDN playback failed; switching to the proxy manifest.", {
        title,
        reason,
      });
    }
    setUsingProxy(true);
    return true;
  }, [cdnManifestUrl, proxyManifestUrl, title, usingProxy]);
  const onManifestFailure = useCallback((reason: string) => {
    fallbackToProxy(reason);
  }, [fallbackToProxy]);

  useEffect(() => {
    setTimeline(null);
    setPlayerState(DEFAULT_PLAYER_STATE);
    hasMediaRef.current = false;
    setPictureStalled(false);
    setScrub(null);
    setPlaying(false);
    setSpeed(1);
    setShowControls(true);
    autoLiveEdgeStartedRef.current = false;
  }, [manifestUrl]);

  useEffect(() => {
    if (!timeline) return;
    const previous = lastLiveEdgeRef.current;
    if (previous == null || Math.abs(previous - timeline.liveEdge) > 0.05) {
      lastLiveEdgeRef.current = timeline.liveEdge;
    }
  }, [timeline?.liveEdge]);

  const onTimelineChange = useCallback((next: VarTimeline) => {
    setTimeline(next);
    if (autoLiveEdgeStartedRef.current || userScrubbedRef.current) return;

    const video = videoRef.current;
    if (!video?.seekable.length) return;
    const seekableStart = video.seekable.start(0);
    const seekableEnd = video.seekable.end(video.seekable.length - 1);
    const target = getVarLiveEdgeTarget(seekableEnd, next.liveSyncPosition);
    if (!Number.isFinite(target)) return;

    autoLiveEdgeStartedRef.current = true;
    video.currentTime = clamp(target, seekableStart, seekableEnd);
    video.play().catch(() => {});
  }, []);

  const onPlaybackState = useCallback((next: PlayerState) => {
    hasMediaRef.current = next.hasFirstSegment;
    if (!next.hasFirstSegment) setPictureStalled(false);
    setPlayerState(next);
  }, []);

  const windowStartUtcMs = timeline?.windowStartProgramTime ?? null;
  const scrubStart = timeline
    ? clamp(
      minStartUtcMs != null && windowStartUtcMs != null
        ? timeline.start + Math.max(0, (minStartUtcMs - windowStartUtcMs) / 1_000)
        : timeline.start,
      timeline.start,
      timeline.liveEdge,
    )
    : 0;
  const currentPosition = scrub ?? (timeline ? clamp(timeline.position, scrubStart, timeline.liveEdge) : 0);
  const currentProgramTime = scrub == null ? timeline?.programTime ?? null : null;

  useEffect(() => {
    onCurrentTimeChange?.(currentProgramTime);
  }, [currentProgramTime, onCurrentTimeChange]);

  const behindSeconds = currentProgramTime != null && timeline?.liveEdgeProgramTime != null
    ? Math.max(0, (timeline.liveEdgeProgramTime - currentProgramTime) / 1_000)
    : timeline
      ? Math.max(0, timeline.liveEdge - currentPosition)
      : 0;
  const hasFrames = Boolean(
    playerState.hasFirstSegment
      && videoRef.current?.readyState != null
      && videoRef.current.readyState >= 2
      && currentProgramTime != null
      && Number.isFinite(currentProgramTime),
  );
  const isReplay = Boolean(hasFrames && behindSeconds > 10);
  const showStarting = !hasFrames;
  const liveRange = timeline ? Math.max(0.001, timeline.liveEdge - scrubStart) : 1;
  const seekTo = useCallback((next: number, pause = false) => {
    const video = videoRef.current;
    if (!video) return;
    const lower = timeline ? scrubStart : (video.seekable.length ? video.seekable.start(0) : 0);
    const upper = timeline?.liveEdge
      ?? (video.seekable.length ? video.seekable.end(video.seekable.length - 1) : Number.POSITIVE_INFINITY);
    if (pause) video.pause();
    video.currentTime = clamp(next, lower, upper);
  }, [scrubStart, timeline]);

  useEffect(() => {
    if (seekToUtcMs == null) {
      lastSeekTargetRef.current = null;
      return;
    }
    if (lastSeekTargetRef.current === seekToUtcMs || currentProgramTime == null) return;
    lastSeekTargetRef.current = seekToUtcMs;
    seekTo(currentPosition + (seekToUtcMs - currentProgramTime) / 1_000, true);
  }, [currentPosition, currentProgramTime, seekTo, seekToUtcMs]);

  const seekBy = useCallback((seconds: number, pause = false) => {
    const video = videoRef.current;
    if (!video) return;
    seekTo(video.currentTime + seconds, pause);
  }, [seekTo]);

  const goLive = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    const edge = timeline?.liveEdge
      ?? (video.seekable.length ? video.seekable.end(video.seekable.length - 1) : null);
    if (edge == null) return;
    const syncPosition = timeline?.liveSyncPosition;
    const target = getVarLiveEdgeTarget(edge, syncPosition);
    setSpeed(1);
    video.playbackRate = 1;
    seekTo(target);
    video.play().catch(() => {});
  }, [seekTo, timeline?.liveEdge, timeline?.liveSyncPosition]);

  const togglePlayback = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) video.play().catch(() => {});
    else video.pause();
  }, []);

  const onKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement | null;
    if (target?.tagName === "INPUT" || target?.tagName === "SELECT" || target?.isContentEditable) return;
    if (event.code === "Space") {
      event.preventDefault();
      togglePlayback();
    } else if (event.key.toLowerCase() === "j") {
      event.preventDefault();
      seekBy(-10);
    } else if (event.key.toLowerCase() === "l") {
      event.preventDefault();
      seekBy(10);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      seekBy(-FRAME_SECONDS, true);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      seekBy(FRAME_SECONDS, true);
    }
  }, [seekBy, togglePlayback]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    return () => {
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
    };
  }, [manifestUrl]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onLoadedMetadata = () => {
      if (video.videoWidth > 0 && video.videoHeight > 0) {
        setSourceAspect(video.videoWidth / video.videoHeight);
      }
    };
    video.addEventListener("loadedmetadata", onLoadedMetadata);
    onLoadedMetadata();
    return () => video.removeEventListener("loadedmetadata", onLoadedMetadata);
  }, [manifestUrl, setSourceAspect]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const clearStall = () => {
      if (stallTimerRef.current != null) {
        window.clearTimeout(stallTimerRef.current);
        stallTimerRef.current = null;
      }
      setPictureStalled(false);
    };
    const checkStall = () => {
      if (stallTimerRef.current != null) window.clearTimeout(stallTimerRef.current);
      if (!hasMediaRef.current || video.paused) return;
      stallTimerRef.current = window.setTimeout(() => {
        if (!video.paused && video.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) {
          setPictureStalled(true);
        }
      }, 1_500);
    };
    video.addEventListener("playing", clearStall);
    video.addEventListener("timeupdate", clearStall);
    video.addEventListener("progress", clearStall);
    video.addEventListener("waiting", checkStall);
    video.addEventListener("stalled", checkStall);
    return () => {
      clearStall();
      video.removeEventListener("playing", clearStall);
      video.removeEventListener("timeupdate", clearStall);
      video.removeEventListener("progress", clearStall);
      video.removeEventListener("waiting", checkStall);
      video.removeEventListener("stalled", checkStall);
    };
  }, [manifestUrl]);

  const pokeControls = useCallback(() => {
    setShowControls(true);
    if (controlsTimerRef.current != null) window.clearTimeout(controlsTimerRef.current);
    controlsTimerRef.current = window.setTimeout(() => setShowControls(false), 4_000);
  }, []);

  useEffect(() => {
    pokeControls();
    return () => {
      if (controlsTimerRef.current != null) window.clearTimeout(controlsTimerRef.current);
    };
  }, [pokeControls]);

  useEffect(() => {
    if (!playing) setShowControls(true);
    else pokeControls();
  }, [playing, pokeControls]);

  useEffect(() => {
    if (!fallbackSrc || usingProxy || cdnManifestUrl === proxyManifestUrl) return;
    const timer = window.setTimeout(() => {
      if (!hasMediaRef.current) fallbackToProxy("15 seconds elapsed without media");
    }, 15_000);
    return () => window.clearTimeout(timer);
  }, [cdnManifestUrl, fallbackSrc, fallbackToProxy, proxyManifestUrl, usingProxy]);

  const markPositions = useMemo(() => {
    if (!timeline || windowStartUtcMs == null) return [];
    return marks
      .map((mark) => ({
        ...mark,
        position: timeline.start + (mark.atUtcMs - windowStartUtcMs) / 1_000,
      }))
      .filter((mark) => mark.position >= scrubStart && mark.position <= timeline.liveEdge);
  }, [marks, scrubStart, timeline, windowStartUtcMs]);

  const handleScrub = (value: number) => {
    userScrubbedRef.current = true;
    setScrub(value);
    seekTo(value);
  };

  return (
    <div
      ref={panelRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
      className={cn(
        "var-player relative min-h-[min(72vh,42rem)] overflow-hidden rounded-2xl bg-void outline-none",
        isFullscreen && "var-player-fullscreen",
        isCssFullscreen && "var-player-css-fullscreen",
      )}
      aria-label={title}
    >
      <div
        className="var-player-zoom-layer absolute inset-0"
      >
        <div className="var-player-frame-centre absolute inset-0 flex items-center justify-center bg-void">
          <div
            ref={frameBoxRef}
            className="var-player-frame-box relative h-auto w-full overflow-hidden bg-void touch-none"
            onPointerDown={handleFramePointerDown}
            onPointerMove={handleFramePointerMove}
            onPointerUp={handleFramePointerUp}
            onPointerCancel={handleFramePointerUp}
            onClick={() => {
              if (draggedRef.current) {
                draggedRef.current = false;
                return;
              }
              pokeControls();
            }}
          >
            <div className="var-player-hls-shell h-full w-full">
              <HlsPlayer
                key={manifestUrl}
                ref={videoRef}
                url={manifestUrl}
                label={title}
                windowSeconds={undefined}
                retryOnNetworkError
                showDvrControls={false}
                showStatusOverlays={false}
                controls={false}
                videoStyle={frameToVideoStyle(frame)}
                onTimelineChange={onTimelineChange}
                useProgramDateTime
                recoverLiveDiscontinuities
                onPlaybackState={onPlaybackState}
                onManifestFailure={onManifestFailure}
              />
            </div>
          </div>
        </div>
      </div>

      <div className={cn("var-player-topbar", !showControls && "is-hidden")}>
        <p className="font-mono text-xs tabular-nums text-text/80" dir="ltr">
          {currentProgramTime == null ? "—" : formatVarWallClock(currentProgramTime)} {copy.clockZone}
        </p>
        <span className="var-player-badge" dir="ltr">
          <Circle className="h-2.5 w-2.5 fill-current" aria-hidden="true" />
          {hasFrames
            ? `${isReplay ? copy.replay : copy.live} · ${isReplay
              ? copy.secondsBehindLive(Math.round(behindSeconds))
              : copy.secondsBehind(Math.round(behindSeconds))}`
            : copy.starting}
        </span>
        <button
          type="button"
          className="var-player-icon"
          onClick={(event) => { event.stopPropagation(); toggleFullscreen(); pokeControls(); }}
          aria-label={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
        >
          {isFullscreen ? <Minimize className="h-4 w-4" aria-hidden="true" /> : <Maximize className="h-4 w-4" aria-hidden="true" />}
        </button>
      </div>

      {(showStarting || playerState.waiting) && (
        <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-black/65 px-5 text-center">
          <div className="h-7 w-7 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          <p className="text-sm font-semibold text-text">{copy.starting}</p>
        </div>
      )}
      {pictureStalled && !playerState.waiting && hasFrames && (
        <div className="pointer-events-none absolute inset-x-3 top-16 z-10 rounded-xl border border-line bg-void/75 px-3 py-2 text-center text-xs font-semibold text-muted-text">
          {copy.noPicture}
        </div>
      )}
      {playerState.error && !playerState.waiting && (
        <div className="pointer-events-none absolute inset-x-3 bottom-28 z-10 rounded-xl bg-void/80 px-3 py-2 text-center text-xs text-text">
          {playerState.error}
        </div>
      )}

      <div className={cn("var-player-bottom-bar", !showControls && "is-hidden")} onClick={(event) => event.stopPropagation()}>
        <div className="var-player-timeline">
          <div className="relative flex-1 px-1">
            <input
              aria-label={copy.timeline}
              type="range"
              min={scrubStart}
              max={timeline?.liveEdge ?? scrubStart + 1}
              step={0.05}
              value={currentPosition}
              disabled={!timeline}
              onChange={(event) => handleScrub(Number(event.target.value))}
              onPointerUp={() => setScrub(null)}
              onKeyUp={() => setScrub(null)}
              className="relative z-10 min-h-8 w-full accent-primary"
            />
            {timeline && (
              <div className="pointer-events-none absolute inset-x-1 top-1/2 z-20 h-5 -translate-y-1/2">
                {markPositions.map((mark) => (
                  <span
                    key={`${mark.atUtcMs}-${mark.kind}`}
                    className="absolute top-0 h-5 w-0.5 rounded-full bg-turf"
                    style={{ left: `${((mark.position - scrubStart) / liveRange) * 100}%` }}
                    title={mark.kind}
                  />
                ))}
              </div>
            )}
          </div>
          <span className="shrink-0 text-[10px] text-muted-text" dir="ltr">
            {timeline ? copy.timelineRange(Math.max(0, Math.round(timeline.liveEdge - scrubStart))) : "—"}
          </span>
        </div>

        <div className="var-player-controls">
          <button type="button" onClick={() => { seekBy(-30); pokeControls(); }} className="var-player-control" aria-label={copy.back30}>{copy.back30Short}</button>
          <button type="button" onClick={() => { seekBy(-10); pokeControls(); }} className="var-player-control" aria-label={copy.back10}>{copy.back10Short}</button>
          <button type="button" onClick={() => { seekBy(-FRAME_SECONDS, true); pokeControls(); }} className="var-player-control" aria-label={copy.backFrame}>{copy.backFrameShort}</button>
          <button type="button" onClick={() => { togglePlayback(); pokeControls(); }} className="var-player-control var-player-control-play" aria-label={playing ? copy.pause : copy.play}>
            {playing ? <Pause className="h-4 w-4" aria-hidden="true" /> : <Play className="h-4 w-4" aria-hidden="true" />}
          </button>
          <button type="button" onClick={() => { seekBy(FRAME_SECONDS, true); pokeControls(); }} className="var-player-control" aria-label={copy.forwardFrame}>{copy.forwardFrameShort}</button>
          <button type="button" onClick={() => { goLive(); pokeControls(); }} className="var-player-control var-player-control-live" aria-label={copy.goLive}>
            <RotateCcw className="h-4 w-4" aria-hidden="true" />
            <span>{copy.goLive}</span>
          </button>
          <div className="var-player-control-group">
            <span>{copy.speed}</span>
            {[0.25, 0.5, 1].map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => {
                  setSpeed(value);
                  if (videoRef.current) videoRef.current.playbackRate = value;
                  pokeControls();
                }}
                className={cn("var-player-pill", speed === value && "is-active")}
              >
                {value}×
              </button>
            ))}
          </div>
          <FrameSizeSlider
            zoom={frameZoom}
            frame={frame}
            maxZoom={maxZoomFor(selectedRatio)}
            compact
            onChange={(nextZoom) => {
              applyFrameChange(nextZoom, selectedRatio);
              pokeControls();
            }}
          />
          {hevcSupported && (
            <div className="var-player-control-group">
              <span>{copy.quality}</span>
              {(["hls", "hevc"] as const).map((nextVariant) => (
                <button
                  key={nextVariant}
                  type="button"
                  onClick={() => { setVariant(nextVariant); pokeControls(); }}
                  className={cn("var-player-pill", variant === nextVariant && "is-active")}
                >
                  {nextVariant === "hls" ? copy.standard : copy.fullDetail}
                </button>
              ))}
            </div>
          )}
          {onMark && (
            <button
              type="button"
              onClick={() => currentProgramTime != null && onMark(currentProgramTime)}
              disabled={currentProgramTime == null}
              className="var-player-control var-player-control-mark"
              aria-label={copy.markMoment}
            >
              <Flag className="h-4 w-4" aria-hidden="true" />
              <span>{copy.markMoment}</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}