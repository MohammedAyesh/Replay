import { useState } from "react";
import { CalendarClock, Check, Clock, Eye, Film, Loader2, Send } from "lucide-react";
import { useListAcademyConsoleSessions, getListAcademyConsoleSessionsQueryKey, type AcademySessionSummary } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useMarketingCopy } from "@/i18n/marketing-strings";
import { formatMoment, parseMoment, useMakeTrialClip, useSendTrialClip, useSetTrialSession, useTrials, type TrialView } from "@/lib/academy-trials-api";
import { cn } from "@/lib/utils";

const DAY = 86_400_000;

function when(iso: string, locale: "ar" | "en") {
  return new Intl.DateTimeFormat(locale === "ar" ? "ar-JO-u-nu-latn" : "en-GB", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Amman" }).format(new Date(iso));
}

function errorCode(e: unknown): string {
  const err = e as { code?: string; body?: { code?: string } } | null;
  return err?.code ?? err?.body?.code ?? "generic";
}

/**
 * People → Trial sessions: each lead at the trial stage, the session their
 * child tried, the moment to send the family (within 24 hours) and the
 * follow-up that goes a few days later unless they joined.
 */
export function TrialsCard({ academyId, now = Date.now(), hideWhenEmpty = false }: { academyId: number; now?: number; hideWhenEmpty?: boolean }) {
  const copy = useMarketingCopy();
  const t = copy.trials;
  const trials = useTrials(academyId);
  const sessions = useListAcademyConsoleSessions(academyId, { query: { queryKey: getListAcademyConsoleSessionsQueryKey(academyId), staleTime: 60_000 } });
  // Sessions from two weeks back to a week ahead are the ones a trial can be on.
  const pickable = (Array.isArray(sessions.data) ? sessions.data : [])
    .filter((s) => { const at = new Date(s.startsAt).getTime(); return at > now - 14 * DAY && at < now + 7 * DAY; })
    .sort((a, b) => b.startsAt.localeCompare(a.startsAt));
  const list = trials.data ?? [];
  if (trials.isLoading || trials.isError || (hideWhenEmpty && list.length === 0)) return null;
  return (
    <section className="rounded-2xl border border-line bg-surface p-4 sm:p-5" data-testid="trials-card">
      <h2 className="flex items-center gap-2 font-display text-xl font-bold text-text"><Film className="h-5 w-5 text-turf" aria-hidden="true" />{t.title}</h2>
      <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-text">{t.hint}</p>
      {list.length === 0 ? <p className="mt-3 text-sm text-muted-text" data-testid="trials-empty">{t.empty}</p> : (
        <ul className="mt-4 divide-y divide-line">
          {list.map((trial) => <TrialRow key={trial.contactId} academyId={academyId} trial={trial} sessions={pickable} now={now} />)}
        </ul>
      )}
    </section>
  );
}

function TrialRow({ academyId, trial, sessions, now }: { academyId: number; trial: TrialView; sessions: AcademySessionSummary[]; now: number }) {
  const copy = useMarketingCopy();
  const t = copy.trials;
  const setSession = useSetTrialSession(academyId);
  const make = useMakeTrialClip(academyId);
  const send = useSendTrialClip(academyId);
  const [childName, setChildName] = useState(trial.clip?.childName ?? "");
  const [moment, setMoment] = useState(trial.clip ? formatMoment(trial.clip.momentSeconds) : "");
  const [picking, setPicking] = useState(!trial.clip);
  const [error, setError] = useState<string | null>(null);
  const clip = trial.clip;
  const hoursLeft = trial.dueBy ? Math.ceil((new Date(trial.dueBy).getTime() - now) / 3_600_000) : null;
  const sessionOptions = trial.session && !sessions.some((s) => s.id === trial.session!.id)
    ? [{ id: trial.session.id, startsAt: trial.session.startsAt, squadName: null, type: trial.session.type } as unknown as AcademySessionSummary, ...sessions]
    : sessions;

  const onMake = () => {
    setError(null);
    const seconds = parseMoment(moment);
    if (seconds === null) { setError(t.badTime); return; }
    make.mutate({ contactId: trial.contactId, momentSeconds: seconds, childName: childName.trim() || null }, {
      onSuccess: () => setPicking(false),
      onError: (e) => setError(t.errors[errorCode(e) as keyof typeof t.errors] ?? t.errors.generic),
    });
  };
  const onSend = () => {
    if (!clip) return;
    setError(null);
    send.mutate(clip.id, { onError: (e) => setError(t.errors[errorCode(e) as keyof typeof t.errors] ?? t.errors.generic) });
  };

  return (
    <li className="space-y-3 py-4 first:pt-0 last:pb-0" data-testid={`trial-${trial.contactId}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-semibold text-text" dir="auto">{trial.name || trial.display || trial.phone}</span>
        <span className="text-xs text-muted-text" dir="ltr">{trial.display ?? trial.phone}</span>
        {clip?.status !== "sent" && hoursLeft !== null && trial.session?.hasVideo !== undefined && (
          <span className={cn("ms-auto inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-bold", hoursLeft <= 0 ? "bg-[#ff6b6b]/15 text-[#ff8a8a]" : hoursLeft <= 6 ? "bg-[#ffb020]/15 text-[#ffc861]" : "bg-raised text-muted-text")} data-testid="trial-due">
            <Clock className="h-3 w-3" aria-hidden="true" />{t.due(hoursLeft)}
          </span>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <CalendarClock className="h-4 w-4 text-muted-text" aria-hidden="true" />
        <select value={trial.session?.id ?? ""} disabled={setSession.isPending || clip?.status === "sent"} aria-label={t.session}
          onChange={(e) => setSession.mutate({ contactId: trial.contactId, sessionId: e.target.value ? Number(e.target.value) : null })}
          className="min-h-9 rounded-lg border border-input bg-raised px-2 text-sm text-text" data-testid="trial-session">
          <option value="">{t.pickSession}</option>
          {sessionOptions.map((s) => <option key={s.id} value={s.id}>{when(s.startsAt, copy.locale)}{s.squadName ? ` · ${s.squadName}` : ""}</option>)}
        </select>
        {trial.session && !trial.session.hasVideo && <span className="text-xs text-muted-text">{t.noVideo}</span>}
      </div>
      {trial.session?.hasVideo && (picking || !clip) && clip?.status !== "sent" && (
        <div className="flex flex-wrap items-end gap-2">
          <label className="space-y-1 text-xs text-muted-text">
            <span className="block">{t.childName}</span>
            <Input dir="auto" value={childName} onChange={(e) => setChildName(e.target.value)} className="h-9 w-40" data-testid="trial-child" />
          </label>
          <label className="space-y-1 text-xs text-muted-text">
            <span className="block">{t.moment}</span>
            <Input dir="ltr" inputMode="numeric" placeholder="12:30" value={moment} onChange={(e) => setMoment(e.target.value)} className="h-9 w-28" data-testid="trial-moment" />
          </label>
          <Button type="button" size="sm" className="h-9 bg-floodlight font-bold text-void" disabled={make.isPending || !moment.trim()} onClick={onMake} data-testid="trial-make">
            {make.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Film className="h-4 w-4" aria-hidden="true" />}{t.make}
          </Button>
        </div>
      )}
      {clip && !picking && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-text" dir="auto">{clip.childName ? `${clip.childName} · ` : ""}<bdi dir="ltr">{formatMoment(clip.momentSeconds)}</bdi></span>
          {clip.status === "sent" ? (
            <>
              <span className="inline-flex items-center gap-1 rounded-full bg-turf/15 px-2 py-0.5 text-[11px] font-bold text-turf"><Check className="h-3 w-3" aria-hidden="true" />{t.sent(when(clip.sentAt!, copy.locale))}</span>
              <span className="inline-flex items-center gap-1 text-xs text-muted-text"><Eye className="h-3 w-3" aria-hidden="true" />{clip.openedAt ? t.opened : t.notOpened}</span>
              {clip.followUpStatus && (
                <span className="text-xs text-muted-text" data-testid="trial-follow-up">
                  {clip.followUpStatus === "pending" && clip.followUpAt ? t.followUp.pending(when(clip.followUpAt, copy.locale)) : clip.followUpStatus === "sent" ? t.followUp.sent : t.followUp.skipped}
                </span>
              )}
            </>
          ) : (
            <>
              <span className="text-xs text-muted-text">{clip.exportStatus === "done" ? t.ready : t.preparing}</span>
              <Button type="button" size="sm" variant="ghost" className="h-8" onClick={() => setPicking(true)}>{t.remake}</Button>
              <Button type="button" size="sm" className="h-8 bg-floodlight font-bold text-void" disabled={send.isPending} onClick={onSend} data-testid="trial-send">
                {send.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Send className="h-4 w-4" aria-hidden="true" />}{t.send}
              </Button>
            </>
          )}
        </div>
      )}
      {error && <p className="text-sm text-[#ff8a8a]" role="alert">{error}</p>}
    </li>
  );
}
