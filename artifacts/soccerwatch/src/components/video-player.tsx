import { useState, useRef, useEffect, useCallback } from "react";
import { useSkipTap } from "@/hooks/use-skip-tap";
import { SkipFlash } from "@/components/skip-flash";
import { useLocation } from "wouter";
import {
  useCreateUserClip,
  getListUserClipsQueryKey,
  type BunnyVideo,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Play, Pause, X, SkipBack, SkipForward,
  Circle, Square, CheckCircle2, Maximize, Minimize,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { useTranslation } from "@/i18n";
import { useFullscreenVideo } from "@/lib/fullscreen-video";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import Hls from "hls.js";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import {
  DEFAULT_SRC_ASPECT,
  OUT_ASPECT,
  makeFrame,
  frameToVideoStyle,
  formatElapsed,
  type AspectRatio,
  type CropKeyframe,
} from "@/lib/cropFrame";

type ClipMode = "idle" | "recording" | "review";

export type VideoPlayerSource =
  | { kind: "vod"; video: BunnyVideo }
  | { kind: "live"; cameraId: string; title: string };

const MIN_FRAME_ZOOM = 0.4;
const MAX_FRAME_ZOOM = 4;

function formatDuration(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function maxZoomFor(ratio: AspectRatio): number {
  return ratio === "9:16" ? MAX_FRAME_ZOOM : 1;
}

function FrameSizeSlider({
  zoom, onChange, frame, maxZoom, compact,
}: {
  zoom: number;
  onChange: (z: number) => void;
  frame: { x: number; y: number; w: number; h: number };
  maxZoom: number;
  compact?: boolean;
}) {
  const coveredW = Math.max(0, Math.min(1, (Math.min(1, frame.x + frame.w) - Math.max(0, frame.x)) / frame.w));
  const coveredH = Math.max(0, Math.min(1, (Math.min(1, frame.y + frame.h) - Math.max(0, frame.y)) / frame.h));
  const blackPct = Math.round((1 - coveredW * coveredH) * 100);
  return (
    <div
      className={cn("pointer-events-auto rounded-2xl bg-black/60 backdrop-blur-sm px-3 py-2", compact ? "w-56" : "w-full max-w-sm")}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between mb-1">
        <span className="text-[10px] uppercase tracking-wide text-white/60 font-semibold">Frame size</span>
        <span className="text-[10px] text-white/70 tabular-nums">
          {zoom.toFixed(2)}x{blackPct > 0 ? ` · ${blackPct}% black` : ""}
        </span>
      </div>
      <input
        type="range"
        min={MIN_FRAME_ZOOM}
        max={maxZoom}
        step={0.02}
        value={zoom}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-full accent-primary"
        aria-label="Frame size"
      />
    </div>
  );
}

function MiniMap({ frame, srcAspect }: { frame: { x: number; y: number; w: number; h: number }; srcAspect: number }) {
  const W = 128;
  const H = Math.max(24, Math.round(W / (srcAspect > 0 ? srcAspect : DEFAULT_SRC_ASPECT)));
  return (
    <div className="relative rounded-md overflow-hidden border border-white/30 shadow-lg shrink-0" style={{ width: W, height: H, background: "rgba(0,0,0,0.55)" }}>
      <div className="absolute inset-0 opacity-20">
        <div className="absolute left-1/2 inset-y-0 w-px bg-white" />
        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white" style={{ width: H * 0.5, height: H * 0.5 }} />
      </div>
      <div className="absolute inset-0 bg-black/55" style={{
        clipPath: `polygon(0% 0%, 100% 0%, 100% 100%, 0% 100%, 0% 0%, ${frame.x * 100}% ${frame.y * 100}%, ${frame.x * 100}% ${(frame.y + frame.h) * 100}%, ${(frame.x + frame.w) * 100}% ${(frame.y + frame.h) * 100}%, ${(frame.x + frame.w) * 100}% ${frame.y * 100}%, ${frame.x * 100}% ${frame.y * 100}%)`,
      }} />
      <div className="absolute border-2 border-primary" style={{ left: `${frame.x * 100}%`, top: `${frame.y * 100}%`, width: `${frame.w * 100}%`, height: `${frame.h * 100}%` }} />
      <p className="absolute bottom-0.5 left-0 right-0 text-center text-[8px] text-white/50 font-medium tracking-wide uppercase pointer-events-none">field view</p>
    </div>
  );
}

export function VideoPlayer({ source, onClose }: { source: VideoPlayerSource; onClose: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const { setFullscreenVideo } = useFullscreenVideo();
  const { user, isGuest } = useAuth();
  const { toast } = useToast();
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const createUserClip = useCreateUserClip();
  const [, setLocation] = useLocation();

  const isLive = source.kind === "live";
  const videoId = source.kind === "vod" ? source.video.guid : `live:${source.cameraId}`;
  const title = source.kind === "vod" ? source.video.title : source.title;
  const playbackUrl = source.kind === "vod" ? source.video.playbackUrl : `/api/live/${source.cameraId}/index.m3u8`;

  const [isPlaying, setIsPlaying] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const seekDraggingRef = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isLandscape, setIsLiveLandscape] = useState(typeof window !== "undefined" && window.innerWidth > window.innerHeight);
  const [showControls, setShowControls] = useState(true);
  const controlsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const resetControlsTimer = useCallback(() => {
    setShowControls(true);
    if (controlsTimerRef.current) clearTimeout(controlsTimerRef.current);
    controlsTimerRef.current = setTimeout(() => setShowControls(false), 4000);
  }, []);

  const resetControlsTimerRef = useRef(resetControlsTimer);
  useEffect(() => { resetControlsTimerRef.current = resetControlsTimer; }, [resetControlsTimer]);

  const [clipMode, setClipMode] = useState<ClipMode>("idle");
  const [clipEndTime, setClipEndTime] = useState(0);
  const [clipTitle, setClipTitle] = useState("");
  const [isSavingClip, setIsSavingClip] = useState(false);
  const [recElapsed, setRecElapsed] = useState(0);
  const [showAuthPrompt, setShowAuthPrompt] = useState(false);
  const [selectedRatio, setSelectedRatio] = useState<AspectRatio>("16:9");
  const selectedRatioRef = useRef<AspectRatio>("16:9");

  const [srcAspect, setSrcAspect] = useState(DEFAULT_SRC_ASPECT);
  const srcAspectRef = useRef(DEFAULT_SRC_ASPECT);
  const [frameZoom, setFrameZoom] = useState(1);
  const frameZoomRef = useRef(1);
  const [frameOrigin, setFrameOrigin] = useState({ x: 0.25, y: 0 });
  const frameOriginRef = useRef({ x: 0.25, y: 0 });
  const frameBoxRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ active: boolean; startX: number; startY: number; originX: number; originY: number }>({ active: false, startX: 0, startY: 0, originX: 0, originY: 0 });
  const draggedRef = useRef(false);

  const clipModeRef = useRef<ClipMode>("idle");
  const stopRecordingRef = useRef<(overrideEndTime?: number) => void>(() => {});
  const clipStartRef = useRef(0);
  // For live streams without VOD duration, track clip timing in a wall-clock offset.
  const clipWallStartRef = useRef(0);
  const recordingRef = useRef<{ interval: ReturnType<typeof setInterval> | null; keyframes: CropKeyframe[] }>({ interval: null, keyframes: [] });
  const elapsedRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const outAspect = OUT_ASPECT[selectedRatio];
  const frame = makeFrame(frameOrigin.x, frameOrigin.y, frameZoom, srcAspect, outAspect);

  const readFrame = useCallback(() => makeFrame(
    frameOriginRef.current.x,
    frameOriginRef.current.y,
    frameZoomRef.current,
    srcAspectRef.current,
    OUT_ASPECT[selectedRatioRef.current]
  ), []);

  const setOrigin = useCallback((x: number, y: number) => {
    const f = makeFrame(x, y, frameZoomRef.current, srcAspectRef.current, OUT_ASPECT[selectedRatioRef.current]);
    frameOriginRef.current = { x: f.x, y: f.y };
    setFrameOrigin({ x: f.x, y: f.y });
  }, []);

  const applyFrameChange = useCallback((requestedZoom: number, nextRatio: AspectRatio) => {
    const nextZoom = Math.max(MIN_FRAME_ZOOM, Math.min(maxZoomFor(nextRatio), requestedZoom));
    const prev = makeFrame(frameOriginRef.current.x, frameOriginRef.current.y, frameZoomRef.current, srcAspectRef.current, OUT_ASPECT[selectedRatioRef.current]);
    const cx = prev.x + prev.w / 2;
    const cy = prev.y + prev.h / 2;
    const oa = OUT_ASPECT[nextRatio];
    const sized = makeFrame(0, 0, nextZoom, srcAspectRef.current, oa);
    const f = makeFrame(cx - sized.w / 2, cy - sized.h / 2, nextZoom, srcAspectRef.current, oa);
    frameZoomRef.current = nextZoom;
    selectedRatioRef.current = nextRatio;
    frameOriginRef.current = { x: f.x, y: f.y };
    setFrameZoom(nextZoom);
    setSelectedRatio(nextRatio);
    setFrameOrigin({ x: f.x, y: f.y });
  }, []);

  useEffect(() => { clipModeRef.current = clipMode; }, [clipMode]);

  const computeCropRect = useCallback((): { x: number; y: number; w: number; h: number } => {
    const f = readFrame();
    return { x: f.x, y: f.y, w: f.w, h: f.h };
  }, [readFrame]);

  useEffect(() => {
    setFullscreenVideo(true);
    return () => setFullscreenVideo(false);
  }, [setFullscreenVideo]);

  useEffect(() => {
    const update = () => setIsLiveLandscape(window.innerWidth > window.innerHeight);
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
    };
  }, []);

  const toggleFullscreen = useCallback(() => {
    const el = containerRef.current as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> };
    const doc = document as Document & { webkitFullscreenElement?: Element; webkitExitFullscreen?: () => void };
    const isFs = document.fullscreenElement || doc.webkitFullscreenElement;
    if (!el) return;
    if (!isFs) {
      (el.requestFullscreen ?? el.webkitRequestFullscreen)?.call(el)?.catch?.(() => {});
    } else {
      (document.exitFullscreen ?? doc.webkitExitFullscreen)?.call(document)?.catch?.(() => {});
    }
  }, []);

  useEffect(() => {
    const doc = document as Document & { webkitFullscreenElement?: Element };
    const handler = () => setIsFullscreen(!!(document.fullscreenElement || doc.webkitFullscreenElement));
    document.addEventListener("fullscreenchange", handler);
    document.addEventListener("webkitfullscreenchange", handler);
    return () => {
      document.removeEventListener("fullscreenchange", handler);
      document.removeEventListener("webkitfullscreenchange", handler);
    };
  }, []);

  useEffect(() => {
    resetControlsTimer();
    return () => {
      if (recordingRef.current.interval) clearInterval(recordingRef.current.interval);
      if (elapsedRef.current) clearInterval(elapsedRef.current);
      if (controlsTimerRef.current) clearTimeout(controlsTimerRef.current);
    };
  }, []);

  const handleSkip = useCallback((delta: number) => {
    if (isLive) return; // Can't seek on a live stream
    const el = videoRef.current;
    if (!el) return;
    el.currentTime = Math.max(0, Math.min(el.duration || Infinity, el.currentTime + delta));
    resetControlsTimer();
  }, [resetControlsTimer, isLive]);

  const { flash: skipFlash, onTouchEnd: skipOnTouchEnd } = useSkipTap({
    onSkip: handleSkip,
    onSingleTap: resetControlsTimer,
    disabled: clipMode !== "idle" || isLive,
  });

  // Mount HLS — different config for VOD vs live.
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    if (isLive) {
      el.muted = true; // autoplay muted for live
    } else {
      el.muted = false;
    }

    function onPlay() { setIsPlaying(true); }
    function onPause() { setIsPlaying(false); }
    function onDurationChange() { if (!isLive && el) setDuration(el.duration || 0); }
    let prevTime = -1;
    function onTimeUpdate() {
      if (!el || seekDraggingRef.current) return;
      const now = el.currentTime;
      setCurrentTime(now);
      if (clipModeRef.current === "recording") {
        const relT = isLive ? (Date.now() - clipWallStartRef.current) / 1000 : now - clipStartRef.current;
        if (relT >= 0) setRecElapsed(relT);
        const jumpedBack = !isLive && prevTime >= 0 && now < prevTime - 0.3;
        const loopedPastStart = !isLive && now < clipStartRef.current - 0.5;
        if (jumpedBack || loopedPastStart) {
          stopRecordingRef.current(jumpedBack ? prevTime : undefined);
          prevTime = -1;
        } else {
          prevTime = now;
        }
      } else {
        prevTime = -1;
      }
    }
    function onEnded() {
      if (clipModeRef.current === "recording") stopRecordingRef.current(videoRef.current?.duration);
    }

    el.addEventListener("play", onPlay);
    el.addEventListener("pause", onPause);
    el.addEventListener("durationchange", onDurationChange);
    el.addEventListener("timeupdate", onTimeUpdate);
    el.addEventListener("ended", onEnded);

    if (Hls.isSupported()) {
      const hls = new Hls(isLive ? { enableWorker: false, liveSyncDurationCount: 3 } : { enableWorker: false });
      hlsRef.current = hls;
      hls.loadSource(playbackUrl);
      hls.attachMedia(el);
      hls.on(Hls.Events.MANIFEST_PARSED, () => el.play().catch(() => {}));
      hls.on(Hls.Events.ERROR, (_, data) => { if (data.fatal) el.dispatchEvent(new Event("error")); });
    } else if (el.canPlayType("application/vnd.apple.mpegurl")) {
      el.src = playbackUrl;
      el.addEventListener("canplay", () => el.play().catch(() => {}), { once: true });
    }

    return () => {
      hlsRef.current?.destroy();
      hlsRef.current = null;
      el.removeEventListener("play", onPlay);
      el.removeEventListener("pause", onPause);
      el.removeEventListener("durationchange", onDurationChange);
      el.removeEventListener("timeupdate", onTimeUpdate);
      el.removeEventListener("ended", onEnded);
    };
  }, [playbackUrl, isLive]);

  function onLoadedMetadata(e: React.SyntheticEvent<HTMLVideoElement>) {
    if (isLive) return; // live duration is Infinity
    const v = e.currentTarget;
    setDuration(v.duration || 0);
    if (!v.videoWidth || !v.videoHeight) return;
    const ar = v.videoWidth / v.videoHeight;
    if (!(ar > 0) || Math.abs(ar - srcAspectRef.current) < 1e-6) return;
    srcAspectRef.current = ar;
    setSrcAspect(ar);
    const centred = makeFrame((1 - (OUT_ASPECT[selectedRatioRef.current] / ar)) / 2, 0, frameZoomRef.current, ar, OUT_ASPECT[selectedRatioRef.current]);
    frameOriginRef.current = { x: centred.x, y: centred.y };
    setFrameOrigin({ x: centred.x, y: centred.y });
  }

  const togglePlay = () => {
    const el = videoRef.current;
    if (!el) return;
    el.paused ? el.play().catch(() => {}) : el.pause();
  };

  const seek = (delta: number) => {
    if (isLive) return;
    const el = videoRef.current;
    if (!el) return;
    el.currentTime = Math.max(0, Math.min(el.duration || Infinity, el.currentTime + delta));
  };

  const startRecording = () => {
    if (!user || isGuest) { setShowAuthPrompt(true); return; }
    if (clipModeRef.current === "recording") return;
    const el = videoRef.current;
    if (!el) return;

    el.play().catch(() => {});
    if (isLive) {
      clipStartRef.current = el.currentTime;
      clipWallStartRef.current = Date.now();
    } else {
      clipStartRef.current = el.currentTime;
    }
    clipModeRef.current = "recording";
    recordingRef.current.keyframes = [];
    setRecElapsed(0);

    const sampleFrame = () => {
      const { x, y, w, h } = computeCropRect();
      const relT = isLive ? (Date.now() - clipWallStartRef.current) / 1000 : (videoRef.current?.currentTime ?? 0) - clipStartRef.current;
      if (relT < 0) return;
      recordingRef.current.keyframes.push({ t: relT, x, y, w, h });
    };

    sampleFrame();
    recordingRef.current.interval = setInterval(sampleFrame, 150);
    elapsedRef.current = setInterval(() => {
      if (isLive) {
        setRecElapsed((Date.now() - clipWallStartRef.current) / 1000);
      } else {
        const v = videoRef.current;
        if (v) setRecElapsed(Math.max(0, v.currentTime - clipStartRef.current));
      }
    }, 100);

    setClipMode("recording");
  };

  const stopRecording = (overrideEndTime?: number) => {
    clipModeRef.current = "review";
    if (recordingRef.current.interval) { clearInterval(recordingRef.current.interval); recordingRef.current.interval = null; }
    if (elapsedRef.current) { clearInterval(elapsedRef.current); elapsedRef.current = null; }

    let endT: number;
    if (isLive) {
      endT = (Date.now() - clipWallStartRef.current) / 1000;
    } else {
      const el = videoRef.current;
      endT = overrideEndTime ?? el?.currentTime ?? clipStartRef.current;
    }

    recordingRef.current.keyframes.push({ t: Math.max(0, endT), x: computeCropRect().x, y: computeCropRect().y, w: computeCropRect().w, h: computeCropRect().h });

    videoRef.current?.pause();
    setClipEndTime(endT);
    setClipTitle(title);
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
    if (!user || isGuest) { setShowAuthPrompt(true); return; }

    let keyframes = recordingRef.current.keyframes.map((kf) => ({ ...kf }));
    if (keyframes.length === 0) {
      const { x, y, w, h } = computeCropRect();
      keyframes = [{ t: 0, x, y, w, h }, { t: 1, x, y, w, h }];
    } else if (keyframes.length === 1) {
      keyframes = [{ ...keyframes[0], t: 0 }, { ...keyframes[0], t: 1 }];
    }

    // Normalise keyframes to 0..1 of clip duration so the renderer is portable.
    const clipDuration = keyframes[keyframes.length - 1].t || 1;
    const normalised = keyframes.map((kf) => ({ ...kf, t: kf.t / clipDuration }));

    let startTime: number;
    let endTime: number;
    if (isLive) {
      startTime = 0;
      endTime = 1;
    } else {
      const totalDuration = videoRef.current?.duration || duration || 0;
      if (totalDuration <= 0) {
        toast({ title: t.clipping.error, description: "Wait for the video to load before saving.", variant: "destructive" });
        return;
      }
      startTime = Math.max(0, Math.min(1, clipStartRef.current / totalDuration));
      endTime = Math.max(0, Math.min(1, clipEndTime / totalDuration));
      if (endTime <= startTime) {
        toast({ title: t.clipping.error, description: "Clip range is invalid. Please try recording again.", variant: "destructive" });
        return;
      }
    }

    setIsSavingClip(true);
    try {
      await createUserClip.mutateAsync({
        data: {
          videoId,
          title: clipTitle.trim() || title,
          startTime,
          endTime,
          cropPath: normalised,
          visibility: "private",
          aspectRatio: selectedRatioRef.current,
        },
      });
      queryClient.invalidateQueries({ queryKey: getListUserClipsQueryKey() });
      toast({ title: t.clipping.saved, description: t.clipping.savedDesc, className: "bg-primary text-white border-none" });
      setClipMode("idle");
      setClipTitle("");
      applyFrameChange(1, "16:9");
      recordingRef.current.keyframes = [];
    } catch (err) {
      const message = err instanceof Error ? err.message : t.clipping.error;
      toast({ title: t.clipping.error, description: message, variant: "destructive" });
    } finally {
      setIsSavingClip(false);
    }
  };

  const clipSeconds = Math.max(0, clipEndTime - (isLive ? clipWallStartRef.current / 1000 : clipStartRef.current));

  return (
    <motion.div
      ref={containerRef}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 bg-black"
    >
      {/* Live indicator in top-left */}
      {isLive && (
        <div className="absolute top-safe top-3 start-3 z-30 flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-red-500/90 backdrop-blur-sm pointer-events-none">
          <span className="w-1.5 h-1.5 rounded-full bg-white animate-pulse" />
          <span className="text-white text-[10px] font-bold uppercase tracking-wider">Live</span>
        </div>
      )}

      <div className="absolute inset-0 flex items-center justify-center bg-black">
        <div
          ref={frameBoxRef}
          className={cn("relative overflow-hidden bg-black touch-none", clipMode === "recording" ? "ring-2 ring-red-500" : "ring-1 ring-white/25")}
          style={selectedRatio === "9:16" ? { height: "min(100%, calc(100vw * 16 / 9))", aspectRatio: "9/16" } : { width: "min(100%, calc(100dvh * 16 / 9))", aspectRatio: "16/9" }}
          onPointerDown={handleFramePointerDown}
          onPointerMove={(e) => {
            if (!dragRef.current.active) return;
            const box = frameBoxRef.current;
            if (!box) return;
            const bw = box.clientWidth, bh = box.clientHeight;
            if (!(bw > 0) || !(bh > 0)) return;
            const rawX = e.clientX - dragRef.current.startX;
            const rawY = e.clientY - dragRef.current.startY;
            if (!draggedRef.current && Math.hypot(rawX, rawY) > 8) draggedRef.current = true;
            const f = readFrame();
            setOrigin(dragRef.current.originX - (rawX / bw) * f.w, dragRef.current.originY - (rawY / bh) * f.h);
          }}
          onPointerUp={(e) => {
            if (dragRef.current.active) {
              try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* */ }
            }
            dragRef.current.active = false;
          }}
          onPointerCancel={(e) => {
            if (dragRef.current.active) {
              try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* */ }
            }
            dragRef.current.active = false;
          }}
          onTouchEnd={(e) => { if (draggedRef.current) return; if (!isLive) skipOnTouchEnd(e); }}
          onClick={() => { if (draggedRef.current) { draggedRef.current = false; return; } resetControlsTimer(); }}
        >
          <video ref={videoRef} className="pointer-events-none select-none" style={frameToVideoStyle(frame)} playsInline onLoadedMetadata={onLoadedMetadata} />
          <SkipFlash flash={skipFlash} />
        </div>
      </div>

      <AnimatePresence>
        {showControls && clipMode === "idle" && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="absolute inset-0 z-20 flex flex-col pointer-events-none">
            <div className="flex items-center justify-between px-4 pt-safe pt-4 pointer-events-auto">
              <button onClick={onClose} className="w-10 h-10 rounded-full bg-black/40 backdrop-blur-sm flex items-center justify-center">
                <X className="w-5 h-5 text-white" />
              </button>
              <div className="flex items-center gap-2">
                <button onClick={() => applyFrameChange(frameZoomRef.current, selectedRatio === "16:9" ? "9:16" : "16:9")} className="px-3 py-1.5 rounded-full bg-black/40 backdrop-blur-sm text-white text-xs font-bold">
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

            <div className="px-4 pb-safe pb-6 pointer-events-auto space-y-3">
              {duration > 0 && (
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
                    onChange={(e) => { const v = parseFloat(e.target.value); setCurrentTime(v); if (videoRef.current) videoRef.current.currentTime = v; }}
                    className="flex-1 accent-primary h-1"
                  />
                  <span className="text-white text-xs tabular-nums w-10">{formatDuration(duration)}</span>
                </div>
              )}

              <div className="flex justify-center">
                <FrameSizeSlider zoom={frameZoom} frame={frame} maxZoom={maxZoomFor(selectedRatio)} onChange={(z) => applyFrameChange(z, selectedRatioRef.current)} />
              </div>

              <div className="flex justify-center">
                <button onClick={startRecording} className="flex items-center gap-2 px-5 py-2.5 rounded-full bg-primary text-black font-bold text-sm">
                  <Circle className="w-4 h-4 fill-black" />
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
              <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-black/60 backdrop-blur-sm border border-red-500/40">
                <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                <span className="text-red-400 text-xs font-bold tabular-nums">{formatElapsed(recElapsed)}</span>
              </div>
              <MiniMap frame={frame} srcAspect={srcAspect} />
            </div>
            <div className="flex-1" />
            <div className="px-4 pb-safe pb-6 pointer-events-auto flex flex-col items-center gap-3">
              <FrameSizeSlider zoom={frameZoom} frame={frame} maxZoom={maxZoomFor(selectedRatio)} compact onChange={(z) => applyFrameChange(z, selectedRatioRef.current)} />
              <button onClick={() => stopRecording()} className="flex items-center gap-2 px-5 py-2.5 rounded-full bg-red-500 text-white font-bold text-sm">
                <Square className="w-4 h-4 fill-white" />
                {t.clipping.stopRecording}
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {clipMode === "review" && (
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="absolute bottom-0 left-0 right-0 z-20 bg-black/80 backdrop-blur-md px-4 pb-safe pb-6 pt-4 space-y-3">
            <p className="text-white text-sm font-semibold text-center">
              {t.clipping.reviewTitle} · {formatElapsed(clipSeconds)}
            </p>
            <input
              value={clipTitle}
              onChange={(e) => setClipTitle(e.target.value)}
              placeholder={t.clipping.titlePlaceholder}
              className="w-full bg-white/10 border border-white/20 rounded-xl px-3 py-2.5 text-white placeholder:text-white/40 text-sm outline-none focus:border-primary"
            />
            <div className="flex gap-2">
              <button onClick={discardClip} className="flex-1 py-2.5 rounded-xl border border-white/20 text-white text-sm font-medium">
                {t.clipping.discard}
              </button>
              <button onClick={saveClip} disabled={isSavingClip} className="flex-1 py-2.5 rounded-xl bg-primary text-black text-sm font-bold flex items-center justify-center gap-2 disabled:opacity-60">
                <CheckCircle2 className="w-4 h-4" />
                {isSavingClip ? t.clipping.saving : t.clipping.save}
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <Dialog open={showAuthPrompt} onOpenChange={setShowAuthPrompt}>
        <DialogContent className="bg-zinc-900 border-zinc-700 max-w-sm mx-4">
          <DialogTitle className="text-white">{t.myClips.signInTitle}</DialogTitle>
          <DialogDescription className="text-zinc-400">{t.myClips.signInDesc}</DialogDescription>
          <div className="flex gap-2 mt-2">
            <button onClick={() => setShowAuthPrompt(false)} className="flex-1 py-2.5 rounded-xl border border-zinc-700 text-zinc-300 text-sm">
              {t.clipping.discard}
            </button>
            <button onClick={() => { setShowAuthPrompt(false); setLocation("/login"); }} className="flex-1 py-2.5 rounded-xl bg-primary text-black text-sm font-bold">
              {t.clipping.signInCTA}
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </motion.div>
  );
}
