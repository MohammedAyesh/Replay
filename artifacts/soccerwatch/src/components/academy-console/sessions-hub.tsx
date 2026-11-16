import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, ArrowRight, Radio, Video } from "lucide-react";
import {
  getListAcademyConsoleRecordingsQueryKey,
  useListAcademyConsoleRecordings,
  type AcademySessionSummary,
} from "@workspace/api-client-react";
import { AcademySessionsSection } from "@/components/academy-console/sessions-section";
import { AcademyRecordingsSection } from "@/components/academy-console/recordings-section";
import { AnalysisBadge, MatchDetailView, MatchList, PlayerCompare } from "@/components/academy-console/matches-section";
import { PhoneReviewCard } from "@/components/academy-console/phone-review-card";
import { useConsoleNavCopy } from "@/i18n/console-nav-strings";
import { useMatchesCopy } from "@/i18n/matches-strings";
import { useAcademyMatches } from "@/lib/academy-matches-api";
import { canTagNow } from "@/lib/academy-coach-api";
import { LiveTagger } from "@/components/coach-board/LiveTagger";
import { useCoachCopy } from "@/i18n/coach-strings";
import { cn } from "@/lib/utils";

/**
 * Sessions: the academy's schedule and results, its videos and their analysis,
 * and the videos still to attach, on one page (this replaced the separate
 * Schedule & Results, Recordings and Matches sections).
 *
 * A session with video opens its detail (squad, who's who, stats, Coach view,
 * the match page) in place. Old links keep working: /academy/matches?match=<id>
 * and /academy/schedule, /academy/recordings all land here.
 *
 * Staff see the parts their access allows, as before: the schedule needs
 * "schedule", videos to attach need "recordings", video and analysis need
 * "matches".
 */
export type SessionsAccess = { schedule: boolean; recordings: boolean; matches: boolean };
type Tab = "sessions" | "videos" | "compare";

