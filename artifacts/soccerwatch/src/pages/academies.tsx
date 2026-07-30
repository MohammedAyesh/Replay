import { useState, useRef, useEffect, useCallback } from "react";
import { Link, useLocation } from "wouter";
import { motion, AnimatePresence } from "framer-motion";
import { GraduationCap, MapPin, Calendar, ChevronRight, Search, Video,
  Play, Pause, X, SkipBack, SkipForward, Circle, Square, CheckCircle2, Minimize, Maximize } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListAcademies,
  useGetAcademyRecordings,
  getListAcademiesQueryKey,
  getGetAcademyRecordingsQueryKey,
  useCreateUserClip,
  getListUserClipsQueryKey,
  type BunnyVideo,
  type Recording,
} from "@workspace/api-client-react";
import { cn } from "@/lib/utils";
import { useTranslation } from "@/i18n";
import { useFullscreenVideo } from "@/lib/fullscreen-video";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import { useSkipTap } from "@/hooks/use-skip-tap";
import { SkipFlash } from "@/components/skip-flash";
import Hls from "hls.js";
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

const DAYS_SHORT: Record<string, string> = {
  monday: "Mon", tuesday: "Tue", wednesday: "Wed", thursday: "Thu", friday: "Fri", saturday: "Sat", sunday: "Sun",
};

function DayBadge({ day }: { day: string }) {
  return (
    <span className="px-1.5 py-0.5 rounded-md bg-primary/15 text-primary text-[10px] font-semibold uppercase tracking-wide">
      {DAYS_SHORT[day.toLowerCase()] ?? day}
    </span>
  );
}

const CAMERA_LABELS: Record<string, string> = {
  camera1: "Camera 1",
  camera2: "Camera 2",
};

function LiveRow({ cameraId, onOpen }: { cameraId: string; onOpen: () => void }) {
  return (
    <button
      onClick={onOpen}
      className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl bg-muted/50 hover:bg-muted transition-colors group"
    >
      <div className="w-9 h-9 rounded-lg bg-red-500/15 flex items-center justify-center flex-shrink-0">
        <Play className="w-4 h-4 text-red-500 fill-red-500" />
      </div>
      <div className="flex-1 text-start">
        <p className="text-sm font-semibold text-foreground">
          {CAMERA_LABELS[cameraId] ?? cameraId}
        </p>
        <div className="flex items-center gap-1.5 mt-0.5">
          <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
          <span className="text-[11px] font-medium text-red-500 uppercase tracking-wide">Live</span>
        </div>
      </div>
      <ChevronRight className="w-4 h-4 text-muted-foreground group-hover:text-foreground transition-colors rtl:hidden" />
      <ChevronRight className="w-4 h-4 text-muted-foreground group-hover:text-foreground transition-colors ltr:hidden rotate-180" />
    </button>
  );
}

