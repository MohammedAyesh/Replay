import { useState, useMemo } from "react";
import { Link, useRoute, useLocation } from "wouter";
import { useFCCompute, dateFromKey, timeFromFilename, formatDateLabel, storeOSSVideo, FCVideo } from "@/lib/fc";
import { ChevronLeft, Play, Calendar, Video } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function FieldDetail() {
  const [, params] = useRoute("/fields/:camera");
  const camera = decodeURIComponent(params?.camera ?? "Cam01");
  const [, navigate] = useLocation();

  const { data, isLoading } = useFCCompute(camera);

  const allVideos = (data?.videos ?? []).filter(
    (v) => !v.key.includes("/hls/") && v.filename !== "init.mp4"
  );

  const dates = useMemo(() => {
    const set = new Set<string>();
    for (const v of allVideos) {
      const d = dateFromKey(v.key);
      if (d) set.add(d);
    }
    return Array.from(set).sort((a, b) => b.localeCompare(a));
  }, [allVideos]);

  const [selectedDate, setSelectedDate] = useState<string | null>(null);

  const currentDate = selectedDate ?? dates[0] ?? null;

  const visibleVideos = useMemo(() => {
    if (!currentDate) return allVideos;
    return allVideos.filter((v) => dateFromKey(v.key) === currentDate);
  }, [allVideos, currentDate]);

  function handlePlay(v: FCVideo) {
    const d = dateFromKey(v.key) ?? "";
    storeOSSVideo({ url: v.url, filename: v.filename, camera, date: d });
    navigate("/oss-player");
  }

  if (isLoading) {
    return (
      <div className="flex-1 bg-background flex flex-col h-full overflow-hidden">
        <header className="pt-safe px-4 py-4 bg-white border-b sticky top-0 z-10 flex items-center gap-3 shadow-sm">
          <Link href="/fields" className="w-10 h-10 flex items-center justify-center -ml-2 rounded-full hover:bg-muted text-foreground">
            <ChevronLeft className="w-6 h-6" />
          </Link>
          <div className="flex-1 min-w-0">
            <h1 className="text-lg font-bold truncate">{camera}</h1>
          </div>
        </header>
        <div className="animate-pulse p-4 space-y-3">
          {[1, 2, 3].map((i) => <div key={i} className="h-16 bg-muted rounded-xl" />)}
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 bg-background flex flex-col h-full overflow-hidden">
      {/* Header */}
      <header className="pt-safe px-4 py-4 bg-white border-b sticky top-0 z-10 flex items-center gap-3 shadow-sm">
        <Link href="/fields" className="w-10 h-10 flex items-center justify-center -ml-2 rounded-full hover:bg-muted text-foreground">
          <ChevronLeft className="w-6 h-6" />
        </Link>
        <div className="flex-1 min-w-0">
          <h1 className="text-lg font-bold truncate">{camera}</h1>
          <p className="text-xs text-muted-foreground truncate">
            {allVideos.length} recordings
          </p>
        </div>
      </header>

      {/* Field image banner */}
      {data?.fieldImageUrl && (
        <div className="relative h-32 overflow-hidden shrink-0">
          <img
            src={data.fieldImageUrl}
            alt={`${camera} field`}
            className="w-full h-full object-cover"
          />
          <div className="absolute inset-0 bg-gradient-to-t from-background/80 to-transparent" />
        </div>
      )}

      <div className="flex-1 overflow-y-auto pb-24">
        {/* Date selector */}
        {dates.length > 0 && (
          <div className="px-4 py-3 flex gap-2 overflow-x-auto no-scrollbar border-b bg-white sticky top-0 z-10">
            {dates.map((d) => (
              <button
                key={d}
                onClick={() => setSelectedDate(d)}
                className={`whitespace-nowrap px-4 py-1.5 rounded-full text-sm font-medium transition-colors ${
                  d === currentDate
                    ? "bg-foreground text-background"
                    : "bg-muted text-muted-foreground hover:bg-border"
                }`}
              >
                {formatDateLabel(d)}
              </button>
            ))}
          </div>
        )}

        {/* Video list */}
        <div className="p-4 space-y-3">
          {visibleVideos.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              No recordings for this date.
            </div>
          ) : (
            visibleVideos.map((v, i) => {
              const d = dateFromKey(v.key);
              const t = timeFromFilename(v.filename) ?? v.time ?? null;
              return (
                <div
                  key={v.key}
                  className="bg-card border border-border rounded-xl p-4 shadow-sm flex items-center justify-between gap-4"
                >
                  <div className="flex-1 min-w-0 space-y-1.5">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-bold text-primary bg-primary/10 px-2 py-0.5 rounded uppercase flex items-center gap-1">
                        <Video className="w-3 h-3" />
                        Clip {String(i + 1).padStart(2, "0")}
                      </span>
                    </div>
                    <div className="flex items-center gap-3 text-sm text-muted-foreground">
                      {d && (
                        <div className="flex items-center gap-1.5">
                          <Calendar className="w-3.5 h-3.5" />
                          {formatDateLabel(d)}
                        </div>
                      )}
                      {t && (
                        <div className="text-xs font-mono bg-muted px-1.5 py-0.5 rounded">
                          {t}
                        </div>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground truncate font-mono">
                      {v.filename}
                    </p>
                  </div>
                  <Button
                    size="icon"
                    onClick={() => handlePlay(v)}
                    className="w-12 h-12 rounded-full shrink-0 shadow-md bg-primary hover:bg-primary/90 text-white"
                  >
                    <Play className="w-5 h-5 ml-0.5" />
                  </Button>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
