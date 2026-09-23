import { useState, useRef, useEffect, useMemo } from "react";
import { Link, useRoute, useLocation } from "wouter";
import {
  useGetBunnyCollections,
  useGetBunnyCollectionVideos,
  useGetFieldRecordings,
  getGetFieldRecordingsQueryKey,
  useCreateUserClip,
  useListAcademies,
  getListAcademiesQueryKey,
  getListUserClipsQueryKey,
  getGetBunnyCollectionsQueryKey,
  BunnyVideo,
  type FieldRecording,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Play, CheckCircle2, Video, Clock } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { useTranslation } from "@/i18n";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/utils";
import { CLAIM_YOUR_MATCH_ENABLED } from "@/lib/feature-flags";
import { ClipPlayer, type ClipDraft } from "@/components/clip-player/ClipPlayer";
import { parseFormatCVideoTitle } from "@workspace/api-zod";

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
export function parseVideoFilename(title: string): VideoMeta | null {
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
    const formatC = parseFormatCVideoTitle(title);
    if (formatC) {
      return {
        isoDate: formatC.date,
        startSeconds: Number(formatC.time.slice(0, 2)) * 3600 + Number(formatC.time.slice(3)) * 60,
      };
    }
  }

  // Some Bunny recordings use the date/time pair without a camera prefix:
  // 2026-09-21_22:00. The recording's DB row still supplies the field and
  // visibility decision; the title only needs to provide the archive date.
  if (parts.length === 2 && /^\d{4}-\d{2}-\d{2}$/.test(parts[0] ?? "") && /^\d{1,2}:\d{2}$/.test(parts[1] ?? "")) {
    const [hour, minute] = (parts[1] ?? "").split(":").map(Number);
    if (hour <= 23 && minute <= 59) {
      return {
        isoDate: parts[0] as string,
        startSeconds: hour * 3600 + minute * 60,
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

function formatRecordingDateTime(
  date: string,
  timeSlot: string,
  locale: "en" | "ar",
  fallback: (date: string, time: string) => string,
): string {
  const parsed = new Date(`${date}T${timeSlot.length === 5 ? `${timeSlot}:00` : timeSlot}`);
  if (Number.isNaN(parsed.getTime())) return fallback(date, timeSlot);
  return new Intl.DateTimeFormat(locale === "ar" ? "ar-JO" : "en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(parsed);
}

function ClaimableRecordingRow({
  recording,
  index,
  locale,
  copy,
}: {
  recording: FieldRecording;
  index: number;
  locale: "en" | "ar";
  copy: {
    invite: string;
    continue: string;
    result: string;
    disputed: string;
    disputedDesc: string;
    needsResolution: string;
    needsResolutionDesc: string;
    dateTimeFallback: (date: string, time: string) => string;
  };
}) {
  const state = recording.viewerClaimState;
  const dateTime = formatRecordingDateTime(recording.date, recording.timeSlot, locale, copy.dateTimeFallback);
  const isDisputed = state === "disputed";
  const needsResolution = state === "needs_resolution";
  const isSettled = state === "confirmed";
  const actionLabel = isSettled ? copy.result : state === null ? copy.invite : copy.continue;

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0, transition: { delay: index * 0.05, duration: 0.22 } }}
      className="flex items-center gap-3 border-t border-border px-4 py-3.5 first:border-t-0"
    >
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10">
        <CheckCircle2 className="h-4 w-4 text-primary" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-foreground">{dateTime}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {recording.court}
        </p>
        {(isDisputed || needsResolution) && (
          <p className="mt-1 text-xs font-medium text-floodlight">
            {isDisputed ? copy.disputed : copy.needsResolution}
            <span className="block font-normal text-muted-foreground">
              {isDisputed ? copy.disputedDesc : copy.needsResolutionDesc}
            </span>
          </p>
        )}
      </div>
      {!isDisputed && !needsResolution && (
        <Link
          href={`/claim/${recording.id}`}
          className="flex shrink-0 items-center gap-1 rounded-xl bg-primary/10 px-3 py-2 text-xs font-bold text-primary transition-colors hover:bg-primary/20"
        >
          <span>{actionLabel}</span>
          <ChevronRight className="h-3.5 w-3.5 rtl:hidden" />
          <ChevronLeft className="h-3.5 w-3.5 ltr:hidden" />
        </Link>
      )}
    </motion.div>
  );
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
  const [, setLocation] = useLocation();
  const guid = params?.id ?? "";
  const { t, locale } = useTranslation();
  const { user, isGuest } = useAuth();
  const canClaim = CLAIM_YOUR_MATCH_ENABLED && Boolean(user) && !isGuest;

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
  const { data: fieldRecordings, isLoading: fieldRecordingsLoading } = useGetFieldRecordings(
    collection?.id ?? 0,
    {
      query: {
        enabled: canClaim && collection?.id != null,
        queryKey: getGetFieldRecordingsQueryKey(collection?.id ?? 0),
        staleTime: 60 * 1000,
      },
    },
  );
  const claimableRecordings = useMemo(
    () => (fieldRecordings ?? []).filter((recording) => recording.hasTracking),
    [fieldRecordings],
  );
  const [activeVideo, setActiveVideo] = useState<BunnyVideo | null>(null);
  const createUserClip = useCreateUserClip();
  const queryClient = useQueryClient();

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
    <div className="field-detail-page flex-1 bg-background flex flex-col h-full overflow-hidden">
      <motion.header
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0, transition: { duration: 0.3, ease: "easeOut" as const } }}
        className="field-detail-header pt-safe px-4 py-4 bg-background sticky top-0 z-10 flex items-center gap-3"
      >
        <button onClick={() => window.history.back()} className="w-10 h-10 flex items-center justify-center -ms-2 rounded-full hover:bg-muted text-foreground">
          <ChevronLeft className="w-6 h-6 rtl:hidden" />
          <ChevronRight className="w-6 h-6 ltr:hidden" />
        </button>
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
        className="field-detail-hero relative h-36 overflow-hidden shrink-0"
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

      <div className="field-detail-recordings flex-1 overflow-y-auto no-scrollbar pb-24">
          {canClaim && (fieldRecordingsLoading || claimableRecordings.length > 0) && (
            <section className="mx-4 mt-4 overflow-hidden rounded-[22px] border border-primary/20 bg-card">
              <div className="border-b border-border px-4 py-4">
                <h2 className="font-display text-base font-bold text-foreground">{t.fieldDetail.claimYourMatch.title}</h2>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">{t.fieldDetail.claimYourMatch.subtitle}</p>
              </div>
              {fieldRecordingsLoading ? (
                <div className="space-y-2 p-4">
                  <div className="h-14 animate-pulse rounded-xl bg-muted" />
                  <div className="h-14 animate-pulse rounded-xl bg-muted" />
                </div>
              ) : (
                <div>
                  {claimableRecordings.map((recording, index) => (
                    <ClaimableRecordingRow
                      key={recording.id}
                      recording={recording}
                      index={index}
                      locale={locale}
                      copy={t.fieldDetail.claimYourMatch}
                    />
                  ))}
                </div>
              )}
            </section>
          )}
          {canClaim && (
            <div className="mx-4 mt-3 rounded-2xl border border-border bg-card px-4 py-3">
              <Link
                href="/claim/demo"
                className="flex items-center justify-between gap-3 text-start"
              >
                <span className="min-w-0">
                  <span className="block text-sm font-semibold text-foreground">{t.fieldDetail.claimYourMatch.tryDemo}</span>
                  <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">{t.fieldDetail.claimYourMatch.tryDemoDesc}</span>
                </span>
                <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground rtl:hidden" />
                <ChevronLeft className="h-4 w-4 shrink-0 text-muted-foreground ltr:hidden" />
              </Link>
            </div>
          )}
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
        {activeVideo && (
          <ClipPlayer
            src={`/api/hls-proxy/manifest?url=${encodeURIComponent(activeVideo.playbackUrl)}`}
            title={activeVideo.title}
            source={{ kind: "bunny", videoId: activeVideo.guid }}
            academyId={academyId}
            layout="overlay"
            canSave={Boolean(user) && !isGuest}
            onClose={() => setActiveVideo(null)}
            onRequireAuth={(_draft) => setLocation("/sign-in")}
            onSave={async (draft) => {
              await createUserClip.mutateAsync({
                data: {
                  videoId: activeVideo.guid,
                  title: draft.title,
                  startTime: draft.startTime,
                  endTime: draft.endTime,
                  cropPath: draft.cropPath,
                  visibility: "private",
                  aspectRatio: draft.aspectRatio,
                  academyId,
                },
              });
              queryClient.invalidateQueries({ queryKey: getListUserClipsQueryKey() });
            }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
// Playback and clipping are provided by ClipPlayer.
