import { useState, useMemo } from "react";
import { Link, useRoute, useLocation } from "wouter";
import {
  useFCCompute,
  dateFromKey,
  timeFromFilename,
  formatDateLabel,
  storeOSSVideos,
  extractHLSChunks,
  getHLSMasterUrl,
} from "@/lib/fc";
import { ChevronLeft, Clock, Radio } from "lucide-react";

export default function FieldDetail() {
  const [, params] = useRoute("/fields/:camera");
  const camera = decodeURIComponent(params?.camera ?? "Cam01");
  const [, navigate] = useLocation();

  // Reuse the same no-camera cache already populated by the fields list page
  const { data, isLoading } = useFCCompute();

  // Direct MP4 entries for this camera
  const mp4Videos = useMemo(
    () =>
      (data?.videos ?? []).filter(
        (v) =>
          v.key.startsWith(camera + "/") &&
          !v.key.includes("/hls/") &&
          v.filename !== "init.mp4"
      ),
    [data, camera]
  );

  // HLS chunk entries for this camera
  const hlsChunks = useMemo(
    () =>
      extractHLSChunks(
        (data?.videos ?? []).filter((v) => v.key.startsWith(camera + "/"))
      ),
    [data, camera]
  );

  // All unique dates across both sources
  const dates = useMemo(() => {
    const set = new Set<string>();
    for (const v of mp4Videos) {
      const d = dateFromKey(v.key);
      if (d) set.add(d);
    }
    for (const c of hlsChunks) {
      if (c.date) set.add(c.date);
    }
    return Array.from(set).sort((a, b) => b.localeCompare(a));
  }, [mp4Videos, hlsChunks]);

  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const currentDate = selectedDate ?? dates[0] ?? null;

  const mp4ForDate = useMemo(
    () => mp4Videos.filter((v) => dateFromKey(v.key) === currentDate),
    [mp4Videos, currentDate]
  );
  const hlsForDate = useMemo(
    () => hlsChunks.filter((c) => c.date === currentDate),
    [hlsChunks, currentDate]
  );

  const allVideos = useMemo(
    () => [...mp4ForDate, ...hlsForDate],
    [mp4ForDate, hlsForDate]
  );

  function handlePlay(index: number) {
    const mp4Entries = mp4ForDate.map((v) => ({
      url: v.url,
      filename: v.filename,
      date: dateFromKey(v.key) ?? "",
      time: timeFromFilename(v.filename) ?? "",
      isHLS: false,
    }));

    const hlsEntries = hlsForDate.map((c) => ({
      url: getHLSMasterUrl(c.chunkKey),
      filename: c.chunkKey.split("/").pop() ?? c.chunkKey,
      date: c.date,
      time: c.time,
      isHLS: true,
    }));

    storeOSSVideos({ videos: [...mp4Entries, ...hlsEntries], startIndex: index, camera });
    navigate("/oss-player");
  }

  const totalForDate = allVideos.length;

  return (
    <div className="flex-1 bg-background flex flex-col h-full overflow-hidden">
      {/* Header */}
      <header className="pt-safe px-4 py-4 bg-white border-b sticky top-0 z-10 flex items-center gap-3 shadow-sm">
        <Link
          href="/fields"
          className="w-10 h-10 flex items-center justify-center -ml-2 rounded-full hover:bg-muted text-foreground"
        >
          <ChevronLeft className="w-6 h-6" />
        </Link>
        <div className="flex-1 min-w-0">
          <h1 className="text-lg font-bold truncate">{camera}</h1>
          <p className="text-xs text-muted-foreground">
            {isLoading
              ? "Loading…"
              : `${mp4Videos.length + hlsChunks.length} recordings`}
          </p>
        </div>
      </header>

      {/* Field image banner */}
      {data?.fieldImageUrl && (
        <div className="relative h-36 overflow-hidden shrink-0">
          <img
            src={data.fieldImageUrl}
            alt={`${camera} field`}
            className="w-full h-full object-cover"
          />
          <div className="absolute inset-0 bg-gradient-to-t from-background/80 to-transparent" />
        </div>
      )}

      <div className="flex-1 overflow-y-auto pb-24">
        {isLoading ? (
          <div className="animate-pulse p-4 space-y-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-12 bg-muted rounded-xl" />
            ))}
          </div>
        ) : (
          <>
            {/* Date pills */}
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

            {/* Time selector grid */}
            <div className="p-4">
              {currentDate && (
                <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide mb-3">
                  {formatDateLabel(currentDate)} — pick a time
                </p>
              )}

              {totalForDate === 0 ? (
                <div className="text-center py-12 text-muted-foreground">
                  No recordings for this date.
                </div>
              ) : (
                <div className="grid grid-cols-3 gap-3">
                  {/* MP4 chips */}
                  {mp4ForDate.map((v, i) => {
                    const t = timeFromFilename(v.filename);
                    return (
                      <button
                        key={v.key}
                        onClick={() => handlePlay(i)}
                        className="flex flex-col items-center gap-1.5 bg-card border border-border rounded-2xl py-4 px-2 shadow-sm hover:border-primary hover:shadow-md active:scale-95 transition-all group disabled:opacity-50"
                      >
                        <div className="w-9 h-9 rounded-full bg-primary/10 flex items-center justify-center group-hover:bg-primary group-active:bg-primary transition-colors">
                          <Clock className="w-4 h-4 text-primary group-hover:text-white group-active:text-white" />
                        </div>
                        <span className="text-sm font-bold text-foreground font-mono">
                          {t ?? `Clip ${i + 1}`}
                        </span>
                      </button>
                    );
                  })}

                  {/* HLS chips */}
                  {hlsForDate.map((c, i) => (
                    <button
                      key={c.chunkKey}
                      onClick={() => handlePlay(mp4ForDate.length + i)}
                      className="flex flex-col items-center gap-1.5 bg-card border border-border rounded-2xl py-4 px-2 shadow-sm hover:border-primary hover:shadow-md active:scale-95 transition-all group disabled:opacity-50"
                    >
                      <div className="w-9 h-9 rounded-full bg-primary/10 flex items-center justify-center group-hover:bg-primary group-active:bg-primary transition-colors">
                        <Radio className="w-4 h-4 text-primary group-hover:text-white group-active:text-white" />
                      </div>
                      <span className="text-sm font-bold text-foreground font-mono">
                        {c.time || `HLS ${i + 1}`}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>

    </div>
  );
}
