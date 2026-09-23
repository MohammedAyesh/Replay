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
import { normalizeClipKeyframes } from "./normalize";

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

export type ClipPlayerProps = {
  /** HLS manifest URL. The caller owns authorization/proxying. */
  src: string;
  title: string;
  source: ClipSource;
  academyId?: number;
  isLive?: boolean;
  liveCameraId?: string;
  layout: "overlay" | "inline";
  onClose?: () => void;
  canSave: boolean;
  onRequireAuth: (draft: ClipDraft) => void;
  onSave: (draft: ClipDraft) => Promise<void>;
  seekToSeconds?: number | null;
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
  title,
  source,
  academyId,
  isLive = false,
  liveCameraId,
  layout,
  onClose,
  canSave,
  onRequireAuth,
  onSave,
  seekToSeconds,
}: ClipPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
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
  const clipModeRef = useRef<ClipMode>("idle");
  const stopRecordingRef = useRef<(overrideEndTime?: number) => void>(() => {});
  const clipStartRef = useRef(0);
  const recordingRef = useRef<{ interval: ReturnType<typeof setInterval> | null; keyframes: CropKeyframe[] }>({
    interval: null,
    keyframes: [],
  });
  const lastExternalSeekRef = useRef<number | null>(null);
  const elapsedRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const { toast } = useToast();
  const { t } = useTranslation();

  const [isPlaying, setIsPlaying] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [qualityLevels, setQualityLevels] = useState<Array<{ height: number; index: number }>>([]);
  const [activeQuality, setActiveQuality] = useState(-1);
  const [showQualityPicker, setShowQualityPicker] = useState(false);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [showControls, setShowControls] = useState(true);
  const [clipMode, setClipMode] = useState<ClipMode>("idle");
  const [clipEndTime, setClipEndTime] = useState(0);
  const [clipTitle, setClipTitle] = useState("");
  const [isSavingClip, setIsSavingClip] = useState(false);
  const [recElapsed, setRecElapsed] = useState(0);

  const sourceKey = source.kind === "bunny" ? source.videoId : source.token;

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
    if (isLive || !videoRef.current) return;
    videoRef.current.currentTime = Math.max(0, Math.min(videoRef.current.duration || Infinity, videoRef.current.currentTime + delta));
    resetControlsTimer();
  }, [isLive, resetControlsTimer]);

  const { flash: skipFlash, onTouchEnd: skipOnTouchEnd } = useSkipTap({
    onSkip: handleSkip,
    onSingleTap: resetControlsTimer,
    disabled: clipMode !== "idle" || isLive,
  });

  useEffect(() => {
    const element = videoRef.current;
    if (!element) return;
    element.muted = isLive;
    let previousTime = -1;
    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    const onDurationChange = () => { if (!isLive) setDuration(element.duration || 0); };
    const onTimeUpdate = () => {
      if (seekDraggingRef.current) return;
      const now = element.currentTime;
      setCurrentTime(now);
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

    element.addEventListener("play", onPlay);
    element.addEventListener("pause", onPause);
    element.addEventListener("durationchange", onDurationChange);
    element.addEventListener("timeupdate", onTimeUpdate);
    element.addEventListener("ended", onEnded);
    setQualityLevels([]);
    setActiveQuality(-1);
    setShowQualityPicker(false);

    if (Hls.isSupported()) {
      const hls = new Hls(isLive ? { enableWorker: false, liveSyncDurationCount: 3 } : { enableWorker: false });
      hlsRef.current = hls;
      capPlaybackQuality(hls);
      hls.loadSource(src);
      hls.attachMedia(element);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        element.play().catch(() => {});
        setQualityLevels(hls.levels.map((level, index) => ({ height: level.height, index })).sort((a, b) => b.height - a.height));
      });
      hls.on(Hls.Events.ERROR, (_, data) => { if (data.fatal) element.dispatchEvent(new Event("error")); });
    } else if (element.canPlayType("application/vnd.apple.mpegurl")) {
      element.src = src;
      element.addEventListener("canplay", () => element.play().catch(() => {}), { once: true });
    }

    return () => {
      hlsRef.current?.destroy();
      hlsRef.current = null;
      element.removeEventListener("play", onPlay);
      element.removeEventListener("pause", onPause);
      element.removeEventListener("durationchange", onDurationChange);
      element.removeEventListener("timeupdate", onTimeUpdate);
      element.removeEventListener("ended", onEnded);
    };
  }, [isLive, src]);

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
    if (isLive || !videoRef.current) return;
    videoRef.current.currentTime = Math.max(0, Math.min(videoRef.current.duration || Infinity, videoRef.current.currentTime + delta));
  };

  const startRecording = () => {
    if (!canSave) {
      const now = videoRef.current?.currentTime ?? 0;
      requireAuth(buildDraft(now, now + 0.1, [{ t: 0, ...computeCropRect() }], clipTitle || title));
      return;
    }
    if (clipModeRef.current === "recording" || !videoRef.current) return;
    const element = videoRef.current;
    element.play().catch(() => {});
    clipStartRef.current = element.currentTime;
    clipModeRef.current = "recording";
    recordingRef.current.keyframes = [];
    setRecElapsed(0);
    const sampleFrame = () => {
      const current = videoRef.current;
      if (!current) return;
      const relativeTime = current.currentTime - clipStartRef.current;
      if (relativeTime < 0) return;
      recordingRef.current.keyframes.push({ t: relativeTime, ...computeCropRect() });
    };
    sampleFrame();
    recordingRef.current.interval = setInterval(sampleFrame, 150);
    elapsedRef.current = setInterval(() => {
      if (videoRef.current) setRecElapsed(Math.max(0, videoRef.current.currentTime - clipStartRef.current));
    }, 100);
    setClipMode("recording");
  };

  const stopRecording = (overrideEndTime?: number) => {
    clipModeRef.current = "review";
    if (recordingRef.current.interval) clearInterval(recordingRef.current.interval);
    if (elapsedRef.current) clearInterval(elapsedRef.current);
    recordingRef.current.interval = null;
    elapsedRef.current = null;
    const endTime = overrideEndTime ?? videoRef.current?.currentTime ?? clipStartRef.current;
    if (videoRef.current) recordingRef.current.keyframes.push({ t: Math.max(0, endTime - clipStartRef.current), ...computeCropRect() });
    videoRef.current?.pause();
    setClipEndTime(endTime);
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
    applyFrameChange(1, "16:9");
  };

  const saveClip = async () => {
    const endTime = clipEndTime;
    const startTime = clipStartRef.current;
    const totalDuration = videoRef.current?.duration || duration || 0;
    if (!isLive && totalDuration <= 0) {
      toast({ title: t.clipping.error, description: "Wait for the video to load before saving.", variant: "destructive" });
      return;
    }
    const draft = buildDraft(startTime, endTime, recordingRef.current.keyframes, clipTitle || title);
    const apiDraft = isLive
      ? { ...draft, startTime: 0, endTime: 1 }
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
        description: isLive ? "Live clip saved. It will be available to play once the recording is uploaded." : t.clipping.savedDesc,
        className: "bg-primary text-white border-none",
        duration: 2500,
      });
      setClipMode("idle");
      setClipTitle("");
      recordingRef.current.keyframes = [];
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

  return (
    <motion.div
      ref={containerRef}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className={shellClass}
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
          <video ref={videoRef} className="pointer-events-none select-none" style={frameToVideoStyle(frame)} playsInline onLoadedMetadata={onLoadedMetadata} />
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
              <button onClick={() => seek(-10)} disabled={isLive} className="w-12 h-12 rounded-full bg-black/30 backdrop-blur-sm flex items-center justify-center disabled:opacity-40">
                <SkipBack className="w-5 h-5 text-white" />
              </button>
              <button onClick={togglePlay} className="w-16 h-16 rounded-full bg-white/20 backdrop-blur-sm flex items-center justify-center">
                {isPlaying ? <Pause className="w-7 h-7 text-white fill-white" /> : <Play className="w-7 h-7 text-white fill-white" />}
              </button>
              <button onClick={() => seek(10)} disabled={isLive} className="w-12 h-12 rounded-full bg-black/30 backdrop-blur-sm flex items-center justify-center disabled:opacity-40">
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
            <p className="text-white text-sm font-semibold text-center">{t.clipping.reviewTitle} · {formatDuration(Math.max(0, clipEndTime - clipStartRef.current))}</p>
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