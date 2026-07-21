import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { usePinchZoom } from "@/hooks/use-pinch-zoom";
import { useSkipTap } from "@/hooks/use-skip-tap";
import { SkipFlash } from "@/components/skip-flash";
import { Link, useRoute, useLocation } from "wouter";
import {
  useGetBunnyCollections,
  useGetBunnyCollectionVideos,
  useCreateUserClip,
  getListUserClipsQueryKey,
  getGetBunnyCollectionsQueryKey,
  BunnyVideo,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Play, Pause, X, SkipBack, SkipForward, Circle, Square, CheckCircle2, Maximize, Minimize, Video, Clock, ZoomIn, ZoomOut } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { useTranslation } from "@/i18n";
import { useFullscreenVideo } from "@/lib/fullscreen-video";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import Hls from "hls.js";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

type CropKeyframe = { t: number; x: number; y: number; w: number; h: number };
type ClipMode = "idle" | "recording" | "review";
type AspectRatio = "16:9" | "9:16";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const DAY_LABELS = ["S", "M", "T", "W", "T", "F", "S"];

interface VideoMeta {
  isoDate: string;   // "2026-07-19"
  startSeconds: number;
}

// Parse "jordangalaxy_19072026_150000.mp4" → { isoDate, startSeconds }
function parseVideoFilename(title: string): VideoMeta | null {
  const name = title.replace(/\.mp4$/i, "");
  const parts = name.split("_");
  if (parts.length < 3) return null;

  const datePart = parts[parts.length - 2]; // "19072026" DDMMYYYY
  const timePart = parts[parts.length - 1]; // "150000"   HHMMSS

  if (!/^\d{8}$/.test(datePart) || !/^\d{6}$/.test(timePart)) return null;

  const day   = datePart.slice(0, 2);
  const month = datePart.slice(2, 4);
  const year  = datePart.slice(4, 8);
  const hh = parseInt(timePart.slice(0, 2), 10);
  const mm = parseInt(timePart.slice(2, 4), 10);
  const ss = parseInt(timePart.slice(4, 6), 10);

  return {
    isoDate: `${year}-${month}-${day}`,
    startSeconds: hh * 3600 + mm * 60 + ss,
  };
}

function formatClock(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600) % 24;
  const m = Math.floor((totalSeconds % 3600) / 60);
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 || 12;
  return `${h12}:${m.toString().padStart(2, "0")} ${ampm}`;
}

