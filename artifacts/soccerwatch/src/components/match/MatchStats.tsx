import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { ArrowUpRight, Crown, Medal, RefreshCw, Trophy } from "lucide-react";
import { Link } from "wouter";
import type { MatchStrings } from "@/i18n/match-strings";
import type { MatchRoom, PlayerForm, PlayerMetricValues, TeamSide } from "@/lib/match-api";
import type { Lab } from "@/lib/game-claim/play";
import { cn } from "@/lib/utils";

type MetricKey = "distanceKm" | "topSpeedKmh" | "touches" | "passesCompleted" | "dribblesWon" | "goals";
type AwardKey = "motm" | "distance" | "speed" | "touches" | "passes" | "dribbles" | "goals";

type PlayerStats = PlayerMetricValues & {
  playerId: number;
  name: string;
  team: string | null;
  claimed: boolean;
  personalBestMetrics?: MetricKey[];
};

type TeamStats = {
  sides: [string, string];
  colours: [Lab, Lab];
  measured: [boolean, boolean];
  touches: [number, number];
  passesTried: [number, number];
  passesCompleted: [number, number];
  possessionPercent: [number, number];
  completionPercent: number;
  dribbles?: [number, number];
  dribblesWon?: [number, number];
  dribblesLost?: [number, number];
  shots?: [number, number];
  goals?: [number, number];
};

type CompetitionAward = { key: AwardKey; playerIds: number[]; value: number | null };
type CompetitionCallout = {
  metric: MetricKey;
  leaderId: number;
  runnerUpId: number;
  leaderValue: number;
  runnerUpValue: number;
  gap: number;
};

type Stats = {
  available: boolean;
  recordings: number[];
  hasBall: boolean;
  hasPitch: boolean;
  unlocked: boolean;
  players: PlayerStats[] | null;
  team: TeamStats | null;
  competition?: {
    viewerPlayerId: number | null;
    awards: CompetitionAward[];
    callouts: CompetitionCallout[];
    personalForm: PlayerForm | null;
  };
};

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
const pct = (x: number, y: number) => (y > 0 ? Math.round((100 * x) / y) : 0);

function MirrorRow({ label, a, b, fmt, colors, lowerIsBetter = false }: {
  label: string;
  a: number;
  b: number;
  fmt: (v: number) => string;
  colors: [string, string];
  lowerIsBetter?: boolean;
}) {
  const max = Math.max(a, b, 1e-9);
  const lead = a === b ? null : (a > b) !== lowerIsBetter ? 0 : 1;
  return (
    <div className="flex flex-col gap-1">
      <div className="grid grid-cols-[3.5rem_1fr_3.5rem] items-baseline text-sm" dir="ltr">
        <span className={cn("tabular-nums", lead === 0 ? "font-black text-text" : "text-muted-text")}>{fmt(a)}</span>
        <span className="text-center text-xs font-semibold uppercase tracking-wider text-muted-text">{label}</span>
        <span className={cn("text-end tabular-nums", lead === 1 ? "font-black text-text" : "text-muted-text")}>{fmt(b)}</span>
      </div>
      <div className="grid grid-cols-2 gap-1" dir="ltr">
        <div className="flex h-2 justify-end overflow-hidden rounded-s-full bg-white/5">
          <i className="block h-full rounded-s-full" style={{ width: `${(100 * a) / max}%`, background: colors[0], opacity: lead === 1 ? 0.55 : 1 }} />
        </div>
        <div className="flex h-2 overflow-hidden rounded-e-full bg-white/5">
          <i className="block h-full rounded-e-full" style={{ width: `${(100 * b) / max}%`, background: colors[1], opacity: lead === 0 ? 0.55 : 1 }} />
        </div>
      </div>
    </div>
  );
}

const metricValue = (player: PlayerStats, key: MetricKey): number | null => player[key] ?? null;

function metricFormat(key: MetricKey, value: number): string {
  if (key === "distanceKm") return value.toFixed(2);
  if (key === "topSpeedKmh") return value.toFixed(1);
  return String(Math.round(value));
}

function metricUnit(key: MetricKey): string {
  if (key === "distanceKm") return "km";
  if (key === "topSpeedKmh") return "km/h";
  return "";
}

function metricLabel(copy: MatchStrings, key: MetricKey): string {
  const labels: Record<MetricKey, string> = {
    distanceKm: copy.competitionDistance,
    topSpeedKmh: copy.competitionSpeed,
    touches: copy.competitionTouches,
    passesCompleted: copy.competitionPasses,
    dribblesWon: copy.competitionDribbles,
    goals: copy.competitionGoals,
  };
  return labels[key];
}

