import { useMemo, useState } from "react";
import { AnimatePresence } from "framer-motion";
import { useQueryClient } from "@tanstack/react-query";
import {
  getListAcademyConsoleSessionsQueryKey,
  getListAcademyConsoleRecordingsQueryKey,
  useListAcademyConsoleSessions,
  useListAcademyConsoleRecordings,
  useUpdateAcademyConsoleRecordingSession,
  type AcademySessionSummary,
  type AcademyConsoleRecording,
} from "@workspace/api-client-react";
import { CalendarDays, Play, Video } from "lucide-react";
import { ClipPlayer } from "@/components/clip-player/ClipPlayer";
import { getBunnyMp4FallbackSource } from "@/lib/bunnyPlayback";
import { useTranslation } from "@/i18n";
import { Button } from "@/components/ui/button";
import { formatAmmanDateTime } from "@/lib/academy-session-time";
import { getRecordingViewInput } from "@/lib/recording-view-tracking";
import { useRecordingViewTracking } from "@/lib/use-recording-view-tracking";

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
  const queryClient = useQueryClient();
  const recordingsQuery = useListAcademyConsoleRecordings(academyId, {
    query: { queryKey: getListAcademyConsoleRecordingsQueryKey(academyId), staleTime: 60_000 },
  });
  const sessionsQuery = useListAcademyConsoleSessions(academyId, {
    query: { queryKey: getListAcademyConsoleSessionsQueryKey(academyId), staleTime: 20_000 },
  });
  const updateRecordingSession = useUpdateAcademyConsoleRecordingSession();
  const recordings = useMemo(() => [...(recordingsQuery.data ?? [])].sort((a, b) => (
    `${b.date} ${b.timeSlot}`.localeCompare(`${a.date} ${a.timeSlot}`)
  )), [recordingsQuery.data]);
  const [playing, setPlaying] = useState<AcademyConsoleRecording | null>(null);
  const viewTracking = useRecordingViewTracking(
    playing?.videoUrl ? getRecordingViewInput(playing) : null,
  );
  const [assignmentErrors, setAssignmentErrors] = useState<Record<number, boolean>>({});
  const sessions = sessionsQuery.data ?? [];
  const dateFormat = new Intl.DateTimeFormat(locale === "ar" ? "ar-JO" : "en-GB", { dateStyle: "medium", timeZone: "Asia/Amman" });
  const formatDate = (date: string) => {
    const parsed = new Date(`${date}T12:00:00+03:00`);
    return Number.isNaN(parsed.getTime()) ? date : dateFormat.format(parsed);
  };
  const candidateSessions = (recording: AcademyConsoleRecording) => sessions.filter((session) => (
    session.id === recording.sessionId
    || (session.fieldId === recording.fieldId && Math.abs(
      Date.parse(`${formatAmmanDateTime(session.startsAt, "en").dateKey}T00:00:00Z`)
        - Date.parse(`${recording.date}T00:00:00Z`),
    ) <= 24 * 60 * 60 * 1000)
  ));
  const assignRecording = async (recording: AcademyConsoleRecording, rawSessionId: string) => {
    const sessionId = rawSessionId ? Number(rawSessionId) : null;
    if (sessionId === recording.sessionId || !Number.isSafeInteger(sessionId ?? 0)) return;
    setAssignmentErrors((current) => ({ ...current, [recording.id]: false }));
    try {
      const updated = await updateRecordingSession.mutateAsync({
        academyId,
        recordingId: recording.id,
        data: { sessionId },
      });
      queryClient.setQueryData<AcademyConsoleRecording[]>(
        getListAcademyConsoleRecordingsQueryKey(academyId),
        (current) => current?.map((item) => item.id === updated.id ? updated : item),
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: getListAcademyConsoleRecordingsQueryKey(academyId) }),
        queryClient.invalidateQueries({ queryKey: getListAcademyConsoleSessionsQueryKey(academyId) }),
      ]);
    } catch {
      setAssignmentErrors((current) => ({ ...current, [recording.id]: true }));
    }
  };

  return (
    <section className="space-y-6" data-testid="academy-recordings">
      <header>
        <p className="text-xs font-bold uppercase tracking-[0.18em] text-turf">{t.academyConsole.workspace}</p>
        <h1 className="mt-2 font-display text-4xl font-bold tracking-tight text-text">{t.academyConsole.recordings}</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-text">{copy.description}</p>
      </header>
      {sessionsQuery.isError && <p className="rounded-xl border border-destructive/20 bg-destructive/5 p-3 text-sm text-destructive" role="alert">{copy.sessionsLoadError}</p>}
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
              {recording.sessionLabel && <p className="mt-2 text-xs font-semibold text-turf" data-testid={`recording-session-label-${recording.id}`}>{copy.session}: {recording.sessionLabel}</p>}
              <div className="mt-3 flex flex-col gap-1.5 sm:max-w-md">
                <label htmlFor={`recording-session-${recording.id}`} className="text-xs font-semibold text-muted-text">{copy.session}</label>
                <select
                  id={`recording-session-${recording.id}`}
                  value={recording.sessionId ?? ""}
                  onChange={(event) => void assignRecording(recording, event.target.value)}
                  disabled={sessionsQuery.isLoading || sessionsQuery.isError || updateRecordingSession.isPending}
                  className="min-h-10 w-full rounded-lg border border-input bg-raised px-3 text-start text-sm text-text"
                  data-testid={`select-recording-session-${recording.id}`}
                >
                  <option value="">{copy.noSession}</option>
                  {candidateSessions(recording).map((session: AcademySessionSummary) => {
                    const formatted = formatAmmanDateTime(session.startsAt, locale);
                    return <option key={session.id} value={session.id}>
                      {formatted.date} · {formatted.time} · {session.location}
                    </option>;
                  })}
                </select>
                {assignmentErrors[recording.id] && <span role="alert" className="text-xs text-destructive" data-testid={`recording-session-error-${recording.id}`}>{copy.assignmentError}</span>}
              </div>
            </div>
            {recording.videoUrl ? <Button type="button" onClick={() => setPlaying(recording)} className="min-h-10 rounded-xl bg-floodlight px-4 font-bold text-void hover:bg-floodlight/90" data-testid={`button-play-recording-${recording.id}`}><Play className="me-2 h-4 w-4" aria-hidden="true" />{copy.play}</Button> : <span className="self-start rounded-full border border-line px-3 py-1.5 text-xs font-semibold text-muted-text sm:self-center">{copy.noPlayback}</span>}
          </article>)}
        </div>}
      <AnimatePresence>
        {playing?.videoUrl && <ClipPlayer
          src={playing.videoUrl}
          proxySrc={`/api/hls-proxy/manifest?url=${encodeURIComponent(playing.videoUrl)}`}
          fallbackSrc={getBunnyMp4FallbackSource(playing.videoUrl)}
          title={`${academyName} · ${playing.date} · ${playing.timeSlot}`}
          source={{ kind: "bunny", videoId: extractBunnyGuid(playing.videoUrl) }}
          academyId={academyId}
          layout="overlay"
          canSave={false}
          onPlaybackStart={viewTracking.onPlaybackStart}
          onPlaybackProgress={viewTracking.onPlaybackProgress}
          onRequireAuth={() => setPlaying(null)}
          onSave={async () => {
            throw new Error(copy.description);
          }}
          onClose={() => {
            viewTracking.flush();
            setPlaying(null);
          }}
        />}
      </AnimatePresence>
    </section>
  );
}