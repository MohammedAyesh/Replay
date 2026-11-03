import { useEffect, useMemo, useState } from "react";
import { PrivateClipsCard } from "@/components/academy-console/private-clips-card";
import { PhoneMediaCard } from "@/components/academy-console/phone-media-card";
import { PhoneReviewCard } from "@/components/academy-console/phone-review-card";
import { ArrowLeft, ArrowRight, BarChart3, Check, ExternalLink, Loader2, RefreshCw, Sparkles, UserRoundX, Video } from "lucide-react";
import { useMatchesCopy, type MatchesStrings } from "@/i18n/matches-strings";
import {
  useAcademyMatch,
  useAcademyMatches,
  useAcademyPlayerStats,
  useAnalyseMatch,
  useBindPlayer,
  useRefreshMatchStats,
  useSaveLineup,
  useSaveMatchPage,
  type DetectedPlayer,
  type LineupPlayer,
  type MatchDetail,
  type MatchListItem,
  type MatchSession,
  type PlayerStatsRow,
} from "@/lib/academy-matches-api";
import { METRICS, combine, ratingsFor, type MetricKey } from "@/lib/academy-match-metrics";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { CompareBars, PlayerStatsTable, TeamStatsBars, matchValues, scoreLine, type ComparePlayer } from "@/components/academy-matches/match-stats-views";

type Copy = MatchesStrings & { locale: "ar" | "en" };
const ACTIVE = ["queued", "claimed", "running"];

function sessionTitle(session: MatchSession, copy: Copy) {
  return session.type === "match" ? `${copy.match}${session.opponent ? ` ${copy.vs} ${session.opponent}` : ""}` : copy.training;
}

