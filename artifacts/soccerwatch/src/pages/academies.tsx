import { useState } from "react";
import { Link, useLocation } from "wouter";
import { motion, AnimatePresence } from "framer-motion";
import { GraduationCap, MapPin, ChevronRight, Search, Play } from "lucide-react";
import { Input } from "@/components/ui/input";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListAcademies,
  useGetAcademyRecordings,
  getListAcademiesQueryKey,
  getGetAcademyRecordingsQueryKey,
  useCreateUserClip,
  getListUserClipsQueryKey,
  type Recording,
} from "@workspace/api-client-react";
import { useTranslation } from "@/i18n";
import { useAuth } from "@/lib/auth";
import { ClipPlayer } from "@/components/clip-player/ClipPlayer";

/** Pull the bare Bunny GUID out of a full CDN URL like
 *  https://cdn.example.net/abc-123/playlist.m3u8  →  "abc-123"
 *  Falls back to the raw string so nothing silently breaks if the format changes. */
function extractBunnyGuid(videoUrl: string): string {
  try {
    return new URL(videoUrl).pathname.split("/").filter(Boolean)[0] ?? videoUrl;
  } catch {
    return videoUrl;
  }
}

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
      <div className="w-9 h-9 rounded-lg bg-live/15 flex items-center justify-center flex-shrink-0">
        <Play className="w-4 h-4 text-live fill-live" />
      </div>
      <div className="flex-1 text-start">
        <p className="text-sm font-semibold text-foreground">
          {CAMERA_LABELS[cameraId] ?? cameraId}
        </p>
        <div className="flex items-center gap-1.5 mt-0.5">
          <span className="w-1.5 h-1.5 rounded-full bg-live animate-pulse" />
          <span className="text-[11px] font-medium text-live uppercase tracking-wide">Live</span>
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
      className="overflow-hidden rounded-[22px] border border-border bg-card"
    >
      <button onClick={onToggle} className="w-full text-start">
        {/* Banner */}
        <div className="relative aspect-video w-full overflow-hidden">
          {academy.logoUrl ? (
            <img
              src={academy.logoUrl}
              alt={academy.name}
              className="absolute inset-0 h-full w-full object-cover"
              onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
            />
          ) : (
            <div className="absolute inset-0 field-pattern bg-card" />
          )}
          <div className="absolute inset-0 bg-gradient-to-b from-black/30 via-transparent to-black/40" />
        </div>
        {/* Content block */}
        <div className="px-4 py-3.5">
          <div className="flex items-center gap-2">
            <p className="min-w-0 flex-1 truncate font-display text-base font-semibold leading-[1.25] text-foreground">{academy.name}</p>
            <div className="flex shrink-0 items-baseline gap-1 text-end">
              <p className="text-base font-bold tabular-nums text-foreground">{academy.recordingCount}</p>
              <p className="text-[10px] uppercase text-muted-foreground">videos</p>
            </div>
            <div className="flex shrink-0 items-center">
              <motion.div animate={{ rotate: isExpanded ? 90 : 0 }} transition={{ duration: 0.2 }}
                className="rtl:hidden inline-block"
              >
                <ChevronRight className="w-4 h-4 text-muted-foreground" />
              </motion.div>
              <motion.div animate={{ rotate: isExpanded ? -90 : 0 }} transition={{ duration: 0.2 }}
                className="ltr:hidden inline-block"
              >
                <ChevronRight className="w-4 h-4 text-muted-foreground" />
              </motion.div>
            </div>
          </div>
          <div className="mt-1.5 flex items-center gap-1 text-xs text-muted-foreground">
            <MapPin className="h-3 w-3 shrink-0" />
            <span className="truncate">{academy.fieldName} · {academy.fieldLocation}</span>
          </div>
          <div className="mt-3 flex flex-wrap gap-1">
            {academy.daysOfWeek.slice(0, 4).map((d) => <DayBadge key={d} day={d} />)}
          </div>
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

export default function Academies({ embedded = false }: { embedded?: boolean }) {
  const { locale } = useTranslation();
  const { user, isGuest } = useAuth();
  const [, setLocation] = useLocation();
  const createUserClip = useCreateUserClip();
  const queryClient = useQueryClient();
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
    <div className="academies-page flex flex-1 min-h-0 flex-col overflow-hidden bg-background">
      <motion.div initial={{ opacity: 0, y: -12 }}
        animate={{ opacity: 1, y: 0, transition: { duration: 0.35, ease: "easeOut" as const } }}
        className={embedded ? "shrink-0 bg-background px-4 pb-3 pt-4" : "sticky top-0 z-10 shrink-0 bg-background px-4 pb-3 pt-4"}
      >
        {!embedded && (
          <>
            <h1 className="text-2xl font-bold text-foreground">Academies</h1>
            <p className="text-muted-foreground text-sm mb-4">Live streams and recordings from partner academies</p>
          </>
        )}
        <div className="relative">
          <Search className="absolute start-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)}
            placeholder={locale === "ar" ? "ابحث عن أكاديمية" : "Search academies…"} className="ps-9 bg-muted border-transparent focus-visible:ring-primary rounded-xl h-12"
          />
        </div>
      </motion.div>

      <div className="academies-page-scroll min-h-0 flex-1 overflow-y-auto no-scrollbar px-4 pb-28 space-y-4">
        {isLoading ? (
          <>{[1, 2, 3].map((i) => <div key={i} className="h-[150px] animate-pulse rounded-[22px] border border-border bg-card" />)}</>
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
          <ClipPlayer
            src={`/api/live/${liveFor.cameraId}/index.m3u8`}
            title={liveFor.title}
            source={{ kind: "bunny", videoId: `live:${liveFor.cameraId}` }}
            liveCameraId={liveFor.cameraId}
            academyId={liveFor.academyId}
            isLive
            layout="overlay"
            canSave={Boolean(user) && !isGuest}
            onClose={() => setLiveFor(null)}
            onRequireAuth={(_draft) => setLocation("/sign-in")}
            onSave={async (draft) => {
              await createUserClip.mutateAsync({
                data: {
                  videoId: `live:${liveFor.cameraId}`,
                  title: draft.title,
                  startTime: draft.startTime,
                  endTime: draft.endTime,
                  cropPath: draft.cropPath,
                  visibility: "private",
                  aspectRatio: draft.aspectRatio,
                  academyId: liveFor.academyId,
                },
              });
              queryClient.invalidateQueries({ queryKey: getListUserClipsQueryKey() });
            }}
          />
        )}
        {recordingFor && recordingFor.rec.videoUrl && (
          <ClipPlayer
            src={`/api/hls-proxy/manifest?url=${encodeURIComponent(recordingFor.rec.videoUrl)}`}
            title={recordingFor.title}
            source={{ kind: "bunny", videoId: extractBunnyGuid(recordingFor.rec.videoUrl) }}
            academyId={recordingFor.academyId}
            layout="overlay"
            canSave={Boolean(user) && !isGuest}
            onClose={() => setRecordingFor(null)}
            onRequireAuth={(_draft) => setLocation("/sign-in")}
            onSave={async (draft) => {
              await createUserClip.mutateAsync({
                data: {
                  videoId: extractBunnyGuid(recordingFor.rec.videoUrl ?? ""),
                  title: draft.title,
                  startTime: draft.startTime,
                  endTime: draft.endTime,
                  cropPath: draft.cropPath,
                  visibility: "private",
                  aspectRatio: draft.aspectRatio,
                  academyId: recordingFor.academyId,
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
