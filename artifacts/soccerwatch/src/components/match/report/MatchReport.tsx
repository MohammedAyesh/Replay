import { useState, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { ArrowLeft, Crown, Flag, Footprints, Loader2, Play, RefreshCw, Share2, Shield, Sparkles, Users, Video, UserPlus, Scissors, Zap, Route, Clock3, Trophy } from "lucide-react";
import { FriendButton } from "@/components/friends/FriendButton";
import { PlayerAvatar, StandingsTable, formatDate, formatDay, splitDuration } from "@/components/match/bits";
import { useMatchStatsData, type PlayerStats, type Stats } from "@/components/match/MatchStats";
import { SafetyMenu } from "@/components/safety/SafetyMenu";
import { StatsBetaNote } from "@/components/match/StatsBeta";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useToast } from "@/hooks/use-toast";
import type { MatchStrings } from "@/i18n/match-strings";
import { useReportCopy, type ReportStrings } from "@/i18n/report-strings";
import { useAuth } from "@/lib/auth";
import { friendStatusFor, useFriends } from "@/lib/friends-api";
import {
  useMakeCaptain,
  useMatchClips,
  useSetScore,
  useVote,
  whatsappLink,
  type MatchReplay,
  type MatchRoom,
  type TeamSide,
} from "@/lib/match-api";
import { cameraGaps, clock, minuteMark, metricValue, formatMetric, standings, rankedCount, levelWith, isPersonalBest } from "@/lib/match-report";
import { cn } from "@/lib/utils";
import { findPath } from "@/lib/find-nav";
import { GameBar, Num, Section, visibleColour } from "./ReportParts";
import {
  Disclosure,
  EveryoneSection,
  MomentsSection,
  NightSection,
  RivalSection,
  StoodOutSection,
  TwoSidesSection,
  YouSection,
  watchHref,
} from "./StatsReport";

type R = ReportStrings & { locale: "en" | "ar" };
type Copy = MatchStrings & { locale: "en" | "ar" };

export type MatchReportSlots = {
  /** "I played in this match", for someone who opened the link after the game */
  rsvp: ReactNode;
  /** a player booking's payment state */
  booking: ReactNode;
  /** the paywalled stats panel, shown in place of the numbers while they are locked */
  lockedStats: ReactNode;
  /** team switches, the pitch board and auto-teams */
  teams: ReactNode;
  /** adding someone who played */
  invite: ReactNode;
  /** score and games editor, phase previews: captain and owner only */
  captainTools: ReactNode;
};

/**
 * After the whistle, the match is one scroll: what happened, then you, then
 * everyone, then the people. No tabs, no podium. Every comparison respects the
 * measuring margin (see lib/match-report.ts).
 */
