import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { AnimatePresence, motion } from "framer-motion";
import {
  AlertTriangle,
  CheckCircle2,
  Circle,
  CircleDot,
  LoaderCircle,
  Maximize,
  Minimize,
  Pause,
  Play,
  MoveHorizontal,
  Square,
  X,
} from "lucide-react";
import Hls from "hls.js";
import type { TimelineFragment } from "@/components/HlsPlayer";
import { CoachBubble } from "@/components/explainers/CoachBubble";
import { SkipFlash } from "@/components/skip-flash";
import { usePanoramaFrame, maxZoomFor } from "@/hooks/use-panorama-frame";
import { useSkipTap } from "@/hooks/use-skip-tap";
import { useToast } from "@/hooks/use-toast";
import { useTranslation } from "@/i18n";
import { useExplainerCopy } from "@/i18n/explainer-strings";
import { useFirstTime } from "@/lib/first-time";
import { useClientSettings } from "@/lib/client-settings";
import { useFullscreenVideo } from "@/lib/fullscreen-video";
import {
  DEFAULT_SRC_ASPECT,
  formatElapsed,
  frameToVideoStyle,
  type AspectRatio,
  type CropKeyframe,
  type Frame,
  clampOrigin,
  applyFrameToVideo,
} from "@/lib/cropFrame";
import {
  cameraAt, cameraYAt, type CameraPoint,
} from "@/lib/follow-ball";
import { computeFollowBallPath } from "@/lib/follow-ball-compute";
import {
  PLAYBACK_MAX_WIDTH,
  capBelowFailedLevel,
  capPlaybackQuality,
  getAllowedHlsLevelIndexes,
} from "@/lib/hlsQuality";
import { cn } from "@/lib/utils";
import {
  beginSeekDrag,
  changeSeekValue,
  clampPlaybackPosition,
  createPlaybackWatchdog,
  createSeekDragState,
  decidePlaybackRecovery,
  endSeekDrag,
  initialPlaybackSourceStage,
  playbackPositionForRestore,
  PLAYBACK_STALL_TIMEOUT_MS,
  summarizeFatalHlsError,
  type PlaybackSourceStage,
} from "./playbackRecovery";
import {
  createLiveClipWindow,
  formatAmmanClock,
  liveElapsedSeconds,
  liveProgramTimeAtPosition,
} from "./liveTime";
import { normalizeClipKeyframes } from "./normalize";
import {
  FRAME_DURATION_SECONDS,
  PLAYBACK_SPEEDS,
  playbackSpeedForKey,
  playbackStepForKey,
} from "./playbackControls";

export type ClipSource =
  | { kind: "bunny"; videoId: string }
  | { kind: "ownerShare"; token: string };

export type ClipDraft = {
  startTime: number;
  endTime: number;
  cropPath: CropKeyframe[];
  aspectRatio: AspectRatio;
  title: string;
};

export type LiveDvrOptions = {
  windowStartUtcMs: number;
  windowEndUtcMs: number;
  maxDurationSeconds?: number;
  onCurrentTimeUtcChange?: (timeUtcMs: number | null) => void;
};

/** A tick on the seek bar: a moment worth finding in a long recording. */
export type ClipTimelineMarker = {
  /** seconds into the video */
  at: number;
  color: string;
  label: string;
  /** drawn taller, for the moments the viewer is looking for */
  emphasis?: boolean;
};

/** A shaded stretch under the seek bar, e.g. where the ball was in play. */
export type ClipTimelineBand = { from: number; to: number; color: string };

/** A seek the page asks for; a new id seeks again even to the same second. */
export type ClipSeekRequest = { seconds: number; id: number; play?: boolean };

export type ClipPlayerProps = {
  /** Preferred HLS manifest URL. */
  src: string;
  /** Same recording through the app proxy. Archived recordings use this before any cross-origin source. */
  proxySrc?: string;
  /** Same-origin progressive MP4 fallback, tried only after an HLS retry fails. */
  fallbackSrc?: string;
  onFallback?: () => void;
  title: string;
  source: ClipSource;
  fieldId?: number;
  academyId?: number;
  isLive?: boolean;
  /** Enable UTC-based review and clipping for a rolling live HLS DVR window. */
  liveDvr?: LiveDvrOptions;
  liveCameraId?: string;
  layout: "overlay" | "inline";
  /** Condense idle editing controls into a single docked row. */
  toolbarLayout?: "stacked" | "single-row";
  onClose?: () => void;
  canSave: boolean;
  onRequireAuth: (draft: ClipDraft) => void;
  onSave: (draft: ClipDraft) => Promise<void>;
  seekToSeconds?: number | null;
  seekToUtcMs?: number | null;
  /** Ticks drawn on the seek bar (recorded footage only). */
  timelineMarkers?: ClipTimelineMarker[];
  /** Stretches shaded in a thin strip under the seek bar (recorded footage only). */
  timelineBands?: ClipTimelineBand[];
  /** Called as playback moves, with the video position in seconds. */
  onPositionChange?: (seconds: number) => void;
  /** Seek on demand; unlike seekToSeconds it repeats when the id changes. */
  seekRequest?: ClipSeekRequest | null;
  /** A small label pinned to the top corner of the picture, e.g. the moment now playing. */
  stageBadge?: ReactNode;
};

