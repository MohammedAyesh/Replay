import { useEffect, useMemo, useState } from "react";
import { useLocation, useSearch } from "wouter";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import {
  getGetAcademyConsoleAttendanceQueryKey,
  getGetAcademyConsoleAttendanceQueryOptions,
  getListAcademyConsolePlayersQueryKey,
  getListAcademyConsoleSessionsQueryKey,
  useGetAcademyConsoleAttendance,
  useListAcademyConsolePlayers,
  useListAcademyConsoleSessions,
  useUpdateAcademyConsoleAttendance,
  type AcademyAttendanceStatusAssignmentStatus,
  type AcademySessionSummary,
} from "@workspace/api-client-react";
import { ArrowLeft, ArrowRight, CalendarCheck2, Check, Clock3, MapPin } from "lucide-react";
import { useTranslation } from "@/i18n";
import { Button } from "@/components/ui/button";
import { formatAmmanDateTime } from "@/lib/academy-session-time";
import { computeMonthlyAttendanceInsights } from "@/lib/academy-attendance-insights";

type AttendanceStatus = AcademyAttendanceStatusAssignmentStatus;
const statuses: AttendanceStatus[] = ["present", "absent", "late", "excused"];
const AMMAN = "Asia/Amman";

function monthKey(session: AcademySessionSummary) {
  return formatAmmanDateTime(session.startsAt, "en").dateKey.slice(0, 7);
}

function monthLabel(key: string, locale: string) {
  const [year, month] = key.split("-").map(Number);
  return new Intl.DateTimeFormat(locale === "ar" ? "ar-JO" : "en-GB", {
    timeZone: AMMAN,
    month: "long",
    year: "numeric",
  }).format(new Date(Date.UTC(year, month - 1, 15, 12)));
}

function monthNumber(key: string) {
  const [year, month] = key.split("-").map(Number);
  return year * 12 + month;
}

function defaultSession(sessions: AcademySessionSummary[]) {
  const now = Date.now();
  const past = sessions.filter((session) => Date.parse(session.startsAt) <= now)
    .sort((a, b) => Date.parse(b.startsAt) - Date.parse(a.startsAt));
  if (past.length) return past[0];
  return [...sessions].sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))[0];
}

