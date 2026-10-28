import { Crown, Footprints, Route, Zap } from "lucide-react";
import type { MatchStrings } from "@/i18n/match-strings";
import type { ReportStrings } from "@/i18n/report-strings";
import type { MatchReplay, MatchRoom, TeamSide } from "@/lib/match-api";
import { isPersonalBest, metricValue, formatMetric, minuteMark, rankedCount, standings } from "@/lib/match-report";
import { cn } from "@/lib/utils";
import { PlayerAvatar, StandingsTable } from "@/components/match/bits";
import type { PlayerStats, Stats } from "@/components/match/MatchStats";
import { Num, visibleColour } from "./ReportParts";
import { useSetScore } from "@/lib/match-api";

type Copy = MatchStrings & { locale: "en" | "ar" };
type R = ReportStrings & { locale: "en" | "ar" };

export function ReportScoreRows({ room, copy, r, colors, names, replay, meId, me, players, stats, onOpenCaptainTools }: {
  room: MatchRoom; copy: Copy; r: R; colors: Record<TeamSide, string>; names: Record<TeamSide, string>;
  replay: MatchReplay | undefined; meId: number | null; me: PlayerStats | null; players: PlayerStats[];
  stats: Stats | null; onOpenCaptainTools?: () => void;
}) {
  const setScore = useSetScore(room.code);
  const score = room.score;
  const suggested = replay?.suggested ?? null;
  const three = room.teamCount === 3;
  const viewer = me ? room.players.find((player) => player.id === me.playerId) : null;
  const winner = Boolean(me && room.vote.closed && room.vote.winners.includes(me.playerId));
  const goals = me?.report?.goalTimes ?? replay?.goals.filter((goal) => goal.scorer?.playerId === meId).map((goal) => goal.atSeconds) ?? [];
  const scoreOutcome = me?.team && score && me.team !== "C"
    ? score.a === score.b ? r.draw
      : (me.team === "A" ? score.a > score.b : score.b > score.a) ? r.weWon : r.weLost
    : null;
  const metrics = me && stats ? [
    { metric: "distanceRate" as const, label: r.perTenOnCamera, icon: <Route className="h-4 w-4" /> },
    { metric: "topSpeed" as const, label: r.kmhTop, icon: <Zap className="h-4 w-4" /> },
    { metric: "touchRate" as const, label: r.touchesPerTen, icon: <Footprints className="h-4 w-4" /> },
  ].map((cell) => {
    const value = metricValue(me, cell.metric);
    const standing = standings(players.filter((player) => player.claimed), cell.metric).find((entry) => entry.player.playerId === me.playerId);
    const personalBest = cell.metric === "distanceRate"
      ? isPersonalBest("distance", me.distanceKm, stats.competition?.personalForm?.bests.distanceKm ?? null, stats.competition?.personalForm?.matchesUsed ?? 0)
      : cell.metric === "topSpeed"
        ? isPersonalBest("topSpeed", me.topSpeedKmh, stats.competition?.personalForm?.bests.topSpeedKmh ?? null, stats.competition?.personalForm?.matchesUsed ?? 0)
        : false;
    const rank = standing?.ranked
      ? standing.shared ? r.rankShared(r.ordinal(standing.rank), rankedCount(players.filter((player) => player.claimed), cell.metric))
        : r.rankOf(r.ordinal(standing.rank), rankedCount(players.filter((player) => player.claimed), cell.metric))
      : r.notRankedShort(Math.round(me.minutes ?? 0));
    return { ...cell, value: value === null ? "–" : formatMetric(cell.metric, value), note: personalBest ? r.personalBest : rank, personalBest };
  }) : [];

  return (
    <>
      {me ? (
        <>
          <div className="mt-3 flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <span className="relative">
                {winner && <Crown className="absolute -top-3 left-1/2 z-10 h-5 w-5 -translate-x-1/2 text-floodlight" />}
                <PlayerAvatar name={me.name} initials={viewer?.initials} avatarUrl={viewer?.avatarUrl} size={58} ring="#D4FF4F" />
              </span>
              <div className="min-w-0">
                <h1 className="font-display text-2xl font-extrabold">{r.matchForYou}</h1>
                {winner && <p className="text-sm font-bold text-floodlight">{r.motmWinner}</p>}
                {goals.map((at) => <p key={at} className="text-xs text-muted-text">{r.scoredAt(String(minuteMark(at)))}</p>)}
              </div>
            </div>
            {score && <div className="shrink-0 text-end" dir="ltr">
              <Num className="text-[30px] font-bold leading-none text-text">{score.a}–{score.b}</Num>
              {scoreOutcome && <p className={cn("text-xs font-extrabold", scoreOutcome === r.weWon ? "text-turf" : "text-muted-text")}>{scoreOutcome}</p>}
            </div>}
          </div>
          {three && room.standings && <div className="mt-3"><StandingsTable rows={room.standings} colors={colors} names={names} leader={room.leader} labels={copy} compact /></div>}
        </>
      ) : three && room.standings ? (
        <div className="mt-3"><StandingsTable rows={room.standings} colors={colors} names={names} leader={room.leader} labels={copy} compact /></div>
      ) : (
        <div className="mt-3 grid grid-cols-[1fr_auto_1fr] items-center gap-2" dir="ltr">
          <span className="flex min-w-0 items-center gap-2"><i className="h-3 w-3 shrink-0 rounded-full border border-white/30" style={{ background: visibleColour(colors.A) }} /><span className="truncate font-display text-base font-bold">{names.A}</span></span>
          <Num className={cn("text-[40px] font-bold leading-none", !score && "text-[#3A4560]")}>{score ? `${score.a}–${score.b}` : "–"}</Num>
          <span className="flex min-w-0 items-center justify-end gap-2"><span className="truncate font-display text-base font-bold text-muted-text">{names.B}</span><i className="h-3 w-3 shrink-0 rounded-full border border-white/30" style={{ background: visibleColour(colors.B) }} /></span>
        </div>
      )}
      {!score && !three && (
        <div className="mt-2 flex flex-wrap items-center justify-center gap-2 text-xs text-muted-text">
          <span>{r.awaitingScore}</span>
          {suggested && <span>· {r.replayCounted(suggested.a, suggested.b)}</span>}
          {suggested && room.canManage && (
            <button type="button" disabled={setScore.isPending} onClick={() => void setScore.mutateAsync({ scoreA: suggested.a, scoreB: suggested.b })}
              className="min-h-11 rounded-full border border-turf/60 px-3 text-xs font-semibold text-turf disabled:opacity-60">{r.useReplayScore}</button>
          )}
          {!suggested && room.canManage && (onOpenCaptainTools ? (
            <button type="button" onClick={onOpenCaptainTools} className="min-h-11 rounded-full border border-turf/60 px-3 text-xs font-semibold text-turf">{r.enterScore}</button>
          ) : <span className="text-turf">{r.enterScore}</span>)}
        </div>
      )}
      {me && metrics.length > 0 && <div className="mt-4 grid grid-cols-3 gap-2">
        {metrics.map((metric) => <div key={metric.metric} className="min-w-0 rounded-xl bg-void/45 p-2.5">
          <div className="flex items-center justify-between text-muted-text">{metric.icon}<span className="truncate text-[9px]">{metric.metric === "distanceRate" ? "km" : metric.metric === "topSpeed" ? "km/h" : ""}</span></div>
          <Num className={cn("mt-1 block text-2xl font-bold leading-none", metric.personalBest ? "text-floodlight" : "text-text")}>{metric.value}</Num>
          <span className="mt-1 block truncate text-[10px] text-muted-text">{metric.label}</span>
          <span className={cn("mt-1 block truncate text-[9px]", metric.personalBest ? "font-bold text-floodlight" : "text-muted-text")}>{metric.note}</span>
        </div>)}
      </div>}
    </>
  );
}
