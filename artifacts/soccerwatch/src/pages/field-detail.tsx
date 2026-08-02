import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { useSkipTap } from "@/hooks/use-skip-tap";
import { SkipFlash } from "@/components/skip-flash";
import { Link, useRoute, useLocation } from "wouter";
import {
  useGetBunnyCollections,
  useGetBunnyCollectionVideos,
  useCreateUserClip,
  useListAcademies,
  getListAcademiesQueryKey,
  getListUserClipsQueryKey,
  getGetBunnyCollectionsQueryKey,
  BunnyVideo,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Play, Pause, X, SkipBack, SkipForward, Circle, Square, CheckCircle2, Maximize, Minimize, Video, Clock } from "lucide-react";
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

// Supports two filename formats:
//
// Format A (long): cam{N}_{...}_{DDMMYYYY}_{HHMMSS}
//   e.g. "cam1_GalaxyField_01_19072026_150000"
//   last two underscore-segments = 8-digit DDMMYYYY + 6-digit HHMMSS
//
// Format B (short): cam{N}_{YYYYMMDD}{HH}
//   e.g. "cam1_2026072714"  (14 = 14:00 / 2 pm)
//   second segment is exactly 10 digits: first 8 = YYYYMMDD, last 2 = HH
//   start time = HH:00; end time is derived from the video's duration field
function parseVideoFilename(title: string): VideoMeta | null {
  const name = title.replace(/\.mp4$/i, "");
  const parts = name.split("_");

  // ── Format A ──────────────────────────────────────────────────────────────
  if (parts.length >= 3) {
    const datePart = parts[parts.length - 2]; // "19072026" DDMMYYYY
    const timePart = parts[parts.length - 1]; // "150000"   HHMMSS

    if (/^\d{8}$/.test(datePart) && /^\d{6}$/.test(timePart)) {
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
  }

  // ── Format C ──────────────────────────────────────────────────────────────
  // cam2_2026-07-27_17:00  →  parts = ["cam2", "2026-07-27", "17:00"]
  //   last two segments = ISO date (YYYY-MM-DD) + HH:MM time
  if (parts.length >= 3) {
    const datePart = parts[parts.length - 2];
    const timePart = parts[parts.length - 1];
    if (/^\d{4}-\d{2}-\d{2}$/.test(datePart) && /^\d{1,2}:\d{2}$/.test(timePart)) {
      const [hh, mm] = timePart.split(":").map(Number);
      return {
        isoDate: datePart,
        startSeconds: hh * 3600 + mm * 60,
      };
    }
  }

  // ── Format B ──────────────────────────────────────────────────────────────
  // cam1_2026072714  →  parts = ["cam1", "2026072714"]
  if (parts.length === 2 && /^\d{10}$/.test(parts[1])) {
    const chunk = parts[1];
    const year  = chunk.slice(0, 4);
    const month = chunk.slice(4, 6);
    const day   = chunk.slice(6, 8);
    const hh    = parseInt(chunk.slice(8, 10), 10);
    return {
      isoDate: `${year}-${month}-${day}`,
      startSeconds: hh * 3600, // start of the hour; end = startSeconds + video.duration
    };
  }

  return null;
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
  // A field can belong to at most one academy in the common case this was
  // built for; if more than one references the same fieldId, the first match
  // wins (same assumption the server makes for the legacy Clip system).
  const { data: academies } = useListAcademies({ query: { queryKey: getListAcademiesQueryKey(), staleTime: 5 * 60 * 1000 } });
  const academyId = collection?.id != null
    ? academies?.find((a) => a.fieldId === collection.id)?.id
    : undefined;
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

  // Auto-select the most recent recording date, but only once.
  //
  // This effect depends on `videos`, and react-query hands back a new array
  // whenever a background refetch returns different bytes. Re-running it yanked
  // anyone browsing an older date back to today the moment the hourly archive
  // pipeline published a new video.
  const didAutoSelectDate = useRef(false);
  useEffect(() => {
    if (didAutoSelectDate.current) return;
    if (!videos?.length) return;
    const dates = [...videosByDate.keys()].sort();
    const mostRecent = dates[dates.length - 1];
    if (mostRecent) {
      const d = new Date(mostRecent + "T00:00:00");
      setCalYear(d.getFullYear());
      setCalMonth(d.getMonth());
      setSelectedDate(mostRecent);
      didAutoSelectDate.current = true;
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
        {activeVideo && <VideoPlayer video={activeVideo} onClose={() => setActiveVideo(null)} academyId={academyId} clipsEnabled={collection?.clipsVisible ?? false} />}
      </AnimatePresence>
    </div>
  );
}

/**
 * Frame zoom limits. 1.0 = frame exactly fills the source height, so the output
 * is entirely live footage with no black.
 *
 * 16:9 is a view onto the camera's own field of view: the user pans it around
 * while the video plays to frame what they want, and it must always be full of
 * picture. So it caps at 1.0 — zooming past that would grow the frame beyond
 * the source and introduce black bars.
 *
 * 9:16 is a reframe for vertical, where deliberate letterboxing is useful, so it
 * is allowed to exceed the source.
 */
const MIN_FRAME_ZOOM = 0.4;
const MAX_FRAME_ZOOM = 4;

export function maxZoomFor(ratio: AspectRatio): number {
  return ratio === "9:16" ? MAX_FRAME_ZOOM : 1;
}

/**
 * Resizes the crop frame. Above 1.0 the frame grows beyond the source and the
 * uncovered area becomes black bars in both the preview and the export, so this
 * doubles as "how much black space do I want".
 */
function FrameSizeSlider({
  zoom,
  onChange,
  frame,
  maxZoom,
  compact,
}: {
  zoom: number;
  onChange: (z: number) => void;
  frame: { x: number; y: number; w: number; h: number };
  maxZoom: number;
  compact?: boolean;
}) {
  // Fraction of the output frame that is black bar, for a readable label
  const coveredW = Math.max(0, Math.min(1, (Math.min(1, frame.x + frame.w) - Math.max(0, frame.x)) / frame.w));
  const coveredH = Math.max(0, Math.min(1, (Math.min(1, frame.y + frame.h) - Math.max(0, frame.y)) / frame.h));
  const blackPct = Math.round((1 - coveredW * coveredH) * 100);
  return (
    <div
      className={cn(
        "pointer-events-auto rounded-2xl bg-black/60 backdrop-blur-sm px-3 py-2",
        compact ? "w-56" : "w-full max-w-sm"
      )}
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

/**
 * Overview of where the crop frame sits within the whole recording.
 *
 * Rendered at the source's real aspect ratio (a wide panorama, not 16:9), and
 * the frame is plotted in the same source-fraction coords that are recorded
 * into cropPath. Because the container clips, a frame larger than the source
 * visibly runs off the edge — which is precisely the black bar region.
 */
function MiniMap({ frame, srcAspect }: { frame: { x: number; y: number; w: number; h: number }; srcAspect: number }) {
  const W = 128;
  const H = Math.max(24, Math.round(W / (srcAspect > 0 ? srcAspect : DEFAULT_SRC_ASPECT)));
  return (
    <div
      className="relative rounded-md overflow-hidden border border-white/30 shadow-lg shrink-0"
      style={{ width: W, height: H, background: "rgba(0,0,0,0.55)" }}
    >
      {/* Pitch reference lines, drawn across the full panorama */}
      <div className="absolute inset-0 opacity-20">
        <div className="absolute left-1/2 inset-y-0 w-px bg-white" />
        <div
          className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white"
          style={{ width: H * 0.5, height: H * 0.5 }}
        />
      </div>
      {/* Dim everything outside the frame */}
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
      {/* The frame itself */}
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

// ── Video Player (unchanged) ──────────────────────────────────────────────────

function VideoPlayer({ video, onClose, academyId, clipsEnabled = true }: { video: BunnyVideo; onClose: () => void; academyId?: number; clipsEnabled?: boolean }) {
  const videoRef = useRef<HTMLVideoElement>(null);
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
   * The preview is WYSIWYG: the on-screen box has the OUTPUT aspect ratio and
   * shows exactly what the exported clip will contain, black bars included.
   * Dragging moves the frame (this replaces the old scroll container) and the
   * zoom slider resizes it (this replaces pinch-zoom). Both used to live on
   * separate layers from the crop that actually got recorded, which is why the
   * old minimap and the saved clip disagreed with each other.
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
  /**
   * Set once a pointer travels far enough to count as a pan. The frame box also
   * carries useSkipTap's touch handler, so without this a drag to re-frame the
   * shot registered as a double-tap and jumped the video +/-10s.
   */
  const draggedRef = useRef(false);

  const clipModeRef = useRef<ClipMode>("idle");
  const stopRecordingRef = useRef<(overrideEndTime?: number) => void>(() => {});

  const outAspect = OUT_ASPECT[selectedRatio];

  /** Current frame in source-fraction coords. Derived, never stored twice. */
  const frame = makeFrame(frameOrigin.x, frameOrigin.y, frameZoom, srcAspect, outAspect);

  /** Same value read from refs — safe to call from intervals/handlers. */
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

  /**
   * Change zoom and/or output ratio, keeping the current centre point.
   *
   * This performs ALL the mutation itself and reads the outgoing frame first.
   * Callers must not pre-assign frameZoomRef/selectedRatioRef: doing so made the
   * "previous" frame read back with the new zoom already applied, so the centre
   * came out wrong and zooming out in 16:9 parked the picture at the top of the
   * frame with every black pixel below it instead of splitting the bars evenly.
   */
  const applyFrameChange = useCallback((requestedZoom: number, nextRatio: AspectRatio) => {
    // Clamped per ratio: 16:9 must stay full of picture, so it never exceeds 1.0.
    const nextZoom = Math.max(MIN_FRAME_ZOOM, Math.min(maxZoomFor(nextRatio), requestedZoom));
    const prev = makeFrame(
      frameOriginRef.current.x,
      frameOriginRef.current.y,
      frameZoomRef.current,
      srcAspectRef.current,
      OUT_ASPECT[selectedRatioRef.current]
    );
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

  // The minimap now renders straight from `frame`, which only changes when the
  // user drags or zooms. The old rAF loop called setState ~60x/sec with a fresh
  // object, re-rendering this entire component every frame for the whole
  // recording — that was the source of the stutter.

  const clipStartRef = useRef(0);
  const recordingRef = useRef<{ interval: ReturnType<typeof setInterval> | null; keyframes: CropKeyframe[] }>({
    interval: null,
    keyframes: [],
  });
  const elapsedRef = useRef<ReturnType<typeof setInterval> | null>(null);

  /**
   * Drag-to-pan the frame. Movement is converted from preview pixels into
   * source-frame fractions via the frame's own width, so panning feels the same
   * at every zoom level. Dragging the image right moves the frame left, which
   * is why the delta is subtracted.
   */
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
    setOrigin(
      dragRef.current.originX - (rawX / bw) * f.w,
      dragRef.current.originY - (rawY / bh) * f.h
    );
  }, [readFrame, setOrigin]);

  const handleFramePointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current.active) {
      try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* already released */ }
    }
    dragRef.current.active = false;
  }, []);

  /**
   * The crop rect for the current instant, in source-frame fractions.
   * This is literally what the preview is showing, so what gets recorded and
   * what the user sees can no longer drift apart.
   */
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
    const el = videoRef.current;
    if (!el) return;
    el.currentTime = Math.max(0, Math.min(el.duration || Infinity, el.currentTime + delta));
    resetControlsTimer();
  }, [resetControlsTimer]);

  const { flash: skipFlash, onTouchEnd: skipOnTouchEnd } = useSkipTap({
    onSkip: handleSkip,
    onSingleTap: resetControlsTimer,
    disabled: clipMode !== "idle",
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

    const proxiedUrl = `/api/hls-proxy/manifest?url=${encodeURIComponent(video.playbackUrl)}`;
    if (Hls.isSupported()) {
      const hls = new Hls({ enableWorker: false });
      hlsRef.current = hls;
      hls.loadSource(proxiedUrl);
      hls.attachMedia(el);
      hls.on(Hls.Events.MANIFEST_PARSED, () => el.play().catch(() => {}));
      hls.on(Hls.Events.ERROR, (_, data) => { if (data.fatal) el.dispatchEvent(new Event("error")); });
    } else if (el.canPlayType("application/vnd.apple.mpegurl")) {
      el.src = proxiedUrl;
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

  /**
   * Read the real source aspect from the decoded stream rather than assuming
   * 3840x1080, then centre the frame on the field.
   */
  function onLoadedMetadata(e: React.SyntheticEvent<HTMLVideoElement>) {
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
      if (!videoEl) return;
      const relT = videoEl.currentTime - clipStartRef.current;
      if (relT < 0) return;

      // Exactly the rect the preview is displaying, including any black bars.
      const { x, y, w, h } = computeCropRect();
      recordingRef.current.keyframes.push({ t: relT, x, y, w, h });
    };

    sampleFrame();
    recordingRef.current.interval = setInterval(sampleFrame, 150);

    // Clamped at 0: HLS re-buffering can nudge currentTime slightly backwards,
    // which previously rendered as a negative duration in the REC badge.
    elapsedRef.current = setInterval(() => {
      const videoEl = videoRef.current;
      if (videoEl) setRecElapsed(Math.max(0, videoEl.currentTime - clipStartRef.current));
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
    const endT = overrideEndTime ?? el?.currentTime ?? clipStartRef.current;

    if (el) {
      const { x, y, w, h } = computeCropRect();
      recordingRef.current.keyframes.push({ t: Math.max(0, endT - clipStartRef.current), x, y, w, h });
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
    applyFrameChange(1, "16:9");
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
      const { x, y, w, h } = computeCropRect();
      keyframes = [{ t: 0, x, y, w, h }, { t: 1, x, y, w, h }];
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
          academyId,
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

  const clipSeconds = Math.max(0, clipEndTime - clipStartRef.current);

  return (
    <motion.div
      ref={containerRef}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 bg-black"
    >
      {/*
        WYSIWYG frame preview.

        The box below has the OUTPUT aspect ratio and its background is black,
        so whenever the frame is zoomed out past the source the uncovered
        area renders as real black bars — exactly what the export produces.
        Drag to pan, use the size slider to resize.
      */}
      <div className="absolute inset-0 flex items-center justify-center bg-black">
        <div
          ref={frameBoxRef}
          className={cn(
            "relative overflow-hidden bg-black touch-none",
            clipMode === "recording" ? "ring-2 ring-red-500" : "ring-1 ring-white/25"
          )}
          style={
            selectedRatio === "9:16"
              ? { height: "min(100%, calc(100vw * 16 / 9))", aspectRatio: "9/16" }
              : { width: "min(100%, calc(100dvh * 16 / 9))", aspectRatio: "16/9" }
          }
          onPointerDown={handleFramePointerDown}
          onPointerMove={handleFramePointerMove}
          onPointerUp={handleFramePointerUp}
          onPointerCancel={handleFramePointerUp}
          onTouchEnd={(e) => {
            if (draggedRef.current) return;
            skipOnTouchEnd(e);
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
            style={frameToVideoStyle(frame)}
            playsInline
            onLoadedMetadata={onLoadedMetadata}
          />

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
                  onClick={() => applyFrameChange(
                    frameZoomRef.current,
                    selectedRatio === "16:9" ? "9:16" : "16:9"
                  )}
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

              {/* Frame sizing — set the shot (and any black bars) before recording */}
              <div className="flex justify-center">
                <FrameSizeSlider
                  zoom={frameZoom}
                  frame={frame}
                  maxZoom={maxZoomFor(selectedRatio)}
                  onChange={(z) => applyFrameChange(z, selectedRatioRef.current)}
                />
              </div>

              {/* Clip button — only shown when admin has enabled clipping for this field */}
              {clipsEnabled && (
                <div className="flex justify-center">
                  <button
                    onClick={startRecording}
                    className="flex items-center gap-2 px-5 py-2.5 rounded-full bg-primary text-black font-bold text-sm"
                  >
                    <Circle className="w-4 h-4 fill-black" />
                    {t.clipping.record}
                  </button>
                </div>
              )}
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
            {/* Top bar: REC badge + minimap */}
            <div className="pt-safe pt-4 px-4 flex items-start justify-between">
              {/* REC indicator — formatElapsed never returns "" or a negative value */}
              <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-black/60 backdrop-blur-sm border border-red-500/40">
                <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                <span className="text-red-400 text-xs font-bold tabular-nums">{formatElapsed(recElapsed)}</span>
              </div>

              {/*
                Minimap. Drawn at the SOURCE aspect ratio (panoramic), with the
                frame rect plotted in the same source-fraction coords that get
                recorded — so it now tracks panning, and a frame extending past
                the source visibly clips at the edge (that overflow is the black
                bars in the output).
              */}
              <MiniMap frame={frame} srcAspect={srcAspect} />
            </div>

            <div className="flex-1" />
            <div className="px-4 pb-safe pb-6 pointer-events-auto flex flex-col items-center gap-3">
              {/* Resizing mid-recording is captured like any other frame change */}
              <FrameSizeSlider
                zoom={frameZoom}
                frame={frame}
                maxZoom={maxZoomFor(selectedRatio)}
                compact
                onChange={(z) => applyFrameChange(z, selectedRatioRef.current)}
              />
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
              onClick={() => { setShowAuthPrompt(false); setLocation("/sign-in"); }}
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