function sessionDate(session: MatchSession, locale: string) {
  return new Intl.DateTimeFormat(locale === "ar" ? "ar-JO-u-nu-latn" : "en-GB", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Amman" }).format(new Date(session.startsAt));
}

function Card({ title, step, children, action, testId }: { title: string; step?: number; children: React.ReactNode; action?: React.ReactNode; testId?: string }) {
  return (
    <section className="rounded-2xl border border-line bg-surface p-5" data-testid={testId}>
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2.5 font-display text-xl font-bold text-text">
          {step !== undefined && <span className="grid h-7 w-7 place-items-center rounded-full bg-raised text-sm text-muted-text">{step}</span>}
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

export function AcademyMatchesSection({ academyId, isOwner }: { academyId: number; isOwner: boolean }) {
  const copy = useMatchesCopy();
  const [tab, setTab] = useState<"matches" | "players">("matches");
  // A link from the creative hub's squad grid opens a match at a step: ?match=<id>&step=who.
  const linked = useMemo(() => {
    const q = new URLSearchParams(typeof window === "undefined" ? "" : window.location.search);
    const id = Number(q.get("match"));
    return Number.isSafeInteger(id) && id > 0 ? { id, step: q.get("step") } : null;
  }, []);
  const [openId, setOpenId] = useState<number | null>(linked?.id ?? null);
  const [first, setFirst] = useState(true);
  useEffect(() => { if (first) { setFirst(false); return; } setOpenId(null); }, [academyId]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <section className="space-y-5" data-testid="academy-matches" dir={copy.locale === "ar" ? "rtl" : "ltr"}>
      {openId === null ? (
        <>
          <header>
            <h1 className="font-display text-4xl font-bold tracking-tight text-text">{copy.title}</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-text">{copy.description}</p>
          </header>
          <div className="flex gap-1.5">
            {(["matches", "players"] as const).map((t) => (
              <button key={t} type="button" onClick={() => setTab(t)} data-testid={`matches-tab-${t}`}
                className={cn("min-h-9 rounded-full px-3.5 text-sm font-semibold", tab === t ? "bg-turf/15 text-turf" : "bg-raised text-muted-text hover:text-text")}>
                {copy.tabs[t]}
              </button>
            ))}
          </div>
          {tab === "matches" ? <><PhoneReviewCard academyId={academyId} /><MatchList academyId={academyId} copy={copy} onOpen={setOpenId} /></> : <PlayerCompare academyId={academyId} copy={copy} />}
        </>
      ) : (
        <MatchDetailView academyId={academyId} sessionId={openId} isOwner={isOwner} copy={copy} onBack={() => setOpenId(null)} focus={linked?.id === openId ? linked.step : null} />
      )}
    </section>
  );
}

function AnalysisBadge({ item, copy }: { item: Pick<MatchListItem, "hasVideo" | "analysis">; copy: Copy }) {
  if (!item.hasVideo) return <span className="rounded-full bg-raised px-2 py-0.5 text-[11px] font-bold text-muted-text">{copy.noVideo}</span>;
  const status = item.analysis ?? "none";
  const tone = status === "succeeded" ? "bg-turf/15 text-turf" : ACTIVE.includes(status) ? "bg-sky-400/15 text-sky-300" : status === "failed" ? "bg-red-500/15 text-red-400" : "bg-amber-300/15 text-amber-200";
  return <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-bold", tone)}>{copy.analysis[status]}</span>;
}

function MatchList({ academyId, copy, onOpen }: { academyId: number; copy: Copy; onOpen: (id: number) => void }) {
  const matches = useAcademyMatches(academyId);
  if (matches.isLoading) return <div className="space-y-2">{[0, 1, 2].map((n) => <div key={n} className="h-20 animate-pulse rounded-2xl bg-raised" />)}</div>;
  if (matches.isError) return <p className="text-sm text-red-400" role="alert">{(matches.error as Error).message}</p>;
  const list = matches.data ?? [];
  if (!list.length) return <p className="rounded-2xl border border-dashed border-line p-8 text-center text-sm text-muted-text">{copy.empty}</p>;
  const Chevron = copy.locale === "ar" ? ArrowLeft : ArrowRight;
  return (
    <ul className="space-y-2" data-testid="matches-list">
      {list.map((m) => {
        const score = scoreLine(m);
        return (
          <li key={m.id}>
            <button type="button" onClick={() => onOpen(m.id)} className="flex w-full items-center gap-4 rounded-2xl border border-line bg-surface p-4 text-start transition-colors hover:border-muted-text" data-testid={`match-${m.id}`}>
              <span className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-raised">
                {score ? <span className="font-display text-sm font-bold tabular-nums text-text" dir="ltr">{score}</span> : <Video className="h-5 w-5 text-muted-text" aria-hidden="true" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block font-semibold text-text" dir="auto">{sessionTitle(m, copy)}</span>
                <span className="mt-0.5 block text-xs text-muted-text">{[sessionDate(m, copy.locale), m.squadName, m.location].filter(Boolean).join(" · ")}</span>
                <span className="mt-1.5 flex flex-wrap gap-1.5">
                  <AnalysisBadge item={m} copy={copy} />
                  {m.playersWithStats > 0 && <span className="rounded-full bg-violet-400/15 px-2 py-0.5 text-[11px] font-bold text-violet-300">{copy.playersWithStats(m.playersWithStats)}</span>}
                  {m.published && <span className="rounded-full bg-floodlight/15 px-2 py-0.5 text-[11px] font-bold text-floodlight">{copy.published}</span>}
                </span>
              </span>
              <Chevron className="h-4 w-4 shrink-0 text-muted-text" aria-hidden="true" />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function MatchDetailView({ academyId, sessionId, isOwner, copy, onBack, focus }: { academyId: number; sessionId: number; isOwner: boolean; copy: Copy; onBack: () => void; focus?: string | null }) {
  const detail = useAcademyMatch(academyId, sessionId);
  const loaded = Boolean(detail.data);
  useEffect(() => {
    if (!loaded || focus !== "who") return;
    document.querySelector('[data-testid="match-who"]')?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [loaded, focus]);
  const Back = copy.locale === "ar" ? ArrowRight : ArrowLeft;
  const back = (
    <button type="button" onClick={onBack} className="inline-flex items-center gap-1.5 text-sm font-semibold text-muted-text hover:text-text" data-testid="button-matches-back">
      <Back className="h-4 w-4" aria-hidden="true" />{copy.back}
    </button>
  );
  if (detail.isLoading) return <div className="space-y-3">{back}{[0, 1, 2].map((n) => <div key={n} className="h-40 animate-pulse rounded-2xl bg-raised" />)}</div>;
  if (detail.isError || !detail.data) return <div className="space-y-3">{back}<p className="text-sm text-red-400" role="alert">{(detail.error as Error | null)?.message}</p></div>;
  const data = detail.data;
  const score = scoreLine(data.session);
  return (
    <div className="space-y-5" data-testid="match-detail">
      {back}
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-4xl font-bold tracking-tight text-text" dir="auto">{sessionTitle(data.session, copy)}</h1>
          <p className="mt-1 text-sm text-muted-text">{[sessionDate(data.session, copy.locale), data.session.squadName, data.session.location].filter(Boolean).join(" · ")}</p>
        </div>
        {score && <span className="rounded-2xl bg-raised px-5 py-2 font-display text-3xl font-bold tabular-nums text-text" dir="ltr">{score}</span>}
      </header>
      <VideoCard academyId={academyId} data={data} isOwner={isOwner} copy={copy} />
      <LineupCard academyId={academyId} data={data} copy={copy} />
      <WhoCard academyId={academyId} data={data} copy={copy} />
      <StatsCard academyId={academyId} data={data} copy={copy} />
      <ShareCard academyId={academyId} data={data} isOwner={isOwner} copy={copy} />
      <PhoneMediaCard academyId={academyId} sessionId={sessionId} lineup={data.lineup} />
      {data.session.type === "match" && <PrivateClipsCard academyId={academyId} sessionId={sessionId} isOwner={isOwner} analysed={data.analysis.analysed} />}
    </div>
  );
}

function VideoCard({ academyId, data, isOwner, copy }: { academyId: number; data: MatchDetail; isOwner: boolean; copy: Copy }) {
  const save = useSaveMatchPage(academyId, data.session.id);
  const analyse = useAnalyseMatch(academyId, data.session.id);
  const [page, setPage] = useState(data.page);
  useEffect(() => { setPage(data.page); }, [data.page]);
  const job = data.analysis.job;
  const active = job ? ACTIVE.includes(job.status) : false;
  const dirty = JSON.stringify(page) !== JSON.stringify(data.page);

  if (!data.analysis.hasVideo) {
    return <Card title={copy.steps.video} step={1} testId="match-video"><p className="text-sm text-muted-text">{copy.video.noVideo}</p></Card>;
  }
  return (
    <Card title={copy.steps.video} step={1} testId="match-video"
      action={<span className="rounded-full bg-raised px-2.5 py-1 text-xs font-bold text-muted-text">{copy.analysis[job?.status ?? "none"]}</span>}>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {data.recordings.length > 1 && (
          <label className="text-sm">
            <span className="mb-1 block text-xs font-bold uppercase tracking-wide text-muted-text">{copy.video.pick}</span>
            <select value={page.recordingId ?? ""} onChange={(e) => setPage({ ...page, recordingId: Number(e.target.value) })} className="h-10 w-full rounded-lg border border-input bg-raised px-3 text-text">
              {data.recordings.map((r) => <option key={r.id} value={r.id}>{`${r.date} ${r.timeSlot} · ${r.court}`}</option>)}
            </select>
          </label>
        )}
        <label className="text-sm">
          <span className="mb-1 block text-xs font-bold uppercase tracking-wide text-muted-text">{copy.video.kit}</span>
          <input type="color" value={page.kitColor ?? "#ffffff"} onChange={(e) => setPage({ ...page, kitColor: e.target.value })} className="h-10 w-full cursor-pointer rounded-lg border border-input bg-raised p-1" data-testid="input-kit-color" />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-xs font-bold uppercase tracking-wide text-muted-text">{copy.video.opponentKit}</span>
          <input type="color" value={page.opponentKitColor ?? "#000000"} onChange={(e) => setPage({ ...page, opponentKitColor: e.target.value })} className="h-10 w-full cursor-pointer rounded-lg border border-input bg-raised p-1" />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-xs font-bold uppercase tracking-wide text-muted-text">{copy.video.perSide}</span>
          <select value={page.playersPerSide ?? ""} onChange={(e) => setPage({ ...page, playersPerSide: e.target.value ? Number(e.target.value) : null })} className="h-10 w-full rounded-lg border border-input bg-raised px-3 text-text">
            <option value="">–</option>
            {[3, 4, 5, 6, 7, 8, 9, 10, 11].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-xs font-bold uppercase tracking-wide text-muted-text">{copy.video.numbers}</span>
          <select value={page.shirtsHaveNumbers} onChange={(e) => setPage({ ...page, shirtsHaveNumbers: e.target.value as MatchDetail["page"]["shirtsHaveNumbers"] })} className="h-10 w-full rounded-lg border border-input bg-raised px-3 text-text">
            <option value="yes">{copy.video.yes}</option>
            <option value="no">{copy.video.no}</option>
            <option value="unknown">{copy.video.unknown}</option>
          </select>
        </label>
      </div>
      {dirty && (
        <Button type="button" size="sm" className="mt-4 bg-turf font-bold text-void" disabled={save.isPending}
          onClick={() => save.mutate({ recordingId: page.recordingId, kitColor: page.kitColor, opponentKitColor: page.opponentKitColor, playersPerSide: page.playersPerSide, shirtsHaveNumbers: page.shirtsHaveNumbers })}
          data-testid="button-save-match-page">
          {copy.video.save}
        </Button>
      )}
      {save.isError && <p className="mt-2 text-sm text-red-400" role="alert">{(save.error as Error).message}</p>}

      <div className="mt-5 rounded-xl bg-raised p-4">
        {active ? (
          <p className="flex items-center gap-2 text-sm font-semibold text-sky-300"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />{copy.analysis[job!.status]}{(job!.stage || job!.progress !== null) && <span className="font-normal text-muted-text">· {copy.video.progress(job!.stage, job!.progress)}</span>}</p>
        ) : (
          <>
            {job?.status === "failed" && <p className="mb-3 text-sm text-red-400">{copy.video.failed}</p>}
            <p className="text-sm text-muted-text">{copy.video.analyseHint}</p>
            {isOwner && (
              <Button type="button" className="mt-3 min-h-10 rounded-xl bg-floodlight font-bold text-void" disabled={analyse.isPending}
                onClick={() => analyse.mutate(data.analysis.analysed)} data-testid="button-analyse-match">
                <Sparkles className="me-2 h-4 w-4" aria-hidden="true" />{data.analysis.analysed ? copy.video.analyseAgain : copy.video.analyse}
              </Button>
            )}
            {analyse.isError && <p className="mt-2 text-sm text-red-400" role="alert">{(analyse.error as Error).message}</p>}
          </>
        )}
      </div>
    </Card>
  );
}

type LineupDraft = Record<number, { inSquad: boolean; number: string }>;

function draftOf(lineup: LineupPlayer[]): LineupDraft {
  return Object.fromEntries(lineup.map((p) => [p.playerId, { inSquad: p.inSquad, number: p.shirtNumber === null ? "" : String(p.shirtNumber) }]));
}

function LineupCard({ academyId, data, copy }: { academyId: number; data: MatchDetail; copy: Copy }) {
  const save = useSaveLineup(academyId, data.session.id);
  const [draft, setDraft] = useState<LineupDraft>(() => draftOf(data.lineup));
  const [remember, setRemember] = useState(true);
  const [saved, setSaved] = useState(false);
  const serverKey = JSON.stringify(draftOf(data.lineup));
  useEffect(() => { setDraft(JSON.parse(serverKey) as LineupDraft); }, [serverKey]);
  const dirty = JSON.stringify(draft) !== serverKey;

  const numbers = Object.values(draft).filter((d) => d.inSquad && d.number !== "").map((d) => d.number);
  const duplicate = new Set(numbers).size !== numbers.length;
  const players = [...data.lineup].sort((a, b) => Number(b.inSquad) - Number(a.inSquad) || a.name.localeCompare(b.name));

  const submit = () => {
    setSaved(false);
    save.mutate({
      players: data.lineup.map((p) => {
        const d = draft[p.playerId];
        const n = d.number.trim() === "" ? null : Number(d.number);
        return { playerId: p.playerId, inSquad: d.inSquad, shirtNumber: n !== null && Number.isInteger(n) && n >= 0 && n <= 99 ? n : null };
      }),
      rememberNumbers: remember,
    }, { onSuccess: () => setSaved(true) });
  };

  return (
    <Card title={copy.steps.lineup} step={2} testId="match-lineup">
      <p className="mb-3 text-sm text-muted-text">{copy.lineup.hint}</p>
      <div className="grid gap-1.5 sm:grid-cols-2">
        {players.map((p) => {
          const d = draft[p.playerId] ?? { inSquad: false, number: "" };
          return (
            <div key={p.playerId} className={cn("flex items-center gap-3 rounded-xl border px-3 py-2", d.inSquad ? "border-turf/40 bg-turf/5" : "border-line")} data-testid={`lineup-${p.playerId}`}>
              <input type="checkbox" checked={d.inSquad} onChange={() => setDraft({ ...draft, [p.playerId]: { ...d, inSquad: !d.inSquad } })} className="h-4 w-4 accent-[#2FD8C4]" aria-label={`${copy.lineup.played}: ${p.name}`} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold text-text" dir="auto">{p.name}</span>
                {p.squadName && <span className="block truncate text-xs text-muted-text" dir="auto">{p.squadName}</span>}
              </span>
              <Input inputMode="numeric" maxLength={2} value={d.number} placeholder={copy.lineup.number}
                onChange={(e) => setDraft({ ...draft, [p.playerId]: { inSquad: d.inSquad || e.target.value !== "", number: e.target.value.replace(/\D/g, "").slice(0, 2) } })}
                className="h-9 w-16 text-center font-display font-bold tabular-nums" aria-label={`${copy.lineup.number} ${p.name}`} data-testid={`input-shirt-${p.playerId}`} />
            </div>
          );
        })}
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button type="button" className="min-h-10 rounded-xl bg-turf font-bold text-void" disabled={!dirty || duplicate || save.isPending} onClick={submit} data-testid="button-save-lineup">{copy.lineup.save}</Button>
        <label className="flex items-center gap-2 text-sm text-muted-text">
          <input type="checkbox" checked={remember} onChange={() => setRemember(!remember)} className="h-4 w-4 accent-[#2FD8C4]" />{copy.lineup.remember}
        </label>
        {saved && !dirty && <span className="flex items-center gap-1 text-sm font-semibold text-turf"><Check className="h-4 w-4" aria-hidden="true" />{copy.lineup.saved}</span>}
      </div>
      {duplicate && <p className="mt-2 text-sm text-red-400" role="alert">{copy.lineup.duplicate}</p>}
      {save.isError && <p className="mt-2 text-sm text-red-400" role="alert">{(save.error as Error).message}</p>}
    </Card>
  );
}

function Photo({ jpeg, className }: { jpeg: string | undefined; className?: string }) {
  if (!jpeg) return <span className={cn("block bg-raised", className)} />;
  return <img src={jpeg.startsWith("data:") ? jpeg : `data:image/jpeg;base64,${jpeg}`} alt="" className={cn("object-cover", className)} />;
}

function WhoCard({ academyId, data, copy }: { academyId: number; data: MatchDetail; copy: Copy }) {
  const bind = useBindPlayer(academyId, data.session.id);
  const [picking, setPicking] = useState<LineupPlayer | null>(null);
  const squad = data.lineup.filter((p) => p.inSquad);
  const byId = new Map(data.detected.map((d) => [d.id, d]));
  const takenBy = new Map(data.lineup.filter((p) => p.boundTo).map((p) => [p.boundTo!, p]));

  return (
    <Card title={copy.steps.whoIsWho} step={3} testId="match-who"
      action={data.detected.length > 0 ? <span className="text-xs text-muted-text">{copy.who.detected(data.detected.length)}</span> : undefined}>
      {!data.analysis.analysed ? <p className="text-sm text-muted-text">{copy.who.waiting}</p>
        : !data.analysis.hasRoster ? <p className="text-sm text-muted-text">{copy.who.noRoster}</p>
          : (
            <>
              <p className="mb-3 text-sm text-muted-text">{copy.who.hint}</p>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {squad.map((p) => {
                  const found = p.boundTo ? byId.get(p.boundTo) : undefined;
                  const how = p.boundHow === "owner" ? copy.who.byOwner : p.boundHow === "number" ? copy.who.byNumber : p.boundBy === "owner" && !p.rosterPlayerId ? copy.who.notInVideo : copy.who.notMatched;
                  return (
                    <button key={p.playerId} type="button" onClick={() => setPicking(p)} data-testid={`who-${p.playerId}`}
                      className={cn("flex items-center gap-3 rounded-xl border p-2.5 text-start transition-colors hover:border-muted-text", found ? "border-line" : "border-dashed border-amber-300/40")}>
                      {found ? <Photo jpeg={found.photos[0]} className="h-14 w-11 shrink-0 rounded-lg" /> : <span className="grid h-14 w-11 shrink-0 place-items-center rounded-lg bg-raised"><UserRoundX className="h-4 w-4 text-muted-text" aria-hidden="true" /></span>}
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5">
                          {p.shirtNumber !== null && <span className="font-display font-bold tabular-nums text-muted-text">{p.shirtNumber}</span>}
                          <span className="truncate text-sm font-semibold text-text" dir="auto">{p.name}</span>
                        </span>
                        <span className={cn("mt-0.5 block text-xs", found ? "text-turf" : "text-amber-200")}>{how}{found ? ` · ${copy.who.minutes(Math.round(found.minutes))}` : ""}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
              {bind.isError && <p className="mt-2 text-sm text-red-400" role="alert">{(bind.error as Error).message}</p>}
            </>
          )}
      <Dialog open={picking !== null} onOpenChange={(open) => { if (!open) setPicking(null); }}>
        <DialogContent className="max-h-[90dvh] max-w-3xl overflow-y-auto border-line bg-surface" dir={copy.locale === "ar" ? "rtl" : "ltr"}>
          <DialogHeader>
            <DialogTitle dir="auto">{picking ? copy.who.pickTitle(picking.name) : ""}</DialogTitle>
            <DialogDescription>{copy.who.pickHint}</DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
            {[...data.detected].sort((a, b) => b.minutes - a.minutes).map((d: DetectedPlayer) => {
              const owner = takenBy.get(d.id);
              const current = picking?.boundTo === d.id;
              return (
                <button key={d.id} type="button" disabled={bind.isPending}
                  onClick={() => picking && bind.mutate({ playerId: picking.playerId, rosterPlayerId: d.id }, { onSuccess: () => setPicking(null) })}
                  className={cn("overflow-hidden rounded-xl border text-start transition-colors", current ? "border-turf ring-2 ring-turf" : "border-line hover:border-muted-text")}
                  data-testid={`pick-${d.id}`}>
                  <span className="flex h-28 gap-px bg-void">
                    {(d.photos.length ? d.photos : [undefined]).slice(0, 3).map((photo, i) => <Photo key={i} jpeg={photo} className="h-full min-w-0 flex-1" />)}
                  </span>
                  <span className="block p-2 text-xs">
                    <span className="font-display text-base font-bold tabular-nums text-text">{d.number ?? d.numberCandidate ?? copy.who.noNumber}</span>
                    <span className="ms-1.5 text-muted-text">{copy.who.minutes(Math.round(d.minutes))}</span>
                    {owner && owner.playerId !== picking?.playerId && <span className="mt-0.5 block truncate text-amber-200" dir="auto">{owner.name}</span>}
                  </span>
                </button>
              );
            })}
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button type="button" variant="ghost" disabled={bind.isPending} onClick={() => picking && bind.mutate({ playerId: picking.playerId, rosterPlayerId: "auto" }, { onSuccess: () => setPicking(null) })}>{copy.who.clear}</Button>
            <Button type="button" variant="ghost" disabled={bind.isPending} onClick={() => picking && bind.mutate({ playerId: picking.playerId, rosterPlayerId: null }, { onSuccess: () => setPicking(null) })} data-testid="button-not-in-video">{copy.who.notIn}</Button>
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function StatsCard({ academyId, data, copy }: { academyId: number; data: MatchDetail; copy: Copy }) {
  const refresh = useRefreshMatchStats(academyId, data.session.id);
  const [selected, setSelected] = useState<number[]>([]);
  const names = new Map(data.lineup.map((p) => [p.playerId, p]));
  const players = useMemo(
    () => (data.stats?.players ?? []).map((s) => ({ playerId: s.playerId, name: names.get(s.playerId)?.name ?? `#${s.playerId}`, shirtNumber: names.get(s.playerId)?.shirtNumber ?? null, stats: s })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data.stats, data.lineup],
  );
  const ratings = useMemo(() => ratingsFor(players), [players]);
  const toggle = (id: number) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : s.length >= 3 ? [...s.slice(1), id] : [...s, id]));
  const compare: ComparePlayer[] = selected.map((id) => players.find((p) => p.playerId === id)).filter((p): p is (typeof players)[number] => Boolean(p))
    .map((p) => ({ id: p.playerId, name: p.name, values: matchValues(p.stats, ratings.get(p.playerId) ?? null) }));

  return (
    <Card title={copy.steps.stats} step={4} testId="match-stats"
      action={data.analysis.analysed ? <Button type="button" size="sm" variant="ghost" disabled={refresh.isPending} onClick={() => refresh.mutate()}><RefreshCw className={cn("me-1.5 h-4 w-4", refresh.isPending && "animate-spin")} aria-hidden="true" />{copy.stats.refresh}</Button> : undefined}>
      {!players.length ? <p className="text-sm text-muted-text">{data.analysis.analysed ? copy.stats.none : copy.family.notAnalysed}</p> : (
        <div className="space-y-5">
          {data.stats?.team && (
            <div className="rounded-xl bg-raised/50 p-4">
              <p className="mb-3 text-xs font-bold uppercase tracking-wide text-muted-text">{copy.stats.team}</p>
              <TeamStatsBars team={data.stats.team} hasBall={data.stats.hasBall} copy={copy} />
            </div>
          )}
          <PlayerStatsTable players={players} copy={copy} selected={selected} onToggle={toggle} />
          {compare.length >= 2 ? <div className="rounded-xl bg-raised/50 p-4"><CompareBars players={compare} copy={copy} /></div>
            : <p className="text-xs text-muted-text">{copy.stats.compareHint}</p>}
          <p className="text-xs text-muted-text">{copy.stats.goalsNote}</p>
        </div>
      )}
    </Card>
  );
}

function ShareCard({ academyId, data, isOwner, copy }: { academyId: number; data: MatchDetail; isOwner: boolean; copy: Copy }) {
  const save = useSaveMatchPage(academyId, data.session.id);
  const href = `${import.meta.env.BASE_URL.replace(/\/$/, "")}/academy/me/match/${data.session.id}`;
  return (
    <Card title={copy.steps.share} step={5} testId="match-share">
      <p className="text-sm text-muted-text">{copy.share.hint}</p>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        {isOwner ? (
          <label className="flex min-h-10 cursor-pointer items-center gap-2.5 rounded-xl bg-raised px-3.5 text-sm font-semibold text-text">
            <input type="checkbox" checked={data.page.published} disabled={save.isPending} onChange={() => save.mutate({ published: !data.page.published })} className="h-4 w-4 accent-[#D4FF4F]" data-testid="toggle-publish-match" />
            {copy.share.publish}
          </label>
        ) : <span className="text-sm font-semibold text-text">{data.page.published ? copy.published : copy.notPublished}</span>}
        <a href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-sm font-semibold text-turf hover:underline" data-testid="link-parents-page">
          <ExternalLink className="h-4 w-4" aria-hidden="true" />{copy.share.open}
        </a>
      </div>
      {save.isError && <p className="mt-2 text-sm text-red-400" role="alert">{(save.error as Error).message}</p>}
    </Card>
  );
}

/** Each player's matches combined, and two or three players side by side. */
export function aggregatePlayers(rows: PlayerStatsRow[]) {
  // Ratings are relative to the others in the same match, so compute them per match.
  const bySession = new Map<number, PlayerStatsRow[]>();
  for (const r of rows) bySession.set(r.sessionId, [...(bySession.get(r.sessionId) ?? []), r]);
  const rating = new Map<string, number>();
  for (const [sessionId, sessionRows] of bySession) {
    for (const [playerId, value] of ratingsFor(sessionRows.map((r) => ({ playerId: r.playerId, name: r.playerName, stats: r.stats })))) rating.set(`${sessionId}:${playerId}`, value);
  }
  const byPlayer = new Map<number, PlayerStatsRow[]>();
  for (const r of rows) byPlayer.set(r.playerId, [...(byPlayer.get(r.playerId) ?? []), r]);
  return [...byPlayer.values()].map((own) => {
    const values = Object.fromEntries(METRICS.map((m) => [m.key, combine(own.map((r) => m.value(r.stats, rating.get(`${r.sessionId}:${r.playerId}`) ?? null)), m.combine)])) as Record<MetricKey, number | null>;
    return { playerId: own[0].playerId, name: own[0].playerName, squadName: own[0].squadName, jerseyNumber: own[0].jerseyNumber, matches: own.length, values };
  }).sort((a, b) => (b.values.rating ?? -1) - (a.values.rating ?? -1) || b.matches - a.matches);
}

function PlayerCompare({ academyId, copy }: { academyId: number; copy: Copy }) {
  const rows = useAcademyPlayerStats(academyId);
  const [selected, setSelected] = useState<number[]>([]);
  const players = useMemo(() => aggregatePlayers(rows.data ?? []), [rows.data]);
  if (rows.isLoading) return <div className="h-60 animate-pulse rounded-2xl bg-raised" />;
  if (rows.isError) return <p className="text-sm text-red-400" role="alert">{(rows.error as Error).message}</p>;
  if (!players.length) return <p className="rounded-2xl border border-dashed border-line p-8 text-center text-sm text-muted-text">{copy.players.none}</p>;
  const toggle = (id: number) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : s.length >= 3 ? [...s.slice(1), id] : [...s, id]));
  const compare = selected.map((id) => players.find((p) => p.playerId === id)!).filter(Boolean).map((p) => ({ id: p.playerId, name: p.name, values: p.values }));
  const fmt = (key: MetricKey, value: number | null) => {
    const m = METRICS.find((x) => x.key === key)!;
    if (value === null) return "–";
    const n = value.toFixed(key === "rating" ? 1 : m.decimals);
    return m.unit === "km" ? `${n} ${copy.stats.km}` : m.unit === "kmh" ? `${n} ${copy.stats.kmh}` : m.unit === "%" ? `${n}%` : n;
  };
  const cols: Array<{ key: MetricKey; how: string }> = [
    { key: "rating", how: copy.players.avg }, { key: "minutes", how: copy.players.total }, { key: "distance", how: copy.players.perMatch },
    { key: "topSpeed", how: copy.players.best }, { key: "touches", how: copy.players.perMatch }, { key: "passes", how: copy.players.perMatch },
    { key: "accuracy", how: copy.players.avg }, { key: "dribbles", how: copy.players.total }, { key: "shots", how: copy.players.total }, { key: "goals", how: copy.players.total },
  ];
  return (
    <div className="space-y-5" data-testid="matches-player-compare">
      <p className="text-sm text-muted-text">{copy.players.hint}</p>
      {compare.length >= 2 && <div className="rounded-2xl border border-line bg-surface p-5"><CompareBars players={compare} copy={copy} /></div>}
      <div className="overflow-x-auto rounded-2xl border border-line bg-surface">
        <table className="w-full min-w-[820px] text-sm">
          <thead>
            <tr className="border-b border-line text-[11px] font-bold uppercase tracking-wide text-muted-text">
              <th className="w-10 px-3 py-2" />
              <th className="px-3 py-2 text-start">{copy.stats.player}</th>
              <th className="px-2 py-2 text-end">{copy.players.matches}</th>
              {cols.map((c) => <th key={c.key} className="px-2 py-2 text-end">{copy.stats[c.key]}<span className="block font-normal normal-case opacity-70">{c.how}</span></th>)}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {players.map((p) => (
              <tr key={p.playerId} data-testid={`compare-row-${p.playerId}`}>
                <td className="px-3 py-2"><input type="checkbox" checked={selected.includes(p.playerId)} onChange={() => toggle(p.playerId)} className="h-4 w-4 accent-[#2FD8C4]" aria-label={`${copy.stats.compare} ${p.name}`} /></td>
                <td className="px-3 py-2">
                  <span className="flex items-center gap-2">
                    {p.jerseyNumber !== null && <span className="w-6 text-center font-display font-bold tabular-nums text-muted-text">{p.jerseyNumber}</span>}
                    <span className="font-semibold text-text" dir="auto">{p.name}</span>
                  </span>
                  {p.squadName && <span className="block text-xs text-muted-text" dir="auto">{p.squadName}</span>}
                </td>
                <td className="px-2 py-2 text-end tabular-nums text-muted-text">{p.matches}</td>
                {cols.map((c) => <td key={c.key} className={cn("px-2 py-2 text-end tabular-nums", c.key === "rating" ? "font-display font-bold text-text" : "text-muted-text")}>{fmt(c.key, p.values[c.key])}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="flex items-center gap-1.5 text-xs text-muted-text"><BarChart3 className="h-3.5 w-3.5" aria-hidden="true" />{copy.stats.goalsNote}</p>
    </div>
  );
}
