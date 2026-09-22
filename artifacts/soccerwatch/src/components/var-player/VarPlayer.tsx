import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type TouchEvent as ReactTouchEvent,
} from "react";
import {
  Circle,
  Flag,
  Pause,
  Play,
  RotateCcw,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { HlsPlayer, type HlsPlayerProps } from "@/components/HlsPlayer";
import { cn } from "@/lib/utils";

export interface VarMark {
  atUtcMs: number;
  kind: string;
}

export interface VarPlayerProps {
  src: string;
  title: string;
  onMark?: (atUtcMs: number) => void;
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

function formatBehind(seconds: number): string {
  return `${Math.max(0, Math.round(seconds))} s behind`;
}

function buttonLabel(label: string, arabic: string): string {
  return `${label} / ${arabic}`;
}

export function VarPlayer({ src, title, onMark, marks = [], minStartUtcMs }: VarPlayerProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [variant, setVariant] = useState<"hls" | "hevc">("hls");
  const [timeline, setTimeline] = useState<VarTimeline | null>(null);
  const [playerState, setPlayerState] = useState<PlayerState>(DEFAULT_PLAYER_STATE);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [scrub, setScrub] = useState<number | null>(null);
  const [lastAdvancedAt, setLastAdvancedAt] = useState<number | null>(null);
  const lastLiveEdgeRef = useRef<number | null>(null);
  const dragRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const pinchRef = useRef<{ distance: number; zoom: number } | null>(null);
  const hevcSupported = useMemo(isHevcSupported, []);
  const manifestUrl = useMemo(() => getVarManifestUrl(src, variant), [src, variant]);

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    setTimeline(null);
    setPlayerState(DEFAULT_PLAYER_STATE);
    setScrub(null);
    setPlaying(false);
    setSpeed(1);
  }, [manifestUrl]);

  useEffect(() => {
    if (!timeline) return;
    const previous = lastLiveEdgeRef.current;
    if (previous == null || Math.abs(previous - timeline.liveEdge) > 0.05) {
      lastLiveEdgeRef.current = timeline.liveEdge;
      setLastAdvancedAt(Date.now());
    }
  }, [timeline?.liveEdge]);

  const onTimelineChange = useCallback((next: VarTimeline) => {
    setTimeline(next);
  }, []);

  const onPlaybackState = useCallback((next: PlayerState) => {
    setPlayerState(next);
  }, []);

  const windowStartUtcMs = timeline?.programTime != null
    ? timeline.programTime - (timeline.position - timeline.start) * 1_000
    : null;
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
  const currentProgramTime = timeline?.programTime != null && timeline
    ? timeline.programTime + (currentPosition - timeline.position) * 1_000
    : null;
  const behindSeconds = currentProgramTime != null
    ? Math.max(0, (nowMs - currentProgramTime) / 1_000)
    : timeline
      ? Math.max(0, timeline.liveEdge - currentPosition)
      : 0;
  const stale = Boolean(
    timeline
    && playerState.hasFirstSegment
    && lastAdvancedAt != null
    && nowMs - lastAdvancedAt > 60_000,
  );
  const showStarting = !playerState.hasFirstSegment && !timeline;
  const liveRange = timeline ? Math.max(0.001, timeline.liveEdge - scrubStart) : 1;
  const zoomStyle: CSSProperties = {
    transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
    transformOrigin: "center center",
    transition: dragRef.current ? "none" : "transform 160ms ease-out",
  };

  const setZoomLevel = useCallback((next: number) => {
    const clamped = clamp(Math.round(next * 4) / 4, 1, 4);
    setZoom(clamped);
    if (clamped === 1) setPan({ x: 0, y: 0 });
  }, []);

  const seekTo = useCallback((next: number, pause = false) => {
    const video = videoRef.current;
    if (!video) return;
    const lower = timeline ? scrubStart : (video.seekable.length ? video.seekable.start(0) : 0);
    const upper = timeline?.liveEdge
      ?? (video.seekable.length ? video.seekable.end(video.seekable.length - 1) : Number.POSITIVE_INFINITY);
    if (pause) video.pause();
    video.currentTime = clamp(next, lower, upper);
  }, [scrubStart, timeline]);

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
    setSpeed(1);
    video.playbackRate = 1;
    seekTo(edge - 0.25);
    video.play().catch(() => {});
  }, [seekTo, timeline?.liveEdge]);

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

  const limitPan = useCallback((value: number) => {
    const max = 180 * (zoom - 1);
    return clamp(value, -max, max);
  }, [zoom]);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (zoom <= 1 || event.pointerType === "touch") return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y };
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    setPan({
      x: limitPan(dragRef.current.panX + event.clientX - dragRef.current.x),
      y: limitPan(dragRef.current.panY + event.clientY - dragRef.current.y),
    });
  };

  const endPointerDrag = () => {
    dragRef.current = null;
  };

  const distanceBetweenTouches = (event: ReactTouchEvent<HTMLDivElement>): number => {
    const [first, second] = [event.touches[0], event.touches[1]];
    return Math.hypot(first.clientX - second.clientX, first.clientY - second.clientY);
  };

  const onTouchStart = (event: ReactTouchEvent<HTMLDivElement>) => {
    if (event.touches.length === 2) {
      pinchRef.current = { distance: distanceBetweenTouches(event), zoom };
    } else if (event.touches.length === 1 && zoom > 1) {
      dragRef.current = {
        x: event.touches[0].clientX,
        y: event.touches[0].clientY,
        panX: pan.x,
        panY: pan.y,
      };
    }
  };

  const onTouchMove = (event: ReactTouchEvent<HTMLDivElement>) => {
    if (pinchRef.current && event.touches.length === 2) {
      event.preventDefault();
      const ratio = distanceBetweenTouches(event) / Math.max(1, pinchRef.current.distance);
      setZoomLevel(pinchRef.current.zoom * ratio);
      return;
    }
    if (dragRef.current && event.touches.length === 1) {
      event.preventDefault();
      setPan({
        x: limitPan(dragRef.current.panX + event.touches[0].clientX - dragRef.current.x),
        y: limitPan(dragRef.current.panY + event.touches[0].clientY - dragRef.current.y),
      });
    }
  };

  const finishTouch = () => {
    pinchRef.current = null;
    dragRef.current = null;
  };

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
    setScrub(value);
    seekTo(value);
  };

  return (
    <div
      ref={panelRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
      className="var-player space-y-3 outline-none"
      aria-label={title}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-foreground">{title}</p>
          <p className="font-mono text-xs tabular-nums text-muted-foreground" dir="ltr">
            {currentProgramTime == null ? "—" : formatVarWallClock(currentProgramTime)} Amman
          </p>
        </div>
        <span className="shrink-0 rounded-full border border-red-500/30 bg-red-500/10 px-2.5 py-1 text-xs font-semibold text-red-300" dir="ltr">
          <Circle className="mr-1 inline h-2.5 w-2.5 fill-current" aria-hidden="true" />
          LIVE · {formatBehind(behindSeconds)}
        </span>
      </div>

      <div
        className="relative overflow-hidden rounded-2xl border border-border bg-black touch-none"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPointerDrag}
        onPointerCancel={endPointerDrag}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={finishTouch}
      >
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
          videoStyle={zoomStyle}
          onTimelineChange={onTimelineChange}
          onPlaybackState={onPlaybackState}
        />
        {(showStarting || playerState.waiting) && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/75 px-5 text-center">
            <div className="h-7 w-7 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            <p className="text-sm font-semibold text-white">
              Starting VAR — the camera is connecting (up to a minute)
            </p>
          </div>
        )}
        {stale && !playerState.waiting && (
          <div className="absolute inset-x-3 top-3 rounded-xl border border-amber-400/30 bg-black/75 px-3 py-2 text-center text-xs font-semibold text-amber-100">
            No picture from the camera — retrying
          </div>
        )}
        {playerState.error && !playerState.waiting && (
          <div className="absolute inset-x-3 bottom-3 rounded-xl bg-black/80 px-3 py-2 text-center text-xs text-white">
            {playerState.error}
          </div>
        )}
      </div>

      <div className="rounded-2xl border border-border bg-card p-3">
        <div className="relative px-1">
          <input
            aria-label={buttonLabel("VAR timeline", "خط زمني للمراجعة")}
            type="range"
            min={scrubStart}
            max={timeline?.liveEdge ?? scrubStart + 1}
            step={0.05}
            value={currentPosition}
            disabled={!timeline}
            onChange={(event) => handleScrub(Number(event.target.value))}
            onPointerUp={() => setScrub(null)}
            onKeyUp={() => setScrub(null)}
            className="relative z-10 min-h-11 w-full accent-primary"
          />
          {timeline && (
            <div className="pointer-events-none absolute inset-x-1 top-1/2 z-20 h-5 -translate-y-1/2">
              {markPositions.map((mark) => (
                <span
                  key={`${mark.atUtcMs}-${mark.kind}`}
                  className="absolute top-0 h-5 w-0.5 rounded-full bg-amber-300 shadow-[0_0_8px_rgba(252,211,77,.8)]"
                  style={{ left: `${((mark.position - scrubStart) / liveRange) * 100}%` }}
                  title={mark.kind}
                />
              ))}
            </div>
          )}
        </div>
        <div className="flex justify-between text-[10px] text-muted-foreground" dir="ltr">
          <span>{timeline ? `−${Math.max(0, Math.round(timeline.liveEdge - scrubStart))} s` : "—"}</span>
          <span>{timeline ? `${Math.max(0, Math.round(timeline.liveEdge - currentPosition))} s behind` : "Waiting"}</span>
          <span>LIVE</span>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
        <button type="button" onClick={() => seekBy(-30)} className="var-control" aria-label={buttonLabel("Back 30 seconds", "رجوع ٣٠ ثانية")}>−30 s</button>
        <button type="button" onClick={() => seekBy(-10)} className="var-control" aria-label={buttonLabel("Back 10 seconds", "رجوع ١٠ ثوان")}>−10 s</button>
        <button type="button" onClick={() => seekBy(-FRAME_SECONDS, true)} className="var-control" aria-label={buttonLabel("Back one frame", "إطار للخلف")}>−1 frame</button>
        <button type="button" onClick={togglePlayback} className="var-control bg-primary text-primary-foreground" aria-label={buttonLabel(playing ? "Pause" : "Play", playing ? "إيقاف" : "تشغيل")}>
          {playing ? <Pause className="h-4 w-4" aria-hidden="true" /> : <Play className="h-4 w-4" aria-hidden="true" />}
          <span>{playing ? "Pause" : "Play"}</span>
        </button>
        <button type="button" onClick={() => seekBy(FRAME_SECONDS, true)} className="var-control" aria-label={buttonLabel("Forward one frame", "إطار للأمام")}>+1 frame</button>
        <button type="button" onClick={goLive} className="var-control border-red-500/30 text-red-300" aria-label={buttonLabel("Go live", "العودة للبث")}>
          <RotateCcw className="h-4 w-4" aria-hidden="true" />
          <span>Go live</span>
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold text-muted-foreground">Speed / السرعة</span>
        {[0.25, 0.5, 1].map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => {
              setSpeed(value);
              if (videoRef.current) videoRef.current.playbackRate = value;
            }}
            className={cn("min-h-11 min-w-16 rounded-xl border px-3 text-xs font-semibold", speed === value ? "border-primary bg-primary/15 text-primary" : "border-border text-muted-foreground")}
          >
            {value}×
          </button>
        ))}
        <span className="ms-2 text-xs font-semibold text-muted-foreground">Zoom / التكبير</span>
        <button type="button" onClick={() => setZoomLevel(zoom - 0.25)} className="var-icon-control" aria-label={buttonLabel("Zoom out", "تصغير")}><ZoomOut className="h-4 w-4" /></button>
        <span className="min-w-10 text-center text-xs font-semibold text-foreground" dir="ltr">{zoom}×</span>
        <button type="button" onClick={() => setZoomLevel(zoom + 0.25)} className="var-icon-control" aria-label={buttonLabel("Zoom in", "تكبير")}><ZoomIn className="h-4 w-4" /></button>
        {onMark && (
          <button
            type="button"
            onClick={() => currentProgramTime != null && onMark(currentProgramTime)}
            disabled={currentProgramTime == null}
            className="ms-auto inline-flex min-h-11 items-center gap-1.5 rounded-xl border border-amber-300/30 px-3 text-xs font-semibold text-amber-200 disabled:opacity-40"
            aria-label={buttonLabel("Mark this moment", "تحديد هذه اللحظة")}
          >
            <Flag className="h-4 w-4" aria-hidden="true" />
            Mark / تحديد
          </button>
        )}
      </div>

      {hevcSupported && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>Quality / الجودة</span>
          {(["hls", "hevc"] as const).map((nextVariant) => (
            <button
              key={nextVariant}
              type="button"
              onClick={() => setVariant(nextVariant)}
              className={cn("min-h-11 rounded-xl border px-3 font-semibold", variant === nextVariant ? "border-primary bg-primary/15 text-primary" : "border-border")}
            >
              {nextVariant === "hls" ? "Standard / عادي" : "Full detail / تفاصيل كاملة"}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}