function awardLabel(copy: MatchStrings, key: AwardKey): string {
  const labels: Record<AwardKey, string> = {
    motm: copy.motm,
    distance: copy.competitionAwardDistance,
    speed: copy.competitionAwardSpeed,
    touches: copy.competitionAwardTouches,
    passes: copy.competitionAwardPasses,
    dribbles: copy.competitionAwardDribbles,
    goals: copy.competitionAwardGoals,
  };
  return labels[key];
}

function formatFormMetric(copy: MatchStrings, key: keyof PlayerMetricValues, value: number | null): string {
  if (value === null) return copy.competitionMetricUnavailable;
  if (key === "distanceKm") return `${value.toFixed(2)} km`;
  if (key === "topSpeedKmh") return `${value.toFixed(1)} km/h`;
  return String(Math.round(value));
}

export function FormPanel({ form, copy, compact = false }: { form: PlayerForm | null; copy: MatchStrings; compact?: boolean }) {
  if (!form) {
    return <p className="text-xs text-muted-text">{copy.competitionNoForm}</p>;
  }
  const formMetrics: Array<keyof PlayerMetricValues> = ["distanceKm", "topSpeedKmh", "touches", "passesCompleted", "goals"];
  const shortMetricLabels: Record<keyof PlayerMetricValues, string> = {
    minutes: copy.pvpMinutes,
    distanceKm: copy.competitionDistance,
    topSpeedKmh: copy.competitionSpeed,
    touches: copy.competitionTouches,
    passesTried: copy.competitionPasses,
    passesCompleted: copy.competitionPasses,
    passesReceived: copy.pvpPasses,
    dribbles: copy.pvpDribbles,
    dribblesWon: copy.competitionDribbles,
    dribblesLost: copy.pvpDribblesLost,
    shots: copy.pvpShots,
    goals: copy.competitionGoals,
  };
  const available = formMetrics.filter((key) => form.averages[key] !== null || form.bests[key] !== null);
  return (
    <div className={cn("flex flex-col gap-3", compact && "gap-2")}>
      <div className="grid grid-cols-2 gap-2">
        {available.slice(0, compact ? 3 : 5).map((key) => (
          <div key={key} className="rounded-xl border border-line bg-raised/70 p-2.5" data-testid={`form-metric-${key}`}>
            <p className="truncate text-[10px] font-semibold uppercase tracking-wide text-muted-text">{shortMetricLabels[key]}</p>
            <div className="mt-1 flex items-baseline gap-1.5 font-mono">
              <span className="text-lg font-bold text-floodlight">{formatFormMetric(copy, key, form.averages[key])}</span>
              <span className="text-[10px] text-muted-text">{copy.competitionAverage}</span>
            </div>
            <p className="mt-0.5 text-[10px] text-muted-text">{copy.competitionBest}: {formatFormMetric(copy, key, form.bests[key])}</p>
          </div>
        ))}
      </div>
      {!compact && form.lastFive.length > 0 && (
        <div>
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-text">{copy.competitionLastFive}</p>
          <div className="flex gap-1.5 overflow-x-auto pb-1 no-scrollbar" dir="ltr">
            {form.lastFive.map((match) => (
              <Link key={match.matchId} href={`/m/${match.code}`} className="min-w-[74px] rounded-lg border border-line bg-raised px-2 py-1.5 text-center" data-testid={`link-form-match-${match.matchId}`}>
                <span className="block font-mono text-xs font-bold text-text">{match.code}</span>
                <span className="mt-0.5 block text-[9px] text-muted-text">{match.stats.distanceKm === null ? "—" : `${match.stats.distanceKm.toFixed(1)} km`}</span>
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function CompetitionPanel({ stats, copy, room }: { stats: Stats; copy: MatchStrings; room: MatchRoom }) {
  const competition = stats.competition;
  const claimed = (stats.players ?? []).filter((player) => player.claimed);
  const [metric, setMetric] = useState<MetricKey>("distanceKm");
  const viewerId = competition?.viewerPlayerId ?? null;
  const metricKeys: MetricKey[] = ["distanceKm", "topSpeedKmh", "touches", "passesCompleted", "dribblesWon", "goals"];
  const hasGoals = claimed.some((player) => player.goals !== null);
  const availableMetricKeys = metricKeys.filter((key) =>
    (key !== "goals" || hasGoals) && claimed.some((player) => metricValue(player, key) !== null),
  );
  const ranked = useMemo(() => {
    const eligible = claimed.filter((player) => metricValue(player, metric) !== null);
    const sorted = [...eligible].sort((a, b) => (metricValue(b, metric) ?? 0) - (metricValue(a, metric) ?? 0));
    const ranks = new Map<number, number>();
    sorted.forEach((player, index) => {
      const previous = index > 0 ? metricValue(sorted[index - 1], metric) : null;
      ranks.set(player.playerId, previous !== null && previous === metricValue(player, metric) ? (ranks.get(sorted[index - 1].playerId) ?? index + 1) : index + 1);
    });
    const viewerIndex = sorted.findIndex((player) => player.playerId === viewerId);
    const above = viewerIndex > 0 ? sorted[viewerIndex - 1] : null;
    const viewer = viewerIndex >= 0 ? sorted[viewerIndex] : null;
    const displayRows = viewer ? [viewer, ...sorted.filter((player) => player.playerId !== viewer.playerId)] : sorted;
    return { sorted, displayRows, ranks, above, viewer };
  }, [claimed, metric, viewerId]);

  useEffect(() => {
    if (!availableMetricKeys.includes(metric)) setMetric(availableMetricKeys[0] ?? "distanceKm");
  }, [availableMetricKeys, metric]);

  if (!competition) return null;
  const playerById = new Map(claimed.map((player) => [player.playerId, player]));
  const visibleAwards = competition.awards
    .filter((award) => award.key !== "motm" || room.vote.closed)
    .filter((award) => award.playerIds.some((id) => playerById.has(id)));
  const callouts = competition.callouts.filter((callout) => playerById.has(callout.leaderId) && playerById.has(callout.runnerUpId));

  return (
    <motion.section
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.28 }}
      className="flex flex-col gap-4 rounded-2xl border border-floodlight/25 bg-surface p-4"
      data-testid="section-competition-stats"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="flex items-center gap-2 text-base font-bold"><Trophy className="h-4 w-4 text-floodlight" />{copy.competitionTitle}</p>
          <p className="mt-1 text-xs leading-5 text-muted-text">{copy.competitionHint}</p>
        </div>
        <span className="rounded-full border border-floodlight/30 bg-floodlight/10 px-2 py-1 font-mono text-[10px] font-bold text-floodlight">{claimed.length}</span>
      </div>

      {visibleAwards.length > 0 && (
        <div>
          <p className="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-[0.12em] text-muted-text"><Medal className="h-3.5 w-3.5 text-floodlight" />{copy.competitionAwards}</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {visibleAwards.map((award) => {
              const winner = award.playerIds.map((id) => playerById.get(id)).filter((player): player is PlayerStats => Boolean(player));
              return (
                <div key={award.key} className="rounded-xl border border-line bg-raised/75 p-3" data-testid={`award-${award.key}`}>
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-floodlight">{awardLabel(copy, award.key)}</p>
                  <p className="mt-1 truncate text-sm font-bold">{winner.map((player) => player.name).join(" · ")}</p>
                  {award.value !== null && <p className="mt-1 font-mono text-xs text-muted-text">{metricFormat(award.key === "distance" ? "distanceKm" : award.key === "speed" ? "topSpeedKmh" : award.key === "dribbles" ? "dribblesWon" : award.key === "passes" ? "passesCompleted" : award.key === "goals" ? "goals" : "touches", award.value)}</p>}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {callouts.length > 0 && (
        <div>
          <p className="mb-2 text-xs font-bold uppercase tracking-[0.12em] text-muted-text">{copy.competitionCallouts}</p>
          <div className="flex gap-2 overflow-x-auto pb-1 no-scrollbar">
            {callouts.map((callout) => (
              <div key={`${callout.metric}-${callout.leaderId}`} className="min-w-[176px] rounded-xl border border-line bg-raised/60 p-3" data-testid={`callout-${callout.metric}`}>
                <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-text">{metricLabel(copy, callout.metric)}</p>
                <p className="mt-1 truncate text-sm font-bold">{playerById.get(callout.leaderId)?.name}</p>
                <p className="mt-0.5 font-mono text-base font-bold text-floodlight">{metricFormat(callout.metric, callout.leaderValue)} {metricUnit(callout.metric)}</p>
                <p className="mt-1 text-[10px] text-muted-text">{playerById.get(callout.runnerUpId)?.name} · {metricFormat(callout.metric, callout.runnerUpValue)} {metricUnit(callout.metric)}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {ranked.sorted.length > 0 && (
        <div className="border-t border-line pt-4">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-bold uppercase tracking-[0.12em] text-muted-text">{copy.competitionMetric}</p>
            <div className="flex max-w-[76%] gap-1 overflow-x-auto no-scrollbar" dir="ltr">
              {availableMetricKeys.map((key) => (
                <button key={key} type="button" onClick={() => setMetric(key)} data-testid={`button-rank-${key}`} className={cn("shrink-0 rounded-full border px-2.5 py-1.5 text-[10px] font-bold transition-colors", metric === key ? "border-floodlight bg-floodlight text-void" : "border-line bg-raised text-muted-text")}>
                  {metricLabel(copy, key)}
                </button>
              ))}
            </div>
          </div>
          <div className="mt-3 flex flex-col gap-1.5">
            {ranked.displayRows.map((player) => {
              const value = metricValue(player, metric);
              const viewer = player.playerId === viewerId;
              const above = viewer && ranked.above ? metricValue(ranked.above, metric) : null;
              const numericGap = viewer && above !== null && value !== null ? above - value : null;
              return (
                <motion.div key={player.playerId} layout initial={{ opacity: 0 }} animate={{ opacity: 1 }} className={cn("flex items-center gap-2 rounded-xl border px-2.5 py-2", viewer ? "border-floodlight/70 bg-floodlight/10" : "border-line bg-raised/45")} data-testid={`row-rank-${player.playerId}`}>
                  <span className="w-5 text-center font-mono text-xs font-bold text-muted-text">{ranked.ranks.get(player.playerId)}</span>
                  <span className="flex min-w-0 flex-1 items-center gap-1.5">
                    <i className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: player.team ? room.teams[player.team as TeamSide]?.color : "var(--replay-turf)" }} />
                    <span className="truncate text-sm font-semibold">{player.name}</span>
                    {viewer && <span className="rounded-full bg-floodlight px-1.5 py-0.5 text-[9px] font-black text-void">{copy.competitionYou}</span>}
                    {player.personalBestMetrics?.includes(metric) && <span title={copy.competitionPersonalBest} className="text-floodlight"><ArrowUpRight className="h-3 w-3" /></span>}
                  </span>
                  <span className="shrink-0 text-end font-mono text-sm font-bold">{value === null ? copy.competitionMetricUnavailable : `${metricFormat(metric, value)} ${metricUnit(metric)}`}</span>
                  {viewer && numericGap !== null && numericGap > 0 && <span className="hidden shrink-0 text-[9px] font-semibold text-muted-text min-[370px]:inline">{copy.competitionGap(`${metricFormat(metric, numericGap)} ${metricUnit(metric)}`)}</span>}
                  {ranked.ranks.get(player.playerId) === 1 && <Crown className="h-3.5 w-3.5 shrink-0 text-floodlight" />}
                </motion.div>
              );
            })}
          </div>
        </div>
      )}
      {ranked.sorted.length === 0 && <p className="rounded-xl border border-line bg-raised/40 p-3 text-xs text-muted-text">{copy.competitionNoData}</p>}

      {competition.personalForm && (
        <div className="border-t border-line pt-4">
          <div className="mb-3 flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-bold">{copy.competitionForm}</p>
              <p className="mt-0.5 text-xs text-muted-text">{copy.competitionFormHint(competition.personalForm.matchesUsed)}</p>
            </div>
            <span className="font-mono text-xs text-floodlight">{competition.personalForm.matchesUsed} {copy.competitionMatches}</span>
          </div>
          <FormPanel form={competition.personalForm} copy={copy} compact />
        </div>
      )}
    </motion.section>
  );
}

export function MatchStats({ room, copy }: { room: MatchRoom; copy: MatchStrings }) {
  const [stats, setStats] = useState<Stats | null>(null);
  const [failed, setFailed] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  useEffect(() => {
    let live = true;
    setFailed(false);
    setStats(null);
    fetch(`${basePath}/api/m/${room.code}/stats`, { credentials: "include" })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(String(response.status)))))
      .then((data: Stats) => { if (live) setStats(data); })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [room.code, room.stats.unlocked, retryKey]);

  const claimed = useMemo(() => (stats?.players ?? []).filter((player) => player.claimed), [stats]);
  const [pa, setPa] = useState<number | null>(null);
  const [pb, setPb] = useState<number | null>(null);
  useEffect(() => {
    if (!claimed.length) return;
    const byKm = [...claimed].sort((p, q) => (q.distanceKm ?? -1) - (p.distanceKm ?? -1));
    const first = byKm.find((p) => p.team === "A") ?? byKm[0];
    const second = byKm.find((p) => p.team && p.team !== first.team) ?? byKm.find((p) => p.playerId !== first.playerId) ?? null;
    setPa((value) => value ?? first.playerId);
    setPb((value) => value ?? second?.playerId ?? null);
  }, [claimed]);

  if (failed) {
    return (
      <section className="rounded-2xl border border-line bg-surface p-4 text-center" data-testid="stats-error">
        <p className="text-sm font-semibold text-muted-text">{copy.error}</p>
        <button type="button" onClick={() => setRetryKey((key) => key + 1)} className="mx-auto mt-3 inline-flex min-h-10 items-center gap-2 rounded-full border border-line px-4 text-xs font-bold" data-testid="button-retry-match-stats"><RefreshCw className="h-3.5 w-3.5" />{copy.back}</button>
      </section>
    );
  }
  if (!stats) {
    return <section className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4" data-testid="stats-loading"><div className="h-4 w-36 animate-pulse rounded bg-raised" /><div className="h-3 w-full animate-pulse rounded bg-raised" /><div className="h-20 animate-pulse rounded-xl bg-raised" /></section>;
  }
  const findHref = stats.recordings[0] ? `/find/${stats.recordings[0]}` : null;
  if (!stats.available) return <section className="rounded-2xl border border-line bg-surface p-4 text-sm text-muted-text">{copy.matchStatsNoFootage}</section>;
  const t = stats.team;
  const name = (side: string) => room.teams[side as TeamSide]?.name || side;
  const colors: [string, string] = [room.teams.A.color, room.teams.B.color];
  const bySide = (side: "A" | "B") => claimed.filter((player) => player.team === side);
  const km = (side: "A" | "B") => bySide(side).reduce((sum, player) => sum + (player.distanceKm ?? 0), 0);
  const top = (side: "A" | "B") => bySide(side).reduce((sum, player) => Math.max(sum, player.topSpeedKmh ?? 0), 0);
  const hasSideKm = km("A") > 0 || km("B") > 0;
  const int = (value: number) => String(Math.round(value));
  const playerA = claimed.find((player) => player.playerId === pa) ?? null;
  const playerB = claimed.find((player) => player.playerId === pb) ?? null;
  const pvpRows: Array<[string, (player: PlayerStats) => number | null, (value: number) => string]> = [
    [copy.pvpMinutes, (player) => player.minutes, int],
    [copy.pvpKm, (player) => player.distanceKm, (value) => value.toFixed(2)],
    [copy.pvpTop, (player) => player.topSpeedKmh, (value) => value.toFixed(1)],
    [copy.pvpTouches, (player) => player.touches, int],
    [copy.pvpPasses, (player) => player.passesCompleted, int],
    [copy.pvpDribbles, (player) => player.dribbles, int],
    [copy.pvpDribblesWon, (player) => player.dribblesWon, int],
    [copy.pvpDribblesLost, (player) => player.dribblesLost, int],
    [copy.pvpShots, (player) => player.shots, int],
    [copy.pvpGoals, (player) => player.goals, int],
  ];
  const playerColor = (player: PlayerStats | null, fallback: string) => (player?.team ? room.teams[player.team as TeamSide]?.color ?? fallback : fallback);
  const pvpA = playerColor(playerA, colors[0]);
  const pvpB = playerColor(playerB, colors[1]);
  const pvpColors: [string, string] = pvpA.toLowerCase() === pvpB.toLowerCase() ? [pvpA, "#7B5CFF"] : [pvpA, pvpB];

  return (
    <section className="flex flex-col gap-5 rounded-2xl border border-line bg-surface p-4">
      <div>
        <p className="text-base font-bold">{copy.h2hTitle}</p>
        <div className="mt-3 grid grid-cols-[1fr_auto_1fr] items-center gap-2" dir="ltr">
          <span className="flex min-w-0 items-center gap-2 text-sm font-bold"><i className="h-3 w-3 shrink-0 rounded-full" style={{ background: colors[0] }} /><span className="truncate">{name("A")}</span></span>
          <span className="font-mono text-xs text-muted-text">{copy.vs}</span>
          <span className="flex min-w-0 items-center justify-end gap-2 text-sm font-bold"><span className="truncate">{name("B")}</span><i className="h-3 w-3 shrink-0 rounded-full" style={{ background: colors[1] }} /></span>
        </div>
      </div>
      {t && (
        <div className="flex flex-col gap-3.5">
          {t.goals && (t.goals[0] + t.goals[1] > 0) && <MirrorRow label={copy.h2hGoals} a={t.goals[0]} b={t.goals[1]} fmt={int} colors={colors} />}
          {t.shots && <MirrorRow label={copy.h2hShots} a={t.shots[0]} b={t.shots[1]} fmt={int} colors={colors} />}
          <MirrorRow label={copy.teamPossession} a={t.possessionPercent[0]} b={t.possessionPercent[1]} fmt={(value) => `${Math.round(value)}%`} colors={colors} />
          <MirrorRow label={copy.teamPasses} a={t.passesCompleted[0]} b={t.passesCompleted[1]} fmt={int} colors={colors} />
          <MirrorRow label={copy.teamCompletion} a={pct(t.passesCompleted[0], t.passesTried[0])} b={pct(t.passesCompleted[1], t.passesTried[1])} fmt={(value) => `${value}%`} colors={colors} />
          {t.dribblesWon && <><MirrorRow label={copy.h2hDribbles} a={(t.dribbles ?? t.dribblesWon)[0]} b={(t.dribbles ?? t.dribblesWon)[1]} fmt={int} colors={colors} /><MirrorRow label={copy.h2hDribbleRate} a={pct(t.dribblesWon[0], t.dribblesWon[0] + (t.dribblesLost?.[0] ?? 0))} b={pct(t.dribblesWon[1], t.dribblesWon[1] + (t.dribblesLost?.[1] ?? 0))} fmt={(value) => `${value}%`} colors={colors} /></>}
          <MirrorRow label={copy.teamTouches} a={t.touches[0]} b={t.touches[1]} fmt={int} colors={colors} />
          {hasSideKm && <><MirrorRow label={copy.h2hDistance} a={km("A")} b={km("B")} fmt={(value) => `${value.toFixed(1)} km`} colors={colors} /><MirrorRow label={copy.h2hTopSpeed} a={top("A")} b={top("B")} fmt={(value) => (value ? value.toFixed(1) : "—")} colors={colors} /><p className="text-[11px] text-muted-text">{copy.h2hClaimedOnly}</p></>}
        </div>
      )}

      {stats.competition && <CompetitionPanel stats={stats} copy={copy} room={room} />}

      {stats.players && claimed.length >= 2 && (
        <div className="flex flex-col gap-3 border-t border-line pt-4">
          <div><p className="text-base font-bold">{copy.pvpTitle}</p><p className="mt-0.5 text-xs text-muted-text">{copy.pvpHint}</p></div>
          <div className="grid grid-cols-2 gap-2">
            {[{ value: pa, set: setPa, other: pb }, { value: pb, set: setPb, other: pa }].map((select, index) => (
              <select key={index} value={select.value ?? ""} onChange={(event) => select.set(Number(event.target.value))} className="min-h-11 rounded-xl border border-line bg-raised px-3 text-sm font-semibold text-text" data-testid={`select-pvp-${index}`}>
                {claimed.map((player) => <option key={player.playerId} value={player.playerId} disabled={player.playerId === select.other}>{player.name}</option>)}
              </select>
            ))}
          </div>
          {playerA && playerB && <div className="flex flex-col gap-3">{pvpRows.map(([label, get, format]) => { const a = get(playerA); const b = get(playerB); if (a === null && b === null) return null; return <MirrorRow key={label} label={label} a={a ?? 0} b={b ?? 0} fmt={(value) => (value === 0 && label === copy.pvpTop ? "—" : format(value))} colors={pvpColors} />; })}</div>}
        </div>
      )}
      {stats.players && claimed.length === 0 && <p className="text-sm text-muted-text">{copy.matchStatsNone}</p>}
      {stats.players && claimed.length > 0 && stats.players.length > claimed.length && <p className="text-xs text-muted-text">{stats.players.filter((player) => !player.claimed).map((player) => player.name).join(", ")} · {copy.notClaimed}</p>}
      {findHref && <Link href={findHref} className="flex min-h-11 items-center justify-center rounded-full border border-floodlight/60 text-sm font-bold text-floodlight" data-testid="link-find-yourself">{copy.matchStatsClaim}</Link>}
      <p className="text-xs text-muted-text">{copy.statsFloor}</p>
    </section>
  );
}