function AcademyCard({ academy, index, isExpanded, onToggle, onOpenLive, onOpenRecording }: {
  academy: {
    id: number; name: string; fieldId: number; fieldName: string; fieldLocation: string;
    daysOfWeek: string[]; description?: string | null; logoUrl?: string | null;
    cameraIds?: string[] | null; recordingCount: number;
  };
  index: number; isExpanded: boolean; onToggle: () => void;
  onOpenLive: (cameraId: string, title: string, academyId: number) => void;
  onOpenRecording: (rec: Recording, academyId: number, academyName: string) => void;
}) {
  const { data: recordings, isLoading: recLoading } = useGetAcademyRecordings(
    academy.id,
    { query: { queryKey: getGetAcademyRecordingsQueryKey(academy.id), enabled: isExpanded, staleTime: 5 * 60 * 1000 } }
  );

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0, transition: { delay: index * 0.07, duration: 0.35, ease: "easeOut" } }}
      className="bg-card border border-border rounded-2xl overflow-hidden"
    >
      <button onClick={onToggle} className="w-full flex items-center gap-4 p-4 text-start hover:bg-muted/40 transition-colors">
        {academy.logoUrl ? (
          <img src={academy.logoUrl} alt={academy.name} className="w-12 h-12 rounded-xl object-cover flex-shrink-0" />
        ) : (
          <div className="w-12 h-12 rounded-xl bg-primary/15 flex items-center justify-center flex-shrink-0">
            <GraduationCap className="w-6 h-6 text-primary" />
          </div>
        )}
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-foreground truncate">{academy.name}</p>
          <div className="flex items-center gap-1 mt-0.5 text-muted-foreground text-xs">
            <MapPin className="w-3 h-3" />
            <span className="truncate">{academy.fieldName} · {academy.fieldLocation}</span>
          </div>
          <div className="flex items-center gap-1 mt-1.5 flex-wrap">
            {academy.daysOfWeek.slice(0, 4).map((d) => <DayBadge key={d} day={d} />)}
          </div>
        </div>
        <div className="text-end flex-shrink-0">
          <p className="text-lg font-bold text-foreground tabular-nums">{academy.recordingCount}</p>
          <p className="text-[10px] text-muted-foreground uppercase">videos</p>
          <motion.div animate={{ rotate: isExpanded ? 90 : 0 }} transition={{ duration: 0.2 }}
            className="rtl:hidden inline-block mt-1"
          >
            <ChevronRight className="w-4 h-4 text-muted-foreground" />
          </motion.div>
          <motion.div animate={{ rotate: isExpanded ? -90 : 0 }} transition={{ duration: 0.2 }}
            className="ltr:hidden inline-block mt-1"
          >
            <ChevronRight className="w-4 h-4 text-muted-foreground" />
          </motion.div>
        </div>
      </button>

      <AnimatePresence>
        {isExpanded && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.25 }} className="overflow-hidden"
          >
            <div className="border-t border-border px-4 py-3 space-y-3">
              {academy.cameraIds && academy.cameraIds.length > 0 && (
                <div>
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Live</p>
                  <div className="space-y-1.5">
                    {academy.cameraIds.map((cam) => (
                      <LiveRow
                        key={cam}
                        cameraId={cam}
                        onOpen={() => onOpenLive(cam, `${academy.name} · ${CAMERA_LABELS[cam] ?? cam}`, academy.id)}
                      />
                    ))}
                  </div>
                </div>
              )}
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Recordings</p>
              {recLoading ? (
                <div className="space-y-2">
                  {[1, 2].map((i) => <div key={i} className="h-12 bg-muted rounded-xl animate-pulse" />)}
                </div>
              ) : !recordings || recordings.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-4">No recordings yet</p>
              ) : (
                <div className="divide-y divide-border">
                  {recordings.map((rec) => (
                    <button
                      key={rec.id}
                      onClick={() => onOpenRecording(rec, academy.id, academy.name)}
                      className="w-full flex items-center gap-3 py-2.5 hover:bg-muted/40 transition-colors text-start"
                    >
                      <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0">
                        <Play className="w-4 h-4 text-primary" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-foreground truncate">{rec.date} · {rec.timeSlot}</p>
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <span>{rec.duration}</span>
                          {rec.score && <><span>·</span><span>{rec.score}</span></>}
                        </div>
                      </div>
                      <ChevronRight className="w-4 h-4 text-muted-foreground rtl:hidden flex-shrink-0" />
                      <ChevronRight className="w-4 h-4 text-muted-foreground ltr:hidden flex-shrink-0" />
                    </button>
                  ))}
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

export default function Academies() {
  const { data: academies, isLoading } = useListAcademies({
    query: { queryKey: getListAcademiesQueryKey(), staleTime: 5 * 60 * 1000 },
  });
  const [search, setSearch] = useState("");
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [liveFor, setLiveFor] = useState<{ cameraId: string; title: string; academyId: number } | null>(null);
  const [recordingFor, setRecordingFor] = useState<{ rec: Recording; academyId: number; title: string } | null>(null);

  const filtered = (academies ?? []).filter(
    (a) => a.name.toLowerCase().includes(search.toLowerCase()) ||
      a.fieldName.toLowerCase().includes(search.toLowerCase()) ||
      a.fieldLocation.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="flex-1 bg-background flex flex-col h-full overflow-hidden">
      <motion.div initial={{ opacity: 0, y: -12 }}
        animate={{ opacity: 1, y: 0, transition: { duration: 0.35, ease: "easeOut" as const } }}
        className="pt-safe px-4 py-6 bg-background sticky top-0 z-10"
      >
        <h1 className="text-2xl font-bold text-foreground">Academies</h1>
        <p className="text-muted-foreground text-sm mb-4">Live streams and recordings from partner academies</p>
        <div className="relative">
          <Search className="absolute start-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)}
            placeholder="Search academies…" className="ps-9 bg-muted border-transparent focus-visible:ring-primary rounded-xl h-12"
          />
        </div>
      </motion.div>

      <div className="flex-1 overflow-y-auto px-4 pb-24 space-y-3">
        {isLoading ? (
          <>{[1, 2, 3].map((i) => <div key={i} className="h-32 bg-muted rounded-2xl animate-pulse" />)}</>
        ) : filtered.length === 0 ? (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}
            className="text-center py-16 text-muted-foreground"
          >
            <GraduationCap className="w-12 h-12 mx-auto mb-3 opacity-30" />
            <p className="font-medium">{search ? "No academies found" : "No academies yet"}</p>
            {!search && <p className="text-sm mt-1 opacity-70">Academies will appear here once added by an admin.</p>}
          </motion.div>
        ) : (
          filtered.map((academy, i) => (
            <AcademyCard
              key={academy.id} academy={academy} index={i}
              isExpanded={expandedId === academy.id}
              onToggle={() => setExpandedId(expandedId === academy.id ? null : academy.id)}
              onOpenLive={(cameraId, title, academyId) => setLiveFor({ cameraId, title, academyId })}
              onOpenRecording={(rec, academyId, academyName) =>
                setRecordingFor({ rec, academyId, title: `${academyName} · ${rec.date} · ${rec.timeSlot}` })
              }
            />
          ))
        )}
      </div>

      <AnimatePresence>
        {liveFor && (
          <VideoPlayer
            video={{ guid: `live:${liveFor.cameraId}`, title: liveFor.title, playbackUrl: "/api/live/dummy" } as unknown as BunnyVideo}
            onClose={() => setLiveFor(null)}
            liveHlsUrl={`/api/live/${liveFor.cameraId}/index.m3u8`}
            liveCameraId={liveFor.cameraId}
            academyId={liveFor.academyId}
            isLive
          />
        )}
        {recordingFor && recordingFor.rec.videoUrl && (
          <VideoPlayer
            video={{
              guid: recordingFor.rec.videoUrl,
              title: recordingFor.title,
              playbackUrl: `/api/hls-proxy/manifest?url=${encodeURIComponent(recordingFor.rec.videoUrl)}`,
            } as unknown as BunnyVideo}
            onClose={() => setRecordingFor(null)}
            academyId={recordingFor.academyId}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

// ── Video Player (verbatim copy from field-detail.tsx + minor live tweaks) ───

/**
 * IMPORTANT: this is a verbatim copy of field-detail.tsx's VideoPlayer so the
 * academy Live view shows identical playback, cropping, recording and review
 * behaviour. Only these props were added:
 *   - liveHlsUrl?: string   (overrides video.playbackUrl)
 *   - liveCameraId?: string (synthetic videoId on save: `live:${...}`)
 *   - isLive?: boolean      (disables seek/skip-tap, no seek bar, live HLS config)
 * No other logic was rewritten — match field-detail exactly so the two views
 * behave identically.
 */

const MIN_FRAME_ZOOM = 0.4;
const MAX_FRAME_ZOOM = 4;

function formatDurationPlayer(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function maxZoomFor(ratio: AspectRatio): number {
  return ratio === "9:16" ? MAX_FRAME_ZOOM : 1;
}

function FrameSizeSlider({
  zoom, onChange, frame, maxZoom, compact,
}: {
  zoom: number; onChange: (z: number) => void;
  frame: { x: number; y: number; w: number; h: number };
  maxZoom: number; compact?: boolean;
}) {
  const coveredW = Math.max(0, Math.min(1, (Math.min(1, frame.x + frame.w) - Math.max(0, frame.x)) / frame.w));
  const coveredH = Math.max(0, Math.min(1, (Math.min(1, frame.y + frame.h) - Math.max(0, frame.y)) / frame.h));
  const blackPct = Math.round((1 - coveredW * coveredH) * 100);
  return (
    <div className={cn("pointer-events-auto rounded-2xl bg-black/60 backdrop-blur-sm px-3 py-2", compact ? "w-56" : "w-full max-w-sm")}
      onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between mb-1">
        <span className="text-[10px] uppercase tracking-wide text-white/60 font-semibold">Frame size</span>
        <span className="text-[10px] text-white/70 tabular-nums">
          {zoom.toFixed(2)}x{blackPct > 0 ? ` · ${blackPct}% black` : ""}
        </span>
      </div>
      <input type="range" min={MIN_FRAME_ZOOM} max={maxZoom} step={0.02} value={zoom}
        onChange={(e) => onChange(parseFloat(e.target.value))} className="w-full accent-primary" aria-label="Frame size"
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

function VideoPlayer({
  video, onClose, liveHlsUrl, liveCameraId, isLive = false, academyId,
}: {
  video: BunnyVideo; onClose: () => void;
  liveHlsUrl?: string; liveCameraId?: string; isLive?: boolean; academyId?: number;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const { setFullscreenVideo } = useFullscreenVideo();
  const { user, isGuest } = useAuth();
  const { toast } = useToast();
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const createUserClip = useCreateUserClip();
  const [, setLocation] = useLocation();

  const playbackUrl = liveHlsUrl ?? video.playbackUrl;

  const [isPlaying, setIsPlaying] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [qualityLevels, setQualityLevels] = useState<Array<{ height: number; index: number }>>([]);
  const [activeQuality, setActiveQuality] = useState<number>(-1); // -1 = Auto (ABR)
  const [showQualityPicker, setShowQualityPicker] = useState(false);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const seekDraggingRef = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isLandscape, setIsLandscape] = useState(typeof window !== "undefined" && window.innerWidth > window.innerHeight);
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

  /**
   * Crop frame model.
   *
   * zoom 1.0  = frame exactly fills the source height (tightest, no black).
   * zoom > 1  = frame is larger than the source -> black bars.
   */
  const [srcAspect, setSrcAspect] = useState(DEFAULT_SRC_ASPECT);
  const srcAspectRef = useRef(DEFAULT_SRC_ASPECT);
  const [frameZoom, setFrameZoom] = useState(1);
  const frameZoomRef = useRef(1);
  const [frameOrigin, setFrameOrigin] = useState({ x: 0.25, y: 0 });
  const frameOriginRef = useRef({ x: 0.25, y: 0 });
  const frameBoxRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ active: boolean; startX: number; startY: number; originX: number; originY: number }>({
    active: false, startX: 0, startY: 0, originX: 0, originY: 0,
  });
  const draggedRef = useRef(false);

  const clipModeRef = useRef<ClipMode>("idle");
  const stopRecordingRef = useRef<(overrideEndTime?: number) => void>(() => {});

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

  const clipStartRef = useRef(0);
  const recordingRef = useRef<{ interval: ReturnType<typeof setInterval> | null; keyframes: CropKeyframe[] }>({
    interval: null,
    keyframes: [],
  });
  const elapsedRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const handleFramePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    draggedRef.current = false;
    dragRef.current = {
      active: true,
      startX: e.clientX,
      startY: e.clientY,
      originX: frameOriginRef.current.x,
      originY: frameOriginRef.current.y,
    };
    resetControlsTimerRef.current();
  }, []);

  const handleFramePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current.active) return;
    const box = frameBoxRef.current;
    if (!box) return;
    const bw = box.clientWidth;
    const bh = box.clientHeight;
    if (!(bw > 0) || !(bh > 0)) return;
    const rawX = e.clientX - dragRef.current.startX;
    const rawY = e.clientY - dragRef.current.startY;
    if (!draggedRef.current && Math.hypot(rawX, rawY) > 8) draggedRef.current = true;
    const f = readFrame();
    setOrigin(dragRef.current.originX - (rawX / bw) * f.w, dragRef.current.originY - (rawY / bh) * f.h);
  }, [readFrame, setOrigin]);

  const handleFramePointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current.active) {
      try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* already released */ }
    }
    dragRef.current.active = false;
  }, []);

  const computeCropRect = useCallback((): { x: number; y: number; w: number; h: number } => {
    const f = readFrame();
    return { x: f.x, y: f.y, w: f.w, h: f.h };
  }, [readFrame]);

  useEffect(() => {
    setFullscreenVideo(true);
    return () => setFullscreenVideo(false);
  }, [setFullscreenVideo]);

  useEffect(() => {
    const update = () => setIsLandscape(window.innerWidth > window.innerHeight);
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
    if (isLive) return;
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

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    el.muted = isLive; // muted required for autoplay on live streams

    function onPlay() { setIsPlaying(true); }
    function onPause() { setIsPlaying(false); }
    function onDurationChange() { if (!isLive && el) setDuration(el.duration || 0); }
    let prevTime = -1;
    function onTimeUpdate() {
      if (!el || seekDraggingRef.current) return;
      const now = el.currentTime;
      setCurrentTime(now);
      if (clipModeRef.current === "recording") {
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

    setQualityLevels([]);
    setActiveQuality(-1);
    setShowQualityPicker(false);

    if (Hls.isSupported()) {
      const hls = new Hls(isLive ? { enableWorker: false, liveSyncDurationCount: 3 } : { enableWorker: false });
      hlsRef.current = hls;
      hls.loadSource(playbackUrl);
      hls.attachMedia(el);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        el.play().catch(() => {});
        const lvls = hls.levels
          .map((l, i) => ({ height: l.height, index: i }))
          .sort((a, b) => b.height - a.height);
        setQualityLevels(lvls);
        setActiveQuality(-1);
      });
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
    if (isLive) return;
    const v = e.currentTarget;
    setDuration(v.duration || 0);
    if (!v.videoWidth || !v.videoHeight) return;
    const ar = v.videoWidth / v.videoHeight;
    if (!(ar > 0) || Math.abs(ar - srcAspectRef.current) < 1e-6) return;
    srcAspectRef.current = ar;
    setSrcAspect(ar);
    const f = makeFrame(0, 0, frameZoomRef.current, ar, OUT_ASPECT[selectedRatioRef.current]);
    const centred = makeFrame((1 - f.w) / 2, (1 - f.h) / 2, frameZoomRef.current, ar, OUT_ASPECT[selectedRatioRef.current]);
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
    clipStartRef.current = el.currentTime;
    clipModeRef.current = "recording";
    recordingRef.current.keyframes = [];
    setRecElapsed(0);

    const sampleFrame = () => {
      const videoEl = videoRef.current;
      if (!videoEl) return;
      const relT = videoEl.currentTime - clipStartRef.current;
      if (relT < 0) return;
      const { x, y, w, h } = computeCropRect();
      recordingRef.current.keyframes.push({ t: relT, x, y, w, h });
    };

    sampleFrame();
    recordingRef.current.interval = setInterval(sampleFrame, 150);
    elapsedRef.current = setInterval(() => {
      const videoEl = videoRef.current;
      if (videoEl) setRecElapsed(Math.max(0, videoEl.currentTime - clipStartRef.current));
    }, 100);

    setClipMode("recording");
  };

  const stopRecording = (overrideEndTime?: number) => {
    clipModeRef.current = "review";
    if (recordingRef.current.interval) { clearInterval(recordingRef.current.interval); recordingRef.current.interval = null; }
    if (elapsedRef.current) { clearInterval(elapsedRef.current); elapsedRef.current = null; }

    const el = videoRef.current;
    const endT = overrideEndTime ?? el?.currentTime ?? clipStartRef.current;

    if (el) {
      const { x, y, w, h } = computeCropRect();
      recordingRef.current.keyframes.push({ t: Math.max(0, endT - clipStartRef.current), x, y, w, h });
    }

    el?.pause();
    setClipEndTime(endT);
    setClipTitle(isLive ? `${liveCameraId} clip` : video.title);
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
    const clipDuration = Math.max(0.1, keyframes[keyframes.length - 1].t);
    keyframes = keyframes.map((kf) => ({ ...kf, t: Math.max(0, Math.min(1, kf.t / clipDuration)) }));

    const savedVideoId = isLive ? `live:${liveCameraId}` : video.guid;
    const savedTitle = clipTitle.trim() || (isLive ? `${liveCameraId} clip` : video.title);

    let startTime: number, endTime: number;
    if (isLive) {
      startTime = 0;
      endTime = 1;
    } else {
      const el = videoRef.current;
      const totalDuration = el?.duration || duration || 0;
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
          videoId: savedVideoId,
          title: savedTitle,
          startTime,
          endTime,
          cropPath: keyframes,
          visibility: "private",
          aspectRatio: selectedRatioRef.current,
          academyId,
        },
      });
      queryClient.invalidateQueries({ queryKey: getListUserClipsQueryKey() });
      toast({
        title: t.clipping.saved,
        description: isLive
          ? "Live clip saved. It will be available to play once the recording is uploaded."
          : t.clipping.savedDesc,
        className: "bg-primary text-white border-none",
      });
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

  const clipSeconds = Math.max(0, clipEndTime - clipStartRef.current);

  return (
    <motion.div
      ref={containerRef}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 bg-black"
    >
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
          onPointerMove={handleFramePointerMove}
          onPointerUp={handleFramePointerUp}
          onPointerCancel={handleFramePointerUp}
          onTouchEnd={(e) => {
            if (draggedRef.current) return;
            if (!isLive) skipOnTouchEnd(e);
          }}
          onClick={() => {
            if (draggedRef.current) { draggedRef.current = false; return; }
            resetControlsTimer();
          }}
        >
          <video ref={videoRef} className="pointer-events-none select-none" style={frameToVideoStyle(frame)} playsInline onLoadedMetadata={onLoadedMetadata} />
          <SkipFlash flash={skipFlash} />
        </div>
      </div>

      {/* Quality picker — always visible once manifest is parsed, not auto-hidden */}
      {qualityLevels.length > 1 && (
        <div className="absolute top-safe top-3 end-3 z-30 pointer-events-auto">
          <div className="relative">
            <button
              onClick={() => setShowQualityPicker((p) => !p)}
              className="px-3 py-1.5 rounded-full bg-black/60 backdrop-blur-sm text-white text-xs font-bold border border-white/20"
            >
              {activeQuality === -1
                ? "Auto"
                : (() => { const l = qualityLevels.find((q) => q.index === activeQuality); return l ? (l.height >= 2160 ? "4K" : `${l.height}p`) : "Auto"; })()}
            </button>
            {showQualityPicker && (
              <div className="absolute top-full end-0 mt-1 bg-black/85 backdrop-blur-md rounded-xl overflow-hidden shadow-xl border border-white/10 min-w-[5rem]">
                {[{ height: 0, index: -1 }, ...qualityLevels].map(({ height, index }) => {
                  const label = index === -1 ? "Auto" : height >= 2160 ? "4K" : `${height}p`;
                  const isActive = activeQuality === index;
                  return (
                    <button
                      key={index}
                      onClick={() => {
                        if (hlsRef.current) hlsRef.current.currentLevel = index;
                        setActiveQuality(index);
                        setShowQualityPicker(false);
                      }}
                      className={cn(
                        "block w-full px-4 py-2.5 text-xs font-semibold text-left transition-colors",
                        isActive ? "text-primary" : "text-white hover:bg-white/10",
                      )}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

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
              {!isLive && duration > 0 && (
                <div className="flex items-center gap-2">
                  <span className="text-white text-xs tabular-nums w-10 text-end">{formatDurationPlayer(currentTime)}</span>
                  <input type="range" min={0} max={duration} step={0.1} value={currentTime}
                    onMouseDown={() => { seekDraggingRef.current = true; }}
                    onTouchStart={() => { seekDraggingRef.current = true; }}
                    onMouseUp={() => { seekDraggingRef.current = false; }}
                    onTouchEnd={() => { seekDraggingRef.current = false; }}
                    onChange={(e) => { const v = parseFloat(e.target.value); setCurrentTime(v); if (videoRef.current) videoRef.current.currentTime = v; }}
                    className="flex-1 accent-primary h-1"
                  />
                  <span className="text-white text-xs tabular-nums w-10">{formatDurationPlayer(duration)}</span>
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
              {t.clipping.reviewTitle} · {formatDurationPlayer(clipSeconds)}
            </p>
            <input value={clipTitle} onChange={(e) => setClipTitle(e.target.value)} placeholder={t.clipping.titlePlaceholder}
              className="w-full bg-white/10 border border-white/20 rounded-xl px-3 py-2.5 text-white placeholder:text-white/40 text-sm outline-none focus:border-primary"
            />
            <div className="flex gap-2">
              <button onClick={discardClip} className="flex-1 py-2.5 rounded-xl border border-white/20 text-white text-sm font-medium">{t.clipping.discard}</button>
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
            <button onClick={() => setShowAuthPrompt(false)} className="flex-1 py-2.5 rounded-xl border border-zinc-700 text-zinc-300 text-sm">{t.clipping.discard}</button>
            <button onClick={() => { setShowAuthPrompt(false); setLocation("/sign-in"); }} className="flex-1 py-2.5 rounded-xl bg-primary text-black text-sm font-bold">{t.clipping.signInCTA}</button>
          </div>
        </DialogContent>
      </Dialog>
    </motion.div>
  );
}
