import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "wouter";
import { AnimatePresence } from "framer-motion";
import { ArrowLeft, ArrowRight, Play } from "lucide-react";
import { useMatchesCopy } from "@/i18n/matches-strings";
import { useAuth } from "@/lib/auth";
import { useFamilyMatch, useFamilyPlayerHistory, type FamilyPlayerHistory } from "@/lib/academy-matches-api";
import { METRICS, combine, ratingsFor, type MetricKey } from "@/lib/academy-match-metrics";
import { ClipPlayer } from "@/components/clip-player/ClipPlayer";
import { getBunnyMp4FallbackSource } from "@/lib/bunnyPlayback";
import { CompareBars, PlayerStatsTable, TeamStatsBars, matchValues, scoreLine } from "@/components/academy-matches/match-stats-views";
import { cn } from "@/lib/utils";

function bunnyVideoId(value: string): string {
  try {
    return new URL(value).pathname.split("/").filter(Boolean)[0] ?? value;
  } catch {
    return value;
  }
}

const SEASON_METRICS: MetricKey[] = ["rating", "distance", "topSpeed", "touches", "passes", "accuracy", "dribbles", "shots"];

/** The child's average over his published matches against the squad's average in the same matches. */
export function seasonVsSquad(history: FamilyPlayerHistory) {
  const own: Array<Partial<Record<MetricKey, number | null>>> = [];
  const squad: Array<Partial<Record<MetricKey, number | null>>> = [];
  for (const match of history.matches) {
    const everyone = [match.stats, ...match.squad.filter((s) => s.playerId !== match.stats.playerId)];
    const ratings = ratingsFor(everyone.map((s) => ({ playerId: s.playerId, name: "", stats: s })));
    own.push(matchValues(match.stats, ratings.get(match.stats.playerId) ?? null));
    for (const s of everyone) squad.push(matchValues(s, ratings.get(s.playerId) ?? null));
  }
  const avg = (rows: typeof own) => Object.fromEntries(SEASON_METRICS.map((key) => {
    const m = METRICS.find((x) => x.key === key)!;
    return [key, combine(rows.map((r) => r[key] ?? null), m.combine === "max" ? "max" : "avg")];
  })) as Partial<Record<MetricKey, number | null>>;
  return { own: avg(own), squad: avg(squad), perMatch: own };
}