export function AcademyAttendanceSection({ academyId }: { academyId: number }) {
  const { t, locale } = useTranslation();
  const copy = t.academyConsole.attendancePanel;
  const [location, setLocation] = useLocation();
  const search = useSearch();
  const qc = useQueryClient();
  const sessionsQuery = useListAcademyConsoleSessions(academyId, {
    query: { queryKey: getListAcademyConsoleSessionsQueryKey(academyId), staleTime: 20_000 },
  });
  const playersQuery = useListAcademyConsolePlayers(academyId, {
    query: { queryKey: getListAcademyConsolePlayersQueryKey(academyId), staleTime: 20_000 },
  });
  const sessions = useMemo(
    () => [...(sessionsQuery.data ?? [])].sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt)),
    [sessionsQuery.data],
  );
  const requestedSessionId = useMemo(() => {
    const value = new URLSearchParams(search).get("sessionId");
    const parsed = value ? Number(value) : null;
    return parsed && Number.isSafeInteger(parsed) ? parsed : null;
  }, [search]);
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [activeMonth, setActiveMonth] = useState("");

  useEffect(() => {
    if (!sessions.length) {
      setSessionId(null);
      setActiveMonth("");
      return;
    }
    const requested = requestedSessionId
      ? sessions.find((session) => session.id === requestedSessionId)
      : undefined;
    const current = sessions.find((session) => session.id === sessionId);
    const next = requested ?? current ?? defaultSession(sessions);
    if (!next) return;
    setSessionId(next.id);
    setActiveMonth(monthKey(next));
  }, [sessions, requestedSessionId, sessionId]);

  const months = useMemo(() => {
    const sessionMonths = sessions.map(monthKey);
    if (!sessionMonths.length) return [];
    const currentMonth = monthNumber(formatAmmanDateTime(new Date().toISOString(), "en").dateKey.slice(0, 7));
    const first = Math.min(currentMonth, ...sessionMonths.map(monthNumber));
    const last = Math.max(currentMonth + 6, ...sessionMonths.map(monthNumber));
    return Array.from({ length: last - first + 1 }, (_, index) => {
      const absolute = first + index;
      const year = Math.floor((absolute - 1) / 12);
      const month = ((absolute - 1) % 12) + 1;
      return `${year}-${String(month).padStart(2, "0")}`;
    });
  }, [sessions]);
  const monthIndex = months.indexOf(activeMonth);
  const monthSessions = useMemo(
    () => sessions.filter((session) => monthKey(session) === activeMonth),
    [sessions, activeMonth],
  );
  const dateGroups = useMemo(() => {
    const groups = new Map<string, AcademySessionSummary[]>();
    for (const session of monthSessions) {
      const key = formatAmmanDateTime(session.startsAt, locale).dateKey;
      groups.set(key, [...(groups.get(key) ?? []), session]);
    }
    return [...groups.entries()];
  }, [monthSessions, locale]);
  const selectedSession = sessions.find((session) => session.id === sessionId);
  const attendanceQuery = useGetAcademyConsoleAttendance(academyId, sessionId ?? 0, {
    query: {
      enabled: sessionId !== null,
      queryKey: getGetAcademyConsoleAttendanceQueryKey(academyId, sessionId ?? 0),
    },
  });
  const monthAttendanceQueries = useQueries({
    queries: monthSessions.map((session) => getGetAcademyConsoleAttendanceQueryOptions(academyId, session.id, {
      query: {
        queryKey: getGetAcademyConsoleAttendanceQueryKey(academyId, session.id),
        staleTime: 20_000,
      },
    })),
  });
  const monthlyInsights = computeMonthlyAttendanceInsights(
    monthAttendanceQueries.flatMap((query) => query.data?.players ?? []),
  );
  const updateAttendance = useUpdateAcademyConsoleAttendance();
  const [marks, setMarks] = useState<Record<number, AttendanceStatus>>({});
  const [saveError, setSaveError] = useState(false);

  useEffect(() => {
    if (!attendanceQuery.data || attendanceQuery.data.sessionId !== sessionId) return;
    setMarks(Object.fromEntries(attendanceQuery.data.players.flatMap((player) => (
      player.status ? [[player.playerId, player.status as AttendanceStatus]] : []
    ))));
  }, [attendanceQuery.data, sessionId]);

  const roster = useMemo(() => {
    const saved = attendanceQuery.data?.players ?? [];
    if (selectedSession?.squadId !== null && selectedSession?.squadId !== undefined) return saved;
    const savedById = new Map(saved.map((player) => [player.playerId, player]));
    return (playersQuery.data ?? []).filter((player) => player.isActive).map((player) => {
      const existing = savedById.get(player.id);
      return {
        playerId: player.id,
        playerName: player.name,
        jerseyNumber: player.jerseyNumber,
        status: existing?.status ?? null,
      };
    });
  }, [attendanceQuery.data, playersQuery.data, selectedSession]);
  const dirty = roster.some((player) => marks[player.playerId] !== (player.status ?? undefined));

  const selectSession = (session: AcademySessionSummary) => {
    setSessionId(session.id);
    setActiveMonth(monthKey(session));
    setSaveError(false);
    setLocation(`/academy/attendance?sessionId=${session.id}`);
  };

  const save = async () => {
    if (!selectedSession) return;
    setSaveError(false);
    try {
      await updateAttendance.mutateAsync({
        academyId,
        sessionId: selectedSession.id,
        data: { entries: roster.flatMap((player) => {
          const status = marks[player.playerId] ?? player.status;
          return status ? [{ playerId: player.playerId, status }] : [];
        }) },
      });
      await Promise.all([
        qc.invalidateQueries({ queryKey: getGetAcademyConsoleAttendanceQueryKey(academyId, selectedSession.id) }),
        qc.invalidateQueries({ queryKey: getListAcademyConsoleSessionsQueryKey(academyId) }),
      ]);
    } catch {
      setSaveError(true);
    }
  };

  const loading = sessionsQuery.isLoading || playersQuery.isLoading || (sessionId !== null && attendanceQuery.isLoading);
  const isArabic = locale === "ar";
  return (
    <section className="space-y-6" data-testid="academy-attendance">
      <header>
        <p className="text-xs font-bold uppercase tracking-[0.18em] text-turf">{t.academyConsole.workspace}</p>
        <h1 className="mt-2 font-display text-4xl font-bold tracking-tight text-text">{t.academyConsole.attendance}</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-text">{copy.description}</p>
      </header>
      {sessionsQuery.isError ? <PanelAlert text={copy.loadError} retry={() => void sessionsQuery.refetch()} retryText={t.academyConsole.retry} /> :
        sessionsQuery.isLoading ? <div className="space-y-3" data-testid="academy-attendance-loading"><div className="h-24 animate-pulse rounded-2xl bg-surface" /><div className="h-48 animate-pulse rounded-2xl bg-surface" /></div> :
        sessions.length === 0 ? <div className="rounded-2xl border border-dashed border-line bg-surface p-8 text-center" data-testid="academy-attendance-empty"><CalendarCheck2 className="mx-auto h-8 w-8 text-turf" /><h2 className="mt-3 font-display text-xl font-bold text-text">{copy.noSessions}</h2><p className="mt-1 text-sm text-muted-text">{copy.noSessionsHint}</p></div> :
        <>
          <div className="grid gap-4 lg:grid-cols-[minmax(17rem,0.82fr)_minmax(0,1.18fr)]">
            <section className="overflow-hidden rounded-2xl border border-line bg-surface" aria-label={copy.chooseSession} data-testid="attendance-session-browser">
              <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
                <div className="min-w-0">
                  <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-muted-text">{copy.chooseSession}</p>
                  <h2 className="mt-1 truncate font-display text-lg font-bold text-text" aria-live="polite" data-testid="text-attendance-active-month">
                    {monthLabel(activeMonth || months[0], locale)}
                  </h2>
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button type="button" variant="outline" size="icon" aria-label={copy.previousMonth} disabled={monthIndex <= 0} onClick={() => setActiveMonth(months[monthIndex - 1])} data-testid="button-attendance-previous-month">
                    {isArabic ? <ArrowRight className="h-4 w-4" aria-hidden="true" /> : <ArrowLeft className="h-4 w-4" aria-hidden="true" />}
                  </Button>
                  <Button type="button" variant="outline" size="icon" aria-label={copy.nextMonth} disabled={monthIndex < 0 || monthIndex >= months.length - 1} onClick={() => setActiveMonth(months[monthIndex + 1])} data-testid="button-attendance-next-month">
                    {isArabic ? <ArrowLeft className="h-4 w-4" aria-hidden="true" /> : <ArrowRight className="h-4 w-4" aria-hidden="true" />}
                  </Button>
                </div>
              </div>
              <div className="max-h-[34rem] space-y-4 overflow-y-auto p-3" data-testid="attendance-month-session-list">
                {dateGroups.length ? dateGroups.map(([dateKey, daySessions]) => (
                  <div key={dateKey} data-testid={`attendance-date-group-${dateKey}`}>
                    <p className="px-2 pb-1.5 pt-1 text-[11px] font-bold uppercase tracking-wide text-muted-text">
                      {formatAmmanDateTime(daySessions[0].startsAt, locale).date}
                    </p>
                    <div className="space-y-1">
                      {daySessions.map((session) => {
                        const datetime = formatAmmanDateTime(session.startsAt, locale);
                        const active = session.id === sessionId;
                        return (
                          <button
                            key={session.id}
                            type="button"
                            aria-current={active ? "true" : undefined}
                            aria-pressed={active}
                            onClick={() => selectSession(session)}
                            className={`flex min-h-14 w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-start transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-turf ${active ? "border-turf/50 bg-turf/10" : "border-transparent hover:bg-raised"}`}
                            data-testid={`button-select-attendance-session-${session.id}`}
                          >
                            <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg text-xs font-bold tabular-nums ${active ? "bg-turf text-void" : "bg-raised text-muted-text"}`}>{datetime.time}</span>
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm font-semibold text-text">{session.squadName || copy.academyWide}</span>
                              <span className="mt-0.5 block truncate text-xs text-muted-text">{session.type === "match" ? t.academyConsole.schedule.match : t.academyConsole.schedule.training} · {session.location}</span>
                            </span>
                            {active && <span className="h-2 w-2 shrink-0 rounded-full bg-turf" aria-hidden="true" />}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )) : <p className="rounded-xl border border-dashed border-line px-4 py-7 text-center text-sm text-muted-text" data-testid="attendance-month-empty">{copy.noSessionsThisMonth}</p>}
              </div>
            </section>
            <div className="min-w-0 space-y-4">
              {selectedSession && (
                <section className="rounded-2xl border border-line bg-surface p-4 sm:p-5" data-testid={`attendance-session-summary-${selectedSession.id}`}>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-turf">{selectedSession.type === "match" ? t.academyConsole.schedule.match : t.academyConsole.schedule.training}</p>
                      <h2 className="mt-1 font-display text-xl font-bold text-text">{selectedSession.squadName || copy.academyWide}</h2>
                    </div>
                    <div className="flex flex-wrap gap-x-4 gap-y-2 text-xs text-muted-text">
                      <span className="inline-flex items-center gap-1.5"><CalendarCheck2 className="h-3.5 w-3.5 text-turf" aria-hidden="true" />{formatAmmanDateTime(selectedSession.startsAt, locale).date}</span>
                      <span className="inline-flex items-center gap-1.5"><Clock3 className="h-3.5 w-3.5 text-turf" aria-hidden="true" />{formatAmmanDateTime(selectedSession.startsAt, locale).time}</span>
                      <span className="inline-flex items-center gap-1.5"><MapPin className="h-3.5 w-3.5 text-turf" aria-hidden="true" />{selectedSession.location}</span>
                    </div>
                  </div>
                  <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid={`attendance-saved-counts-${selectedSession.id}`}>
                    {statuses.map((status) => <div key={status} className="rounded-lg border border-line bg-raised px-3 py-2"><span className="block text-[10px] font-semibold text-muted-text">{copy[status]}</span><b className="mt-1 block font-display text-lg tabular-nums text-text" data-testid={`attendance-count-${status}`}>{selectedSession.attendanceCounts[status]}</b></div>)}
                  </div>
                </section>
              )}
              {attendanceQuery.isError || playersQuery.isError ? <PanelAlert text={copy.loadError} retry={() => void (attendanceQuery.isError ? attendanceQuery.refetch() : playersQuery.refetch())} retryText={t.academyConsole.retry} /> :
                loading ? <div className="space-y-2" data-testid="attendance-roster-loading">{[0, 1, 2].map((n) => <div key={n} className="h-16 animate-pulse rounded-xl bg-surface" />)}</div> :
                roster.length === 0 ? <div className="rounded-2xl border border-dashed border-line bg-surface p-7 text-center text-sm text-muted-text" data-testid="attendance-roster-empty">{copy.noPlayers}</div> :
                <div className="overflow-hidden rounded-2xl border border-line bg-surface">
                  <div className="flex items-center justify-between border-b border-line px-4 py-3"><h2 className="font-display text-lg font-bold text-text">{selectedSession?.squadName ?? copy.academyWide}</h2><span className="text-xs text-muted-text">{roster.length} {copy.players}</span></div>
                  <div className="divide-y divide-line">
                    {roster.map((player) => <div key={player.playerId} className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between" data-testid={`attendance-player-${player.playerId}`}>
                      <div className="min-w-0"><p dir="auto" className="font-semibold text-text">{player.jerseyNumber !== null ? <span className="me-2 font-mono text-xs text-muted-text">#{player.jerseyNumber}</span> : null}{player.playerName}</p></div>
                      <div className="grid grid-cols-2 gap-1 rounded-xl bg-raised p-1 sm:flex" role="group" aria-label={`${copy.markStatus}: ${player.playerName}`}>
                        {statuses.map((status) => <button key={status} type="button" aria-pressed={marks[player.playerId] === status || (!marks[player.playerId] && player.status === status)} onClick={() => setMarks((prev) => ({ ...prev, [player.playerId]: status }))} className={`min-h-9 rounded-lg px-3 text-xs font-bold transition-colors ${marks[player.playerId] === status || (!marks[player.playerId] && player.status === status) ? "bg-turf text-void" : "text-muted-text hover:text-text"}`} data-testid={`attendance-${status}-${player.playerId}`}>{copy[status]}</button>)}
                      </div>
                    </div>)}
                  </div>
                </div>}
              {saveError && <p className="text-sm text-destructive" role="alert" data-testid="attendance-save-error">{copy.saveError}</p>}
              <div className="flex justify-end"><Button type="button" disabled={!roster.length || updateAttendance.isPending || (!dirty && !attendanceQuery.isError)} onClick={() => void save()} className="min-h-11 rounded-xl bg-floodlight px-5 font-bold text-void hover:bg-floodlight/90" data-testid="button-save-attendance"><Check className="me-2 h-4 w-4" aria-hidden="true" />{updateAttendance.isPending ? copy.saving : copy.save}</Button></div>
            </div>
          </div>
          <section className="rounded-2xl border border-line bg-surface p-4 sm:p-5" data-testid="attendance-monthly-insights">
            <div>
              <h2 className="font-display text-lg font-bold text-text">{copy.monthlyInsights}</h2>
              <p className="mt-1 text-xs text-muted-text">{monthLabel(activeMonth || months[0], locale)}</p>
            </div>
            {monthAttendanceQueries.some((query) => query.isError) ? (
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3" data-testid="attendance-insights-error">
                <p className="text-sm text-destructive" role="alert">{copy.monthlyInsightsError}</p>
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-10"
                  onClick={() => void Promise.all(monthAttendanceQueries.filter((query) => query.isError).map((query) => query.refetch()))}
                >
                  {t.academyConsole.retry}
                </Button>
              </div>
            ) : monthAttendanceQueries.some((query) => query.isLoading) ? (
              <div className="mt-4 h-20 animate-pulse rounded-xl bg-raised" data-testid="attendance-insights-loading" aria-label={copy.monthlyInsightsLoading} />
            ) : monthlyInsights.mostCommitted.length === 0 ? (
              <p className="mt-4 rounded-xl border border-dashed border-line px-4 py-5 text-center text-sm text-muted-text" data-testid="attendance-insights-empty">
                {copy.monthlyInsightsEmpty}
              </p>
            ) : (
              <div className="mt-4 grid gap-4 lg:grid-cols-2">
                <AttendanceInsightList
                  title={copy.mostCommitted}
                  summaries={monthlyInsights.mostCommitted}
                  locale={locale}
                  absenceRateLabel={copy.absenceRate}
                />
                <AttendanceInsightList
                  title={copy.mostAbsent}
                  summaries={monthlyInsights.mostAbsent}
                  locale={locale}
                  absenceRateLabel={copy.absenceRate}
                  needsAttention
                />
              </div>
            )}
          </section>
        </>}
    </section>
  );
}

function AttendanceInsightList({
  title,
  summaries,
  locale,
  absenceRateLabel,
  needsAttention = false,
}: {
  title: string;
  summaries: ReturnType<typeof computeMonthlyAttendanceInsights>["mostCommitted"];
  locale: string;
  absenceRateLabel: string;
  needsAttention?: boolean;
}) {
  const numberFormat = new Intl.NumberFormat(locale === "ar" ? "ar-JO" : "en-GB");
  const percentFormat = new Intl.NumberFormat(locale === "ar" ? "ar-JO" : "en-GB", {
    style: "percent",
    maximumFractionDigits: 0,
  });

  return (
    <section className="rounded-xl border border-line bg-raised/50 p-4" data-testid={needsAttention ? "attendance-most-absent" : "attendance-most-committed"}>
      <h3 className={`text-sm font-bold ${needsAttention ? "text-amber-200" : "text-turf"}`}>{title}</h3>
      <ol className="mt-3 space-y-2">
        {summaries.map((summary) => (
          <li
            key={summary.playerId}
            className={`flex min-h-10 items-center justify-between gap-3 rounded-lg px-3 py-2 ${needsAttention ? "border-s-2 border-amber-400 bg-amber-400/5" : "bg-surface"}`}
            data-testid={`attendance-insight-player-${summary.playerId}`}
          >
            <span className="min-w-0 truncate text-sm font-semibold text-text" dir="auto">{summary.playerName}</span>
            <span className={`flex shrink-0 items-center gap-1.5 text-xs font-bold tabular-nums ${needsAttention ? "text-amber-200" : "text-muted-text"}`} aria-label={`${absenceRateLabel}: ${percentFormat.format(summary.absenceRate)}; ${numberFormat.format(summary.absent)} / ${numberFormat.format(summary.countedRecords)}`}>
              <bdi>{percentFormat.format(summary.absenceRate)}</bdi>
              <span aria-hidden="true">·</span>
              <bdi dir="ltr">{numberFormat.format(summary.absent)}/{numberFormat.format(summary.countedRecords)}</bdi>
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function PanelAlert({ text, retry, retryText }: { text: string; retry: () => void; retryText: string }) {
  return <div className="rounded-2xl border border-line bg-surface p-5" role="alert" data-testid="academy-attendance-error"><p className="text-sm text-muted-text">{text}</p><Button type="button" variant="outline" className="mt-3 min-h-10" onClick={retry}>{retryText}</Button></div>;
}