import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  CheckCircle2,
  Circle,
  Maximize,
  Minimize,
  Pause,
  Play,
  SkipBack,
  SkipForward,
  Square,
  X,
} from "lucide-react";
import Hls from "hls.js";
import type { TimelineFragment } from "@/components/HlsPlayer";
import { FrameSizeSlider } from "@/components/panorama/FrameSizeSlider";
import { SkipFlash } from "@/components/skip-flash";
import { usePanoramaFrame, maxZoomFor } from "@/hooks/use-panorama-frame";
import { useSkipTap } from "@/hooks/use-skip-tap";
import { useToast } from "@/hooks/use-toast";
import { useTranslation } from "@/i18n";
import { useFullscreenVideo } from "@/lib/fullscreen-video";
import {
  DEFAULT_SRC_ASPECT,
  formatElapsed,
  frameToVideoStyle,
  type AspectRatio,
  type CropKeyframe,
  type Frame,
} from "@/lib/cropFrame";
import { capPlaybackQuality } from "@/lib/hlsQuality";
import { cn } from "@/lib/utils";
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

export type ClipPlayerProps = {
  /** HLS manifest URL. The caller owns authorization/proxying. */
  src: string;
  /** Optional alternate manifest used after the preferred stream fails. */
  fallbackSrc?: string;
  onFallback?: () => void;
  title: string;
  source: ClipSource;
  academyId?: number;
  isLive?: boolean;
  /** Enable UTC-based review and clipping for a rolling live HLS DVR window. */
  liveDvr?: LiveDvrOptions;
  liveCameraId?: string;
  layout: "overlay" | "inline";
  onClose?: () => void;
  canSave: boolean;
  onRequireAuth: (draft: ClipDraft) => void;
  onSave: (draft: ClipDraft) => Promise<void>;
  seekToSeconds?: number | null;
  seekToUtcMs?: number | null;
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
  levels: Array<{ height: number; index: number }>;
  active: number;
  open: boolean;
  onToggle: () => void;
  onSelect: (index: number) => void;
}) {
  if (levels.length <= 1) return null;
  const label = (index: number, height?: number) =>
    index === -1 ? "Auto" : (height ?? 0) >= 2160 ? "4K" : `${height ?? 0}p`;
  return (
    <div
      className="absolute end-3 z-30 pointer-events-auto"
      style={{ top: "calc(env(safe-area-inset-top) + 4rem)" }}
    >
      <div className="relative">
        <button
          onClick={onToggle}
          className="px-3 py-1.5 rounded-full bg-black/60 backdrop-blur-sm text-white text-xs font-bold border border-white/20"
        >
          {label(active, levels.find((level) => level.index === active)?.height)}
        </button>
        {open && (
          <div className="absolute top-full end-0 mt-1 bg-black/85 backdrop-blur-md rounded-xl overflow-hidden shadow-xl border border-white/10 min-w-[5rem]">
            {[{ height: 0, index: -1 }, ...levels].map((level) => (
              <button
                key={level.index}
                onClick={() => onSelect(level.index)}
                className={cn(
                  "block w-full px-4 py-2.5 text-xs font-semibold text-left transition-colors",
                  active === level.index ? "text-primary" : "text-white hover:bg-white/10",
                )}
              >
                {label(level.index, level.height)}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function ClipPlayer({
  src,
  fallbackSrc,
  onFallback,
  title,
  source,
  academyId,
  isLive = false,
  liveDvr,
  liveCameraId,
  layout,
  onClose,
  canSave,
  onRequireAuth,
  onSave,
  seekToSeconds,
  seekToUtcMs,
}: ClipPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const fallbackRestoreUtcRef = useRef<number | null>(null);
  const fallbackTriedRef = useRef(false);
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
    applyFrameChange,
    setSourceAspect,
    handleFramePointerDown,
    handleFramePointerMove,
    handleFramePointerUp,
  } = usePanoramaFrame();
  const seekDraggingRef = useRef(false);
  const controlsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const frameRepeatDelayRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const frameRepeatIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
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

  const [isPlaying, setIsPlaying] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [qualityLevels, setQualityLevels] = useState<Array<{ height: number; index: number }>>([]);
  const [activeQuality, setActiveQuality] = useState(-1);
  const [showQualityPicker, setShowQualityPicker] = useState(false);
  const [usingFallback, setUsingFallback] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [look, setLook] = useState<"original" | "warm" | "cinematic" | "noir">("original");
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [liveUtcMs, setLiveUtcMs] = useState<number | null>(null);
  const [liveRange, setLiveRange] = useState<{ startUtcMs: number; endUtcMs: number } | null>(null);
  const [showControls, setShowControls] = useState(true);
  const [clipMode, setClipMode] = useState<ClipMode>("idle");
  const [clipEndTime, setClipEndTime] = useState(0);
  const [clipTitle, setClipTitle] = useState("");
  const [isSavingClip, setIsSavingClip] = useState(false);
  const [recElapsed, setRecElapsed] = useState(0);
  const [clipDurationSeconds, setClipDurationSeconds] = useState(0);

  const sourceKey = source.kind === "bunny" ? source.videoId : source.token;
  const isLiveDvr = Boolean(liveDvr);
  const maxLiveClipSeconds = Math.max(1, Math.min(600, liveDvr?.maxDurationSeconds ?? 600));
  const activeSrc = usingFallback && fallbackSrc ? fallbackSrc : src;

  const programTimeAt = useCallback((position: number): number | null => {
    return liveProgramTimeAtPosition(position, liveFragmentsRef.current);
  }, []);

  useEffect(() => {
    setUsingFallback(false);
    fallbackTriedRef.current = false;
  }, [src]);

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
    videoRef.current.currentTime = Math.max(0, Math.min(videoRef.current.duration || Infinity, seekToSeconds));
  }, [seekToSeconds]);

  const resetControlsTimer = useCallback(() => {
    setShowControls(true);
    if (controlsTimerRef.current) clearTimeout(controlsTimerRef.current);
    controlsTimerRef.current = setTimeout(() => setShowControls(false), 4000);
  }, []);

  const seekToUtc = useCallback((targetUtcMs: number) => {
    const element = videoRef.current;
    if (!element || !liveRange) return;
    const bounded = Math.max(liveRange.startUtcMs, Math.min(liveRange.endUtcMs, targetUtcMs));
    const position = mediaPositionAtUtc(bounded);
    if (position == null) return;
    element.currentTime = position;
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
    videoRef.current.currentTime = Math.max(0, Math.min(videoRef.current.duration || Infinity, videoRef.current.currentTime + delta));
    resetControlsTimer();
  }, [isLive, isLiveDvr, resetControlsTimer]);

  const { flash: skipFlash, onTouchEnd: skipOnTouchEnd } = useSkipTap({
    onSkip: handleSkip,
    onSingleTap: resetControlsTimer,
    disabled: clipMode !== "idle" || (isLive && !isLiveDvr),
  });

  useEffect(() => {
    const element = videoRef.current;
    if (!element) return;
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
    const switchToFallback = () => {
      if (!fallbackSrc || fallbackTriedRef.current || activeSrc === fallbackSrc) return false;
      fallbackTriedRef.current = true;
      fallbackRestoreUtcRef.current = isLiveDvr ? liveUtcRef.current : null;
      setUsingFallback(true);
      onFallback?.();
      return true;
    };
    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    const onDurationChange = () => { if (!isLive) setDuration(element.duration || 0); };
    const onTimeUpdate = () => {
      if (isLiveDvr && fallbackRestoreUtcRef.current != null) return;
      if (seekDraggingRef.current) return;
      const now = element.currentTime;
      setCurrentTime(now);
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
    element.addEventListener("durationchange", onDurationChange);
    element.addEventListener("timeupdate", onTimeUpdate);
    element.addEventListener("ended", onEnded);
    element.addEventListener("error", switchToFallback);
    setQualityLevels([]);
    setActiveQuality(-1);
    setShowQualityPicker(false);

    if (Hls.isSupported()) {
      const hls = new Hls(isLive
        ? {
          enableWorker: false,
          liveSyncDurationCount: 10,
          maxLiveSyncPlaybackRate: 1.05,
          liveMaxLatencyDurationCount: 20,
          maxBufferLength: 40,
          maxMaxBufferLength: 60,
          backBufferLength: 90,
        }
        : { enableWorker: false });
      hlsRef.current = hls;
      capPlaybackQuality(hls);
      hls.loadSource(activeSrc);
      hls.attachMedia(element);
      if (isLiveDvr) {
        hls.on(Hls.Events.LEVEL_UPDATED, updateLiveRange);
        hls.on(Hls.Events.LEVEL_LOADED, updateLiveRange);
      }
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        element.play().catch(() => {});
        setQualityLevels(hls.levels.map((level, index) => ({ height: level.height, index })).sort((a, b) => b.height - a.height));
      });
      hls.on(Hls.Events.ERROR, (_, data) => {
        if (!data.fatal) return;
        if (switchToFallback()) return;
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
        else if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
        else element.dispatchEvent(new Event("error"));
      });
    } else if (element.canPlayType("application/vnd.apple.mpegurl")) {
      element.src = activeSrc;
      element.addEventListener("canplay", () => element.play().catch(() => {}), { once: true });
    }

    return () => {
      if (isLiveDvr && liveUtcRef.current != null) {
        fallbackRestoreUtcRef.current = liveUtcRef.current;
      }
      hlsRef.current?.destroy();
      hlsRef.current = null;
      element.removeEventListener("play", onPlay);
      element.removeEventListener("pause", onPause);
      element.removeEventListener("durationchange", onDurationChange);
      element.removeEventListener("timeupdate", onTimeUpdate);
      element.removeEventListener("ended", onEnded);
      element.removeEventListener("error", switchToFallback);
      liveFragmentsRef.current = [];
    };
  }, [activeSrc, fallbackSrc, isLive, isLiveDvr, liveDvr, mediaPositionAtUtc, onFallback, programTimeAt]);

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
    videoRef.current.currentTime = Math.max(0, Math.min(videoRef.current.duration || Infinity, videoRef.current.currentTime + delta));
    resetControlsTimer();
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
          onPointerMove={handleFramePointerMove}
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
            className="pointer-events-none select-none"
            style={{ ...frameToVideoStyle(frame), filter: videoFilter }}
            playsInline
            onLoadedMetadata={onLoadedMetadata}
          />
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

      <AnimatePresence>
        {showControls && clipMode === "idle" && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="absolute inset-0 z-20 flex flex-col pointer-events-none">
            <div className="flex items-center justify-between px-4 pt-safe pt-4 pointer-events-auto">
              {onClose ? (
                <button onClick={onClose} className="w-10 h-10 rounded-full bg-black/40 backdrop-blur-sm flex items-center justify-center">
                  <X className="w-5 h-5 text-white" />
                </button>
              ) : <span />}
              <div className="flex items-center gap-2">
                <button
                  onClick={() => applyFrameChange(selectedRatio === "16:9" ? 1 : frameZoomRef.current, selectedRatio === "16:9" ? "9:16" : "16:9")}
                  className="px-3 py-1.5 rounded-full bg-black/40 backdrop-blur-sm text-white text-xs font-bold"
                >
                  {selectedRatio}
                </button>
                <button onClick={toggleFullscreen} className="w-10 h-10 rounded-full bg-black/40 backdrop-blur-sm flex items-center justify-center">
                  {isFullscreen ? <Minimize className="w-4 h-4 text-white" /> : <Maximize className="w-4 h-4 text-white" />}
                </button>
              </div>
            </div>

            <div className="flex-1 flex items-center justify-center gap-8 pointer-events-auto">
              <button onClick={() => seek(-10)} disabled={isLive && !isLiveDvr} className="w-12 h-12 rounded-full bg-black/30 backdrop-blur-sm flex items-center justify-center disabled:opacity-40">
                <SkipBack className="w-5 h-5 text-white" />
              </button>
              <button onClick={togglePlay} className="w-16 h-16 rounded-full bg-white/20 backdrop-blur-sm flex items-center justify-center">
                {isPlaying ? <Pause className="w-7 h-7 text-white fill-white" /> : <Play className="w-7 h-7 text-white fill-white" />}
              </button>
              <button onClick={() => seek(10)} disabled={isLive && !isLiveDvr} className="w-12 h-12 rounded-full bg-black/30 backdrop-blur-sm flex items-center justify-center disabled:opacity-40">
                <SkipForward className="w-5 h-5 text-white" />
              </button>
            </div>

            <div className="px-4 pointer-events-auto space-y-3" style={{ paddingBottom: "max(1.5rem, env(safe-area-inset-bottom))" }}>
              {!isLive && duration > 0 && (
                <div className="flex items-center gap-2">
                  <span className="text-white text-xs tabular-nums w-10 text-end">{formatDuration(currentTime)}</span>
                  <input
                    type="range"
                    min={0}
                    max={duration}
                    step={0.1}
                    value={currentTime}
                    onMouseDown={() => { seekDraggingRef.current = true; }}
                    onTouchStart={() => { seekDraggingRef.current = true; }}
                    onMouseUp={() => { seekDraggingRef.current = false; }}
                    onTouchEnd={() => { seekDraggingRef.current = false; }}
                    onChange={(event) => {
                      const value = parseFloat(event.target.value);
                      setCurrentTime(value);
                      if (videoRef.current) videoRef.current.currentTime = value;
                    }}
                    className="flex-1 accent-primary h-1"
                  />
                  <span className="text-white text-xs tabular-nums w-10">{formatDuration(duration)}</span>
                </div>
              )}
              {isLiveDvr && liveRange && (
                <div className="flex items-center gap-2">
                  <span className="w-14 text-end font-mono text-[10px] text-white/80">
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
                    className="flex-1 accent-primary h-1"
                  />
                  <span className="w-14 font-mono text-[10px] text-white/80">
                    {formatAmmanClock(liveRange.endUtcMs)}
                  </span>
                  {liveUtcMs != null && liveRange.endUtcMs - liveUtcMs > 8_000 && (
                    <button
                      type="button"
                      onClick={() => seekToUtc(liveRange.endUtcMs)}
                      className="rounded-full bg-live px-2.5 py-1 text-[10px] font-bold text-white"
                    >
                      Live
                    </button>
                  )}
                </div>
              )}
              <div className="space-y-2">
                <div role="group" aria-label="Frame stepping" data-testid="player-step-controls" className="grid grid-cols-6 gap-1">
                  {([
                    { label: "−1 s", seconds: -1, testId: "step-back-one-second" },
                    { label: "−2 frames", seconds: -2 * FRAME_DURATION_SECONDS, testId: "step-back-two-frames" },
                    { label: "−1 frame", seconds: -FRAME_DURATION_SECONDS, testId: "step-back-one-frame", repeat: true },
                    { label: "+1 frame", seconds: FRAME_DURATION_SECONDS, testId: "step-forward-one-frame", repeat: true },
                    { label: "+2 frames", seconds: 2 * FRAME_DURATION_SECONDS, testId: "step-forward-two-frames" },
                    { label: "+1 s", seconds: 1, testId: "step-forward-one-second" },
                  ]).map(({ label, seconds, testId, repeat }) => (
                    <button
                      key={testId}
                      type="button"
                      data-testid={testId}
                      aria-label={label}
                      title={repeat ? `${label}; hold to repeat` : label}
                      disabled={isLive && !isLiveDvr}
                      onPointerDown={repeat ? (event) => startFrameRepeat(event, seconds) : undefined}
                      onPointerUp={repeat ? stopFrameRepeat : undefined}
                      onPointerCancel={repeat ? stopFrameRepeat : undefined}
                      onLostPointerCapture={repeat ? stopFrameRepeat : undefined}
                      onClick={repeat
                        ? (event) => { if (event.detail === 0) stepVideoBy(seconds); }
                        : () => stepVideoBy(seconds)}
                      className="min-h-12 min-w-0 touch-manipulation rounded-lg border border-white/20 bg-black/50 px-1 text-[10px] font-semibold leading-tight text-white disabled:opacity-40 sm:px-2 sm:text-xs"
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <div className="flex flex-wrap items-center justify-center gap-1.5">
                  {PLAYBACK_SPEEDS.map((rate, index) => (
                    <button
                      key={rate}
                      type="button"
                      data-testid={`playback-speed-${index + 1}`}
                      aria-label={`Playback speed ${rate} times`}
                      aria-pressed={Math.abs(playbackRate - rate) < 0.01}
                      title={`${rate}× (key ${index + 1})`}
                      onClick={() => {
                        setPlaybackRate(rate);
                        resetControlsTimer();
                      }}
                      className={cn(
                        "min-h-11 min-w-14 rounded-lg border px-3 text-xs font-bold",
                        Math.abs(playbackRate - rate) < 0.01
                          ? "border-primary bg-primary/20 text-white"
                          : "border-white/20 bg-black/50 text-white",
                      )}
                    >
                      {rate}×
                    </button>
                  ))}
                <label className="flex min-h-11 shrink-0 items-center gap-2 rounded-lg border border-white/20 bg-black/50 px-3 text-xs font-semibold text-white">
                  <span>Look</span>
                  <select
                    aria-label="Video look filter"
                    value={look}
                    onChange={(event) => {
                      setLook(event.target.value as typeof look);
                      resetControlsTimer();
                    }}
                    className="bg-transparent text-white outline-none"
                  >
                    <option value="original" className="bg-black">Original</option>
                    <option value="warm" className="bg-black">Warm</option>
                    <option value="cinematic" className="bg-black">Cinematic</option>
                    <option value="noir" className="bg-black">Noir</option>
                  </select>
                </label>
              </div>
              </div>
              <p className="hidden text-center text-[10px] text-white/50 sm:block">
                ←/→: 1 frame · ,/.: 2 frames · Shift+←/→: 1 s · 1/2/3: 0.25×/0.5×/1×
              </p>
              <div className="flex justify-center">
                <FrameSizeSlider zoom={frameZoom} frame={frame} maxZoom={maxZoomFor(selectedRatio)} onChange={(zoom) => applyFrameChange(zoom, selectedRatioRef.current)} />
              </div>
              <div className="flex justify-center">
        <button onClick={startRecording} className="flex items-center gap-2 px-5 py-2.5 rounded-full bg-primary text-primary-foreground font-bold text-sm">
                  <Circle className="w-4 h-4 fill-primary-foreground" />
                  {t.clipping.record}
                </button>
              </div>
            </div>
          </motion.div>
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
              <MiniMap frame={frame} srcAspect={srcAspect} />
            </div>
            <div className="flex-1" />
            <div className="px-4 pointer-events-auto flex flex-col items-center gap-3" style={{ paddingBottom: "max(1.5rem, env(safe-area-inset-bottom))" }}>
              <FrameSizeSlider zoom={frameZoom} frame={frame} maxZoom={maxZoomFor(selectedRatio)} compact onChange={(zoom) => applyFrameChange(zoom, selectedRatioRef.current)} />
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