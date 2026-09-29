import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { ArrowUpRight, Crown, Medal, RefreshCw, Trophy } from "lucide-react";
import { Link } from "wouter";
import { PlayerAvatar } from "@/components/match/bits";
import type { MatchStrings } from "@/i18n/match-strings";
import type { MatchRoom, PlayerForm, PlayerMetricValues, TeamSide } from "@/lib/match-api";
import { useAuth } from "@/lib/auth";
import type { Lab } from "@/lib/game-claim/play";
import type { ReportTimeline } from "@/lib/match-report";
import { cn } from "@/lib/utils";
import {
  metricDeltaDirection,
  podiumPlaces,
  rankCompetitionPlayers,
  visibleLeaderboardRows,
} from "./competition-leaderboard";

type MetricKey = "distanceKm" | "topSpeedKmh" | "touches" | "passesCompleted" | "dribblesWon" | "goals";
type AwardKey = "motm" | "distance" | "speed" | "touches" | "passes" | "dribbles" | "goals";

export type PlayerStats = PlayerMetricValues & {
  playerId: number;
  name: string;
  team: string | null;
  claimed: boolean;
  personalBestMetrics?: MetricKey[];
  /** the whole-match report timeline, on claimed rows */
  report?: ReportTimeline;
};

export type TeamStats = {
  sides: string[];
  colours: Lab[];
  measured: boolean[];
  touches: number[];
  passesTried: number[];
  passesCompleted: number[];
  possessionPercent: number[];
  completionPercent: number;
  dribbles?: number[];
  dribblesWon?: number[];
  dribblesLost?: number[];
  shots?: number[];
  goals?: number[];
};

export type CompetitionAward = { key: AwardKey; playerIds: number[]; value: number | null; personalBest: boolean };
type CompetitionCallout =
  | { kind: "outran"; outran: number; total: number }
  | { kind: "speed-beaten"; otherPlayerId: number; gap: number }
  | { kind: "team-dribbles-lead" };