function formatDuration(seconds: number): string {
  if (!seconds) return "";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function formatShortDate(isoDate: string): string {
  const [y, m, d] = isoDate.split("-");
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${parseInt(d)} ${months[parseInt(m) - 1]} ${y}`;
}

// ── Calendar ──────────────────────────────────────────────────────────────────

function MiniCalendar({
  year,
  month,
  markedDates,
  selectedDate,
  onSelect,
  onPrev,
  onNext,
}: {
  year: number;
  month: number;
  markedDates: Set<string>;
  selectedDate: string | null;
  onSelect: (isoDate: string) => void;
  onPrev: () => void;
  onNext: () => void;
}) {
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const cells: (number | null)[] = [];
  for (let i = 0; i < firstDay; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);

  return (
    <div className="px-4 pt-3 pb-2">
      <div className="flex items-center justify-between mb-3">
        <button
          onClick={onPrev}
          className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-muted transition-colors text-muted-foreground"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
        <span className="text-sm font-semibold text-foreground">
          {MONTH_NAMES[month]} {year}
        </span>
        <button
          onClick={onNext}
          className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-muted transition-colors text-muted-foreground"
        >
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>

      <div className="grid grid-cols-7 mb-1">
        {DAY_LABELS.map((d, i) => (
          <div key={i} className="h-8 flex items-center justify-center text-[10px] font-semibold text-muted-foreground uppercase">
            {d}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-7">
        {cells.map((day, i) => {
          if (!day) return <div key={i} className="h-10" />;
          const isoDate = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
          const hasRec = markedDates.has(isoDate);
          const isSelected = selectedDate === isoDate;

          return (
            <button
              key={i}
              onClick={() => hasRec && onSelect(isoDate)}
              disabled={!hasRec}
              className={cn(
                "relative h-10 w-full flex flex-col items-center justify-center rounded-full text-sm font-medium transition-colors",
                isSelected
                  ? "bg-primary text-black font-bold"
                  : hasRec
                  ? "text-foreground hover:bg-primary/15"
                  : "text-muted-foreground/30 cursor-default"
              )}
            >
              {day}
              {hasRec && !isSelected && (
                <span className="absolute bottom-1 w-1 h-1 rounded-full bg-primary" />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── Recording row ─────────────────────────────────────────────────────────────

function RecordingRow({
  video,
  meta,
  index,
  onPlay,
}: {
  video: BunnyVideo;
  meta: VideoMeta;
  index: number;
  onPlay: () => void;
}) {
  const durationSecs = video.duration ?? 0;
  const endSeconds = meta.startSeconds + durationSecs;

  return (
    <motion.button
      initial={{ opacity: 0, x: -12 }}
      animate={{ opacity: 1, x: 0, transition: { delay: index * 0.06, duration: 0.25, ease: "easeOut" } }}
      whileTap={{ scale: 0.97 }}
      onClick={onPlay}
      className="w-full flex items-center gap-3 px-4 py-3.5 hover:bg-muted/40 active:bg-muted/60 transition-colors text-start"
    >
      <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center flex-shrink-0">
        <Video className="w-4 h-4 text-primary" />
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-foreground tabular-nums">
            {formatClock(meta.startSeconds)}
          </span>
          <span className="text-muted-foreground text-xs">→</span>
          <span className="text-sm font-semibold text-foreground tabular-nums">
            {formatClock(endSeconds)}
          </span>
        </div>
        {durationSecs > 0 && (
          <div className="flex items-center gap-1 mt-0.5">
            <Clock className="w-3 h-3 text-muted-foreground" />
            <span className="text-xs text-muted-foreground">{formatDuration(durationSecs)}</span>
          </div>
        )}
      </div>

      <ChevronRight className="w-4 h-4 text-muted-foreground flex-shrink-0 rtl:hidden" />
      <ChevronLeft className="w-4 h-4 text-muted-foreground flex-shrink-0 ltr:hidden" />
    </motion.button>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function FieldDetail() {
  const [, params] = useRoute("/fields/:id");
  const guid = params?.id ?? "";
  const { t } = useTranslation();

  const { data: collections } = useGetBunnyCollections({
    query: {
      queryKey: getGetBunnyCollectionsQueryKey(),
      staleTime: 5 * 60 * 1000,
      gcTime: 5 * 60 * 1000,
    },
  });
  const collection = collections?.find((c) => c.guid === guid);
  const { data: videos, isLoading: videosLoading } = useGetBunnyCollectionVideos(guid);
  const [activeVideo, setActiveVideo] = useState<BunnyVideo | null>(null);

  // Group videos by ISO date
  const videosByDate = useMemo(() => {
    const map = new Map<string, { video: BunnyVideo; meta: VideoMeta }[]>();
    for (const video of videos ?? []) {
      const meta = parseVideoFilename(video.title);
      if (!meta) continue;
      const arr = map.get(meta.isoDate) ?? [];
      arr.push({ video, meta });
      map.set(meta.isoDate, arr);
    }
    for (const arr of map.values()) {
      arr.sort((a, b) => a.meta.startSeconds - b.meta.startSeconds);
    }
    return map;
  }, [videos]);

  const markedDates = useMemo(() => new Set(videosByDate.keys()), [videosByDate]);

  const today = new Date();
  const [calYear, setCalYear] = useState(today.getFullYear());
  const [calMonth, setCalMonth] = useState(today.getMonth());
  const [selectedDate, setSelectedDate] = useState<string | null>(null);

  // Auto-select the most recent recording date when videos load
  useEffect(() => {
    if (!videos?.length) return;
    const dates = [...videosByDate.keys()].sort();
    const mostRecent = dates[dates.length - 1];
    if (mostRecent) {
      const d = new Date(mostRecent + "T00:00:00");
      setCalYear(d.getFullYear());
      setCalMonth(d.getMonth());
      setSelectedDate(mostRecent);
    }
  }, [videos, videosByDate]);

  const prevMonth = () => {
    if (calMonth === 0) { setCalYear(y => y - 1); setCalMonth(11); }
    else setCalMonth(m => m - 1);
  };
  const nextMonth = () => {
    if (calMonth === 11) { setCalYear(y => y + 1); setCalMonth(0); }
    else setCalMonth(m => m + 1);
  };

  const selectedVideos = selectedDate ? (videosByDate.get(selectedDate) ?? []) : [];

  return (
    <div className="flex-1 bg-background flex flex-col h-full overflow-hidden">
      <motion.header
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0, transition: { duration: 0.3, ease: "easeOut" as const } }}
        className="pt-safe px-4 py-4 bg-background sticky top-0 z-10 flex items-center gap-3"
      >
        <Link href="/fields" className="w-10 h-10 flex items-center justify-center -ms-2 rounded-full hover:bg-muted text-foreground">
          <ChevronLeft className="w-6 h-6 rtl:hidden" />
          <ChevronRight className="w-6 h-6 ltr:hidden" />
        </Link>
        <div className="flex-1 min-w-0">
          <h1 className="font-bold text-foreground text-base leading-tight truncate">
            {collection?.name ?? "Field"}
          </h1>
          {!videosLoading && (
            <p className="text-xs text-muted-foreground">
              {markedDates.size} {markedDates.size === 1 ? "recording day" : "recording days"}
            </p>
          )}
        </div>
      </motion.header>

      {/* Field hero image */}
      <motion.div
        initial={{ opacity: 0, scale: 1.04 }}
        animate={{ opacity: 1, scale: 1, transition: { duration: 0.5, ease: "easeOut" as const } }}
        className="relative h-36 overflow-hidden shrink-0"
      >
        {collection?.previewImageUrl ? (
          <img src={collection.previewImageUrl} alt={collection.name}
            className="absolute inset-0 w-full h-full object-cover"
            onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
          />
        ) : (
          <div className="absolute inset-0 field-pattern" />
        )}
        <div className="absolute inset-0 bg-gradient-to-b from-black/10 via-black/30 to-black/70" />
      </motion.div>

      <div className="flex-1 overflow-y-auto pb-24">
        {videosLoading ? (
          <div className="p-4 space-y-3">
            <div className="h-52 bg-muted rounded-2xl animate-pulse" />
            <div className="h-16 bg-muted rounded-xl animate-pulse" />
            <div className="h-16 bg-muted rounded-xl animate-pulse" />
          </div>
        ) : !videos || videos.length === 0 || markedDates.size === 0 ? (
          <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0, transition: { delay: 0.1 } }}
            className="flex flex-col items-center justify-center py-20 px-6 text-center">
            <div className="w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center mb-4">
              <Play className="w-6 h-6 text-primary" />
            </div>
            <h3 className="font-semibold text-foreground mb-1">{t.fieldDetail.noRecordingsTitle}</h3>
            <p className="text-sm text-muted-foreground">{t.fieldDetail.noRecordingsDesc}</p>
          </motion.div>
        ) : (
          <>
            {/* Calendar */}
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0, transition: { duration: 0.3 } }}
              className="bg-card border-b border-border"
            >
              <MiniCalendar
                year={calYear}
                month={calMonth}
                markedDates={markedDates}
                selectedDate={selectedDate}
                onSelect={setSelectedDate}
                onPrev={prevMonth}
                onNext={nextMonth}
              />
            </motion.div>

            {/* Date label + recordings */}
            <AnimatePresence mode="wait">
              {selectedDate && selectedVideos.length > 0 ? (
                <motion.div
                  key={selectedDate}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0, transition: { duration: 0.25 } }}
                  exit={{ opacity: 0, transition: { duration: 0.15 } }}
                >
                  <div className="px-4 pt-4 pb-2">
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                      {formatShortDate(selectedDate)}
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {selectedVideos.length} {selectedVideos.length === 1 ? "recording" : "recordings"}
                    </p>
                  </div>

                  <div className="divide-y divide-border">
                    {selectedVideos.map(({ video, meta }, i) => (
                      <RecordingRow
                        key={video.guid}
                        video={video}
                        meta={meta}
                        index={i}
                        onPlay={() => setActiveVideo(video)}
                      />
                    ))}
                  </div>
                </motion.div>
              ) : selectedDate ? (
                <motion.div
                  key="empty"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="text-center py-10 text-muted-foreground text-sm"
                >
                  No recordings on this date.
                </motion.div>
              ) : (
                <motion.div
                  key="pick"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="text-center py-10 text-muted-foreground text-sm"
                >
                  Tap a highlighted date to see recordings.
                </motion.div>
              )}
            </AnimatePresence>
          </>
        )}
      </div>

      <AnimatePresence>
        {activeVideo && <VideoPlayer video={activeVideo} onClose={() => setActiveVideo(null)} />}
      </AnimatePresence>
    </div>
  );
}

// ── Video Player (unchanged) ──────────────────────────────────────────────────

function VideoPlayer({ video, onClose }: { video: BunnyVideo; onClose: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const { setFullscreenVideo } = useFullscreenVideo();
  const { user, isGuest } = useAuth();
  const { toast } = useToast();
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const createUserClip = useCreateUserClip();
  const [, setLocation] = useLocation();

  const [isPlaying, setIsPlaying] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const seekDraggingRef = useRef(false);
  const zoomRef = useRef<HTMLDivElement>(null);
  const { isZoomed } = usePinchZoom(zoomRef);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isLandscape, setIsLandscape] = useState(
    typeof window !== "undefined" && window.innerWidth > window.innerHeight
  );
  const [showControls, setShowControls] = useState(true);
  const controlsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const resetControlsTimer = useCallback(() => {
    setShowControls(true);
    if (controlsTimerRef.current) clearTimeout(controlsTimerRef.current);
    controlsTimerRef.current = setTimeout(() => setShowControls(false), 4000);
  }, []);
  const [clipMode, setClipMode] = useState<ClipMode>("idle");
  const [clipEndTime, setClipEndTime] = useState(0);
  const [clipTitle, setClipTitle] = useState("");
  const [isSavingClip, setIsSavingClip] = useState(false);
  const [recElapsed, setRecElapsed] = useState(0);
  const [showAuthPrompt, setShowAuthPrompt] = useState(false);
  const [selectedRatio, setSelectedRatio] = useState<AspectRatio>("16:9");
  const selectedRatioRef = useRef<AspectRatio>("16:9");
  const [cropZoom, setCropZoom] = useState(0.8);
  const cropZoomRef = useRef(0.8);
  const [scrollOffset, setScrollOffset] = useState(0);
  const clipModeRef = useRef<ClipMode>("idle");
  const stopRecordingRef = useRef<(overrideEndTime?: number) => void>(() => {});

  useEffect(() => {
    const scrollEl = scrollRef.current;
    if (!scrollEl) return;
    const onScroll = () => setScrollOffset(scrollEl.scrollLeft);
    scrollEl.addEventListener("scroll", onScroll, { passive: true });
    return () => scrollEl.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => { clipModeRef.current = clipMode; }, [clipMode]);

  const clipStartRef = useRef(0);
  const recordingRef = useRef<{ interval: ReturnType<typeof setInterval> | null; keyframes: CropKeyframe[] }>({
    interval: null,
    keyframes: [],
  });
  const elapsedRef = useRef<ReturnType<typeof setInterval> | null>(null);

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
    const el = videoRef.current;
    if (!el) return;
    el.currentTime = Math.max(0, Math.min(el.duration || Infinity, el.currentTime + delta));
    resetControlsTimer();
  }, [resetControlsTimer]);

  const { flash: skipFlash, onTouchEnd: skipOnTouchEnd } = useSkipTap({
    onSkip: handleSkip,
    onSingleTap: resetControlsTimer,
    disabled: isZoomed || clipMode !== "idle",
  });

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    el.muted = false;

    function onPlay() { setIsPlaying(true); }
    function onPause() { setIsPlaying(false); }
    function onDurationChange() { if (el) setDuration(el.duration || 0); }
    let prevTime = -1;
    function onTimeUpdate() {
      if (!el || seekDraggingRef.current) return;
      const now = el.currentTime;
      setCurrentTime(now);
      if (clipModeRef.current === "recording") {
        const jumpedBack = prevTime >= 0 && now < prevTime - 0.3;
        const loopedPastStart = now < clipStartRef.current - 0.5;
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
      if (clipModeRef.current === "recording") {
        stopRecordingRef.current(videoRef.current?.duration);
      }
    }

    el.addEventListener("play", onPlay);
    el.addEventListener("pause", onPause);
    el.addEventListener("durationchange", onDurationChange);
    el.addEventListener("timeupdate", onTimeUpdate);
    el.addEventListener("ended", onEnded);

    if (Hls.isSupported()) {
      const hls = new Hls({ enableWorker: false });
      hlsRef.current = hls;
      hls.loadSource(video.playbackUrl);
      hls.attachMedia(el);
      hls.on(Hls.Events.MANIFEST_PARSED, () => el.play().catch(() => {}));
      hls.on(Hls.Events.ERROR, (_, data) => { if (data.fatal) el.dispatchEvent(new Event("error")); });
    } else if (el.canPlayType("application/vnd.apple.mpegurl")) {
      el.src = video.playbackUrl;
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
  }, [video.playbackUrl]);

  function onLoadedMetadata(e: React.SyntheticEvent<HTMLVideoElement>) {
    const v = e.currentTarget;
    const scrollEl = scrollRef.current;
    if (!scrollEl || !v.videoWidth || !v.videoHeight) return;
    const containerH = scrollEl.clientHeight;
    const ar = v.videoWidth / v.videoHeight;
    const w = Math.round(containerH * ar);
    scrollEl.dataset.videoWidth = String(w);
    setDuration(v.duration || 0);
    requestAnimationFrame(() => {
      const maxScroll = scrollEl.scrollWidth - scrollEl.clientWidth;
      scrollEl.scrollLeft = maxScroll / 2;
    });
  }

  useEffect(() => {
    const scrollEl = scrollRef.current;
    if (!scrollEl) return;
    const timer = setTimeout(() => {
      const maxScroll = scrollEl.scrollWidth - scrollEl.clientWidth;
      scrollEl.scrollLeft = maxScroll / 2;
    }, 200);
    return () => clearTimeout(timer);
  }, []);

  // Re-center scroll when zoom changes so the view stays on the middle of the field
  useEffect(() => {
    const scrollEl = scrollRef.current;
    if (!scrollEl) return;
    const timer = setTimeout(() => {
      const maxScroll = scrollEl.scrollWidth - scrollEl.clientWidth;
      const currentFrac = maxScroll > 0 ? scrollEl.scrollLeft / maxScroll : 0.5;
      scrollEl.scrollLeft = currentFrac * (scrollEl.scrollWidth - scrollEl.clientWidth);
    }, 50);
    return () => clearTimeout(timer);
  }, [cropZoom]);

  const togglePlay = () => {
    const el = videoRef.current;
    if (!el) return;
    el.paused ? el.play().catch(() => {}) : el.pause();
  };

  const seek = (delta: number) => {
    const el = videoRef.current;
    if (!el) return;
    el.currentTime = Math.max(0, Math.min(el.duration || Infinity, el.currentTime + delta));
  };

  const startRecording = () => {
    if (!user || isGuest) {
      setShowAuthPrompt(true);
      return;
    }
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
      const scrollEl = scrollRef.current;
      if (!videoEl || !scrollEl) return;
      const totalW = scrollEl.scrollWidth;
      const containerW = scrollEl.clientWidth;
      const containerH = scrollEl.clientHeight;
      const relT = videoEl.currentTime - clipStartRef.current;
      if (relT < 0) return;

      let x: number, w: number;
      if (selectedRatioRef.current === "9:16") {
        const cropPxW = containerH * 9 / 16;
        const maxScroll = Math.max(0, totalW - containerW);
        const cropLeft = maxScroll > 0
          ? (scrollEl.scrollLeft / maxScroll) * (containerW - cropPxW)
          : (containerW - cropPxW) / 2;
        x = totalW > 0 ? (scrollEl.scrollLeft + cropLeft) / totalW : 0;
        w = totalW > 0 ? cropPxW / totalW : 81 / 256;
      } else {
        x = totalW > 0 ? scrollEl.scrollLeft / totalW : 0;
        w = totalW > 0 ? containerW / totalW : 1;
      }

      recordingRef.current.keyframes.push({ t: relT, x, y: 0, w, h: 1 });
    };

    sampleFrame();
    recordingRef.current.interval = setInterval(sampleFrame, 150);

    elapsedRef.current = setInterval(() => {
      const videoEl = videoRef.current;
      if (videoEl) setRecElapsed(videoEl.currentTime - clipStartRef.current);
    }, 100);

    setClipMode("recording");
  };

  const stopRecording = (overrideEndTime?: number) => {
    clipModeRef.current = "review";
    if (recordingRef.current.interval) {
      clearInterval(recordingRef.current.interval);
      recordingRef.current.interval = null;
    }
    if (elapsedRef.current) {
      clearInterval(elapsedRef.current);
      elapsedRef.current = null;
    }

    const el = videoRef.current;
    const scrollEl = scrollRef.current;
    const endT = overrideEndTime ?? el?.currentTime ?? clipStartRef.current;

    if (el && scrollEl) {
      const totalW = scrollEl.scrollWidth;
      const containerW = scrollEl.clientWidth;
      const containerH = scrollEl.clientHeight;
      let x: number, w: number;
      if (selectedRatioRef.current === "9:16") {
        const cropPxW = containerH * 9 / 16;
        const maxScroll = Math.max(0, totalW - containerW);
        const cropLeft = maxScroll > 0
          ? (scrollEl.scrollLeft / maxScroll) * (containerW - cropPxW)
          : (containerW - cropPxW) / 2;
        x = totalW > 0 ? (scrollEl.scrollLeft + cropLeft) / totalW : 0;
        w = totalW > 0 ? cropPxW / totalW : 81 / 256;
      } else {
        x = totalW > 0 ? scrollEl.scrollLeft / totalW : 0;
        w = totalW > 0 ? containerW / totalW : 1;
      }
      recordingRef.current.keyframes.push({ t: Math.max(0, endT - clipStartRef.current), x, y: 0, w, h: 1 });
    }

    el?.pause();
    setClipEndTime(endT);
    setClipTitle(video.title);
    setClipMode("review");
  };
  stopRecordingRef.current = stopRecording;

  const discardClip = () => {
    clipModeRef.current = "idle";
    recordingRef.current.keyframes = [];
    setClipMode("idle");
    setClipTitle("");
    setRecElapsed(0);
    setSelectedRatio("16:9");
    selectedRatioRef.current = "16:9";
    setCropZoom(0.8);
    cropZoomRef.current = 0.8;
  };

  const saveClip = async () => {
    if (!user || isGuest) {
      setShowAuthPrompt(true);
      return;
    }
    const el = videoRef.current;
    const totalDuration = el?.duration || duration || 0;
    if (totalDuration <= 0) {
      toast({ title: t.clipping.error, description: "Wait for the video to load before saving.", variant: "destructive" });
      return;
    }
    const startT = clipStartRef.current;
    const endT = clipEndTime;
    const clipDuration = Math.max(0.1, endT - startT);

    let keyframes = recordingRef.current.keyframes.map((kf) => ({
      ...kf,
      t: Math.max(0, Math.min(1, kf.t / clipDuration)),
    }));

    if (keyframes.length === 0) {
      const scrollEl = scrollRef.current;
      const totalW = scrollEl?.scrollWidth ?? 1;
      const containerW = scrollEl?.clientWidth ?? totalW;
      let x: number, w: number;
      if (selectedRatioRef.current === "9:16") {
        const containerH = scrollEl?.clientHeight ?? 1;
        const cropPxW = containerH * 9 / 16;
        const maxScroll = Math.max(0, totalW - containerW);
        const sl = scrollEl?.scrollLeft ?? 0;
        const cropLeft = maxScroll > 0 ? (sl / maxScroll) * (containerW - cropPxW) : (containerW - cropPxW) / 2;
        x = totalW > 0 ? (sl + cropLeft) / totalW : 0;
        w = totalW > 0 ? cropPxW / totalW : 81 / 256;
      } else {
        const sl = scrollEl?.scrollLeft ?? 0;
        x = totalW > 0 ? sl / totalW : 0;
        w = totalW > 0 ? containerW / totalW : 1;
      }
      keyframes = [{ t: 0, x, y: 0, w, h: 1 }, { t: 1, x, y: 0, w, h: 1 }];
    } else if (keyframes.length === 1) {
      keyframes = [{ ...keyframes[0], t: 0 }, { ...keyframes[0], t: 1 }];
    }

    const startTime = Math.max(0, Math.min(1, startT / totalDuration));
    const endTime = Math.max(0, Math.min(1, endT / totalDuration));
    if (endTime <= startTime) {
      toast({ title: t.clipping.error, description: "Clip range is invalid. Please try recording again.", variant: "destructive" });
      return;
    }

    setIsSavingClip(true);
    try {
      await createUserClip.mutateAsync({
        data: {
          videoId: video.guid,
          title: clipTitle.trim() || video.title,
          startTime,
          endTime,
          cropPath: keyframes,
          visibility: "private",
          aspectRatio: selectedRatioRef.current,
        },
      });
      queryClient.invalidateQueries({ queryKey: getListUserClipsQueryKey() });
      toast({ title: t.clipping.saved, description: t.clipping.savedDesc, className: "bg-primary text-white border-none" });
      setClipMode("idle");
      setClipTitle("");
      setSelectedRatio("16:9");
      selectedRatioRef.current = "16:9";
      setCropZoom(0.8);
      cropZoomRef.current = 0.8;
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
      {/* Letterboxed 16:9 scrollable video */}
      <div ref={zoomRef} className="absolute inset-0 flex items-center justify-center bg-black">
        <div className="relative" style={{ width: "min(100%, calc(100dvh * 16 / 9))", aspectRatio: "16/9" }}>
          {/* Crop overlay — only shown while recording in 9:16 mode */}
          {clipMode === "recording" && selectedRatio === "9:16" && (() => {
            const scrollEl = scrollRef.current;
            const totalW = scrollEl?.scrollWidth ?? 1;
            const containerW = scrollEl?.clientWidth ?? totalW;
            const containerH = scrollEl?.clientHeight ?? 1;
            const cropPxW = containerH * 9 / 16;
            const maxScroll = Math.max(0, totalW - containerW);
            const cropLeft = maxScroll > 0
              ? (scrollOffset / maxScroll) * (containerW - cropPxW)
              : (containerW - cropPxW) / 2;
            const leftFrac = totalW > 0 ? (scrollOffset + cropLeft) / totalW : 0;
            const widthFrac = totalW > 0 ? cropPxW / totalW : 81 / 256;
            return (
              <>
                <div className="absolute inset-y-0 bg-black/50 z-10 pointer-events-none" style={{ left: 0, width: `${leftFrac * 100}%` }} />
                <div className="absolute inset-y-0 bg-black/50 z-10 pointer-events-none" style={{ left: `${(leftFrac + widthFrac) * 100}%`, right: 0 }} />
                <div className="absolute inset-y-0 border-2 border-white/60 z-10 pointer-events-none rounded-sm" style={{ left: `${leftFrac * 100}%`, width: `${widthFrac * 100}%` }} />
              </>
            );
          })()}

          {/* Scrollable video */}
          <div
            ref={scrollRef}
            className="absolute inset-0 overflow-x-auto overflow-y-hidden flex items-center"
            style={{ scrollbarWidth: "none" }}
            onTouchEnd={skipOnTouchEnd}
            onClick={resetControlsTimer}
          >
            <video
              ref={videoRef}
              style={{ height: `${Math.round(100 / cropZoom)}%`, width: "auto", flexShrink: 0 }}
              playsInline
              onLoadedMetadata={onLoadedMetadata}
            />
          </div>

          {/* Skip flash */}
          <SkipFlash flash={skipFlash} />
        </div>
      </div>

      {/* Controls overlay */}
      <AnimatePresence>
        {showControls && clipMode === "idle" && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 z-20 flex flex-col pointer-events-none"
          >
            {/* Top bar */}
            <div className="flex items-center justify-between px-4 pt-safe pt-4 pointer-events-auto">
              <button
                onClick={onClose}
                className="w-10 h-10 rounded-full bg-black/40 backdrop-blur-sm flex items-center justify-center"
              >
                <X className="w-5 h-5 text-white" />
              </button>
              <div className="flex items-center gap-2">
                {/* Ratio toggle */}
                <button
                  onClick={() => {
                    const next: AspectRatio = selectedRatio === "16:9" ? "9:16" : "16:9";
                    setSelectedRatio(next);
                    selectedRatioRef.current = next;
                  }}
                  className="px-3 py-1.5 rounded-full bg-black/40 backdrop-blur-sm text-white text-xs font-bold"
                >
                  {selectedRatio}
                </button>
                <button
                  onClick={toggleFullscreen}
                  className="w-10 h-10 rounded-full bg-black/40 backdrop-blur-sm flex items-center justify-center"
                >
                  {isFullscreen ? <Minimize className="w-4 h-4 text-white" /> : <Maximize className="w-4 h-4 text-white" />}
                </button>
              </div>
            </div>

            {/* Center play controls */}
            <div className="flex-1 flex items-center justify-center gap-8 pointer-events-auto">
              <button onClick={() => seek(-10)} className="w-12 h-12 rounded-full bg-black/30 backdrop-blur-sm flex items-center justify-center">
                <SkipBack className="w-5 h-5 text-white" />
              </button>
              <button onClick={togglePlay} className="w-16 h-16 rounded-full bg-white/20 backdrop-blur-sm flex items-center justify-center">
                {isPlaying ? <Pause className="w-7 h-7 text-white fill-white" /> : <Play className="w-7 h-7 text-white fill-white" />}
              </button>
              <button onClick={() => seek(10)} className="w-12 h-12 rounded-full bg-black/30 backdrop-blur-sm flex items-center justify-center">
                <SkipForward className="w-5 h-5 text-white" />
              </button>
            </div>

            {/* Bottom bar */}
            <div className="px-4 pb-safe pb-6 pointer-events-auto space-y-3">
              {/* Zoom slider */}
              <div className="flex items-center gap-2">
                <ZoomOut className="w-3.5 h-3.5 text-white/60 shrink-0" />
                <input
                  type="range"
                  min={30}
                  max={100}
                  step={5}
                  value={Math.round(cropZoom * 100)}
                  onChange={(e) => {
                    const z = parseInt(e.target.value) / 100;
                    setCropZoom(z);
                    cropZoomRef.current = z;
                  }}
                  className="flex-1 accent-primary h-1"
                />
                <ZoomIn className="w-3.5 h-3.5 text-white/60 shrink-0" />
              </div>

              {/* Seek bar */}
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
                    onChange={(e) => {
                      const v = parseFloat(e.target.value);
                      setCurrentTime(v);
                      if (videoRef.current) videoRef.current.currentTime = v;
                    }}
                    className="flex-1 accent-primary h-1"
                  />
                  <span className="text-white text-xs tabular-nums w-10">{formatDuration(duration)}</span>
                </div>
              )}

              {/* Clip button */}
              <div className="flex justify-center">
                <button
                  onClick={startRecording}
                  className="flex items-center gap-2 px-5 py-2.5 rounded-full bg-primary text-black font-bold text-sm"
                >
                  <Circle className="w-4 h-4 fill-black" />
                  {t.clipping.record}
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Recording mode overlay */}
      <AnimatePresence>
        {clipMode === "recording" && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 z-20 flex flex-col pointer-events-none"
          >
            <div className="flex-1" />
            <div className="px-4 pb-safe pb-6 pointer-events-auto flex flex-col items-center gap-3 w-full">
              <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-red-500/20 border border-red-500/40">
                <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                <span className="text-red-400 text-xs font-bold tabular-nums">{formatDuration(recElapsed)}</span>
              </div>
              {/* Zoom slider during recording */}
              <div className="flex items-center gap-2 w-full">
                <ZoomOut className="w-3.5 h-3.5 text-white/60 shrink-0" />
                <input
                  type="range"
                  min={30}
                  max={100}
                  step={5}
                  value={Math.round(cropZoom * 100)}
                  onChange={(e) => {
                    const z = parseInt(e.target.value) / 100;
                    setCropZoom(z);
                    cropZoomRef.current = z;
                  }}
                  className="flex-1 accent-primary h-1"
                />
                <ZoomIn className="w-3.5 h-3.5 text-white/60 shrink-0" />
              </div>
              <button
                onClick={() => stopRecording()}
                className="flex items-center gap-2 px-5 py-2.5 rounded-full bg-red-500 text-white font-bold text-sm"
              >
                <Square className="w-4 h-4 fill-white" />
                {t.clipping.stopRecording}
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Review mode overlay */}
      <AnimatePresence>
        {clipMode === "review" && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="absolute bottom-0 left-0 right-0 z-20 bg-black/80 backdrop-blur-md px-4 pb-safe pb-6 pt-4 space-y-3"
          >
            <p className="text-white text-sm font-semibold text-center">
              {t.clipping.reviewTitle} · {formatDuration(clipSeconds)}
            </p>
            <input
              value={clipTitle}
              onChange={(e) => setClipTitle(e.target.value)}
              placeholder={t.clipping.titlePlaceholder}
              className="w-full bg-white/10 border border-white/20 rounded-xl px-3 py-2.5 text-white placeholder:text-white/40 text-sm outline-none focus:border-primary"
            />
            <div className="flex gap-2">
              <button
                onClick={discardClip}
                className="flex-1 py-2.5 rounded-xl border border-white/20 text-white text-sm font-medium"
              >
                {t.clipping.discard}
              </button>
              <button
                onClick={saveClip}
                disabled={isSavingClip}
                className="flex-1 py-2.5 rounded-xl bg-primary text-black text-sm font-bold flex items-center justify-center gap-2 disabled:opacity-60"
              >
                <CheckCircle2 className="w-4 h-4" />
                {isSavingClip ? t.clipping.saving : t.clipping.save}
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Auth prompt dialog */}
      <Dialog open={showAuthPrompt} onOpenChange={setShowAuthPrompt}>
        <DialogContent className="bg-zinc-900 border-zinc-700 max-w-sm mx-4">
          <DialogTitle className="text-white">{t.myClips.signInTitle}</DialogTitle>
          <DialogDescription className="text-zinc-400">{t.myClips.signInDesc}</DialogDescription>
          <div className="flex gap-2 mt-2">
            <button onClick={() => setShowAuthPrompt(false)} className="flex-1 py-2.5 rounded-xl border border-zinc-700 text-zinc-300 text-sm">
              {t.clipping.discard}
            </button>
            <button
              onClick={() => { setShowAuthPrompt(false); setLocation("/login"); }}
              className="flex-1 py-2.5 rounded-xl bg-primary text-black text-sm font-bold"
            >
              {t.clipping.signInCTA}
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </motion.div>
  );
}