function taggingSession(): number | null {
  if (typeof window === "undefined") return null;
  const id = Number(new URLSearchParams(window.location.search).get("tag"));
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function linkedSession(): { id: number; step: string | null } | null {
  if (typeof window === "undefined") return null;
  const q = new URLSearchParams(window.location.search);
  const id = Number(q.get("match") ?? q.get("session"));
  return Number.isSafeInteger(id) && id > 0 ? { id, step: q.get("step") } : null;
}

export function AcademySessionsHub({ academyId, academyName, isOwner, can, initialTab }: {
  academyId: number;
  academyName: string;
  /** manages "matches": analyse, publish the match page */
  isOwner: boolean;
  can: SessionsAccess;
  initialTab?: Tab;
}) {
  const copy = useConsoleNavCopy();
  const matchesCopy = useMatchesCopy();
  const dir = copy.locale === "ar" ? "rtl" : "ltr";
  const linked = useMemo(linkedSession, []);
  const [openId, setOpenId] = useState<number | null>(can.matches ? linked?.id ?? null : null);
  const coachCopy = useCoachCopy();
  // Tag moments on the phone during a session (?tag=<id> opens it straight away, for a home-screen link).
  const [tagId, setTagId] = useState<number | null>(can.matches ? taggingSession() : null);
  const startTagging = (id: number) => {
    setTagId(id);
    if (typeof window !== "undefined") window.history.replaceState(window.history.state, "", `/academy/sessions?tag=${id}`);
  };
  const stopTagging = () => {
    setTagId(null);
    if (typeof window !== "undefined") window.history.replaceState(window.history.state, "", "/academy/sessions");
  };
  const tabs = ([
    (can.schedule || can.matches) && "sessions",
    can.recordings && "videos",
    can.matches && "compare",
  ].filter(Boolean) as Tab[]);
  const [tab, setTab] = useState<Tab>(initialTab && tabs.includes(initialTab) ? initialTab : tabs[0] ?? "sessions");
  const [first, setFirst] = useState(true);
  useEffect(() => { if (first) { setFirst(false); return; } setOpenId(null); }, [academyId]); // eslint-disable-line react-hooks/exhaustive-deps

  const matches = useAcademyMatches(academyId, { enabled: can.matches });
  const byId = useMemo(() => new Map((matches.data ?? []).map((m) => [m.id, m])), [matches.data]);
  const recordings = useListAcademyConsoleRecordings(academyId, {
    query: { queryKey: getListAcademyConsoleRecordingsQueryKey(academyId), staleTime: 60_000, enabled: can.recordings },
  });
  const unattached = (recordings.data ?? []).filter((r) => r.sessionId === null).length;

  const open = (id: number) => {
    setOpenId(id);
    if (typeof window !== "undefined") window.history.replaceState(window.history.state, "", `/academy/sessions?session=${id}`);
  };
  const back = () => {
    setOpenId(null);
    if (typeof window !== "undefined") window.history.replaceState(window.history.state, "", "/academy/sessions");
  };

  if (tagId !== null) return <LiveTagger academyId={academyId} sessionId={tagId} onClose={stopTagging} />;

  if (openId !== null) {
    return (
      <section className="space-y-5" data-testid="academy-sessions-hub" dir={dir}>
        <MatchDetailView academyId={academyId} sessionId={openId} isOwner={isOwner} copy={matchesCopy} onBack={back} focus={linked?.id === openId ? linked.step : null} />
      </section>
    );
  }

  const Chevron = copy.locale === "ar" ? ArrowLeft : ArrowRight;
  const sessionExtra = (session: AcademySessionSummary) => {
    const m = byId.get(session.id);
    const tagNow = canTagNow(session.startsAt, session.endsAt ?? null);
    const tagButton = tagNow && (
      <button type="button" onClick={() => startTagging(session.id)}
        className="inline-flex min-h-9 items-center gap-1.5 rounded-lg bg-floodlight px-3 text-xs font-bold text-void hover:brightness-110"
        data-testid={`button-tag-session-${session.id}`}>
        <Radio className="h-3.5 w-3.5" aria-hidden="true" />{coachCopy.tag.open}
      </button>
    );
    if (!m || !m.hasVideo) return tagButton ? <div className="mt-2.5 flex flex-wrap items-center gap-2">{tagButton}</div> : null;
    return (
      <div className="mt-2.5 flex flex-wrap items-center gap-2" data-testid={`session-video-${session.id}`}>
        {tagButton}
        <AnalysisBadge item={m} copy={matchesCopy} />
        {m.playersWithStats > 0 && <span className="rounded-full bg-violet-400/15 px-2 py-0.5 text-[11px] font-bold text-violet-300">{matchesCopy.playersWithStats(m.playersWithStats)}</span>}
        {m.published && <span className="rounded-full bg-floodlight/15 px-2 py-0.5 text-[11px] font-bold text-floodlight">{matchesCopy.published}</span>}
        <button type="button" onClick={() => open(session.id)}
          className="inline-flex min-h-9 items-center gap-1.5 rounded-lg bg-turf/15 px-3 text-xs font-bold text-turf hover:bg-turf/25"
          data-testid={`button-open-session-${session.id}`}>
          <Video className="h-3.5 w-3.5" aria-hidden="true" />{copy.sessions.openVideo}<Chevron className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>
    );
  };

  return (
    <section className="space-y-5" data-testid="academy-sessions-hub" dir={dir}>
      <header>
        <h1 className="font-display text-4xl font-bold tracking-tight text-text">{copy.sessions.title}</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-text">{copy.sessions.description}</p>
      </header>
      {tabs.length > 1 && (
        <div className="flex flex-wrap gap-1.5" role="tablist">
          {tabs.map((t) => (
            <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)} data-testid={`sessions-tab-${t}`}
              className={cn("inline-flex min-h-9 items-center gap-1.5 rounded-full px-3.5 text-sm font-semibold", tab === t ? "bg-turf/15 text-turf" : "bg-raised text-muted-text hover:text-text")}>
              {copy.sessions.tabs[t]}
              {t === "videos" && unattached > 0 && <span className="grid min-w-5 place-items-center rounded-full bg-amber-300/20 px-1.5 text-[11px] font-bold tabular-nums text-amber-200">{unattached}</span>}
            </button>
          ))}
        </div>
      )}
      {tab === "sessions" && (
        <>
          {can.matches && <PhoneReviewCard academyId={academyId} />}
          {can.schedule
            ? <AcademySessionsSection academyId={academyId} heading={{ title: null, description: null, kicker: null }} sessionExtra={can.matches ? sessionExtra : undefined} />
            : <MatchList academyId={academyId} copy={matchesCopy} onOpen={open} />}
        </>
      )}
      {tab === "videos" && can.recordings && (
        <AcademyRecordingsSection academyId={academyId} academyName={academyName} unattachedOnly heading={{ description: copy.sessions.unattachedHint, empty: copy.sessions.noUnattached }} />
      )}
      {tab === "compare" && can.matches && <PlayerCompare academyId={academyId} copy={matchesCopy} />}
    </section>
  );
}
