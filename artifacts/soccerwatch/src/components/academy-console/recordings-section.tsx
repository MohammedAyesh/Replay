import { useMemo, useState } from "react";
import { AnimatePresence } from "framer-motion";
import {
  getListAcademyConsoleRecordingsQueryKey,
  useListAcademyConsoleRecordings,
  type AcademyConsoleRecording,
} from "@workspace/api-client-react";
import { CalendarDays, Play, Video } from "lucide-react";
import { ClipPlayer } from "@/components/clip-player/ClipPlayer";
import { useTranslation } from "@/i18n";
import { getBunnyMp4FallbackSource } from "@/lib/bunnyPlayback";
import { Button } from "@/components/ui/button";

function extractBunnyGuid(videoUrl: string): string {
  try {
    return new URL(videoUrl).pathname.split("/").filter(Boolean)[0] ?? videoUrl;
  } catch {
    return videoUrl;
  }
}

export function AcademyRecordingsSection({ academyId, academyName }: { academyId: number; academyName: string }) {
  const { t, locale } = useTranslation();
  const copy = t.academyConsole.recordingsPanel;
  const recordingsQuery = useListAcademyConsoleRecordings(academyId, {
    query: { queryKey: getListAcademyConsoleRecordingsQueryKey(academyId), staleTime: 60_000 },
  });
  const recordings = useMemo(() => [...(recordingsQuery.data ?? [])].sort((a, b) => (
    `${b.date} ${b.timeSlot}`.localeCompare(`${a.date} ${a.timeSlot}`)
  )), [recordingsQuery.data]);
  const [playing, setPlaying] = useState<AcademyConsoleRecording | null>(null);
  const dateFormat = new Intl.DateTimeFormat(locale === "ar" ? "ar-JO" : "en-GB", { dateStyle: "medium", timeZone: "Asia/Amman" });
  const formatDate = (date: string) => {
    const parsed = new Date(`${date}T12:00:00+03:00`);
    return Number.isNaN(parsed.getTime()) ? date : dateFormat.format(parsed);
  };

  return (
    <section className="space-y-6" data-testid="academy-recordings">
      <header>
        <p className="text-xs font-bold uppercase tracking-[0.18em] text-turf">{t.academyConsole.workspace}</p>
        <h1 className="mt-2 font-display text-4xl font-bold tracking-tight text-text">{t.academyConsole.recordings}</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-text">{copy.description}</p>
      </header>
      {recordingsQuery.isLoading ? <div className="space-y-3" data-testid="academy-recordings-loading" aria-label={copy.loading}>{[0, 1, 2].map((item) => <div key={item} className="h-24 animate-pulse rounded-2xl border border-line bg-surface" />)}</div> :
        recordingsQuery.isError ? <div className="rounded-2xl border border-line bg-surface p-6" data-testid="academy-recordings-error"><p role="alert" className="text-sm text-muted-text">{copy.loadError}</p><Button type="button" variant="outline" className="mt-4 min-h-10" onClick={() => void recordingsQuery.refetch()}>{t.academyConsole.retry}</Button></div> :
        recordings.length === 0 ? <div className="rounded-2xl border border-dashed border-line bg-surface p-9 text-center" data-testid="academy-recordings-empty"><span className="mx-auto grid h-12 w-12 place-items-center rounded-xl bg-turf/10 text-turf"><Video className="h-5 w-5" aria-hidden="true" /></span><h2 className="mt-4 font-display text-xl font-bold text-text">{copy.emptyTitle}</h2><p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted-text">{copy.emptyDescription}</p></div> :
        <div className="space-y-3" data-testid="academy-recordings-list">
          {recordings.map((recording) => <article key={recording.id} className="flex flex-col gap-4 rounded-2xl border border-line bg-surface p-4 transition-colors hover:border-turf/35 sm:flex-row sm:items-center sm:px-5" data-testid={`academy-recording-${recording.id}`}>
            <div className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-raised text-turf"><Video className="h-5 w-5" aria-hidden="true" /></div>
            <div className="min-w-0 flex-1">
              <h2 className="font-display text-lg font-bold text-text">{recording.fieldName || academyName}</h2>
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-text">
                <span className="inline-flex items-center gap-1.5"><CalendarDays className="h-3.5 w-3.5" aria-hidden="true" />{formatDate(recording.date)}</span>
                <span dir="auto">{recording.timeSlot}</span><span>{recording.court}</span><span>{recording.duration}</span>
                {recording.score && <span className="font-semibold text-text">{recording.score}</span>}
              </div>
            </div>
            {recording.videoUrl ? <Button type="button" onClick={() => setPlaying(recording)} className="min-h-10 rounded-xl bg-floodlight px-4 font-bold text-void hover:bg-floodlight/90" data-testid={`button-play-recording-${recording.id}`}><Play className="me-2 h-4 w-4" aria-hidden="true" />{copy.play}</Button> : <span className="self-start rounded-full border border-line px-3 py-1.5 text-xs font-semibold text-muted-text sm:self-center">{copy.noPlayback}</span>}
          </article>)}
        </div>}
      <AnimatePresence>
        {playing?.videoUrl && <ClipPlayer
          src={playing.videoUrl}
          proxySrc={`/api/hls-proxy/manifest?url=${encodeURIComponent(playing.videoUrl)}`}
          fallbackSrc={getBunnyMp4FallbackSource(playing.videoUrl, extractBunnyGuid(playing.videoUrl)) ?? undefined}
          title={`${academyName} · ${playing.date} · ${playing.timeSlot}`}
          source={{ kind: "bunny", videoId: extractBunnyGuid(playing.videoUrl) }}
          academyId={academyId}
          layout="overlay"
          canSave={false}
          onRequireAuth={() => setPlaying(null)}
          onSave={async () => {
            throw new Error(copy.description);
          }}
          onClose={() => setPlaying(null)}
        />}
      </AnimatePresence>
    </section>
  );
}