export function MatchReport({ room, copy, now, colors, names, replay, onShare, slots }: {
  room: MatchRoom;
  copy: Copy;
  now: number;
  colors: Record<TeamSide, string>;
  names: Record<TeamSide, string>;
  replay: MatchReplay | undefined;
  onShare: () => void;
  slots: MatchReportSlots;
}) {
  const r = useReportCopy();
  const { user } = useAuth();
  const [methods, setMethods] = useState(false);
  const durationSeconds = Math.max(60, (room.endMs - room.startMs) / 1000);
  // Team numbers are open to anyone who can see the match; the server decides whose player rows come back.
  const statsOn = room.stats.enabled && room.stats.unlocked;
  const statsQuery = useMatchStatsData(room, user?.id ?? null, null, statsOn);
  const stats = statsQuery.data ?? null;
  const players = stats?.players ?? null;
  const meId = stats?.competition?.viewerPlayerId ?? room.me?.id ?? null;
  const me: PlayerStats | null = players?.find((player) => player.playerId === meId && player.claimed) ?? null;
  const findRecordingId = replay?.recordings[0] ?? stats?.recordings[0] ?? null;
  const claimedIds = new Set((players ?? []).filter((player) => player.claimed).map((player) => player.playerId));
  // Anyone can find themselves; a claim also puts them in the squad.
  const canFind = Boolean(findRecordingId) && !me && !(room.me && claimedIds.has(room.me.id));
  return (
    <div className="mx-auto flex w-full max-w-xl flex-col px-4 pb-16" data-testid="match-report">
      <ReportHeader copy={copy} r={r} onShare={onShare} />
      <TitleBlock room={room} copy={copy} r={r} now={now} colors={colors} names={names} replay={replay} meId={meId} me={me} players={players ?? []} stats={stats} durationSeconds={durationSeconds} onShare={onShare} findRecordingId={findRecordingId} canFind={canFind} />
      <TimelineBlock room={room} r={r} colors={colors} replay={replay} me={me} meId={meId} durationSeconds={durationSeconds} />
      <GoalList room={room} r={r} colors={colors} replay={replay} meId={meId} names={names} />
      <FlaggedMoments room={room} copy={copy} r={r} />

      {slots.booking && <div className="pt-4">{slots.booking}</div>}
      {slots.rsvp && <div className="pt-4">{slots.rsvp}</div>}

      {room.stats.enabled && (
        room.stats.unlocked ? (
          statsOn ? (
            statsQuery.isError && !stats ? (
              <Section>
                <p className="text-sm text-muted-text">{r.statsError}</p>
                <button type="button" onClick={() => void statsQuery.refetch()} className="inline-flex min-h-11 items-center gap-2 self-start rounded-full border border-line px-4 text-xs font-semibold">
                  <RefreshCw className="h-3.5 w-3.5" />{r.retry}
                </button>
              </Section>
            ) : !stats ? (
              <Section><p className="flex items-center gap-2 text-sm text-muted-text"><Loader2 className="h-4 w-4 animate-spin" />{r.statsLoading}</p></Section>
            ) : !stats.available ? (
              <Section><p className="text-sm text-muted-text">{r.statsUnavailable}</p></Section>
            ) : (
              <>
                <StatsBetaNote className="pt-5" />
                {me && <YouSection me={me} players={players ?? []} stats={stats} room={room} r={r} durationSeconds={durationSeconds} replay={replay} teamNames={names} />}
                {players && <EveryoneSection players={players} meId={me ? meId : null} r={r} />}
                {me && <NightSection me={me} r={r} durationSeconds={durationSeconds} room={room} />}
                {me && <MomentsSection me={me} room={room} r={r} />}
                {players && <RivalSection players={players} meId={me ? meId : null} room={room} r={r} />}
                {players && <StoodOutSection players={players} meId={me ? meId : null} room={room} r={r} />}
                <TwoSidesSection room={room} r={r} copy={copy} whole={stats.team} players={players} />
              </>
            )
          ) : null
        ) : (
          <Section eyebrow={r.numbersComplete} icon={<Sparkles className="h-4 w-4" />} iconTone="lime">{slots.lockedStats}</Section>
        )
      )}

      <ClipsBlock room={room} r={r} />
      <VoteBlock room={room} copy={copy} r={r} now={now} meId={room.me?.id ?? null} />
      <SquadBlock room={room} copy={copy} r={r} colors={colors} claimedIds={players ? claimedIds : null} findRecordingId={findRecordingId} />

      <div className="flex flex-col">
        {slots.teams && <Disclosure title={r.teamsAndSwitches} icon={<Users />} tone="turf" testId="report-teams">{slots.teams}</Disclosure>}
        {slots.invite && <Disclosure title={r.inviteSomeone} icon={<UserPlus />} tone="turf" testId="report-invite">{slots.invite}</Disclosure>}
        {slots.captainTools && <Disclosure title={r.captainTools} icon={<Shield />} tone="lime" testId="report-captain-tools">{slots.captainTools}</Disclosure>}
      </div>

      <footer className="flex flex-col gap-2 pt-6">
        <p className="text-[11px] leading-5 text-muted-text">{r.precision}</p>
        <button type="button" onClick={() => setMethods(true)} className="flex min-h-11 items-center gap-2 self-start text-xs font-semibold text-turf"><span className="flex h-8 w-8 items-center justify-center rounded-lg bg-turf/15"><Clock3 className="h-4 w-4" /></span>{r.howWeMeasure}</button>
      </footer>
      <MethodsSheet open={methods} onClose={() => setMethods(false)} r={r} />
    </div>
  );
}

/* ------------------------------------------------------------------ header */

