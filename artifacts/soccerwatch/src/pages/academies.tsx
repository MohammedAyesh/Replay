import { useState, useEffect, useRef } from "react";
import { Link } from "wouter";
import { motion, AnimatePresence } from "framer-motion";
import { GraduationCap, MapPin, Calendar, ChevronRight, Search, Video, Radio } from "lucide-react";
import { Input } from "@/components/ui/input";
import Hls from "hls.js";
import {
  useListAcademies,
  useGetAcademyRecordings,
  getListAcademiesQueryKey,
  getGetAcademyRecordingsQueryKey,
} from "@workspace/api-client-react";
import { cn } from "@/lib/utils";

const DAYS_SHORT: Record<string, string> = {
  monday: "Mon",
  tuesday: "Tue",
  wednesday: "Wed",
  thursday: "Thu",
  friday: "Fri",
  saturday: "Sat",
  sunday: "Sun",
};

function DayBadge({ day }: { day: string }) {
  return (
    <span className="px-1.5 py-0.5 rounded-md bg-primary/15 text-primary text-[10px] font-semibold uppercase tracking-wide">
      {DAYS_SHORT[day.toLowerCase()] ?? day}
    </span>
  );
}

function LivePlayer({ cameraId }: { cameraId: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    setReady(false);

    const url = `/api/live/${cameraId}/index.m3u8`;

    if (Hls.isSupported()) {
      const hls = new Hls({ liveSyncDurationCount: 3 });
      hls.loadSource(url);
      hls.attachMedia(el);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        setReady(true);
        el.play().catch(() => {});
      });
      return () => hls.destroy();
    } else if (el.canPlayType("application/vnd.apple.mpegurl")) {
      el.src = url;
      el.addEventListener("loadedmetadata", () => {
        setReady(true);
        el.play().catch(() => {});
      });
    }
  }, [cameraId]);

  return (
    <div className="aspect-[3/4] relative overflow-hidden rounded-2xl shadow-md bg-black group">
      <video
        ref={videoRef}
        className="absolute inset-0 w-full h-full object-cover"
        playsInline
        muted
        controls
      />
      <div className="absolute inset-0 bg-gradient-to-b from-black/20 via-black/40 to-black/80 pointer-events-none" />

      <div className="absolute top-3 start-3 z-10 flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-red-500/90 backdrop-blur-sm">
        <span className="w-1.5 h-1.5 rounded-full bg-white animate-pulse" />
        <span className="text-white text-[10px] font-bold uppercase tracking-wider">Live</span>
      </div>

      {!ready && (
        <div className="absolute inset-0 flex items-center justify-center bg-zinc-950/60">
          <div className="w-6 h-6 rounded-full border-2 border-primary border-t-transparent animate-spin" />
        </div>
      )}
    </div>
  );
}