type ClipMode = "idle" | "recording" | "review";
function formatDuration(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function FullscreenBridge() {
  const { setFullscreenVideo } = useFullscreenVideo();
  useEffect(() => {
    setFullscreenVideo(true);
    return () => setFullscreenVideo(false);
  }, [setFullscreenVideo]);
  return null;
}

function MiniMap({ frame, srcAspect }: { frame: Frame; srcAspect: number }) {
  const width = 128;
  const height = Math.max(24, Math.round(width / (srcAspect > 0 ? srcAspect : DEFAULT_SRC_ASPECT)));
  return (
    <div
      className="relative rounded-md overflow-hidden border border-white/30 shadow-lg shrink-0"
      style={{ width, height, background: "rgba(0,0,0,0.55)" }}
    >
      <div className="absolute inset-0 opacity-20">
        <div className="absolute left-1/2 inset-y-0 w-px bg-white" />
        <div
          className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white"
          style={{ width: height * 0.5, height: height * 0.5 }}
        />
      </div>
      <div
        className="absolute inset-0 bg-black/55"
        style={{
          clipPath: `polygon(0% 0%, 100% 0%, 100% 100%, 0% 100%, 0% 0%,
            ${frame.x * 100}% ${frame.y * 100}%,
            ${frame.x * 100}% ${(frame.y + frame.h) * 100}%,
            ${(frame.x + frame.w) * 100}% ${(frame.y + frame.h) * 100}%,
            ${(frame.x + frame.w) * 100}% ${frame.y * 100}%,
            ${frame.x * 100}% ${frame.y * 100}%)`,
        }}
      />
      <div
        className="absolute border-2 border-primary"
        style={{
          left: `${frame.x * 100}%`,
          top: `${frame.y * 100}%`,
          width: `${frame.w * 100}%`,
          height: `${frame.h * 100}%`,
        }}
      />
      <p className="absolute bottom-0.5 left-0 right-0 text-center text-[8px] text-white/50 font-medium tracking-wide uppercase pointer-events-none">
        field view
      </p>
    </div>
  );
}

function QualityPicker({
  levels,
  active,
  open,
  onToggle,
  onSelect,
}: {
  levels: Array<{ width: number; height: number; bitrate: number; index: number }>;
  active: number;
  open: boolean;
  onToggle: () => void;
  onSelect: (index: number) => void;
}) {
  if (levels.length === 0) return null;
  const resolutionLabel = (level: { width: number; height: number }) =>
    level.width > 0 && level.height > 0
      ? `${level.width}×${level.height}`
      : `${level.height}p`;
  const levelLabel = (level: { width: number; height: number; bitrate: number }) => {
    const resolution = resolutionLabel(level);
    return level.bitrate > 0
      ? `${resolution} · ${(level.bitrate / 1_000_000).toFixed(1)} Mbps`
      : resolution;
  };
  const singleLevel = levels.length === 1;
  const activeLevel = levels.find((level) => level.index === active);
  const buttonLabel = singleLevel
    ? resolutionLabel(levels[0])
    : active === -1
      ? "Auto"
      : activeLevel
        ? levelLabel(activeLevel)
        : "Auto";
  return (
    <div
      className="absolute end-3 z-[60] pointer-events-auto"
      style={{ top: "calc(env(safe-area-inset-top) + 4rem)" }}
    >
      <div className="relative">
        <button
          type="button"
          data-testid="button-video-quality"
          aria-label={singleLevel ? `Only resolution available: ${buttonLabel}` : "Select video quality"}
          aria-haspopup={singleLevel ? "dialog" : "menu"}
          aria-expanded={open}
          title={singleLevel ? "Only one resolution is available; click for details" : "Select video quality"}
          onClick={onToggle}
          className="px-3 py-1.5 rounded-full bg-black/70 backdrop-blur-sm text-white text-xs font-bold border border-white/20"
        >
          {buttonLabel}
        </button>
        {open && (
          <div
            role={singleLevel ? "status" : "menu"}
            aria-label="Video quality"
            className="absolute top-full end-0 mt-1 bg-black/95 backdrop-blur-md rounded-xl overflow-hidden shadow-xl border border-white/10 min-w-[8rem]"
          >
            {singleLevel ? (
              <p className="max-w-64 px-3 py-2.5 text-xs leading-5 text-white/80">
                This player received one compatible HLS quality level ({buttonLabel}). If Bunny lists more variants, they must be present in this video's HLS playlist and supported by the browser.
              </p>
            ) : (
              [{ width: 0, height: 0, bitrate: 0, index: -1 }, ...levels].map((level) => (
                <button
                  key={level.index}
                  type="button"
                  role="menuitemradio"
                  aria-checked={active === level.index}
                  data-testid={`video-quality-${level.index}`}
                  onClick={() => onSelect(level.index)}
                  className={cn(
                    "block w-full px-4 py-2.5 text-xs font-semibold text-left transition-colors",
                    active === level.index ? "text-primary" : "text-white hover:bg-white/10",
                  )}
                >
                  {level.index === -1 ? "Auto" : levelLabel(level)}
                </button>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function ClipPlayer({
  src,
  proxySrc,
  fallbackSrc,
  onFallback,
  title,
  source,
  fieldId,
  academyId,
  isLive = false,
  liveDvr,
  liveCameraId,
  layout,
  toolbarLayout = "stacked",
  onClose,
  canSave,
  onRequireAuth,
  onSave,
  seekToSeconds,
  seekToUtcMs,
  timelineMarkers,
  timelineBands,
  onPositionChange,
  seekRequest,
  stageBadge,
}: ClipPlayerProps) {
  const singleRowToolbar = toolbarLayout === "single-row";
  const initialSourceStage = initialPlaybackSourceStage({ isLive, proxySrc, src });
  const videoRef = useRef<HTMLVideoElement>(null);
  const followFrameRef = useRef<Frame | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const fallbackRestoreUtcRef = useRef<number | null>(null);
  const sourceStageRef = useRef<PlaybackSourceStage>(initialSourceStage);
  const resumePositionRef = useRef<number | null>(null);
  const lastKnownPositionRef = useRef(0);
  const currentSourceRetryRef = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const {
    frameBoxRef,
    frameZoomRef,
    selectedRatioRef,
    srcAspectRef,
    frameOriginRef,
    draggedRef,
    frame,
    frameZoom,
    selectedRatio,
    srcAspect,
    readFrame,
    setOrigin,
    applyFrameChange,
    setSourceAspect,
    handleFramePointerDown,
    handleFramePointerMove,
    handleFramePointerUp,
  } = usePanoramaFrame();
  const seekDragStateRef = useRef(createSeekDragState());
  const seekInProgressRef = useRef(false);
  const controlsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const frameRepeatDelayRef = useRef<number | null>(null);
  const frameRepeatIntervalRef = useRef<number | null>(null);
  const clipModeRef = useRef<ClipMode>("idle");
  const stopRecordingRef = useRef<(overrideEndTime?: number) => void>(() => {});
  const clipStartRef = useRef(0);
  const liveClipStartUtcRef = useRef<number | null>(null);
  const liveClipEndUtcRef = useRef<number | null>(null);
  const liveFragmentsRef = useRef<TimelineFragment[]>([]);
  const liveUtcRef = useRef<number | null>(null);
  const recordingRef = useRef<{ interval: ReturnType<typeof setInterval> | null; keyframes: CropKeyframe[] }>({
    interval: null,
    keyframes: [],
  });
  const liveRecordElapsedRef = useRef(0);
  const lastExternalSeekRef = useRef<number | null>(null);
  const lastExternalUtcSeekRef = useRef<number | null>(null);
  const elapsedRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const { toast } = useToast();
  const { t } = useTranslation();
  const clientSettings = useClientSettings(fieldId).data?.settings;
  const followSetting = clientSettings?.["playback.followBall"] !== false;
  const [followChoice, setFollowChoice] = useState<boolean | null>(() => {
    try {
      const saved = localStorage.getItem("replay.followBall");
      return saved === null ? null : saved === "true";
    } catch { return null; }
  });
  const followVideoId = source.kind === "bunny" ? source.videoId : null;
  const ballPathQuery = useQuery({
    queryKey: ["ball-path", followVideoId],
    queryFn: async (): Promise<{ v: 1; samples: Array<[number, number, number]>; gameSpans: Array<[number, number]>; cameraSpans: Array<[number, number]>; coverage: number } | null> => {
      const response = await fetch(`${import.meta.env.BASE_URL.replace(/\/$/, "")}/api/videos/${encodeURIComponent(followVideoId ?? "")}/ball-path`, { credentials: "include" });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`Ball path unavailable (${response.status})`);
      return response.json();
    },
    enabled: followVideoId !== null && followSetting,
    staleTime: 60 * 60 * 1000,
    refetchOnMount: false,
    retry: false,
  });
  const ballPath = ballPathQuery.data && ballPathQuery.data.coverage >= 0.25
    ? ballPathQuery.data : undefined;
  const [cameraPath, setCameraPath] = useState<CameraPoint[] | null>(null);
  const followAvailable = Boolean(followVideoId && followSetting && ballPath && cameraPath?.length);
  const isFollowingBall = followAvailable && followChoice !== false;
  const followEnabledRef = useRef(false);
  followEnabledRef.current = isFollowingBall;
  const setFollowPreference = useCallback((enabled: boolean) => {
    followEnabledRef.current = enabled;
    if (!enabled && followFrameRef.current) {
      setOrigin(followFrameRef.current.x, followFrameRef.current.y);
      followFrameRef.current = null;
    }
    try { localStorage.setItem("replay.followBall", String(enabled)); } catch { /* storage can be disabled */ }
    setFollowChoice(enabled);
  }, [setOrigin]);
  const [duration, setDuration] = useState(0);
  const [followUiFrame, setFollowUiFrame] = useState<Frame | null>(null);
  const displayedFrame = isFollowingBall ? followUiFrame ?? followFrameRef.current ?? frame : frame;
  useEffect(() => {
    setCameraPath(null);
    if (!followVideoId || !ballPath || duration <= 0) return;
    let active = true;
    void computeFollowBallPath(
      followVideoId,
      ballPath.samples,
      ballPath.cameraSpans ?? ballPath.gameSpans,
      duration,
    ).then((path) => {
      if (active) setCameraPath(path);
    }).catch(() => {
      if (active) setCameraPath(null);
    });
    return () => { active = false; };
  }, [ballPath, duration, followVideoId]);
  const followLoopErrorLogged = useRef(false);
  const manualTookControl = useRef(false);

  useEffect(() => {
    if (!isFollowingBall && followFrameRef.current) {
      setOrigin(followFrameRef.current.x, followFrameRef.current.y);
      followFrameRef.current = null;
    }
  }, [isFollowingBall, setOrigin]);

  useEffect(() => {
    if (!isFollowingBall) {
      setFollowUiFrame(null);
      return;
    }
    const timer = window.setInterval(() => setFollowUiFrame(followFrameRef.current), 250);
    return () => window.clearInterval(timer);
  }, [isFollowingBall]);

  useEffect(() => {
    const video = videoRef.current;
    if (!isFollowingBall || !cameraPath?.length) return;
    if (!video) return;
    let raf = 0;
    let active = true;
    const update = () => {
      if (!active || !followEnabledRef.current) return;
      try {
        const current = videoRef.current;
        if (!current) return;
        const frameNow = readFrame();
        const centerX = cameraAt(cameraPath, current.currentTime);
        const centerY = frameZoomRef.current > 1.01
          ? cameraYAt(cameraPath, current.currentTime)
          : frameNow.y + frameNow.h / 2;
        const x = clampOrigin(centerX - frameNow.w / 2, frameNow.w);
        const y = clampOrigin(centerY - frameNow.h / 2, frameNow.h);
        frameOriginRef.current = { x, y };
        const nextFrame = { ...frameNow, x, y };
        followFrameRef.current = nextFrame;
        applyFrameToVideo(current, nextFrame);
        if (!current.paused || current.seeking) raf = requestAnimationFrame(update);
      } catch (error) {
        if (!followLoopErrorLogged.current) {
          followLoopErrorLogged.current = true;
          console.warn("[ClipPlayer] Follow-ball camera stopped", error);
        }
        setFollowPreference(false);
      }
    };
    const start = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(update);
    };
    const stop = () => { cancelAnimationFrame(raf); };
    video.addEventListener("play", start);
    video.addEventListener("seeked", start);
    video.addEventListener("pause", stop);
    start();
    return () => {
      active = false;
      stop();
      video.removeEventListener("play", start);
      video.removeEventListener("seeked", start);
      video.removeEventListener("pause", stop);
    };
  }, [applyFrameToVideo, cameraPath, frameOriginRef, frameZoomRef, isFollowingBall, readFrame, setFollowPreference]);

  const onFramePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    handleFramePointerMove(event, () => {
      if (showLookCoach) dismissLookCoach();
      if (isFollowingBall && !manualTookControl.current) {
        manualTookControl.current = true;
        setFollowPreference(false);
      }
    });
  };

  const [isPlaying, setIsPlaying] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [qualityLevels, setQualityLevels] = useState<Array<{ width: number; height: number; bitrate: number; index: number }>>([]);
  const [activeQuality, setActiveQuality] = useState(-1);
  const [showQualityPicker, setShowQualityPicker] = useState(false);
  const [sourceStage, setSourceStageState] = useState<PlaybackSourceStage>(initialSourceStage);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [look, setLook] = useState<"original" | "warm" | "cinematic" | "noir">("original");
  const [currentTime, setCurrentTime] = useState(0);
  const [liveUtcMs, setLiveUtcMs] = useState<number | null>(null);
  const [liveRange, setLiveRange] = useState<{ startUtcMs: number; endUtcMs: number } | null>(null);
  const [showControls, setShowControls] = useState(true);
  const [playbackUiState, setPlaybackUiState] = useState<"loading" | "ready" | "error">("loading");
  const [isRetryingPlayback, setIsRetryingPlayback] = useState(false);
  const [playbackDiagnostic, setPlaybackDiagnostic] = useState<string | null>(null);
  const [playbackAttempt, setPlaybackAttempt] = useState(0);
  const [clipMode, setClipMode] = useState<ClipMode>("idle");
  const explainerCopy = useExplainerCopy();
  // First-time coach marks: how to look around, then how clipping works.
  const coachReady = playbackUiState === "ready" && clipMode === "idle";
  const [showLookCoach, dismissLookCoach] = useFirstTime("clip-player.look-around.v1", coachReady);
  const [showRecordCoach, dismissRecordCoach] = useFirstTime("clip-player.record.v1", coachReady && !showLookCoach);
  const coachVisible = showLookCoach || showRecordCoach;
  // Home's "Get your first clip" ticks "Watch your match" once a video has played here.
  const [notWatchedYet, markWatched] = useFirstTime("home.first-clip.watched.v1", playbackUiState === "ready");
  useEffect(() => {
    if (notWatchedYet) markWatched();
  }, [notWatchedYet, markWatched]);
  const [clipEndTime, setClipEndTime] = useState(0);
  const [clipTitle, setClipTitle] = useState("");
  const [isSavingClip, setIsSavingClip] = useState(false);
  const [recElapsed, setRecElapsed] = useState(0);
  const [clipDurationSeconds, setClipDurationSeconds] = useState(0);

  const sourceKey = source.kind === "bunny" ? source.videoId : source.token;
  const isLiveDvr = Boolean(liveDvr);
  const maxLiveClipSeconds = Math.max(1, Math.min(600, liveDvr?.maxDurationSeconds ?? 600));
  const activeSrc = sourceStage === "fallback"
    ? fallbackSrc ?? src
    : sourceStage === "proxy"
      ? proxySrc ?? src
      : src;
  const usingFallback = sourceStage === "fallback";

  const setPlaybackSourceStage = useCallback((stage: PlaybackSourceStage) => {
    sourceStageRef.current = stage;
    currentSourceRetryRef.current = false;
    seekInProgressRef.current = false;
    seekDragStateRef.current = createSeekDragState();
    setIsRetryingPlayback(false);
    setSourceStageState(stage);
  }, []);

  const retryPlayback = () => {
    const element = videoRef.current;
    if (element && !isLive) {
      resumePositionRef.current = playbackPositionForRestore(
        element.currentTime,
        lastKnownPositionRef.current,
      );
    }
    setPlaybackUiState("loading");
    setPlaybackDiagnostic(null);
    setIsRetryingPlayback(false);
    setPlaybackSourceStage(initialPlaybackSourceStage({ isLive, proxySrc, src }));
    setPlaybackAttempt((attempt) => attempt + 1);
  };

  const programTimeAt = useCallback((position: number): number | null => {
    return liveProgramTimeAtPosition(position, liveFragmentsRef.current);
  }, []);

  useEffect(() => {
    setPlaybackSourceStage(initialPlaybackSourceStage({ isLive, proxySrc, src }));
    currentSourceRetryRef.current = false;
    resumePositionRef.current = null;
    lastKnownPositionRef.current = 0;
    setPlaybackUiState("loading");
    setPlaybackDiagnostic(null);
    setIsPlaying(false);
  }, [isLive, proxySrc, setPlaybackSourceStage, src]);

  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = playbackRate;
  }, [playbackRate]);

  useEffect(() => () => {
    if (frameRepeatDelayRef.current != null) window.clearTimeout(frameRepeatDelayRef.current);
    if (frameRepeatIntervalRef.current != null) window.clearInterval(frameRepeatIntervalRef.current);
  }, []);

  const mediaPositionAtUtc = useCallback((targetUtcMs: number): number | null => {
    let nearest: { position: number; distance: number } | null = null;
    for (const fragment of liveFragmentsRef.current) {
      if (!Number.isFinite(fragment.programDateTime) || fragment.duration <= 0) continue;
      const startUtcMs = fragment.programDateTime as number;
      const endUtcMs = startUtcMs + fragment.duration * 1000;
      const clampedUtcMs = Math.max(startUtcMs, Math.min(endUtcMs, targetUtcMs));
      const position = fragment.start + (clampedUtcMs - startUtcMs) / 1000;
      const distance = Math.abs(targetUtcMs - clampedUtcMs);
      if (!nearest || distance < nearest.distance) nearest = { position, distance };
      if (distance === 0) return position;
    }
    return nearest?.position ?? null;
  }, []);

  useEffect(() => {
    if (seekToSeconds == null) {
      lastExternalSeekRef.current = null;
      return;
    }
    if (lastExternalSeekRef.current === seekToSeconds || !videoRef.current) return;
    lastExternalSeekRef.current = seekToSeconds;
    const position = Math.max(0, Math.min(videoRef.current.duration || Infinity, seekToSeconds));
    videoRef.current.currentTime = position;
    lastKnownPositionRef.current = position;
  }, [seekToSeconds]);

  const onPositionChangeRef = useRef(onPositionChange);
  onPositionChangeRef.current = onPositionChange;
  const lastSeekRequestIdRef = useRef<number | null>(null);
  useEffect(() => {
    const element = videoRef.current;
    if (!seekRequest || !element || lastSeekRequestIdRef.current === seekRequest.id) return;
    lastSeekRequestIdRef.current = seekRequest.id;
    const position = Math.max(0, Math.min(element.duration || Infinity, seekRequest.seconds));
    element.currentTime = position;
    lastKnownPositionRef.current = position;
    setCurrentTime(position);
    if (seekRequest.play && element.paused) void element.play().catch(() => undefined);
  }, [seekRequest]);

  const coachVisibleRef = useRef(false);
  const resetControlsTimer = useCallback(() => {
    setShowControls(true);
    if (controlsTimerRef.current) clearTimeout(controlsTimerRef.current);
    controlsTimerRef.current = setTimeout(() => {
      if (!coachVisibleRef.current) setShowControls(false);
    }, 4000);
  }, []);
  useEffect(() => {
    coachVisibleRef.current = coachVisible;
    if (coachVisible) setShowControls(true);
    else resetControlsTimer();
  }, [coachVisible, resetControlsTimer]);

  const commitSeekPosition = useCallback((value: number) => {
    const element = videoRef.current;
    if (!element) return;
    const position = clampPlaybackPosition(value, element.duration);
    seekInProgressRef.current = true;
    element.currentTime = position;
    lastKnownPositionRef.current = position;
    setCurrentTime(position);
    resetControlsTimer();
  }, [resetControlsTimer]);

  const handleSeekSliderChange = useCallback((value: number) => {
    const update = changeSeekValue(seekDragStateRef.current, value);
    setCurrentTime(update.previewValue);
    if (update.seekValue != null) commitSeekPosition(update.seekValue);
  }, [commitSeekPosition]);

  const finishSeekSliderDrag = useCallback((value: number) => {
    changeSeekValue(seekDragStateRef.current, value);
    const position = endSeekDrag(seekDragStateRef.current);
    if (position != null) commitSeekPosition(position);
  }, [commitSeekPosition]);

  const seekToUtc = useCallback((targetUtcMs: number) => {
    const element = videoRef.current;
    if (!element || !liveRange) return;
    const bounded = Math.max(liveRange.startUtcMs, Math.min(liveRange.endUtcMs, targetUtcMs));
    const position = mediaPositionAtUtc(bounded);
    if (position == null) return;
    element.currentTime = position;
    lastKnownPositionRef.current = position;
    liveUtcRef.current = bounded;
    setLiveUtcMs(bounded);
    liveDvr?.onCurrentTimeUtcChange?.(bounded);
    resetControlsTimer();
  }, [liveDvr, liveRange, mediaPositionAtUtc, resetControlsTimer]);

  useEffect(() => {
    if (seekToUtcMs == null) {
      lastExternalUtcSeekRef.current = null;
      return;
    }
    if (!liveDvr || !liveRange || lastExternalUtcSeekRef.current === seekToUtcMs) return;
    seekToUtc(seekToUtcMs);
    lastExternalUtcSeekRef.current = seekToUtcMs;
  }, [liveDvr, liveRange, seekToUtc, seekToUtcMs]);

  const computeCropRect = useCallback(() => readFrame(), [readFrame]);

  const buildDraft = useCallback((startTime: number, endTime: number, rawPath: CropKeyframe[], draftTitle: string): ClipDraft => {
    const clipDuration = Math.max(0.1, endTime - startTime);
    let cropPath = normalizeClipKeyframes(rawPath, clipDuration);
    if (cropPath.length === 0) {
      const current = computeCropRect();
      cropPath = [{ t: 0, ...current }, { t: 1, ...current }];
    } else if (cropPath.length === 1) {
      cropPath = [{ ...cropPath[0], t: 0 }, { ...cropPath[0], t: 1 }];
    }
    return {
      startTime,
      endTime,
      cropPath,
      aspectRatio: selectedRatioRef.current,
      title: draftTitle.trim() || (isLive ? `${liveCameraId ?? title} clip` : title),
    };
  }, [computeCropRect, isLive, liveCameraId, title]);

  const requireAuth = useCallback((draft: ClipDraft) => {
    onRequireAuth(draft);
  }, [onRequireAuth]);

  useEffect(() => { clipModeRef.current = clipMode; }, [clipMode]);

  useEffect(() => {
    const update = () => setIsFullscreen(!!(document.fullscreenElement || (document as Document & { webkitFullscreenElement?: Element }).webkitFullscreenElement));
    document.addEventListener("fullscreenchange", update);
    document.addEventListener("webkitfullscreenchange", update);
    return () => {
      document.removeEventListener("fullscreenchange", update);
      document.removeEventListener("webkitfullscreenchange", update);
    };
  }, []);

  useEffect(() => {
    resetControlsTimer();
    return () => {
      if (recordingRef.current.interval) clearInterval(recordingRef.current.interval);
      if (elapsedRef.current) clearInterval(elapsedRef.current);
      if (controlsTimerRef.current) clearTimeout(controlsTimerRef.current);
    };
  }, [resetControlsTimer]);

  const toggleFullscreen = useCallback(() => {
    const element = containerRef.current as (HTMLElement & { webkitRequestFullscreen?: () => Promise<void> }) | null;
    const documentWithWebkit = document as Document & { webkitFullscreenElement?: Element; webkitExitFullscreen?: () => void };
    if (!element) return;
    if (!document.fullscreenElement && !documentWithWebkit.webkitFullscreenElement) {
      (element.requestFullscreen ?? element.webkitRequestFullscreen)?.call(element)?.catch?.(() => {});
    } else {
      (document.exitFullscreen ?? documentWithWebkit.webkitExitFullscreen)?.call(document)?.catch?.(() => {});
    }
  }, []);

  const handleSkip = useCallback((delta: number) => {
    if ((isLive && !isLiveDvr) || !videoRef.current) return;
    commitSeekPosition(videoRef.current.currentTime + delta);
  }, [commitSeekPosition, isLive, isLiveDvr]);

  const { flash: skipFlash, onTouchEnd: skipOnTouchEnd } = useSkipTap({
    onSkip: handleSkip,
    onSingleTap: resetControlsTimer,
    disabled: clipMode !== "idle" || (isLive && !isLiveDvr),
  });

  useEffect(() => {
    const element = videoRef.current;
    if (!element) return;

    const hlsSupported = Hls.isSupported();
    const nativeHlsSupported = Boolean(element.canPlayType("application/vnd.apple.mpegurl"));
    // A prop update can run this effect once with the previous stage captured
    // in its closure. Wait for the source-stage state to catch up before
    // attaching a player; otherwise a stale fallback URL can be loaded.
    if (sourceStageRef.current !== sourceStage) return;

    liveFragmentsRef.current = [];
    setLiveRange(null);
    if (fallbackRestoreUtcRef.current == null) {
      liveUtcRef.current = null;
      setLiveUtcMs(null);
    } else {
      liveUtcRef.current = fallbackRestoreUtcRef.current;
      setLiveUtcMs(fallbackRestoreUtcRef.current);
    }
    element.muted = isLive;
    let previousTime = -1;
    let startupTimer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;
    let recoveryInProgress = false;
    let seekInProgress = false;
    let lastProgressPosition = Number.isFinite(element.currentTime) ? element.currentTime : 0;
    let mediaRecoveryAttempted = false;
    let mediaRecoveryPending = false;
    let watchdog: ReturnType<typeof createPlaybackWatchdog> | null = null;
    const clearStartupTimer = () => {
      if (startupTimer !== null) {
        clearTimeout(startupTimer);
        startupTimer = null;
      }
    };
    const showPlaybackError = () => {
      clearStartupTimer();
      watchdog?.dispose();
      setShowControls(true);
      setPlaybackUiState("error");
    };
    const startStartupTimer = () => {
      clearStartupTimer();
      startupTimer = setTimeout(() => {
        startupTimer = null;
        void handlePlaybackFailure();
      }, PLAYBACK_STALL_TIMEOUT_MS);
    };
    const preservePosition = () => {
      if (isLiveDvr) {
        fallbackRestoreUtcRef.current = liveUtcRef.current;
      } else if (!isLive) {
        resumePositionRef.current = playbackPositionForRestore(
          element.currentTime,
          lastKnownPositionRef.current,
        );
      }
    };
    const handlePlaybackFailure = async () => {
      if (recoveryInProgress || disposed) return;
      recoveryInProgress = true;
      clearStartupTimer();
      setPlaybackUiState("loading");
      try {
        const decision = await decidePlaybackRecovery({
          currentStage: sourceStageRef.current,
          hasProxy: Boolean(proxySrc && proxySrc !== src),
          fallbackSrc,
          currentRetryAttempted: currentSourceRetryRef.current,
        });
        if (disposed) return;

        if (decision.type === "switch-source") {
          preservePosition();
          setPlaybackSourceStage(decision.stage);
          if (decision.stage === "fallback") onFallback?.();
          return;
        }

        if (decision.type === "retry-current") {
          currentSourceRetryRef.current = true;
          setIsRetryingPlayback(true);
          preservePosition();
          const hls = hlsRef.current;
          if (hls) {
            const position = resumePositionRef.current ?? element.currentTime;
            hls.startLoad(position);
          } else {
            element.src = activeSrc;
            element.load();
          }
          startStartupTimer();
          watchdog?.waiting();
          return;
        }

        showPlaybackError();
      } finally {
        recoveryInProgress = false;
      }
    };
    watchdog = createPlaybackWatchdog({
      getSnapshot: () => ({
        paused: element.paused,
        currentTime: element.currentTime,
        seeking: seekInProgress || seekInProgressRef.current || element.seeking,
      }),
      onStalled: () => { void handlePlaybackFailure(); },
      onProgress: () => {
        setPlaybackUiState("ready");
        setIsRetryingPlayback(false);
        setPlaybackDiagnostic(null);
      },
    });
    const markPlaybackReady = () => {
      clearStartupTimer();
      mediaRecoveryPending = false;
      watchdog?.progress();
      setPlaybackUiState("ready");
    };
    const applyPendingResumePosition = () => {
      if (isLive || resumePositionRef.current == null) return;
      if (!Number.isFinite(element.duration) || element.duration <= 0) return;
      const position = clampPlaybackPosition(resumePositionRef.current, element.duration);
      element.currentTime = position;
      lastKnownPositionRef.current = position;
      lastProgressPosition = position;
      resumePositionRef.current = null;
    };
    const onPlay = () => {
      setIsPlaying(true);
      watchdog?.resume();
    };
    const onPause = () => {
      setIsPlaying(false);
      watchdog?.pause();
      if (!seekInProgress && element.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        setPlaybackUiState("ready");
      }
    };
    const onLoadedData = () => {
      applyPendingResumePosition();
      markPlaybackReady();
    };
    const onCanPlay = () => {
      applyPendingResumePosition();
      markPlaybackReady();
    };
    const onPlaying = () => {
      setIsPlaying(true);
      applyPendingResumePosition();
      markPlaybackReady();
    };
    const onWaiting = () => {
      setPlaybackUiState("loading");
      watchdog?.waiting();
    };
    const onSeeking = () => {
      seekInProgress = true;
      seekInProgressRef.current = true;
      lastProgressPosition = element.currentTime;
      setPlaybackUiState("loading");
      watchdog?.seeking();
    };
    const onSeeked = () => {
      seekInProgress = false;
      seekInProgressRef.current = false;
      lastProgressPosition = element.currentTime;
      lastKnownPositionRef.current = element.currentTime;
      markPlaybackReady();
    };
    const onMediaError = () => {
      if (mediaRecoveryPending) return;
      void handlePlaybackFailure();
    };
    const onDurationChange = () => {
      if (!isLive) setDuration(element.duration || 0);
      applyPendingResumePosition();
    };
    const onTimeUpdate = () => {
      if (isLiveDvr && fallbackRestoreUtcRef.current != null) return;
      const now = element.currentTime;
      if (!seekInProgress && now > lastProgressPosition + 0.02) {
        lastProgressPosition = now;
        lastKnownPositionRef.current = now;
        clearStartupTimer();
        watchdog?.progress();
      } else if (now < lastProgressPosition - 0.1) {
        lastProgressPosition = now;
      }
      if (seekDragStateRef.current.dragging) return;
      setCurrentTime(now);
      lastKnownPositionRef.current = now;
      if (isLiveDvr) {
        const wallTime = programTimeAt(now);
        liveUtcRef.current = wallTime;
        setLiveUtcMs(wallTime);
        liveDvr?.onCurrentTimeUtcChange?.(wallTime);
      }
      if (clipModeRef.current === "recording") {
        const jumpedBack = !isLive && previousTime >= 0 && now < previousTime - 0.3;
        const loopedPastStart = !isLive && now < clipStartRef.current - 0.5;
        if (jumpedBack || loopedPastStart) {
          stopRecordingRef.current(jumpedBack ? previousTime : undefined);
          previousTime = -1;
        } else {
          previousTime = now;
        }
      } else {
        previousTime = -1;
      }
    };
    const onEnded = () => {
      if (clipModeRef.current === "recording") stopRecordingRef.current(element.duration);
    };
    const updateLiveRange = (_event: string, data: unknown) => {
      const details = (data as { details?: { fragments?: TimelineFragment[] } }).details;
      const fragments = details?.fragments ?? [];
      liveFragmentsRef.current = fragments;
      if (fallbackRestoreUtcRef.current != null) {
        const restoredPosition = mediaPositionAtUtc(fallbackRestoreUtcRef.current);
        if (restoredPosition != null) {
          element.currentTime = restoredPosition;
          fallbackRestoreUtcRef.current = null;
        }
      }
      const dated = fragments.filter((fragment) =>
        Number.isFinite(fragment.programDateTime) && fragment.duration > 0,
      );
      if (dated.length === 0 || !liveDvr) return;
      const availableStart = Math.min(...dated.map((fragment) => fragment.programDateTime as number));
      const availableEnd = Math.max(...dated.map((fragment) =>
        (fragment.programDateTime as number) + fragment.duration * 1000,
      ));
      const startUtcMs = Math.max(availableStart, liveDvr.windowStartUtcMs);
      const endUtcMs = Math.min(availableEnd, liveDvr.windowEndUtcMs);
      if (endUtcMs <= startUtcMs) return;
      setLiveRange((current) =>
        current?.startUtcMs === startUtcMs && current.endUtcMs === endUtcMs
          ? current
          : { startUtcMs, endUtcMs },
      );
    };

    element.addEventListener("play", onPlay);
    element.addEventListener("pause", onPause);
    element.addEventListener("loadeddata", onLoadedData);
    element.addEventListener("canplay", onCanPlay);
    element.addEventListener("playing", onPlaying);
    element.addEventListener("waiting", onWaiting);
    element.addEventListener("stalled", onWaiting);
    element.addEventListener("seeking", onSeeking);
    element.addEventListener("seeked", onSeeked);
    element.addEventListener("durationchange", onDurationChange);
    element.addEventListener("timeupdate", onTimeUpdate);
    element.addEventListener("ended", onEnded);
    element.addEventListener("error", onMediaError);
    startStartupTimer();
    setQualityLevels([]);
    setActiveQuality(-1);
    setShowQualityPicker(false);

    const isHlsSource = /\.m3u8(?:$|\?)/i.test(activeSrc);
    if (isHlsSource && hlsSupported) {
      const hls = new Hls(isLive
        ? {
          enableWorker: true,
          liveSyncDurationCount: 10,
          maxLiveSyncPlaybackRate: 1.05,
          liveMaxLatencyDurationCount: 20,
          maxBufferLength: 40,
          maxMaxBufferLength: 60,
          backBufferLength: 90,
        }
        : { enableWorker: true });
      hlsRef.current = hls;
      capPlaybackQuality(hls);
      hls.loadSource(activeSrc);
      hls.attachMedia(element);
      if (isLiveDvr) {
        hls.on(Hls.Events.LEVEL_UPDATED, updateLiveRange);
        hls.on(Hls.Events.LEVEL_LOADED, updateLiveRange);
      }
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        const resumePosition = resumePositionRef.current;
        if (resumePosition != null && !isLive) hls.startLoad(resumePosition);
        element.play().catch(() => {});
        void getAllowedHlsLevelIndexes(hls.levels, { maxWidth: PLAYBACK_MAX_WIDTH }).then((allowed) => {
          if (disposed || hlsRef.current !== hls) return;
          setQualityLevels(allowed
            .map((index) => {
              const level = hls.levels[index];
              return { width: level.width, height: level.height, bitrate: level.bitrate, index };
            })
            .sort((a, b) => b.width - a.width || b.height - a.height || b.bitrate - a.bitrate));
        });
      });
      hls.on(Hls.Events.ERROR, (_, data) => {
        if (!data.fatal) return;
        const diagnostic = summarizeFatalHlsError(data);
        setPlaybackDiagnostic(diagnostic);
        setPlaybackUiState("loading");
        setIsRetryingPlayback(true);
        console.error("[ClipPlayer] Fatal HLS playback error", {
          type: data.type,
          details: data.details,
          reason: data.reason,
          responseCode: data.response?.code,
          responseText: typeof data.response?.text === "string"
            ? data.response.text.slice(0, 300)
            : undefined,
          fragment: data.frag
            ? { type: data.frag.type, sn: data.frag.sn, level: data.frag.level }
            : undefined,
        });
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          const fragmentLevel = data.frag?.level;
          const failedLevel = typeof fragmentLevel === "number" && Number.isFinite(fragmentLevel)
            ? fragmentLevel
            : hls.currentLevel;
          capBelowFailedLevel(hls, Math.max(0, failedLevel));
          if (!mediaRecoveryAttempted) {
            clearStartupTimer();
            mediaRecoveryAttempted = true;
            mediaRecoveryPending = true;
            hls.recoverMediaError();
            startStartupTimer();
            return;
          }
          mediaRecoveryPending = false;
        }
        void handlePlaybackFailure();
      });
    } else if (isHlsSource && nativeHlsSupported) {
      element.src = activeSrc;
      element.addEventListener("canplay", () => element.play().catch(() => {}), { once: true });
      element.load();
    } else if (isHlsSource) {
      void handlePlaybackFailure();
    } else {
      element.src = activeSrc;
      element.load();
    }

    return () => {
      disposed = true;
      if (isLiveDvr && liveUtcRef.current != null) {
        fallbackRestoreUtcRef.current = liveUtcRef.current;
      } else if (!isLive && element.currentTime > 0) {
        lastKnownPositionRef.current = playbackPositionForRestore(
          element.currentTime,
          lastKnownPositionRef.current,
        );
      }
      hlsRef.current?.destroy();
      hlsRef.current = null;
      clearStartupTimer();
      watchdog?.dispose();
      element.removeEventListener("play", onPlay);
      element.removeEventListener("pause", onPause);
      element.removeEventListener("loadeddata", onLoadedData);
      element.removeEventListener("canplay", onCanPlay);
      element.removeEventListener("playing", onPlaying);
      element.removeEventListener("waiting", onWaiting);
      element.removeEventListener("stalled", onWaiting);
      element.removeEventListener("seeking", onSeeking);
      element.removeEventListener("seeked", onSeeked);
      element.removeEventListener("durationchange", onDurationChange);
      element.removeEventListener("timeupdate", onTimeUpdate);
      element.removeEventListener("ended", onEnded);
      element.removeEventListener("error", onMediaError);
      liveFragmentsRef.current = [];
    };
  }, [
    activeSrc,
    fallbackSrc,
    isLive,
    isLiveDvr,
    liveDvr,
    mediaPositionAtUtc,
    onFallback,
    playbackAttempt,
    programTimeAt,
    proxySrc,
    setPlaybackSourceStage,
    sourceStage,
    src,
  ]);

  const onLoadedMetadata = (event: React.SyntheticEvent<HTMLVideoElement>) => {
    if (isLive) return;
    const element = event.currentTarget;
    setDuration(element.duration || 0);
    if (!element.videoWidth || !element.videoHeight) return;
    const aspect = element.videoWidth / element.videoHeight;
    setSourceAspect(aspect);
  };

  const togglePlay = () => {
    if (!videoRef.current) return;
    videoRef.current.paused ? videoRef.current.play().catch(() => {}) : videoRef.current.pause();
  };

  const seek = (delta: number) => {
    if ((isLive && !isLiveDvr) || !videoRef.current) return;
    commitSeekPosition(videoRef.current.currentTime + delta);
  };

  const stepVideoBy = (delta: number) => {
    if ((isLive && !isLiveDvr) || !videoRef.current) return;
    const element = videoRef.current;
    element.pause();
    setIsPlaying(false);
    const target = Math.max(
      0,
      Math.min(element.duration || Infinity, element.currentTime + delta),
    );
    // Setting currentTime seeks even when the target is outside the buffered range.
    // The video stays paused while HLS/the browser fetches the target segment.
    element.currentTime = target;
    seekInProgressRef.current = true;
    lastKnownPositionRef.current = target;
    resetControlsTimer();
  };

  const stopFrameRepeat = () => {
    if (frameRepeatDelayRef.current != null) {
      window.clearTimeout(frameRepeatDelayRef.current);
      frameRepeatDelayRef.current = null;
    }
    if (frameRepeatIntervalRef.current != null) {
      window.clearInterval(frameRepeatIntervalRef.current);
      frameRepeatIntervalRef.current = null;
    }
  };

  const startFrameRepeat = (event: React.PointerEvent<HTMLButtonElement>, delta: number) => {
    if (event.button !== 0) return;
    stopFrameRepeat();
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture may be unavailable in older embedded browsers.
    }
    stepVideoBy(delta);
    frameRepeatDelayRef.current = window.setTimeout(() => {
      frameRepeatDelayRef.current = null;
      frameRepeatIntervalRef.current = window.setInterval(() => stepVideoBy(delta), 100);
    }, 350);
  };

  const handlePlayerKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (clipMode !== "idle" || target.closest("input, select, textarea, [contenteditable='true']")) return;
    const shortcutSpeed = playbackSpeedForKey(event.key);
    const shortcutStep = playbackStepForKey(event.key, event.shiftKey);
    if (target.closest("button") && shortcutSpeed == null && shortcutStep == null) return;
    if (shortcutSpeed != null) {
      event.preventDefault();
      setPlaybackRate(shortcutSpeed);
      resetControlsTimer();
      return;
    }
    if (shortcutStep != null) {
      event.preventDefault();
      stepVideoBy(shortcutStep);
      return;
    }
    switch (event.key) {
      case " ":
      case "k":
      case "K":
        event.preventDefault();
        togglePlay();
        break;
    }
  };

  const startRecording = () => {
    if (showRecordCoach) dismissRecordCoach();
    if (!canSave && !isLiveDvr) {
      const now = videoRef.current?.currentTime ?? 0;
      requireAuth(buildDraft(now, now + 0.1, [{ t: 0, ...computeCropRect() }], clipTitle || title));
      return;
    }
    if (clipModeRef.current === "recording" || !videoRef.current) return;
    const element = videoRef.current;
    const liveStartUtcMs = isLiveDvr ? programTimeAt(element.currentTime) : null;
    if (isLiveDvr && liveStartUtcMs == null) {
      toast({ title: t.clipping.error, description: "Wait for live DVR time data before recording a clip.", variant: "destructive" });
      return;
    }
    element.playbackRate = 1;
    setPlaybackRate(1);
    element.play().catch(() => {});
    clipStartRef.current = element.currentTime;
    liveClipStartUtcRef.current = liveStartUtcMs;
    if (liveStartUtcMs != null) {
      liveUtcRef.current = liveStartUtcMs;
      setLiveUtcMs(liveStartUtcMs);
      liveDvr?.onCurrentTimeUtcChange?.(liveStartUtcMs);
    }
    liveClipEndUtcRef.current = null;
    clipModeRef.current = "recording";
    recordingRef.current.keyframes = [];
    liveRecordElapsedRef.current = 0;
    setRecElapsed(0);
    const sampleFrame = () => {
      const current = videoRef.current;
      if (!current) return;
      const mappedUtc = isLiveDvr ? programTimeAt(current.currentTime) : null;
      if (mappedUtc != null) liveUtcRef.current = mappedUtc;
      const elapsedFromTimeline = isLiveDvr
        ? liveElapsedSeconds(liveClipStartUtcRef.current, mappedUtc, liveRecordElapsedRef.current)
        : current.currentTime - clipStartRef.current;
      if (elapsedFromTimeline == null || elapsedFromTimeline < 0) return;
      const relativeTime = elapsedFromTimeline;
      if (isLiveDvr) liveRecordElapsedRef.current = relativeTime;
      if (isLiveDvr && relativeTime > maxLiveClipSeconds) {
        stopRecordingRef.current(current.currentTime);
        return;
      }
      setRecElapsed((previous) => Math.max(previous, relativeTime));
      recordingRef.current.keyframes.push({ t: relativeTime, ...computeCropRect() });
    };
    sampleFrame();
    recordingRef.current.interval = setInterval(sampleFrame, 150);
    elapsedRef.current = setInterval(() => {
      const current = videoRef.current;
      if (!current) return;
      const mappedUtc = isLiveDvr ? programTimeAt(current.currentTime) : null;
      if (mappedUtc != null) {
        liveUtcRef.current = mappedUtc;
        setLiveUtcMs(mappedUtc);
        liveDvr?.onCurrentTimeUtcChange?.(mappedUtc);
      }
      const elapsedFromTimeline = isLiveDvr
        ? liveElapsedSeconds(liveClipStartUtcRef.current, mappedUtc, liveRecordElapsedRef.current)
        : current.currentTime - clipStartRef.current;
      if (elapsedFromTimeline == null || elapsedFromTimeline < 0) return;
      const elapsed = elapsedFromTimeline;
      if (isLiveDvr) liveRecordElapsedRef.current = elapsed;
      setRecElapsed((previous) => Math.max(previous, elapsed));
    }, 100);
    setClipMode("recording");
  };

  const stopRecording = (overrideEndTime?: number) => {
    const element = videoRef.current;
    const endTime = overrideEndTime ?? element?.currentTime ?? clipStartRef.current;
    const mappedEndUtc = isLiveDvr && element ? programTimeAt(element.currentTime) : null;
    const liveWindow = isLiveDvr
      ? createLiveClipWindow(
        liveClipStartUtcRef.current,
        mappedEndUtc,
        maxLiveClipSeconds,
      )
      : null;
    if (isLiveDvr && !liveWindow) {
      if (recordingRef.current.interval) clearInterval(recordingRef.current.interval);
      if (elapsedRef.current) clearInterval(elapsedRef.current);
      recordingRef.current.interval = null;
      elapsedRef.current = null;
      const candidateDuration = liveClipStartUtcRef.current != null && mappedEndUtc != null
        ? (mappedEndUtc - liveClipStartUtcRef.current) / 1000
        : null;
      const description = candidateDuration == null
        ? "Live clip time is unavailable. Please try recording again."
        : candidateDuration < 1
          ? "Clip must be at least 1 second long."
          : "Clip cannot be longer than 10 minutes.";
      clipModeRef.current = "idle";
      recordingRef.current.keyframes = [];
      setClipMode("idle");
      setRecElapsed(0);
      setClipDurationSeconds(0);
      liveClipStartUtcRef.current = null;
      liveClipEndUtcRef.current = null;
      toast({
        title: t.clipping.error,
        description,
        variant: "destructive",
      });
      return;
    }
    clipModeRef.current = "review";
    if (recordingRef.current.interval) clearInterval(recordingRef.current.interval);
    if (elapsedRef.current) clearInterval(elapsedRef.current);
    recordingRef.current.interval = null;
    elapsedRef.current = null;
    const liveEndUtc = liveWindow?.endUtcMs ?? null;
    liveClipEndUtcRef.current = liveEndUtc;
    const relativeEnd = liveWindow?.durationSeconds ?? Math.max(0, endTime - clipStartRef.current);
    if (liveEndUtc != null) {
      liveUtcRef.current = liveEndUtc;
      setLiveUtcMs(liveEndUtc);
      liveDvr?.onCurrentTimeUtcChange?.(liveEndUtc);
    }
    if (videoRef.current) recordingRef.current.keyframes.push({ t: relativeEnd, ...computeCropRect() });
    videoRef.current?.pause();
    setClipEndTime(isLiveDvr && liveEndUtc != null ? liveEndUtc / 1000 : endTime);
    setClipDurationSeconds(relativeEnd);
    setClipTitle(isLive ? `${liveCameraId ?? title} clip` : title);
    setClipMode("review");
  };
  stopRecordingRef.current = stopRecording;

  const discardClip = () => {
    clipModeRef.current = "idle";
    recordingRef.current.keyframes = [];
    setClipMode("idle");
    setClipTitle("");
    setRecElapsed(0);
    setClipDurationSeconds(0);
    liveClipStartUtcRef.current = null;
    liveClipEndUtcRef.current = null;
    applyFrameChange(1, "16:9");
  };

  const saveClip = async () => {
    const endTime = isLiveDvr && liveClipEndUtcRef.current != null
      ? liveClipEndUtcRef.current / 1000
      : clipEndTime;
    const startTime = isLiveDvr && liveClipStartUtcRef.current != null
      ? liveClipStartUtcRef.current / 1000
      : clipStartRef.current;
    const totalDuration = videoRef.current?.duration || duration || 0;
    if (!isLive && totalDuration <= 0) {
      toast({ title: t.clipping.error, description: "Wait for the video to load before saving.", variant: "destructive" });
      return;
    }
    const draft = buildDraft(startTime, endTime, recordingRef.current.keyframes, clipTitle || title);
    const apiDraft = isLive && !isLiveDvr
      ? { ...draft, startTime: 0, endTime: 1 }
      : isLiveDvr
        ? draft
        : {
        ...draft,
        startTime: Math.max(0, Math.min(1, startTime / totalDuration)),
        endTime: Math.max(0, Math.min(1, endTime / totalDuration)),
      };
    if (apiDraft.endTime <= apiDraft.startTime) {
      toast({ title: t.clipping.error, description: "Clip range is invalid. Please try recording again.", variant: "destructive" });
      return;
    }
    if (!canSave) {
      requireAuth(apiDraft);
      return;
    }
    setIsSavingClip(true);
    try {
      await onSave(apiDraft);
      toast({
        title: t.clipping.saved,
        description: isLiveDvr
          ? "Live clip queued for processing."
          : isLive ? "Live clip saved. It will be available to play once the recording is uploaded." : t.clipping.savedDesc,
        className: "bg-primary text-white border-none",
        duration: 2500,
      });
      setClipMode("idle");
      setClipTitle("");
      recordingRef.current.keyframes = [];
      setClipDurationSeconds(0);
      liveClipStartUtcRef.current = null;
      liveClipEndUtcRef.current = null;
      applyFrameChange(1, "16:9");
    } catch (error) {
      toast({ title: t.clipping.error, description: error instanceof Error ? error.message : t.clipping.error, variant: "destructive" });
    } finally {
      setIsSavingClip(false);
    }
  };

  const shellClass = layout === "overlay"
    ? "fixed inset-0 z-50 bg-black"
    : "relative w-full min-h-[min(72vh,42rem)] overflow-hidden rounded-2xl bg-black";
  const stageClass = layout === "overlay"
    ? "absolute inset-0 flex items-center justify-center bg-black"
    : "relative flex min-h-[min(72vh,42rem)] items-center justify-center bg-black";
  const videoFilter = look === "warm"
    ? "sepia(0.18) saturate(1.16) contrast(1.04)"
    : look === "cinematic"
      ? "saturate(0.82) contrast(1.12)"
      : look === "noir"
        ? "grayscale(1) contrast(1.08)"
        : "none";

  return (
    <motion.div
      ref={containerRef}
      tabIndex={0}
      onPointerDown={(event) => {
        const target = event.target as HTMLElement;
        if (!target.closest("button, input, select, textarea, [contenteditable='true']")) {
          event.currentTarget.focus({ preventScroll: true });
        }
      }}
      onKeyDown={handlePlayerKeyDown}
      aria-label={`${title} video player`}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className={cn(shellClass, "outline-none focus-visible:ring-2 focus-visible:ring-primary")}
      data-clip-source={sourceKey}
      data-clip-academy={academyId}
    >
      {layout === "overlay" && <FullscreenBridge />}
      {isLive && (
        <div className="absolute top-safe top-3 start-3 z-30 flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-live/90 backdrop-blur-sm pointer-events-none">
          <span className="w-1.5 h-1.5 rounded-full bg-white animate-pulse" />
          <span className="text-white text-[10px] font-bold uppercase tracking-wider">Live</span>
        </div>
      )}
      <div className={stageClass}>
        <div
          ref={frameBoxRef}
          className={cn("relative overflow-hidden bg-black touch-none", clipMode === "recording" ? "ring-2 ring-live" : "ring-1 ring-white/25")}
          style={selectedRatio === "9:16"
            ? { height: layout === "overlay" ? "min(100%, calc(100vw * 16 / 9))" : "min(70vh, calc(100% * 16 / 9))", aspectRatio: "9/16" }
            : { width: layout === "overlay" ? "min(100%, calc(100dvh * 16 / 9))" : "min(100%, calc(70vh * 16 / 9))", aspectRatio: "16/9" }}
          onPointerDown={handleFramePointerDown}
          onPointerMove={onFramePointerMove}
          onPointerUp={handleFramePointerUp}
          onPointerCancel={handleFramePointerUp}
          onTouchEnd={(event) => {
            if (draggedRef.current) return;
            skipOnTouchEnd(event);
          }}
          onClick={() => {
            if (draggedRef.current) {
              draggedRef.current = false;
              return;
            }
            resetControlsTimer();
          }}
        >
          <video
            ref={videoRef}
            crossOrigin="anonymous"
            className="pointer-events-none select-none"
                style={{ ...frameToVideoStyle(displayedFrame), filter: videoFilter }}
            playsInline
            onLoadedMetadata={onLoadedMetadata}
            onTimeUpdate={(event) => onPositionChangeRef.current?.(event.currentTarget.currentTime)}
          />
          {stageBadge && (
            <div className="pointer-events-none absolute start-3 top-3 z-20 max-w-[70%]">{stageBadge}</div>
          )}
          {followAvailable && !isFollowingBall && (
            <button
              type="button"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                manualTookControl.current = false;
                setFollowPreference(true);
              }}
              className="absolute bottom-16 left-1/2 z-30 flex -translate-x-1/2 items-center gap-2 rounded-full border border-white/25 bg-black/75 px-3 py-2 text-xs font-semibold text-white shadow-lg backdrop-blur"
            >
              <CircleDot size={15} aria-hidden="true" />
              {t.player.followBall}
            </button>
          )}
          <AnimatePresence>
            {playbackUiState === "loading" && (
              <motion.div
                key="playback-loading"
                role="status"
                aria-live="polite"
                data-testid="status-video-loading"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => event.stopPropagation()}
                className="absolute inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-black px-6 text-center text-white"
              >
                {onClose && (
                  <button
                    type="button"
                    aria-label="Close video"
                    onClick={(event) => {
                      event.stopPropagation();
                      onClose();
                    }}
                    className="absolute start-4 top-4 flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20"
                  >
                    <X className="h-5 w-5" />
                  </button>
                )}
                <LoaderCircle className="h-9 w-9 animate-spin text-primary" aria-hidden="true" />
                <p className="text-sm font-semibold">
                  {isRetryingPlayback
                    ? t.player.playbackRetrying
                    : usingFallback
                      ? t.player.fallbackLoading
                      : sourceStage === "proxy"
                        ? t.player.playbackProxyLoading
                        : t.player.playbackLoading}
                </p>
                {playbackDiagnostic && (
                  <p className="max-w-sm text-xs leading-5 text-white/65">
                    {playbackDiagnostic}
                  </p>
                )}
              </motion.div>
            )}
            {playbackUiState === "error" && (
              <motion.div
                key="playback-error"
                role="alert"
                data-testid="status-video-error"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => event.stopPropagation()}
                className="absolute inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-black/90 px-6 text-center text-white"
              >
                <AlertTriangle className="h-9 w-9 text-amber-300" aria-hidden="true" />
                <p className="max-w-sm text-sm leading-6">{t.player.playbackError}</p>
                {playbackDiagnostic && (
                  <p className="max-w-sm text-xs leading-5 text-white/65">
                    {playbackDiagnostic}
                  </p>
                )}
                <button
                  type="button"
                  data-testid="button-retry-video"
                  onClick={retryPlayback}
                  className="min-h-11 rounded-full bg-primary px-5 text-sm font-bold text-primary-foreground"
                >
                  {t.player.retryPlayback}
                </button>
              </motion.div>
            )}
          </AnimatePresence>
          <SkipFlash flash={skipFlash} />
        </div>
      </div>

      <QualityPicker
        levels={qualityLevels}
        active={activeQuality}
        open={showQualityPicker}
        onToggle={() => setShowQualityPicker((open) => !open)}
        onSelect={(index) => {
          if (hlsRef.current) hlsRef.current.currentLevel = index;
          setActiveQuality(index);
          setShowQualityPicker(false);
        }}
      />
      {followAvailable && (
        <button
          type="button"
          aria-label={t.player.followBall}
          aria-pressed={isFollowingBall}
          title={t.player.followBall}
          onClick={() => {
            manualTookControl.current = false;
            setFollowPreference(!isFollowingBall);
          }}
          className="absolute end-[5.5rem] z-[60] flex items-center gap-1.5 rounded-full border border-white/20 bg-black/70 px-2.5 py-1.5 text-xs font-bold text-white backdrop-blur-sm"
          style={{ top: "calc(env(safe-area-inset-top) + 4rem)" }}
        >
          <CircleDot size={15} aria-hidden="true" />
          <span className="hidden sm:inline">{t.player.followBall}</span>
        </button>
      )}

      <AnimatePresence>
        {showControls && clipMode === "idle" && playbackUiState === "ready" && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="absolute inset-0 z-20 flex flex-col pointer-events-none">
            <div className="flex items-center justify-between px-4 pt-safe pt-4">
              {onClose ? (
                <button
                  type="button"
                  aria-label="Close video"
                  onClick={onClose}
                  className="pointer-events-auto flex h-10 w-10 items-center justify-center rounded-full bg-black/40 backdrop-blur-sm"
                >
                  <X className="h-5 w-5 text-white" />
                </button>
              ) : <span />}
            </div>
            <div className="flex-1" />
            {/* Everything lives on one line: play, timeline, time, speed, frame shape, fullscreen, clip. */}
            <div
              className="pointer-events-auto border-t border-white/10 bg-black/75 px-2.5 pt-2 backdrop-blur-md"
              style={{ paddingBottom: "max(0.6rem, env(safe-area-inset-bottom))" }}
            >
              <div
                role="group"
                aria-label="Playback and clip controls"
                data-testid="player-control-row"
                className="flex min-w-0 items-center gap-1 min-[400px]:gap-1.5"
              >
                <button
                  type="button"
                  onClick={togglePlay}
                  aria-label={isPlaying ? "Pause" : "Play"}
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white text-black"
                >
                  {isPlaying ? <Pause className="h-4 w-4 fill-black" /> : <Play className="h-4 w-4 fill-black" />}
                </button>
                {isLiveDvr && liveRange ? (
                  <>
                    <div className="relative flex min-w-0 flex-1 items-center">
                      {/* Narrow phones: the clock rides above the track so the track keeps its width. */}
                      <span aria-hidden className="pointer-events-none absolute -top-3.5 start-0.5 font-mono text-[10px] text-white/80 min-[400px]:hidden">
                        {formatAmmanClock(liveUtcMs)}
                      </span>
                      <input
                        type="range"
                        min={liveRange.startUtcMs}
                        max={liveRange.endUtcMs}
                        step={1000}
                        value={Math.max(liveRange.startUtcMs, Math.min(liveRange.endUtcMs, liveUtcMs ?? liveRange.endUtcMs))}
                        aria-label="Live DVR position in Amman local time"
                        onChange={(event) => seekToUtc(Number(event.target.value))}
                        className="h-1 min-w-0 flex-1 accent-primary"
                      />
                    </div>
                    <span className="hidden w-11 shrink-0 text-center font-mono text-[10px] text-white/80 min-[400px]:block">
                      {formatAmmanClock(liveUtcMs)}
                    </span>
                    {liveUtcMs != null && liveRange.endUtcMs - liveUtcMs > 8_000 && (
                      <button
                        type="button"
                        onClick={() => seekToUtc(liveRange.endUtcMs)}
                        className="h-8 shrink-0 rounded-full bg-live px-2.5 text-[10px] font-bold text-white"
                      >
                        Live
                      </button>
                    )}
                  </>
                ) : !isLive && duration > 0 ? (
                  <>
                    <div className="relative flex min-w-0 flex-1 items-center">
                      {/* Narrow phones: the time rides above the track so the track keeps its width. */}
                      <span aria-hidden className="pointer-events-none absolute -top-3.5 start-0.5 text-[10px] tabular-nums text-white/80 min-[400px]:hidden">
                        {formatDuration(currentTime)}
                      </span>
                      {timelineBands && timelineBands.length > 0 && (
                        <div aria-hidden className="pointer-events-none absolute inset-x-1.5 top-[calc(50%+5px)] h-[3px] overflow-hidden rounded-full">
                          {timelineBands.map((band, index) => {
                            const from = Math.min(100, Math.max(0, (band.from / duration) * 100));
                            const to = Math.min(100, Math.max(0, (band.to / duration) * 100));
                            return to > from ? (
                              <span
                                key={index}
                                className="absolute inset-y-0"
                                style={{ insetInlineStart: `${from}%`, width: `${to - from}%`, background: band.color }}
                              />
                            ) : null;
                          })}
                        </div>
                      )}
                      {timelineMarkers && timelineMarkers.length > 0 && (
                        <div aria-hidden className="pointer-events-none absolute inset-x-1.5 top-1/2 z-10 h-0">
                          {timelineMarkers.map((marker, index) => (
                            <span
                              key={index}
                              title={marker.label}
                              className={cn("absolute w-[3px] -translate-y-1/2 rounded-full", marker.emphasis ? "h-3.5" : "h-2 opacity-80")}
                              style={{
                                insetInlineStart: `calc(${Math.min(100, Math.max(0, (marker.at / duration) * 100))}% - 1.5px)`,
                                background: marker.color,
                              }}
                            />
                          ))}
                        </div>
                      )}
                      <input
                        type="range"
                        min={0}
                        max={duration}
                        step={0.1}
                        value={currentTime}
                        aria-label="Video position"
                        onPointerDown={(event) => {
                          beginSeekDrag(seekDragStateRef.current, parseFloat(event.currentTarget.value));
                          event.currentTarget.setPointerCapture(event.pointerId);
                        }}
                        onPointerUp={(event) => finishSeekSliderDrag(parseFloat(event.currentTarget.value))}
                        onPointerCancel={(event) => finishSeekSliderDrag(parseFloat(event.currentTarget.value))}
                        onChange={(event) => {
                          handleSeekSliderChange(parseFloat(event.currentTarget.value));
                        }}
                        className="relative h-1 min-w-0 flex-1 accent-primary"
                      />
                    </div>
                    <span
                      className="hidden w-11 shrink-0 text-center text-[11px] tabular-nums text-white/85 min-[400px]:block"
                      title={`${formatDuration(currentTime)} / ${formatDuration(duration)}`}
                    >
                      {formatDuration(currentTime)}
                    </span>
                  </>
                ) : (
                  <div className="flex-1" />
                )}
                <button
                  type="button"
                  data-testid="playback-speed"
                  aria-label={explainerCopy.player.speed(playbackRate)}
                  title="1/2/3: 0.25× / 0.5× / 1×"
                  disabled={isLive && !isLiveDvr}
                  onClick={() => {
                    const cycle = [1, 0.5, 0.25];
                    const index = cycle.findIndex((rate) => Math.abs(rate - playbackRate) < 0.01);
                    setPlaybackRate(cycle[(index + 1) % cycle.length]);
                    resetControlsTimer();
                  }}
                  className={cn(
                    "h-10 min-w-9 shrink-0 rounded-full border px-1.5 text-[11px] font-bold tabular-nums text-white disabled:opacity-40 min-[400px]:px-2",
                    Math.abs(playbackRate - 1) < 0.01 ? "border-white/20 bg-white/10" : "border-primary bg-primary/20",
                  )}
                >
                  {playbackRate}×
                </button>
                <button
                  type="button"
                  aria-label={`Frame shape ${selectedRatio}`}
                  onClick={() => applyFrameChange(selectedRatio === "16:9" ? 1 : frameZoomRef.current, selectedRatio === "16:9" ? "9:16" : "16:9")}
                  className="h-10 shrink-0 rounded-full border border-white/20 bg-white/10 px-1.5 text-[11px] font-bold text-white min-[400px]:px-2"
                >
                  {selectedRatio}
                </button>
                <button
                  type="button"
                  onClick={toggleFullscreen}
                  aria-label={isFullscreen ? "Exit full screen" : "Full screen"}
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white/10"
                >
                  {isFullscreen ? <Minimize className="h-4 w-4 text-white" /> : <Maximize className="h-4 w-4 text-white" />}
                </button>
                <button
                  type="button"
                  data-testid="button-record-clip"
                  onClick={startRecording}
                  aria-label={t.clipping.record}
                  className="flex h-10 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full bg-primary px-2.5 text-xs font-bold text-primary-foreground min-[400px]:px-3"
                >
                  <Circle className="h-3.5 w-3.5 fill-live text-live" />
                  {explainerCopy.player.clip}
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showLookCoach && showControls && (
          <CoachBubble
            key="coach-look"
            testId="coach-look-around"
            arrow="none"
            step={explainerCopy.stepOf(1, 2)}
            actionLabel={explainerCopy.next}
            onAction={dismissLookCoach}
            className="inset-x-4 top-[24%] mx-auto max-w-sm"
          >
            <span className="mb-1.5 flex items-center gap-2" aria-hidden="true">
              <MoveHorizontal className="h-5 w-5" />
            </span>
            {explainerCopy.player.lookAround}
          </CoachBubble>
        )}
        {showRecordCoach && showControls && (
          <CoachBubble
            key="coach-record"
            testId="coach-record"
            arrow="down"
            arrowOffset="calc(100% - 34px)"
            step={explainerCopy.stepOf(2, 2)}
            actionLabel={explainerCopy.gotIt}
            onAction={dismissRecordCoach}
            className="end-2 w-[min(18.5rem,calc(100%-1rem))]"
            style={{ bottom: "calc(max(0.6rem, env(safe-area-inset-bottom)) + 3.6rem)" }}
          >
            {explainerCopy.player.record}
          </CoachBubble>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {clipMode === "recording" && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="absolute inset-0 z-20 flex flex-col pointer-events-none">
            <div className="pt-safe pt-4 px-4 flex items-start justify-between">
              <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-black/60 backdrop-blur-sm border border-live/40">
                <div className="w-2 h-2 rounded-full bg-live animate-pulse" />
                <span className="text-live text-xs font-bold tabular-nums">{formatElapsed(recElapsed)}</span>
              </div>
              <MiniMap frame={displayedFrame} srcAspect={srcAspect} />
            </div>
            <div className="flex-1" />
            <div className="px-4 pointer-events-auto flex flex-col items-center gap-3" style={{ paddingBottom: "max(1.5rem, env(safe-area-inset-bottom))" }}>
              <button onClick={() => stopRecording()} className="flex items-center gap-2 px-5 py-2.5 rounded-full border border-line bg-transparent text-text font-bold text-sm hover:bg-raised">
                <Square className="w-4 h-4 fill-text" />
                {t.clipping.stopRecording}
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {clipMode === "review" && (
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="absolute bottom-0 left-0 right-0 z-20 bg-black/80 backdrop-blur-md px-4 pt-4 space-y-3" style={{ paddingBottom: "max(1.5rem, env(safe-area-inset-bottom))" }}>
            <p className="text-white text-sm font-semibold text-center">{t.clipping.reviewTitle} · {formatDuration(isLiveDvr ? clipDurationSeconds : Math.max(0, clipEndTime - clipStartRef.current))}</p>
            <input value={clipTitle} onChange={(event) => setClipTitle(event.target.value)} placeholder={t.clipping.titlePlaceholder} className="w-full bg-white/10 border border-white/20 rounded-xl px-3 py-2.5 text-white placeholder:text-white/40 text-sm outline-none focus:border-primary" />
            <div className="flex gap-2">
              <button onClick={discardClip} className="flex-1 py-2.5 rounded-xl border border-line text-text text-sm font-medium">{t.clipping.discard}</button>
              <button onClick={saveClip} disabled={isSavingClip} className="flex-1 py-2.5 rounded-xl border border-violet bg-violet/10 text-violet text-sm font-bold flex items-center justify-center gap-2 disabled:opacity-60">
                <CheckCircle2 className="w-4 h-4" />
                {isSavingClip ? t.clipping.saving : t.clipping.save}
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

    </motion.div>
  );
}