function ReportHeader({ copy, r, onShare }: { copy: Copy; r: R; onShare: () => void }) {
  const [, setLocation] = useLocation();
  return (
    <div className="flex items-center justify-between gap-2 pt-3">
      <button
        type="button"
        onClick={() => (window.history.length > 1 ? window.history.back() : setLocation("/home"))}
        aria-label={copy.back}
        className="flex h-11 w-11 items-center justify-center rounded-full border border-line"
      >
        <ArrowLeft className="h-4 w-4 rtl:rotate-180" />
      </button>
      <span className="font-display text-[11px] font-bold uppercase tracking-[0.3em] text-turf rtl:tracking-normal rtl:text-xs">{r.eyebrow}</span>
      <button type="button" onClick={onShare} aria-label={copy.share} className="flex h-11 w-11 items-center justify-center rounded-full border border-line">
        <Share2 className="h-4 w-4" />
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ title */

function TitleBlock({ room, copy, r, now, colors, names, replay, meId, me, players, stats, durationSeconds, onShare, findRecordingId, canFind }: {
  room: MatchRoom; copy: Copy; r: R; now: number; colors: Record<TeamSide, string>; names: Record<TeamSide, string>;
  replay: MatchReplay | undefined; meId: number | null; me: PlayerStats | null; players: PlayerStats[];
  stats: Stats | null; durationSeconds: number; onShare: () => void;
  findRecordingId: number | null; canFind: boolean;
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
    <section data-testid="report-top-card" className="relative mt-4 overflow-hidden rounded-3xl border border-line bg-gradient-to-br from-[#1D3B2E] via-[#13283A] to-[#1B1F3D] p-4">
      <p className="text-[13px] text-muted-text">
        {formatDay(room.startMs, copy.locale, now, copy)} · {room.title ? `${room.title} · ` : ""}{room.field.name} · {r.minutesLong(Math.round(durationSeconds / 60))}
        <bdi className="ms-2 font-mono text-[11px] tracking-[0.2em] text-muted-text/70">#{room.code}</bdi>
      </p>
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
      ) : (
        three && room.standings
          ? <div className="mt-3"><StandingsTable rows={room.standings} colors={colors} names={names} leader={room.leader} labels={copy} compact /></div>
          : <div className="mt-3 grid grid-cols-[1fr_auto_1fr] items-center gap-2" dir="ltr">
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
            <button
              type="button"
              disabled={setScore.isPending}
              onClick={() => void setScore.mutateAsync({ scoreA: suggested.a, scoreB: suggested.b })}
              className="min-h-11 rounded-full border border-turf/60 px-3 text-xs font-semibold text-turf disabled:opacity-60"
            >
              {r.useReplayScore}
            </button>
          )}
          {!suggested && room.canManage && <span className="text-turf">{r.enterScore}</span>}
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
      {room.phase === "expired" || !room.footage.ready || (!me && canFind) ? <div className="mt-4 rounded-2xl bg-void/45 p-3.5">
        {room.phase === "expired" ? <p className="text-sm text-muted-text">{r.expired}</p>
          : !room.footage.ready ? <>
            <p className="flex items-center gap-2 text-sm font-semibold"><Loader2 className="h-4 w-4 animate-spin text-turf" />{r.processing}</p>
            <p className="mt-1 text-xs text-muted-text">{r.processingDesc}</p>
            {room.progress > 0 && room.progress < 100 && <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[#1B2338]"><span className="block h-full bg-turf" style={{ width: `${room.progress}%` }} /></div>}
          </>
          : canFind && findRecordingId !== null ? <>
            <p className="font-display text-lg font-bold">{r.findTitle}</p>
            <p className="mt-1 text-sm leading-5 text-muted-text">{r.findDesc}</p>
            <Link href={findPath(findRecordingId, room.code)} className="mt-3 flex min-h-12 items-center justify-center rounded-full bg-floodlight text-base font-bold text-void" data-testid="link-find-yourself">{r.findCta}</Link>
            {room.footage.shareToken && <Link href={`/w/${room.footage.shareToken}?m=${room.code}`} className="mt-2 flex min-h-11 items-center justify-center gap-2 rounded-full border border-turf/60 text-sm font-bold text-turf" data-testid="link-watch-full-match"><Play className="h-4 w-4 fill-current" />{r.watchMatch}</Link>}
          </> : null}
      </div> : null}
      {me && room.footage.ready && <div className="mt-3 grid grid-cols-2 gap-2">
        {room.footage.shareToken && <Link href={`/w/${room.footage.shareToken}?m=${room.code}`} className="flex min-h-12 items-center justify-center gap-2 rounded-full bg-floodlight text-sm font-extrabold text-void" data-testid="link-watch-full-match"><Play className="h-4 w-4 fill-current" />{r.watchMatch}</Link>}
        <button type="button" onClick={onShare} className="flex min-h-12 items-center justify-center gap-2 rounded-full border border-turf/60 text-sm font-bold text-turf"><Share2 className="h-4 w-4" />{r.shareMatch}</button>
      </div>}
      {!me && !canFind && room.phase !== "expired" && room.footage.ready && room.footage.shareToken && <Link href={`/w/${room.footage.shareToken}?m=${room.code}`} className="mt-3 flex min-h-12 items-center justify-center gap-2 rounded-full bg-floodlight text-sm font-extrabold text-void" data-testid="link-watch-full-match"><Play className="h-4 w-4 fill-current" />{r.watchMatch}</Link>}
      {room.footage.expiresAt && room.phase !== "expired" && <p className="mt-2 text-xs text-muted-text">{r.keptUntil(formatDate(Date.parse(room.footage.expiresAt), copy.locale))}</p>}
    </section>
  );
}

function GoalList({ room, r, colors, replay, meId, names }: { room: MatchRoom; r: R; colors: Record<TeamSide, string>; replay: MatchReplay | undefined; meId: number | null; names: Record<TeamSide, string> }) {
  const goals = [...(replay?.goals ?? [])].sort((a, b) => a.atSeconds - b.atSeconds);
  if (!goals.length) return null;
  return <Section eyebrow={r.goalsHeading} icon={<Trophy className="h-4 w-4" />} className="gap-2 py-3">
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-text">
      {goals.map((goal, index) => {
        const mine = meId !== null && goal.scorer?.playerId === meId;
        const label = <><i className="me-1 inline-block h-2 w-2 rounded-full align-middle" style={{ background: goal.side ? visibleColour(colors[goal.side]) : "#8A93A6" }} /><Num>{minuteMark(goal.atSeconds)}′</Num> {mine ? r.you : goal.scorer?.name ?? (goal.side ? names[goal.side] : r.unknownScorer)}</>;
        const href = watchHref(room, goal.atSeconds);
        return <span key={`${goal.atSeconds}-${index}`} className={cn(mine && "font-bold text-floodlight")}>{href ? <Link href={href} className="inline-flex min-h-11 items-center">{label}</Link> : label}</span>;
      })}
      {goals.length > 0 && !room.score && <span className="basis-full text-[11px]">{r.captainCounts}</span>}
    </div>
  </Section>;
}

function FlaggedMoments({ room, copy, r }: { room: MatchRoom; copy: Copy; r: R }) {
  if (!room.footage.shareToken || !room.marks.length) return null;
  return <Section eyebrow={r.flags} icon={<Flag className="h-4 w-4" />} className="gap-2 py-3">
    <div className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4">
      {room.marks.map((mark) => <Link key={mark.id} href={`/w/${room.footage.shareToken}?m=${room.code}&t=${Math.max(0, Math.round((mark.offsetSeconds ?? 0) - 8))}`} className="flex min-h-11 shrink-0 items-center gap-2 rounded-xl border border-line bg-surface px-3 py-2 text-start">
        <Flag className="h-4 w-4 shrink-0 text-turf" />
        <span><span className="block text-xs font-semibold text-turf">{copy.flagKinds[mark.kind] ?? mark.kind}</span><span className="text-[11px] text-muted-text"><Num>{clock(mark.offsetSeconds ?? 0)}</Num>{mark.byName ? ` · ${mark.byName}` : ""}</span></span>
      </Link>)}
    </div>
  </Section>;
}

/* ------------------------------------------------------------------ timeline */

function TimelineBlock({ room, r, colors, replay, me, meId, durationSeconds }: {
  room: MatchRoom; r: R; colors: Record<TeamSide, string>; replay: MatchReplay | undefined;
  me: PlayerStats | null; meId: number | null; durationSeconds: number;
}) {
  const spans = me?.report?.spans ?? null;
  const myGoalTimes = me?.report?.goalTimes ?? [];
  const goals = (replay?.goals ?? []).map((goal) => {
    const mine = (meId !== null && goal.scorer?.playerId === meId) || myGoalTimes.some((at) => Math.abs(at - goal.atSeconds) < 20);
    return {
      at: goal.atSeconds,
      colour: goal.side ? colors[goal.side] : "#8A93A6",
      mine,
      href: watchHref(room, goal.atSeconds),
      label: `${minuteMark(goal.atSeconds)}′ ${goal.scorer?.name ?? ""}`.trim(),
    };
  });
  if (!goals.length && !spans?.length) return null;
  const totalMin = Math.round(durationSeconds / 60);
  const gap = spans?.length ? cameraGaps(spans, durationSeconds)[0] ?? null : null;
  const caption = spans?.length
    ? [
      r.timelineCaption(Math.round((me?.minutes ?? 0)), totalMin),
      goals.some((goal) => goal.mine) ? r.timelineYourGoal : null,
      gap ? r.timelineGap(Math.floor(gap[0] / 60), Math.ceil(gap[1] / 60)) : null,
    ].filter(Boolean).join(" ")
    : r.timelineCaptionNoYou;
  return (
    <div className="flex flex-col gap-2 border-b border-[#1B2236] pb-6 pt-1">
      <GameBar
        durationSeconds={durationSeconds}
        spans={spans}
        goals={goals}
        startLabel="0′"
        midLabel={`${Math.round(totalMin / 2)}′`}
        endLabel={`${totalMin}′`}
      />
      <p className="text-xs leading-5 text-muted-text">{caption}</p>
    </div>
  );
}

/* ------------------------------------------------------------------ footage */

function FootageBlock({ room, copy, r, primary }: { room: MatchRoom; copy: Copy; r: R; primary: boolean }) {
  if (room.phase === "expired") {
    return <Section><p className="text-sm text-muted-text">{r.expired}</p></Section>;
  }
  if (!room.footage.ready) {
    return (
      <Section>
        <p className="flex items-center gap-2 text-sm font-semibold"><Loader2 className="h-4 w-4 animate-spin text-turf" />{r.processing}</p>
        <p className="text-xs text-muted-text">{r.processingDesc}</p>
        {room.progress > 0 && room.progress < 100 && (
          <div className="h-1 overflow-hidden rounded-full bg-[#1B2236]"><span className="block h-full bg-turf" style={{ width: `${room.progress}%` }} /></div>
        )}
      </Section>
    );
  }
  if (!room.footage.shareToken) return null;
  const href = `/w/${room.footage.shareToken}?m=${room.code}`;
  return (
    <Section>
      <Link
        href={href}
        className={cn(
          "flex min-h-12 items-center justify-center gap-2 rounded-full text-base font-bold",
          primary ? "bg-floodlight text-void" : "border border-turf/60 text-turf",
        )}
        data-testid="link-watch-full-match"
      >
        <Play className="h-4 w-4 fill-current" />{r.watchFull}
      </Link>
      {room.footage.expiresAt && <p className="text-xs text-muted-text">{r.keptUntil(formatDate(Date.parse(room.footage.expiresAt), copy.locale))}</p>}
      {room.marks.length > 0 && (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-muted-text">{r.flags}</p>
          <div className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4">
            {room.marks.map((mark) => (
              <Link
                key={mark.id}
                href={`/w/${room.footage.shareToken}?m=${room.code}&t=${Math.max(0, Math.round((mark.offsetSeconds ?? 0) - 8))}`}
                className="shrink-0 rounded-lg border border-line px-3 py-2 text-start"
              >
                <span className="block text-xs font-semibold text-turf">{copy.flagKinds[mark.kind] ?? mark.kind}</span>
                <span className="text-[11px] text-muted-text"><Num>{clock(mark.offsetSeconds ?? 0)}</Num>{mark.byName ? ` · ${mark.byName}` : ""}</span>
              </Link>
            ))}
          </div>
        </div>
      )}
    </Section>
  );
}

function FindBlock({ recordingId, matchCode, r }: { recordingId: number; matchCode: string; r: R }) {
  return (
    <Section eyebrow={r.you}>
      <p className="font-display text-xl font-bold leading-tight">{r.findTitle}</p>
      <p className="text-sm leading-6 text-muted-text">{r.findDesc}</p>
      <Link href={findPath(recordingId, matchCode)} className="flex min-h-12 items-center justify-center rounded-full bg-floodlight text-base font-bold text-void" data-testid="link-find-yourself">
        {r.findCta}
      </Link>
    </Section>
  );
}

/* ------------------------------------------------------------------ clips */

function ClipsBlock({ room, r }: { room: MatchRoom; r: R }) {
  const clips = useMatchClips(room.code);
  const make = room.footage.shareToken ? `/w/${room.footage.shareToken}?m=${room.code}` : null;
  const list = clips.data ?? [];
  return (
    <Section eyebrow={r.clips} icon={<Video className="h-4 w-4" />} iconTone="violet" aside={make ? <Link href={make} className="flex min-h-11 items-center gap-1 font-semibold text-turf"><Scissors className="h-4 w-4" />{r.cutClip}</Link> : undefined}>
      {clips.isLoading ? <Loader2 className="h-5 w-5 animate-spin text-muted-text" /> : list.length === 0 ? (
        <p className="text-sm text-muted-text">{r.noClips}</p>
      ) : (
        <div className="no-scrollbar -mx-4 flex gap-2.5 overflow-x-auto px-4 pb-1">
          {list.map((clip) => (
            <Link key={clip.id} href={clip.mine ? "/my-clips" : `/players/${clip.by.userId}`} className="relative flex w-40 shrink-0 flex-col gap-1.5">
              <div className="relative flex aspect-video items-center justify-center rounded-lg border border-line bg-surface">
                <Play className="h-5 w-5 text-muted-text" />
                <Num className="absolute bottom-1.5 end-1.5 rounded bg-void/80 px-1.5 text-[11px]">{Math.round(clip.duration)}s</Num>
                {clip.mine && <span className="absolute start-1.5 top-1.5 rounded-full bg-violet px-2 py-0.5 text-[10px] font-bold">{r.yourClip}</span>}
                {!clip.mine && (
                  <div className="absolute end-1 top-1 z-10 rounded-full bg-black/45" onClick={(event) => event.preventDefault()}>
                    <SafetyMenu target={{ type: "user_clip", id: clip.id, ownerId: clip.by.userId, ownerName: clip.by.name }} />
                  </div>
                )}
              </div>
              <span className="flex items-center gap-1.5">
                <PlayerAvatar name={clip.by.name} avatarUrl={clip.by.avatarUrl} size={18} />
                <span className="truncate text-xs text-text">{clip.title || clip.by.name}</span>
              </span>
            </Link>
          ))}
        </div>
      )}
    </Section>
  );
}

/* ------------------------------------------------------------------ vote */

function VoteBlock({ room, copy, r, now, meId }: { room: MatchRoom; copy: Copy; r: R; now: number; meId: number | null }) {
  const vote = useVote(room.code);
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const candidates = room.players.filter((player) => player.rsvp === "in");
  const tally = new Map(room.vote.tallies.map((entry) => [entry.playerId, entry.count]));
  const winners = room.players.filter((player) => room.vote.winners.includes(player.id));
  const mine = room.players.find((player) => player.id === room.vote.myVote) ?? null;
  const left = room.vote.closesAt ? splitDuration(Date.parse(room.vote.closesAt) - now) : null;
  const leftLabel = left ? `${left.days ? `${left.days}${copy.days} ` : ""}${left.hours}${copy.hours} ${left.minutes}${copy.minutes}` : "";
  const canVote = room.vote.open && room.isMember;
  const status = room.vote.closed ? r.voteClosed : room.vote.open ? r.voteCloses(leftLabel) : r.voteNotOpen;
  return (
    <Section eyebrow={r.motm} icon={<Crown className="h-4 w-4" />} iconTone="lime" aside={<Num>{r.votesCast(room.vote.votesCast, room.vote.eligibleVoters)}</Num>}>
      {winners.length > 0 && (
        <div className="flex flex-wrap gap-4">
          {winners.map((winner) => (
            <span key={winner.id} className="flex items-center gap-2.5">
              <span className="relative">
                <PlayerAvatar name={winner.name} initials={winner.initials} avatarUrl={winner.avatarUrl} size={44} ring="#D4FF4F" />
                <Crown className="absolute -top-2.5 start-1/2 h-4 w-4 -translate-x-1/2 text-floodlight rtl:translate-x-1/2" />
              </span>
              <span className="font-display text-lg font-bold">{winner.id === meId ? r.you : winner.name}</span>
            </span>
          ))}
        </div>
      )}
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm text-text">{mine ? r.youVoted(mine.name) : status}</p>
          {mine && <p className="text-xs text-muted-text">{status}</p>}
          {!room.isMember && room.vote.open && <p className="text-xs text-muted-text">{r.onlyPlayers}</p>}
        </div>
        {canVote && (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="min-h-11 shrink-0 rounded-full border border-line px-5 text-sm font-bold text-text"
            data-testid="button-open-vote"
          >
            {r.voteNow}
          </button>
        )}
      </div>
      {room.vote.closed && room.vote.tallies.length > 0 && (
        <ul className="flex flex-col divide-y divide-[#1B2236]">
          {[...candidates].filter((player) => tally.has(player.id)).sort((a, b) => (tally.get(b.id) ?? 0) - (tally.get(a.id) ?? 0)).map((player) => (
            <li key={player.id} className="flex items-center gap-2.5 py-2">
              <PlayerAvatar name={player.name} initials={player.initials} avatarUrl={player.avatarUrl} size={26} />
              <span className="min-w-0 flex-1 truncate text-sm">{player.id === meId ? r.you : player.name}</span>
              <Num className="text-xs text-muted-text">{r.votes(tally.get(player.id) ?? 0)}</Num>
            </li>
          ))}
        </ul>
      )}
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="bottom" dir={r.locale === "ar" ? "rtl" : "ltr"} closeLabel={r.close} className="flex max-h-[88dvh] flex-col overflow-y-auto rounded-t-3xl border-line bg-void px-5 pb-8 pt-5 text-text">
          <SheetHeader className="pe-8 text-start">
            <SheetTitle className="font-display text-2xl font-bold">{r.motm}</SheetTitle>
            <SheetDescription className="text-xs text-muted-text">{r.pickOne}</SheetDescription>
          </SheetHeader>
          <div className="mt-4 grid grid-cols-3 gap-3">
            {candidates.map((player) => {
              const chosen = room.vote.myVote === player.id;
              const count = tally.get(player.id);
              return (
                <button
                  key={player.id}
                  type="button"
                  disabled={!canVote || player.isMe || vote.isPending}
                  onClick={() => void vote.mutateAsync(player.id)
                    .then(() => setOpen(false))
                    .catch((error) => toast({ title: error instanceof Error ? error.message : copy.error, variant: "destructive" }))}
                  className={cn(
                    "flex flex-col items-center gap-2 rounded-xl border p-3 disabled:cursor-default",
                    chosen ? "border-floodlight bg-floodlight/10" : "border-line",
                    player.isMe && "opacity-40",
                  )}
                  data-testid={`button-vote-${player.id}`}
                >
                  <PlayerAvatar name={player.name} initials={player.initials} avatarUrl={player.avatarUrl} size={52} ring={chosen ? "#D4FF4F" : undefined} />
                  <span className="w-full truncate text-center text-xs font-semibold">{player.name}</span>
                  {count != null && <Num className="text-[11px] text-muted-text">{r.votes(count)}</Num>}
                </button>
              );
            })}
          </div>
        </SheetContent>
      </Sheet>
    </Section>
  );
}

/* ------------------------------------------------------------------ squad */

function SquadBlock({ room, copy, r, colors, claimedIds, findRecordingId }: {
  room: MatchRoom; copy: Copy; r: R; colors: Record<TeamSide, string>;
  claimedIds: Set<number> | null; findRecordingId: number | null;
}) {
  const makeCaptain = useMakeCaptain(room.code);
  const friends = useFriends(room.signedIn);
  const { toast } = useToast();
  const [confirm, setConfirm] = useState<number | null>(null);
  const order: Record<string, number> = { in: 0, maybe: 1, invited: 2, out: 3 };
  const visible = [...room.players].filter((player) => player.rsvp !== "out").sort((a, b) => order[a.rsvp] - order[b.rsvp]);
  const captainId = room.captain?.userId ?? null;
  const unclaimed = claimedIds ? visible.filter((player) => player.rsvp === "in" && !claimedIds.has(player.id)).length : 0;
  const findUrl = findRecordingId !== null ? `${window.location.origin}${findPath(findRecordingId, room.code)}` : null;
  return (
    <Section eyebrow={r.squad} icon={<Users className="h-4 w-4" />} aside={<Num>{copy.countIn(room.counts.in, room.counts.needed)}</Num>}>
      <ul className="flex flex-col divide-y divide-[#1B2236]">
        {visible.map((player) => (
          <li key={player.id} className="flex min-h-12 items-center gap-3 py-2">
            <PlayerAvatar name={player.name} initials={player.initials} avatarUrl={player.avatarUrl} size={34} dashed={!player.signedUp} ring={player.team ? visibleColour(colors[player.team]) : undefined} />
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-1.5 truncate text-sm font-semibold">
                {player.name}
                {player.userId != null && player.userId === captainId && <span className="rounded bg-floodlight px-1 text-[10px] font-black text-void">{copy.captainBadge}</span>}
                {player.shirtNumber != null && <Num className="text-xs text-muted-text">#{player.shirtNumber}</Num>}
              </p>
              <p className="truncate text-[11px] text-muted-text">
                {!player.signedUp ? copy.notSignedUp : claimedIds && player.rsvp === "in" ? (claimedIds.has(player.id) ? r.found : r.notFound) : player.rsvp === "maybe" ? copy.maybe : ""}
              </p>
            </div>
            {room.signedIn && !friends.isLoading && player.signedUp && !player.isMe && player.userId != null
              && friendStatusFor(player.userId, friends.data).status !== "friends"
              && (
                // One lime button per screen: here the friend action is an outline.
                <span className="[&_button]:h-11 [&_button]:w-11 [&_button]:min-w-11 [&_button.bg-floodlight]:border [&_button.bg-floodlight]:border-turf/50 [&_button.bg-floodlight]:bg-transparent [&_button.bg-floodlight]:text-turf">
                  <FriendButton userId={player.userId} name={player.name} compact />
                </span>
              )}
            {room.canManage && player.signedUp && player.userId !== captainId && (
              confirm === player.id ? (
                <button
                  type="button"
                  disabled={makeCaptain.isPending}
                  onClick={() => void makeCaptain.mutateAsync(player.id)
                    .then(() => { setConfirm(null); toast({ title: copy.captainNow(player.name) }); })
                    .catch((error) => toast({ title: error instanceof Error ? error.message : copy.error, variant: "destructive" }))}
                  className="flex min-h-11 items-center gap-1 rounded-full bg-floodlight px-2.5 text-[11px] font-bold text-void"
                  data-testid={`button-confirm-captain-${player.id}`}
                >
                  <Crown className="h-3 w-3" />{copy.makeCaptain}
                </button>
              ) : (
                <button
                  type="button"
                  aria-label={copy.makeCaptain}
                  title={copy.makeCaptain}
                  onClick={() => setConfirm(player.id)}
                  className="flex h-11 w-11 items-center justify-center rounded-full text-muted-text hover:text-floodlight"
                  data-testid={`button-make-captain-${player.id}`}
                >
                  <Crown className="h-3.5 w-3.5" />
                </button>
              )
            )}
          </li>
        ))}
      </ul>
      {unclaimed > 0 && findUrl && (
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs leading-5 text-muted-text">{r.notFoundNudge(unclaimed)}</p>
          <a href={whatsappLink(r.findLinkText(findUrl))} target="_blank" rel="noopener noreferrer" className="flex min-h-11 shrink-0 items-center text-xs font-semibold text-turf">{r.sendLink} ›</a>
        </div>
      )}
    </Section>
  );
}

/* ------------------------------------------------------------------ methods */

function MethodsSheet({ open, onClose, r }: { open: boolean; onClose: () => void; r: R }) {
  return (
    <Sheet open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <SheetContent side="bottom" dir={r.locale === "ar" ? "rtl" : "ltr"} closeLabel={r.close} className="flex max-h-[90dvh] flex-col overflow-y-auto rounded-t-3xl border-line bg-void px-5 pb-8 pt-5 text-text">
        <SheetHeader className="pe-8 text-start">
          <SheetTitle className="font-display text-2xl font-bold">{r.methodsTitle}</SheetTitle>
          <SheetDescription className="text-sm leading-6 text-muted-text">{r.methodsIntro}</SheetDescription>
        </SheetHeader>
        <dl className="mt-4 flex flex-col divide-y divide-[#1B2236]">
          {r.methods.map(([name, how, error]) => (
            <div key={name} className="grid grid-cols-[6.5rem_1fr] gap-3 py-3">
              <dt className="text-sm font-semibold">{name}{error && <span className="mt-0.5 block text-[11px] font-normal text-turf">{error}</span>}</dt>
              <dd className="text-xs leading-5 text-muted-text">{how}</dd>
            </div>
          ))}
        </dl>
        <ul className="mt-3 flex flex-col gap-2 text-xs leading-5 text-muted-text">
          <li>{r.methodsLevel}</li>
          <li>{r.methodsMinimum}</li>
          <li>{r.methodsPb}</li>
          <li>{r.methodsCaptain}</li>
        </ul>
      </SheetContent>
    </Sheet>
  );
}