function AcademyCard({
  academy,
  index,
  isExpanded,
  onToggle,
}: {
  academy: {
    id: number;
    name: string;
    fieldId: number;
    fieldName: string;
    fieldLocation: string;
    daysOfWeek: string[];
    description?: string | null;
    logoUrl?: string | null;
    cameraId?: string | null;
    recordingCount: number;
  };
  index: number;
  isExpanded: boolean;
  onToggle: () => void;
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
      <button
        onClick={onToggle}
        className="w-full flex items-start gap-3 p-4 text-left hover:bg-muted/30 transition-colors"
      >
        <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center flex-shrink-0 mt-0.5 overflow-hidden">
          {academy.logoUrl ? (
            <img src={academy.logoUrl} alt={academy.name} className="w-full h-full object-cover" />
          ) : (
            <GraduationCap className="w-5 h-5 text-primary" />
          )}
        </div>

        <div className="flex-1 min-w-0">
          <h3 className="font-semibold text-foreground text-base leading-tight">{academy.name}</h3>

          <div className="flex items-center gap-1 mt-1">
            <MapPin className="w-3 h-3 text-muted-foreground flex-shrink-0" />
            <span className="text-muted-foreground text-xs truncate">{academy.fieldLocation}</span>
          </div>

          {academy.daysOfWeek.length > 0 && (
            <div className="flex items-center gap-1 mt-1.5 flex-wrap">
              <Calendar className="w-3 h-3 text-muted-foreground flex-shrink-0" />
              <div className="flex gap-1 flex-wrap">
                {academy.daysOfWeek.map((d) => (
                  <DayBadge key={d} day={d} />
                ))}
              </div>
            </div>
          )}

          {academy.description && (
            <p className="text-muted-foreground text-xs mt-1.5 line-clamp-2">{academy.description}</p>
          )}

          <div className="flex items-center gap-3 mt-2">
            <span className="text-xs text-muted-foreground">
              <span className="font-medium text-foreground">{academy.recordingCount}</span>{" "}
              {academy.recordingCount === 1 ? "recording" : "recordings"}
            </span>
            <span className="text-xs text-primary font-medium">{academy.fieldName}</span>
          </div>
        </div>

        <ChevronRight
          className={cn(
            "w-4 h-4 text-muted-foreground flex-shrink-0 mt-1 transition-transform duration-200",
            isExpanded && "rotate-90"
          )}
        />
      </button>

      <AnimatePresence>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1, transition: { duration: 0.25 } }}
            exit={{ height: 0, opacity: 0, transition: { duration: 0.2 } }}
            className="overflow-hidden"
          >
            <div className="border-t border-border px-4 py-3 space-y-3">
              {academy.cameraId && (
                <div>
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Live</p>
                  <LivePlayer cameraId={academy.cameraId} />
                </div>
              )}
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                Recordings
              </p>

              {recLoading ? (
                <div className="space-y-2">
                  {[1, 2].map((i) => (
                    <div key={i} className="h-12 rounded-xl bg-muted animate-pulse" />
                  ))}
                </div>
              ) : !recordings || recordings.length === 0 ? (
                <p className="text-muted-foreground text-sm text-center py-4">No recordings linked yet.</p>
              ) : (
                <div className="space-y-2">
                  {recordings.map((rec) => (
                    <Link
                      key={rec.id}
                      href={`/fields/${rec.fieldId}`}
                      className="flex items-center gap-3 p-2.5 rounded-xl bg-muted/40 hover:bg-muted/70 transition-colors"
                    >
                      <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0">
                        <Video className="w-4 h-4 text-primary" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-foreground truncate">
                          {rec.date} · {rec.timeSlot}
                        </p>
                        <p className="text-xs text-muted-foreground truncate">
                          {rec.court} · {rec.duration}
                          {rec.score && ` · ${rec.score}`}
                        </p>
                      </div>
                      <ChevronRight className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                    </Link>
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

  const filtered = (academies ?? []).filter(
    (a) =>
      a.name.toLowerCase().includes(search.toLowerCase()) ||
      a.fieldName.toLowerCase().includes(search.toLowerCase()) ||
      a.fieldLocation.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="flex-1 bg-background flex flex-col h-full overflow-hidden">
      <motion.div
        initial={{ opacity: 0, y: -12 }}
        animate={{ opacity: 1, y: 0, transition: { duration: 0.35, ease: "easeOut" } }}
        className="pt-safe px-4 py-6 bg-background sticky top-0 z-10"
      >
        <h1 className="text-2xl font-bold text-foreground">Academies</h1>
        <p className="text-muted-foreground text-sm mb-4">Local soccer academies and their sessions</p>
        <div className="relative">
          <Search className="absolute start-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search academies or fields…"
            className="ps-9 bg-muted border-transparent focus-visible:ring-primary rounded-xl h-12"
          />
        </div>
      </motion.div>

      <div className="flex-1 overflow-y-auto px-4 pb-24 space-y-3">
        {isLoading ? (
          <>
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-32 bg-muted rounded-2xl animate-pulse" />
            ))}
          </>
        ) : filtered.length === 0 ? (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="text-center py-16 text-muted-foreground"
          >
            <GraduationCap className="w-12 h-12 mx-auto mb-3 opacity-30" />
            <p className="font-medium">
              {search ? "No academies found" : "No academies yet"}
            </p>
            {!search && (
              <p className="text-sm mt-1 opacity-70">Academies will appear here once added by an admin.</p>
            )}
          </motion.div>
        ) : (
          filtered.map((academy, i) => (
            <AcademyCard
              key={academy.id}
              academy={academy}
              index={i}
              isExpanded={expandedId === academy.id}
              onToggle={() => setExpandedId(expandedId === academy.id ? null : academy.id)}
            />
          ))
        )}
      </div>
    </div>
  );
}