export type Stats = {
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

export function useMatchStatsData(room: MatchRoom, viewerId: number | null, gameId: number | null = null, enabled = true) {
  return useQuery<Stats>({
    queryKey: ["match-stats", room.code, viewerId, room.stats.unlocked, gameId],
    queryFn: async () => {
      const response = await fetch(`${basePath}/api/m/${room.code}/stats${gameId == null ? "" : `?gameId=${encodeURIComponent(gameId)}`}`, { credentials: "include" });
      if (!response.ok) throw new Error(String(response.status));
      return response.json() as Promise<Stats>;
    },
    enabled,
    staleTime: 15_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
}

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

export function RecentFormPanel({ form, copy }: { form: PlayerForm | null; copy: MatchStrings }) {
  if (!form) return <p className="text-xs text-muted-text">{copy.competitionNoForm}</p>;
  const latest = form.lastFive[0];
  if (!latest) return <p className="text-xs text-muted-text">{copy.competitionNoForm}</p>;

  const metrics: MetricKey[] = ["distanceKm", "topSpeedKmh", "touches", "passesCompleted", "dribblesWon", "goals"];
  const labels: Record<MetricKey, string> = {
    distanceKm: copy.competitionDistance,
    topSpeedKmh: copy.competitionSpeed,
    touches: copy.competitionTouches,
    passesCompleted: copy.competitionPasses,
    dribblesWon: copy.competitionDribbles,
    goals: copy.competitionGoals,
  };
  const hasLatestMetric = (key: MetricKey) => latest.stats[key] !== null;
  const hasBestMetric = (key: MetricKey) => form.bests[key] !== null;
  const displayedMetrics = metrics.filter((key) => hasLatestMetric(key) || hasBestMetric(key));

  return (
    <div className="flex flex-col gap-3" data-testid="your-form-last-match">
      <Link href={`/m/${latest.code}`} className="flex min-h-10 items-center justify-between gap-2 rounded-xl border border-line bg-raised/50 px-3 text-xs font-semibold">
        <span className="text-muted-text">{copy.competitionLastMatch}</span>
        <span className="font-mono text-text">{latest.code}</span>
      </Link>
      <div className="grid grid-cols-2 gap-2">
        {displayedMetrics.map((key) => {
          const value = latest.stats[key];
          const average = form.previousAverages?.[key] ?? null;
          const direction = metricDeltaDirection(value, average);
          const delta = value !== null && average !== null ? formatFormMetric(copy, key, Math.abs(value - average)) : null;
          return (
            <div key={key} className="rounded-xl border border-line bg-raised/70 p-2.5" data-testid={`last-match-metric-${key}`}>
              <p className="truncate text-[10px] font-semibold uppercase tracking-wide text-muted-text">{labels[key]}</p>
              <p className="mt-1 font-display text-2xl font-bold leading-none text-text">{formatFormMetric(copy, key, value)}</p>
              {direction && delta && (
                <p className={cn("mt-1 text-[9px] font-bold", direction === "up" ? "text-turf" : "text-violet")}>
                  {direction === "up" ? copy.competitionDeltaAbove(delta) : copy.competitionDeltaBelow(delta)}
                </p>
              )}
            </div>
          );
        })}
      </div>
      {displayedMetrics.some(hasBestMetric) && (
        <div className="border-t border-line pt-3">
          <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.12em] text-muted-text">{copy.competitionPersonalBests}</p>
          <div className="flex flex-wrap gap-1.5">
            {displayedMetrics.filter(hasBestMetric).map((key) => (
              <span key={key} className="rounded-full border border-floodlight/30 bg-floodlight/10 px-2.5 py-1 text-[10px] font-semibold text-floodlight">
                {labels[key]} · {formatFormMetric(copy, key, form.bests[key])}
              </span>
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
  const ranked = useMemo(
    () => rankCompetitionPlayers(claimed, metric, viewerId),
    [claimed, metric, viewerId],
  );
  const visibleRows = visibleLeaderboardRows(ranked.sorted, viewerId, 8);

  useEffect(() => {
    if (!availableMetricKeys.includes(metric)) setMetric(availableMetricKeys[0] ?? "distanceKm");
  }, [availableMetricKeys, metric]);

  if (!competition) return null;
  const playerById = new Map(claimed.map((player) => [player.playerId, player]));
  const unclaimedPlayers = (stats.players ?? []).filter((player) => !player.claimed);
  const podiumColors = { 1: "#D4FF4F", 2: "#E8EAF0", 3: "#2FD8C4" } as const;
  const podiumHeights = { 1: "h-40", 2: "h-32", 3: "h-28" } as const;
  const visibleAwards = competition.awards
    .filter((award) => award.key !== "motm" || room.vote.closed)
    .filter((award) => award.playerIds.some((id) => playerById.has(id)));
  const callouts = competition.callouts.filter((callout) =>
    callout.kind !== "speed-beaten" || playerById.has(callout.otherPlayerId),
  );
  const renderRankRow = (player: PlayerStats) => {
    const value = metricValue(player, metric);
    const viewer = player.playerId === viewerId;
    const rank = ranked.ranks.get(player.playerId);
    const average = viewer ? competition.personalForm?.averages[metric] ?? null : null;
    const direction = viewer ? metricDeltaDirection(value, average) : null;
    const delta = value !== null && average !== null ? Math.abs(value - average) : null;
    const rosterPlayer = room.players.find((candidate) => candidate.id === player.playerId);
    return (
      <motion.div
        key={player.playerId}
        layout
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        className={cn("flex items-center gap-2 rounded-xl border px-2.5 py-2", viewer ? "border-violet/70 bg-violet/10" : "border-line bg-raised/45")}
        data-testid={`row-rank-${player.playerId}`}
      >
        <span className={cn("w-8 shrink-0 text-center font-mono text-xs font-bold", viewer ? "text-violet" : "text-muted-text")}>#{rank}</span>
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          <i className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: player.team ? room.teams[player.team as TeamSide]?.color : "var(--replay-turf)" }} />
          <PlayerAvatar
            name={player.name}
            initials={rosterPlayer?.initials ?? undefined}
            avatarUrl={rosterPlayer?.avatarUrl}
            size={28}
            ring={viewer ? "#7B5CFF" : undefined}
          />
          <span className="truncate text-sm font-semibold">{player.name}</span>
          {viewer && <span className="rounded-full bg-violet px-1.5 py-0.5 text-[9px] font-black text-white">{copy.competitionYou}</span>}
          {player.personalBestMetrics?.includes(metric) && <span title={copy.competitionPersonalBest} className="text-floodlight"><ArrowUpRight className="h-3 w-3" /></span>}
        </span>
        <span className="shrink-0 text-end font-mono text-sm font-bold">{value === null ? copy.competitionMetricUnavailable : `${metricFormat(metric, value)} ${metricUnit(metric)}`}</span>
        {viewer && direction && delta !== null && (
          <span className={cn("hidden shrink-0 text-[9px] font-bold min-[370px]:inline", direction === "up" ? "text-turf" : "text-violet")}>
            {direction === "up"
              ? copy.competitionDeltaAbove(`${metricFormat(metric, delta)} ${metricUnit(metric)}`.trim())
              : copy.competitionDeltaBelow(`${metricFormat(metric, delta)} ${metricUnit(metric)}`.trim())}
          </span>
        )}
        {rank === 1 && <Crown className="h-3.5 w-3.5 shrink-0 text-floodlight" />}
      </motion.div>
    );
  };
  const findHref = stats.recordings[0] ? `/find/${stats.recordings[0]}` : null;
  const viewerGap = ranked.viewer && ranked.above
    ? (metricValue(ranked.above, metric) ?? 0) - (metricValue(ranked.viewer, metric) ?? 0)
    : null;

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
                  <p className="flex items-center justify-between gap-2 text-[10px] font-semibold uppercase tracking-wide text-floodlight">
                    <span>{awardLabel(copy, award.key)}</span>
                    {award.personalBest && <span title={copy.competitionPersonalBest} className="rounded border border-floodlight/40 px-1 py-0.5 font-mono text-[9px] leading-none">{copy.competitionPbTag}</span>}
                  </p>
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
              <div key={callout.kind} className="min-w-[176px] rounded-xl border border-line bg-raised/60 p-3" data-testid={`callout-${callout.kind}`}>
                <p className="text-xs font-semibold leading-5 text-text">
                  {callout.kind === "outran"
                    ? copy.competitionOutran(callout.outran, callout.total)
                    : callout.kind === "speed-beaten"
                      ? copy.competitionSpeedBeaten(playerById.get(callout.otherPlayerId)!.name, callout.gap.toFixed(1))
                      : copy.competitionTeamDribblesLead}
                </p>
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
          <div className="mt-3 grid grid-cols-3 items-end gap-2" data-testid="competition-podium">
            {podiumPlaces(ranked.sorted).map(({ place, player }) => {
              const podiumColor = podiumColors[place];
              const rosterPlayer = player ? room.players.find((candidate) => candidate.id === player.playerId) : null;
              const value = player ? metricValue(player, metric) : null;
              return player ? (
                <motion.div
                  key={place}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.22, delay: place === 1 ? 0 : place === 2 ? 0.05 : 0.1 }}
                  className="flex min-w-0 flex-col items-center justify-end text-center"
                  data-testid={`podium-place-${place}`}
                >
                  <div
                    className={cn("flex w-full flex-col items-center justify-end gap-1.5 overflow-hidden rounded-t-2xl border border-b-0 px-1 pb-3 pt-2", podiumHeights[place])}
                    style={{ borderColor: podiumColor, background: `${podiumColor}16` }}
                  >
                    <span className="font-display text-3xl font-bold leading-none" style={{ color: podiumColor }}>
                      #{ranked.ranks.get(player.playerId)}
                    </span>
                    <PlayerAvatar
                      name={player.name}
                      initials={rosterPlayer?.initials ?? undefined}
                      avatarUrl={rosterPlayer?.avatarUrl}
                      size={place === 1 ? 48 : 40}
                      ring={podiumColor}
                    />
                    <span className="max-w-full truncate text-[10px] font-bold">{player.name}</span>
                    <span className="font-mono text-[10px] font-semibold text-muted-text">
                      {value === null ? "—" : `${metricFormat(metric, value)} ${metricUnit(metric)}`}
                    </span>
                  </div>
                  <div className="h-1.5 w-full rounded-b-full" style={{ backgroundColor: podiumColor }} />
                </motion.div>
              ) : (
                <div key={place} className={cn("flex items-end", podiumHeights[place])} aria-hidden="true">
                  <div className="h-1.5 w-full rounded-b-full bg-raised" />
                </div>
              );
            })}
          </div>
          <div className="mt-3 flex flex-col gap-1.5">
            {visibleRows.topRows.map(renderRankRow)}
            {visibleRows.pinnedViewer && (
              <>
                <div className="flex items-center gap-2 px-3 py-1.5" data-testid="competition-leaderboard-ellipsis" aria-label="More players above">
                  <span className="h-px flex-1 border-t border-dashed border-muted-text/50" />
                  <span className="font-mono text-xs tracking-[0.3em] text-muted-text">···</span>
                  <span className="h-px flex-1 border-t border-dashed border-muted-text/50" />
                </div>
                {renderRankRow(visibleRows.pinnedViewer)}
              </>
            )}
          </div>
          {ranked.viewer && ranked.viewerRank === 1 && (
            <p className="mt-2 rounded-lg bg-floodlight/10 px-3 py-2 text-center text-xs font-bold text-floodlight" data-testid="competition-viewer-top">
              {copy.competitionTopPitch}
            </p>
          )}
          {ranked.viewer && ranked.viewerRank !== null && ranked.viewerRank > 1 && ranked.above && viewerGap !== null && (
            <p className="mt-2 rounded-lg bg-raised/60 px-3 py-2 text-center text-xs font-semibold text-muted-text" data-testid="competition-viewer-gap">
              {copy.competitionGapTo(`${metricFormat(metric, viewerGap)} ${metricUnit(metric)}`.trim(), ranked.above.name)}
            </p>
          )}
        </div>
      )}
      {ranked.sorted.length === 0 && <p className="rounded-xl border border-line bg-raised/40 p-3 text-xs text-muted-text">{copy.competitionNoData}</p>}

      {unclaimedPlayers.length > 0 && (
        <div className="rounded-xl border border-line bg-raised/45 p-3" data-testid="competition-unclaimed">
          <p className="text-xs font-bold text-text">{copy.competitionPlayersNotOnBoard(unclaimedPlayers.length)}</p>
          <p className="mt-1 text-xs text-muted-text">{unclaimedPlayers.map((player) => player.name).join(", ")}</p>
          {findHref && (
            <Link href={findHref} className="mt-3 flex min-h-10 items-center justify-center rounded-full border border-floodlight/60 text-xs font-bold text-floodlight" data-testid="link-find-unclaimed">
              {copy.matchStatsClaim}
            </Link>
          )}
        </div>
      )}

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

export function MatchCompetitionAwardsRow({ room, copy }: { room: MatchRoom; copy: MatchStrings }) {
  const { user } = useAuth();
  const hasStatsAccess = room.phase === "processing" || room.phase === "ready" || room.phase === "expired";
  const enabled = hasStatsAccess
    && room.stats.enabled
    && room.stats.unlocked
    && room.signedIn
    && Boolean(user)
    && (room.isMember || room.isOwner || room.canManage);
  const statsQuery = useMatchStatsData(room, user?.id ?? null, null, enabled);
  if (!enabled || !statsQuery.data?.competition) return null;

  const playerById = new Map((statsQuery.data.players ?? []).map((player) => [player.playerId, player]));
  const awards = statsQuery.data.competition.awards
    .filter((award) => award.key !== "motm")
    .map((award) => ({
      award,
      names: award.playerIds.map((id) => playerById.get(id)?.name).filter((name): name is string => Boolean(name)),
    }))
    .filter(({ names }) => names.length > 0);
  if (!awards.length) return null;

  return (
    <section className="rounded-2xl border border-floodlight/25 bg-surface p-3" data-testid="overview-competition-awards">
      <p className="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-[0.12em] text-muted-text">
        <Medal className="h-3.5 w-3.5 text-floodlight" />{copy.competitionAwards}
      </p>
      <div className="flex gap-2 overflow-x-auto pb-1 no-scrollbar">
        {awards.map(({ award, names }) => {
          const metric: MetricKey = award.key === "distance" ? "distanceKm"
            : award.key === "speed" ? "topSpeedKmh"
              : award.key === "dribbles" ? "dribblesWon"
                : award.key === "passes" ? "passesCompleted"
                  : award.key === "goals" ? "goals"
                    : "touches";
          return (
            <div key={award.key} className="min-w-[148px] rounded-xl border border-floodlight/25 bg-floodlight/5 px-3 py-2" data-testid={`overview-award-${award.key}`}>
              <p className="text-[9px] font-bold uppercase tracking-wide text-floodlight">{awardLabel(copy, award.key)}</p>
              <p className="mt-0.5 truncate text-xs font-semibold">{names.join(" · ")}</p>
              {award.value !== null && <p className="mt-0.5 font-mono text-[10px] text-muted-text">{metricFormat(metric, award.value)} {metricUnit(metric)}</p>}
              {award.personalBest && <span className="mt-1 inline-block rounded border border-floodlight/40 px-1 py-0.5 font-mono text-[8px] leading-none text-floodlight">{copy.competitionPbTag}</span>}
            </div>
          );
        })}
      </div>
    </section>
  );
}

export function MatchStats({ room, copy, gameId = null }: { room: MatchRoom; copy: MatchStrings; gameId?: number | null }) {
  const { user } = useAuth();
  const statsQuery = useMatchStatsData(room, user?.id ?? null, gameId);
  const stats = statsQuery.data ?? null;
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

  if (statsQuery.isError && !stats) {
    return (
      <section className="rounded-2xl border border-line bg-surface p-4 text-center" data-testid="stats-error">
        <p className="text-sm font-semibold text-muted-text">{copy.error}</p>
        <button type="button" onClick={() => void statsQuery.refetch()} className="mx-auto mt-3 inline-flex min-h-10 items-center gap-2 rounded-full border border-line px-4 text-xs font-bold" data-testid="button-retry-match-stats"><RefreshCw className="h-3.5 w-3.5" />{copy.back}</button>
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
  const selectedGame = gameId === null ? null : room.games.find((game) => game.id === gameId) ?? null;
  const displaySideX = selectedGame?.teamX ?? "A";
  const displaySideY = selectedGame?.teamY ?? "B";
  const displayColorX = room.teams[displaySideX]?.color ?? colors[0];
  const displayColorY = room.teams[displaySideY]?.color ?? colors[1];
  const threeTeam = gameId === null && room.teamCount === 3 && Boolean(t && t.sides.length >= 3);
  const threeRows = t && threeTeam ? [
    ...(t.goals?.some((value) => value > 0) ? [{ label: copy.h2hGoals, values: t.goals, format: int }] : []),
    ...(t.shots ? [{ label: copy.h2hShots, values: t.shots, format: int }] : []),
    { label: copy.teamPossession, values: t.possessionPercent, format: (value: number) => `${Math.round(value)}%` },
    { label: copy.teamPasses, values: t.passesCompleted, format: int },
    { label: copy.teamCompletion, values: t.passesCompleted.map((value, index) => pct(value, t.passesTried[index] ?? 0)), format: (value: number) => `${value}%` },
    ...(t.dribblesWon ? [{ label: copy.h2hDribbles, values: t.dribbles ?? t.dribblesWon, format: int }] : []),
    ...(t.dribblesWon ? [{ label: copy.h2hDribbleRate, values: t.dribblesWon.map((value, index) => pct(value, value + (t.dribblesLost?.[index] ?? 0))), format: (value: number) => `${value}%` }] : []),
    { label: copy.teamTouches, values: t.touches, format: int },
  ] : [];

  return (
    <section className="flex flex-col gap-5 rounded-2xl border border-line bg-surface p-4">
      {stats.competition && <CompetitionPanel stats={stats} copy={copy} room={room} />}
      <div>
        <p className="text-base font-bold">{copy.h2hTitle}</p>
        {!threeTeam && <div className="mt-3 grid grid-cols-[1fr_auto_1fr] items-center gap-2" dir="ltr">
          <span className="flex min-w-0 items-center gap-2 text-sm font-bold"><i className="h-3 w-3 shrink-0 rounded-full" style={{ background: displayColorX }} /><span className="truncate">{name(displaySideX)}</span></span>
          <span className="font-mono text-xs text-muted-text">{copy.vs}</span>
          <span className="flex min-w-0 items-center justify-end gap-2 text-sm font-bold"><span className="truncate">{name(displaySideY)}</span><i className="h-3 w-3 shrink-0 rounded-full" style={{ background: displayColorY }} /></span>
        </div>}
      </div>
      {t && (
        <div className="flex flex-col gap-3.5">
          {threeTeam ? (
            <div className="overflow-x-auto rounded-xl border border-line" data-testid="stats-three-team-table">
              <table className="w-full min-w-[390px] text-xs">
                <thead><tr className="border-b border-line text-muted-text"><th className="p-2 text-start">{copy.metric}</th>{t.sides.slice(0, 3).map((side, index) => <th key={side} className="p-2 text-end"><span className="inline-flex items-center gap-1"><i className="h-2 w-2 rounded-full" style={{ background: String(t.colours[index]) }} />{name(side)}</span></th>)}</tr></thead>
                <tbody>
                  {threeRows.map((row) => (
                    <tr key={row.label} className="border-b border-line last:border-0"><th className="p-2 text-start font-semibold text-muted-text">{row.label}</th>{row.values.slice(0, 3).map((value, index) => <td key={index} className="p-2 text-end font-mono font-bold" dir="ltr">{row.format(value)}</td>)}</tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
          <>
          {t.goals && (t.goals[0] + t.goals[1] > 0) && <MirrorRow label={copy.h2hGoals} a={t.goals[0]} b={t.goals[1]} fmt={int} colors={[displayColorX, displayColorY]} />}
          {t.shots && <MirrorRow label={copy.h2hShots} a={t.shots[0]} b={t.shots[1]} fmt={int} colors={[displayColorX, displayColorY]} />}
          <MirrorRow label={copy.teamPossession} a={t.possessionPercent[0]} b={t.possessionPercent[1]} fmt={(value) => `${Math.round(value)}%`} colors={[displayColorX, displayColorY]} />
          <MirrorRow label={copy.teamPasses} a={t.passesCompleted[0]} b={t.passesCompleted[1]} fmt={int} colors={[displayColorX, displayColorY]} />
          <MirrorRow label={copy.teamCompletion} a={pct(t.passesCompleted[0], t.passesTried[0])} b={pct(t.passesCompleted[1], t.passesTried[1])} fmt={(value) => `${value}%`} colors={[displayColorX, displayColorY]} />
          {t.dribblesWon && <><MirrorRow label={copy.h2hDribbles} a={(t.dribbles ?? t.dribblesWon)[0]} b={(t.dribbles ?? t.dribblesWon)[1]} fmt={int} colors={[displayColorX, displayColorY]} /><MirrorRow label={copy.h2hDribbleRate} a={pct(t.dribblesWon[0], t.dribblesWon[0] + (t.dribblesLost?.[0] ?? 0))} b={pct(t.dribblesWon[1], t.dribblesWon[1] + (t.dribblesLost?.[1] ?? 0))} fmt={(value) => `${value}%`} colors={[displayColorX, displayColorY]} /></>}
          <MirrorRow label={copy.teamTouches} a={t.touches[0]} b={t.touches[1]} fmt={int} colors={[displayColorX, displayColorY]} />
          {hasSideKm && <><MirrorRow label={copy.h2hDistance} a={km("A")} b={km("B")} fmt={(value) => `${value.toFixed(1)} km`} colors={colors} /><MirrorRow label={copy.h2hTopSpeed} a={top("A")} b={top("B")} fmt={(value) => (value ? value.toFixed(1) : "—")} colors={colors} /><p className="text-[11px] text-muted-text">{copy.h2hClaimedOnly}</p></>}
          </>
          )}
        </div>
      )}

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
      {findHref && !(stats.competition && stats.players?.some((player) => !player.claimed)) && <Link href={findHref} className="flex min-h-11 items-center justify-center rounded-full border border-floodlight/60 text-sm font-bold text-floodlight" data-testid="link-find-yourself">{copy.matchStatsClaim}</Link>}
      <p className="text-xs text-muted-text">{copy.statsFloor}</p>
    </section>
  );
}