export default function AcademyMatchPage() {
  const copy = useMatchesCopy();
  const params = useParams<{ sessionId: string }>();
  const sessionId = /^\d+$/.test(params.sessionId ?? "") ? Number(params.sessionId) : null;
  const { isSignedIn, isLoading: authLoading } = useAuth();
  const match = useFamilyMatch(isSignedIn ? sessionId : null);
  const [playing, setPlaying] = useState(false);
  const [selected, setSelected] = useState<number[]>([]);
  const mine = useMemo(() => (match.data?.players ?? []).filter((p) => p.mine), [match.data]);
  const [childId, setChildId] = useState<number | null>(null);
  useEffect(() => {
    if (!mine.length) return;
    setChildId((current) => (current && mine.some((p) => p.playerId === current) ? current : mine[0].playerId));
    setSelected((current) => (current.length ? current : mine.filter((p) => p.stats).map((p) => p.playerId).slice(0, 1)));
  }, [mine]);
  const history = useFamilyPlayerHistory(childId);
  const season = useMemo(() => (history.data && history.data.matches.length > 0 ? seasonVsSquad(history.data) : null), [history.data]);

  const Back = copy.locale === "ar" ? ArrowRight : ArrowLeft;
  const dir = copy.locale === "ar" ? "rtl" : "ltr";
  const shell = (children: React.ReactNode) => (
    <main className="min-h-[100dvh] bg-void text-text" dir={dir} data-testid="academy-match-page">
      <div className="mx-auto max-w-4xl space-y-5 px-4 py-6 pb-16 sm:px-6">
        <Link href="/academy/me" className="inline-flex items-center gap-1.5 text-sm font-semibold text-muted-text hover:text-text" data-testid="link-match-back"><Back className="h-4 w-4" aria-hidden="true" />{copy.family.back}</Link>
        {children}
      </div>
    </main>
  );

  if (authLoading || (match.isLoading && sessionId !== null && isSignedIn)) return shell(<div className="space-y-3">{[0, 1, 2].map((n) => <div key={n} className="h-40 animate-pulse rounded-2xl bg-raised" />)}</div>);
  if (!isSignedIn || sessionId === null || match.isError || !match.data) return shell(<p className="rounded-2xl border border-line bg-surface p-8 text-center text-sm text-muted-text" role="alert">{copy.family.notFound}</p>);

  const data = match.data;
  const score = scoreLine(data.session);
  const date = new Intl.DateTimeFormat(copy.locale === "ar" ? "ar-JO-u-nu-latn" : "en-GB", { weekday: "long", day: "numeric", month: "long", hour: "numeric", minute: "2-digit", timeZone: "Asia/Amman" }).format(new Date(data.session.startsAt));
  const title = data.session.type === "match" ? `${copy.match}${data.session.opponent ? ` ${copy.vs} ${data.session.opponent}` : ""}` : copy.training;
  const tablePlayers = data.players.filter((p) => p.stats).map((p) => ({ playerId: p.playerId, name: p.name, shirtNumber: p.shirtNumber, stats: p.stats!, highlight: p.mine }));
  const ratings = ratingsFor(tablePlayers);
  const toggle = (id: number) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : s.length >= 3 ? [...s.slice(1), id] : [...s, id]));
  const compare = selected.map((id) => tablePlayers.find((p) => p.playerId === id)).filter((p): p is (typeof tablePlayers)[number] => Boolean(p))
    .map((p) => ({ id: p.playerId, name: p.name, values: matchValues(p.stats, ratings.get(p.playerId) ?? null) }));
  const child = mine.find((p) => p.playerId === childId) ?? null;

  return shell(
    <>
      <header className="rounded-3xl border border-line bg-surface p-6 text-center">
        <p className="text-sm font-semibold text-muted-text" dir="auto">{data.academy.name}{data.session.squadName ? ` · ${data.session.squadName}` : ""}</p>
        <h1 className="mt-1 font-display text-3xl font-bold tracking-tight text-text sm:text-4xl" dir="auto">{title}</h1>
        {score && <p className="mt-3 font-display text-5xl font-bold tabular-nums text-floodlight" dir="ltr">{score}</p>}
        <p className="mt-3 text-sm text-muted-text">{date} · <span dir="auto">{data.session.location}</span></p>
        {data.recording?.videoUrl && (
          <button type="button" onClick={() => setPlaying(true)} className="mt-5 inline-flex min-h-11 items-center gap-2 rounded-xl bg-floodlight px-5 font-bold text-void" data-testid="button-watch-match">
            <Play className="h-4 w-4" aria-hidden="true" />{copy.family.watch}
          </button>
        )}
      </header>

      {!data.analysed || !tablePlayers.length ? (
        <p className="rounded-2xl border border-dashed border-line p-8 text-center text-sm text-muted-text">{copy.family.notAnalysed}</p>
      ) : (
        <>
          {mine.length > 1 && (
            <div className="flex flex-wrap gap-1.5">
              {mine.map((p) => (
                <button key={p.playerId} type="button" onClick={() => setChildId(p.playerId)} className={cn("min-h-9 rounded-full px-3.5 text-sm font-semibold", childId === p.playerId ? "bg-floodlight/15 text-floodlight" : "bg-raised text-muted-text")} dir="auto">{p.name}</button>
              ))}
            </div>
          )}
          {child?.stats && (
            <section className="rounded-2xl border border-floodlight/30 bg-floodlight/5 p-5" data-testid="match-your-player">
              <p className="text-xs font-bold uppercase tracking-wide text-floodlight">{copy.family.yourPlayer}</p>
              <h2 className="mt-1 font-display text-2xl font-bold text-text" dir="auto">{child.name}</h2>
              <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
                {(["rating", "distance", "topSpeed", "touches", "passes", "dribbles", "shots", "minutes"] as MetricKey[]).map((key) => {
                  const m = METRICS.find((x) => x.key === key)!;
                  const v = m.value(child.stats!, ratings.get(child.playerId) ?? null);
                  const n = v === null ? "–" : v.toFixed(key === "rating" ? 1 : m.decimals);
                  return (
                    <div key={key} className="rounded-xl bg-surface p-3">
                      <p className="text-[11px] font-bold uppercase tracking-wide text-muted-text">{copy.stats[key]}</p>
                      <p className="mt-1 font-display text-2xl font-bold tabular-nums text-text">{n}<span className="ms-1 text-xs font-normal text-muted-text">{m.unit === "km" ? copy.stats.km : m.unit === "kmh" ? copy.stats.kmh : m.unit === "%" ? "%" : ""}</span></p>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {data.team && (
            <section className="rounded-2xl border border-line bg-surface p-5">
              <h2 className="mb-4 font-display text-xl font-bold text-text">{copy.family.teamStats}</h2>
              <TeamStatsBars team={data.team} hasBall={data.hasBall} copy={copy} />
            </section>
          )}

          <section className="space-y-4">
            <h2 className="font-display text-xl font-bold text-text">{copy.family.players}</h2>
            <PlayerStatsTable players={tablePlayers} copy={copy} selected={selected} onToggle={toggle} />
            {compare.length >= 2 ? <div className="rounded-2xl border border-line bg-surface p-5"><CompareBars players={compare} copy={copy} /></div>
              : <p className="text-xs text-muted-text">{copy.stats.compareHint}</p>}
          </section>

          {child && season && history.data && history.data.matches.length > 1 && (
            <section className="rounded-2xl border border-line bg-surface p-5" data-testid="match-season">
              <h2 className="font-display text-xl font-bold text-text" dir="auto">{copy.family.season(child.name)}</h2>
              <p className="mb-4 mt-1 text-sm text-muted-text">{copy.family.vsSquad} · {history.data.matches.length} {copy.players.matches}</p>
              <CompareBars players={[{ id: "own", name: child.name, values: season.own }, { id: "squad", name: copy.family.squadAverage, values: season.squad }]} copy={copy} metrics={SEASON_METRICS} />
            </section>
          )}
          <p className="text-xs text-muted-text">{copy.stats.goalsNote}</p>
        </>
      )}

      {playing && data.recording?.videoUrl && <AnimatePresence>
        <ClipPlayer
          src={data.recording.videoUrl}
          proxySrc={`/api/hls-proxy/manifest?url=${encodeURIComponent(data.recording.videoUrl)}`}
          fallbackSrc={getBunnyMp4FallbackSource(data.recording.videoUrl)}
          title={`${data.academy.name} · ${title}`}
          source={{ kind: "bunny", videoId: bunnyVideoId(data.recording.videoUrl) }}
          layout="overlay"
          canSave={false}
          onRequireAuth={() => setPlaying(false)}
          onSave={async () => { throw new Error("Saving is unavailable here."); }}
          onClose={() => setPlaying(false)}
        />
      </AnimatePresence>}
    </>,
  );
}
