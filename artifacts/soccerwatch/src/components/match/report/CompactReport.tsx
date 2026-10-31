import { useState, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { usePageBack } from "@/lib/use-page-back";
import { ArrowLeft, BarChart3, ChevronRight, Film, Play, Scissors, Share2 } from "lucide-react";
import type { PlayerStats, Stats } from "@/components/match/MatchStats";
import { GoalReviewBox, goalStatusOf, reviewOf } from "@/components/match/GoalReview";
import { formatDay } from "@/components/match/bits";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import type { MatchStrings } from "@/i18n/match-strings";
import type { ReportStrings } from "@/i18n/report-strings";
import { useReportLayoutCopy, type LayoutStrings } from "@/i18n/report-layout-strings";
import type { MatchReplay, MatchRoom, TeamSide } from "@/lib/match-api";
import { clock, compareHalves, foldBlocks, formatMetric, isPersonalBest, metricValue, type Direction, type ReportMetric } from "@/lib/match-report";
import { matchReelPath, useMyMatchClipIds } from "@/lib/match-reel";
import { barShare, boardRows, formMarks, matchReelPicks, myStanding, pickHeadline, type Headline, type MyStanding } from "@/lib/report-layout";
import { REEL_MAX_CLIPS, REEL_MIN_CLIPS } from "@/lib/end-screen";
import { getListUserClipsQueryKey, useListUserClips } from "@workspace/api-client-react";
import { cn } from "@/lib/utils";
import { Num, visibleColour } from "./ReportParts";
import { Disclosure, EveryoneSection, NightSection, RivalSection, TwoSidesSection, watchHref } from "./StatsReport";

type R = ReportStrings & { locale: "en" | "ar" };
type Copy = MatchStrings & { locale: "en" | "ar" };
type L = LayoutStrings & { locale: "en" | "ar" };

export type LayoutProps = {
  room: MatchRoom;
  copy: Copy;
  r: R;
  now: number;
  colors: Record<TeamSide, string>;
  names: Record<TeamSide, string>;
  replay: MatchReplay | undefined;
  stats: Stats;
  me: PlayerStats;
  players: PlayerStats[];
  durationSeconds: number;
  onShare: () => void;
};

/* ------------------------------------------------------------------ shared bits */

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}

function kickOff(ms: number): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Amman", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(ms));
}

/** First place is only claimed against at least one other ranked player, on something he actually did. */
function isFirst(standing: MyStanding | null): boolean {
  return Boolean(standing && standing.ranked && standing.rank === 1 && standing.of >= 2 && standing.value > 0);
}

function rankText(L: L, standing: MyStanding | null): string | null {
  if (!standing) return null;
  if (!standing.ranked) return L.notRanked;
  if (standing.of < 2) return null;
  if (standing.rank === 1 && !isFirst(standing)) return null;
  return L.rank(standing.rank, standing.shared, standing.of);
}

function LayoutHeader({ room, copy, L, now, onShare, title }: { room: MatchRoom; copy: Copy; L: L; now: number; onShare: () => void; title?: string }) {
  const [, setLocation] = useLocation();
  const pageBack = usePageBack();
  const played = room.players.filter((player) => player.rsvp === "in").length;
  const score = room.score ? `${room.score.a}–${room.score.b}` : null;
  return (
    <div className="flex items-center gap-2 pt-3">
      <button
        type="button"
        onClick={pageBack}
        aria-label={copy.back}
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-line"
      >
        <ArrowLeft className="h-4 w-4 rtl:rotate-180" />
      </button>
      <div className="min-w-0 flex-1">
        <h1 className="truncate font-display text-lg font-bold leading-tight">
          {title ?? <>{room.title || room.field.name} · <Num>{kickOff(room.startMs)}</Num></>}
        </h1>
        <p className="truncate text-xs text-muted-text">
          {formatDay(room.startMs, copy.locale, now, copy)}
          {title ? <> · {room.field.name}</> : null}
          {" · "}{L.played(played)}
          {" · "}{score ? <Num className="font-bold text-text">{score}</Num> : L.scoreNotIn}
        </p>
      </div>
      <button type="button" onClick={onShare} aria-label={copy.share} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-floodlight text-void">
        <Share2 className="h-4 w-4" />
      </button>
    </div>
  );
}

type Moment = { at: number; kind: "goal" | "sprint" | "dribble"; label: string };

function myMoments(me: PlayerStats, L: L): Moment[] {
  const report = me.report;
  if (!report) return [];
  return [
    ...report.goalTimes.map((at) => ({ at, kind: "goal" as const, label: L.goal })),
    ...(report.topSpeedAt !== null && me.topSpeedKmh !== null ? [{ at: report.topSpeedAt, kind: "sprint" as const, label: `${Math.round(me.topSpeedKmh)} ${L.kmh}` }] : []),
    ...report.dribbleWonTimes.map((at) => ({ at, kind: "dribble" as const, label: L.dribble })),
  ].sort((a, b) => a.at - b.at);
}

function openChances(replay: MatchReplay | undefined) {
  return reviewOf(replay).filter((goal) => goalStatusOf(goal) === "open");
}

/** The goal review, folded into one row that opens it in a sheet. */
export function GoalsToCheck({ room, copy, r, colors, names, replay, L }: { room: MatchRoom; copy: Copy; r: R; colors: Record<TeamSide, string>; names: Record<TeamSide, string>; replay: MatchReplay | undefined; L: L }) {
  const [open, setOpen] = useState(false);
  const chances = openChances(replay);
  const likely = chances.filter((goal) => goal.source === "goal").length;
  if (!replay?.canVoteGoals || !chances.length) return null;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex min-h-12 w-full items-center gap-3 rounded-2xl border border-live/40 bg-live/10 px-3.5 text-start"
        data-testid="button-goals-to-check"
      >
        <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-live" aria-hidden="true" />
        <span className="flex-1 text-sm font-semibold">{likely ? L.goalsToCheck(likely) : L.chancesToCheck(chances.length)}</span>
        <ChevronRight className="h-4 w-4 text-muted-text rtl:rotate-180" />
      </button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="bottom" dir={L.locale === "ar" ? "rtl" : "ltr"} closeLabel={r.close} className="flex max-h-[88dvh] flex-col overflow-y-auto rounded-t-3xl border-line bg-void px-5 pb-8 pt-5 text-text">
          <SheetHeader className="pe-8 text-start">
            <SheetTitle className="font-display text-2xl font-bold">{copy.gvAskTitle}</SheetTitle>
            <SheetDescription className="sr-only">{copy.gvAskNote}</SheetDescription>
          </SheetHeader>
          <GoalReviewBox room={room} copy={copy} colors={colors} names={names} replay={replay} className="pt-3" />
        </SheetContent>
      </Sheet>
    </>
  );
}

/** "A reel of this match": straight into the reel builder with his clips from the match picked. */
export function MatchReelRow({ room, L, r }: { room: MatchRoom; L: L; r: R }) {
  const { ids, loading } = useMyMatchClipIds(room.code, room.signedIn);
  const userClips = useListUserClips({ query: { enabled: room.signedIn, queryKey: getListUserClipsQueryKey() } });
  if (!room.signedIn || loading || userClips.isLoading) return null;
  // Count what the reel builder will actually start with: visible, one shape.
  const count = matchReelPicks(userClips.data ?? [], ids, REEL_MAX_CLIPS).length;
  const watch = room.footage.ready && room.footage.shareToken && room.phase !== "expired" ? `/w/${room.footage.shareToken}?m=${room.code}` : null;
  if (count >= REEL_MIN_CLIPS) {
    return (
      <Link href={matchReelPath(room.code)} className="flex min-h-14 items-center gap-3 rounded-2xl border border-turf/40 bg-turf/10 px-3.5" data-testid="link-match-reel">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-turf/20 text-turf"><Film className="h-4 w-4" /></span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-bold">{L.makeReel}</span>
          <span className="block truncate text-xs text-muted-text">{L.reelClips(count)}</span>
        </span>
        <ChevronRight className="h-4 w-4 text-turf rtl:rotate-180" />
      </Link>
    );
  }
  if (!watch) return null;
  return (
    <Link href={watch} className="flex min-h-12 items-center gap-3 rounded-2xl border border-dashed border-line px-3.5" data-testid="link-match-reel-cut">
      <Film className="h-4 w-4 shrink-0 text-muted-text" />
      <span className="min-w-0 flex-1 text-xs text-muted-text">{count > 0 ? `${L.reelClips(count)} · ` : ""}{L.reelNeedClips}</span>
      <span className="flex shrink-0 items-center gap-1 text-xs font-bold text-turf"><Scissors className="h-3.5 w-3.5" />{r.cutClip}</span>
    </Link>
  );
}

/** Everything that used to be its own section, folded behind one row. */
function MoreStats({ me, players, stats, room, r, copy, durationSeconds, L }: { me: PlayerStats; players: PlayerStats[]; stats: Stats; room: MatchRoom; r: R; copy: Copy; durationSeconds: number; L: L }) {
  return (
    <div className="pt-2">
      <Disclosure title={L.more} icon={<BarChart3 className="h-4 w-4" />} tone="turf" testId="report-more-stats">
        <div className="-mt-6 flex flex-col">
          <NightSection me={me} r={r} durationSeconds={durationSeconds} room={room} />
          <RivalSection players={players} meId={me.playerId} room={room} r={r} />
          <EveryoneSection players={players} meId={me.playerId} r={r} />
          <TwoSidesSection room={room} r={r} copy={copy} whole={stats.team} players={players} />
        </div>
      </Disclosure>
    </div>
  );
}

/* ------------------------------------------------------------------ headline */

type HeadlineView = { value: string; unit: string; lines: string[]; badge: string | null; at: number | null };

function headlineView(h: Headline, me: PlayerStats, L: L): HeadlineView {
  const sprintAt = me.report?.topSpeedAt ?? null;
  const valueOf = (metric: ReportMetric, value: number): { value: string; unit: string } => {
    switch (metric) {
      case "topSpeed": return { value: String(Math.round(value)), unit: L.kmh };
      case "distanceRate": return { value: formatMetric("distanceRate", value), unit: L.kmPer10 };
      case "distance": return { value: value.toFixed(1), unit: L.km };
      case "touchRate": return { value: String(Math.round(value)), unit: L.touchesPer10 };
      case "passes": return { value: String(Math.round(value)), unit: L.passes };
      case "dribblesWon": return { value: String(Math.round(value)), unit: L.dribbles };
      default: return { value: String(Math.round(value)), unit: "" };
    }
  };
  switch (h.kind) {
    case "twoBests":
      return { value: String(Math.round(h.topSpeedKmh)), unit: L.kmh, lines: [L.headlineTwoBests, ...(h.topOfPitch ? [L.headlineTopToo] : [])], badge: L.twoBests, at: sprintAt };
    case "best": {
      const v = h.metric === "topSpeed" ? { value: String(Math.round(h.value)), unit: L.kmh } : { value: h.value.toFixed(1), unit: L.km };
      return { ...v, lines: [L.headlineBest[h.metric], ...(h.topOfPitch ? [L.headlineOnPitch(h.metric, h.sharedTop)] : [])], badge: L.personalBest, at: h.metric === "topSpeed" ? sprintAt : null };
    }
    case "top":
      return { ...valueOf(h.metric, h.value), lines: [L.headlineTop(h.metric, h.shared)], badge: null, at: h.metric === "topSpeed" ? sprintAt : null };
    case "rank":
      return { ...valueOf(h.metric, h.value), lines: [L.headlineRank(h.metric, h.rank, h.shared)], badge: null, at: h.metric === "topSpeed" ? sprintAt : null };
    case "total":
      return { value: h.distanceKm.toFixed(1), unit: L.km, lines: [L.headlineTotal], badge: null, at: null };
  }
}

function HeadlineCard({ view, room, L }: { view: HeadlineView; room: MatchRoom; L: L }) {
  const href = view.at !== null ? watchHref(room, view.at) : null;
  return (
    <div className="flex items-center gap-3 rounded-2xl bg-floodlight px-3.5 py-3 text-void" data-testid="report-headline">
      <span className="flex shrink-0 items-baseline gap-1">
        <span dir="ltr" className="font-display text-[44px] font-bold leading-[0.9]">{view.value}</span>
        <span className="font-display text-base font-bold">{view.unit}</span>
      </span>
      <span className="min-w-0 flex-1 text-[13px] leading-snug">
        {view.badge && <span className="mb-0.5 block text-[11px] font-extrabold uppercase tracking-wide rtl:tracking-normal">{view.badge}</span>}
        <b className="font-bold">{view.lines[0]}</b>{view.lines[1] ? <> {view.lines[1]}</> : null}
      </span>
      {href && (
        <Link href={href} aria-label={L.watchIt} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-void text-floodlight">
          <Play className="h-4 w-4 fill-current" />
        </Link>
      )}
    </div>
  );
}

function FormLine({ me, stats, L }: { me: PlayerStats; stats: Stats; L: L }) {
  const marks = formMarks(me, stats.competition?.personalForm);
  if (!marks) return null;
  const up = (d: Direction | null, more: string, less: string, same: string) => (d === "more" ? { text: `▲ ${more}`, lime: true } : d === "less" ? { text: `▼ ${less}`, lime: false } : d === "level" ? { text: `= ${same}`, lime: false } : null);
  const parts = [
    up(marks.distance, L.further, L.less, L.sameGround),
    up(marks.speed, L.faster, L.slower, L.sameSpeed),
    up(marks.touches, L.moreTouches, L.fewerTouches, L.sameTouches),
  ].filter(Boolean) as Array<{ text: string; lime: boolean }>;
  if (!parts.length) return null;
  return (
    <p className="flex flex-wrap gap-x-2 text-xs text-muted-text">
      <span>{L.vsLast(marks.matches)}</span>
      {parts.map((part) => <span key={part.text} className={cn("font-bold", part.lime ? "text-floodlight" : "text-text")}>{part.text}</span>)}
    </p>
  );
}

/* ------------------------------------------------------------------ E1: compact */

function MatchStrip({ room, r, L, me, replay, durationSeconds }: { room: MatchRoom; r: R; L: L; me: PlayerStats; replay: MatchReplay | undefined; durationSeconds: number }) {
  const watch = room.footage.ready && room.footage.shareToken && room.phase !== "expired" ? `/w/${room.footage.shareToken}?m=${room.code}` : null;
  const totalMin = Math.round(durationSeconds / 60);
  const onMin = Math.round(me.minutes ?? 0);
  const pct = (seconds: number) => `${Math.min(98, Math.max(2, (seconds / Math.max(1, durationSeconds)) * 100))}%`;
  const moments = myMoments(me, L);
  const allChances = replay?.canVoteGoals ? openChances(replay) : [];
  const likelyCount = allChances.filter((goal) => goal.source === "goal").length;
  // Pins only for the likely goals; dozens of shot-chances would bury his moments.
  const chances = likelyCount ? allChances.filter((goal) => goal.source === "goal") : [];
  return (
    <div className="flex flex-col gap-1.5 pt-3">
      {watch ? (
        <Link href={watch} aria-label={L.watchMatch} className="relative flex h-[104px] items-center justify-center overflow-hidden rounded-2xl border border-line bg-[#16241E]" data-testid="link-watch-full-match">
          <span aria-hidden="true" className="absolute inset-x-[8%] inset-y-[22%] rounded border border-white/15" />
          <span aria-hidden="true" className="absolute inset-y-[22%] left-1/2 w-px bg-white/15" />
          <span aria-hidden="true" className="absolute left-1/2 top-1/2 h-8 w-8 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/15" />
          <span className="relative flex min-h-10 items-center gap-2 rounded-full bg-void/85 px-4 text-sm font-bold">
            <Play className="h-3.5 w-3.5 fill-current " />{L.watchMatch} · <Num>{totalMin}′</Num>
          </span>
        </Link>
      ) : (
        <div className="flex h-[72px] items-center justify-center rounded-2xl border border-line bg-surface px-4 text-center text-sm text-muted-text">
          {room.phase === "expired" ? r.expired : r.processing}
        </div>
      )}
      <div dir="ltr" className="relative h-6">
        <span className="absolute inset-x-0 top-[10px] h-1 rounded-full bg-[#1B2236]" />
        {(me.report?.spans ?? []).map(([from, to], index) => (
          <span key={index} className="absolute top-[10px] h-1 rounded-full bg-turf/60" style={{ left: pct(from), width: `calc(${pct(to)} - ${pct(from)})` }} />
        ))}
        {chances.map((goal) => (
          <span key={`c${goal.recordingId}-${goal.key ?? goal.t}`} className="absolute top-[4px] h-4 w-4 -translate-x-1/2 rounded-full border-2 border-void bg-live" style={{ left: pct(goal.atSeconds) }} />
        ))}
        {moments.map((moment) => {
          const href = watchHref(room, moment.at);
          const dot = <span className={cn("block h-4 w-4 rounded-full border-2 border-void", moment.kind === "goal" ? "bg-floodlight ring-2 ring-floodlight/40" : "bg-floodlight")} />;
          return href
            ? <Link key={`${moment.kind}-${moment.at}`} href={href} aria-label={`${moment.label} ${clock(moment.at)}`} className="absolute top-0 flex h-6 w-6 -translate-x-1/2 items-center justify-center" style={{ left: pct(moment.at) }}>{dot}</Link>
            : <span key={`${moment.kind}-${moment.at}`} className="absolute top-[4px] -translate-x-1/2" style={{ left: pct(moment.at) }}>{dot}</span>;
        })}
      </div>
      <p className="flex flex-wrap gap-x-3 text-[11px] text-muted-text">
        {moments.length > 0 && <span className="flex items-center gap-1"><i className="h-2 w-2 rounded-full bg-floodlight" />{L.yourMoments}</span>}
        {chances.length > 0 && <span className="flex items-center gap-1"><i className="h-2 w-2 rounded-full bg-live" />{L.goalsToCheck(chances.length)}</span>}
        <span className="ms-auto">{L.onCamera(onMin, totalMin)}</span>
      </p>
    </div>
  );
}

function FourUp({ me, claimed, stats, L }: { me: PlayerStats; claimed: PlayerStats[]; stats: Stats; L: L }) {
  const form = stats.competition?.personalForm ?? null;
  const pbDistance = form ? isPersonalBest("distance", me.distanceKm, form.bests.distanceKm, form.matchesUsed) : false;
  const dribbles = myStanding(claimed, "dribblesWon", me.playerId);
  const dribbleNote = isFirst(dribbles)
    ? rankText(L, dribbles)
    : dribbles?.top && me.dribblesWon !== null && dribbles.top.value > me.dribblesWon
      ? L.offTop(Math.round(dribbles.top.value - me.dribblesWon))
      : rankText(L, dribbles);
  const touchRate = metricValue(me, "touchRate");
  const passPct = me.passesTried && me.passesCompleted !== null ? Math.round((100 * me.passesCompleted) / me.passesTried) : null;
  const tiles: Array<{ key: string; value: ReactNode; label: string; note: string | null; lime: boolean }> = [];
  if (me.distanceKm !== null) {
    const rank = rankText(L, myStanding(claimed, "distanceRate", me.playerId));
    tiles.push({ key: "km", value: <>{me.distanceKm.toFixed(1)}<span className="text-xs text-muted-text"> {L.km}</span></>, label: L.distance, note: pbDistance ? [L.pb, rank].filter(Boolean).join(" · ") : rank, lime: pbDistance });
  }
  if (me.passesCompleted !== null && me.passesTried) {
    tiles.push({ key: "passes", value: <>{me.passesCompleted}<span className="text-xs text-muted-text">/{me.passesTried}</span></>, label: L.passes, note: passPct !== null ? `${passPct}%` : null, lime: false });
  }
  if (me.dribblesWon !== null) {
    tiles.push({ key: "dribbles", value: <>{me.dribblesWon}</>, label: L.dribbles, note: dribbleNote, lime: isFirst(dribbles) });
  }
  if (touchRate !== null) {
    const standing = myStanding(claimed, "touchRate", me.playerId);
    tiles.push({ key: "touches", value: <>{Math.round(touchRate)}</>, label: L.touchesPer10, note: rankText(L, standing), lime: isFirst(standing) });
  }
  if (!tiles.length) return null;
  return (
    <div className={cn("grid gap-1.5", tiles.length >= 4 ? "grid-cols-4" : tiles.length === 3 ? "grid-cols-3" : "grid-cols-2")} data-testid="report-four-up">
      {tiles.map((tile) => (
        <div key={tile.key} className="flex min-w-0 flex-col gap-0.5 rounded-xl bg-surface px-2 py-2">
          <Num className="font-display text-[22px] font-bold leading-none">{tile.value}</Num>
          <span className="text-[11px] leading-tight text-muted-text">{tile.label}</span>
          {tile.note && <span className={cn("text-[11px] font-bold leading-tight", tile.lime ? "text-floodlight" : "text-text/80")}>{tile.note}</span>}
        </div>
      ))}
    </div>
  );
}

const BOARD_METRICS: ReportMetric[] = ["topSpeed", "distanceRate", "touchRate", "passes", "dribblesWon"];

function PitchBoard({ me, players, L }: { me: PlayerStats; players: PlayerStats[]; L: L }) {
  const claimed = players.filter((player) => player.claimed);
  const usable = BOARD_METRICS.filter((metric) => boardRows(claimed, metric, me.playerId).rows.length >= 2);
  const [picked, setPicked] = useState<ReportMetric | null>(null);
  const metric = picked && usable.includes(picked) ? picked : usable[0] ?? null;
  if (!metric) return null;
  const board = boardRows(claimed, metric, me.playerId, 5);
  const best = board.rows[0]?.value ?? 0;
  const notFound = players.filter((player) => !player.claimed).length;
  const row = (entry: (typeof board.rows)[number], divider = false) => (
    <li key={entry.playerId} className={cn("flex min-h-8 items-center gap-2 text-sm", entry.isMe && "-mx-1.5 rounded-lg bg-floodlight/12 px-1.5", divider && "mt-1 border-t border-line pt-1")}>
      <Num className={cn("w-5 shrink-0 font-bold", entry.rank === 1 ? "text-floodlight" : "text-muted-text")}>{entry.rank}</Num>
      <span className={cn("min-w-0 flex-1 truncate", entry.isMe ? "font-bold" : "text-text/90")}><bdi>{entry.isMe ? L.you : firstName(entry.name)}</bdi></span>
      <span dir="ltr" className="h-1.5 w-[32%] shrink-0 overflow-hidden rounded-full bg-[#1B2236]">
        <i className={cn("block h-full rounded-full", entry.isMe ? "bg-floodlight" : "bg-[#5A6478]")} style={{ width: `${barShare(entry.value, best) * 100}%` }} />
      </span>
      <Num className={cn("w-12 shrink-0 text-end font-display text-base font-bold", entry.isMe && "text-floodlight")}>{formatMetric(metric, entry.value)}</Num>
    </li>
  );
  return (
    <section className="flex flex-col gap-2 rounded-2xl border border-line bg-surface p-3" data-testid="report-pitch-board">
      <div className="flex items-center gap-1.5">
        <h2 className="me-auto font-display text-base font-bold">{L.board}</h2>
      </div>
      <div role="tablist" aria-label={L.board} className="no-scrollbar -mx-3 flex gap-1.5 overflow-x-auto px-3">
        {usable.map((option) => (
          <button
            key={option}
            type="button"
            role="tab"
            aria-selected={option === metric}
            onClick={() => setPicked(option)}
            className={cn("min-h-9 shrink-0 rounded-full px-3 text-xs font-bold", option === metric ? "bg-floodlight text-void" : "border border-line text-muted-text")}
            data-testid={`board-metric-${option}`}
          >
            {L.boardMetric[option] ?? option}
          </button>
        ))}
      </div>
      <p className="text-[11px] text-muted-text">{L.boardUnit[metric]}</p>
      <ol className="flex flex-col">
        {board.rows.map((entry) => row(entry))}
        {board.pinned && row(board.pinned, true)}
      </ol>
      {(board.topShared > 1 || notFound > 0) && (
        <p className="text-[11px] leading-4 text-muted-text">
          {board.topShared > 1 ? L.boardTie(board.topShared) : null}
          {board.topShared > 1 && notFound > 0 ? " · " : null}
          {notFound > 0 ? L.notFoundYet(notFound) : null}
        </p>
      )}
    </section>
  );
}

export function CompactLayout(props: LayoutProps) {
  const L = useReportLayoutCopy();
  const { room, copy, r, now, colors, names, replay, stats, me, players, durationSeconds, onShare } = props;
  const claimed = players.filter((player) => player.claimed);
  const headline = pickHeadline(me, claimed, stats.competition?.personalForm);
  return (
    <div className="flex flex-col gap-2.5" data-testid="report-layout-compact">
      <LayoutHeader room={room} copy={copy} L={L} now={now} onShare={onShare} />
      <MatchStrip room={room} r={r} L={L} me={me} replay={replay} durationSeconds={durationSeconds} />
      {headline && <HeadlineCard view={headlineView(headline, me, L)} room={room} L={L} />}
      <FourUp me={me} claimed={claimed} stats={stats} L={L} />
      <FormLine me={me} stats={stats} L={L} />
      <PitchBoard me={me} players={players} L={L} />
      <MatchReelRow room={room} L={L} r={r} />
      <GoalsToCheck room={room} copy={copy} r={r} colors={colors} names={names} replay={replay} L={L} />
      <MoreStats me={me} players={players} stats={stats} room={room} r={r} copy={copy} durationSeconds={durationSeconds} L={L} />
    </div>
  );
}

/* ------------------------------------------------------------------ E2: sheet */

function Arrow({ d, pb, L }: { d: Direction | null; pb?: boolean; L: L }) {
  if (pb) return <span className="whitespace-nowrap font-bold text-floodlight">▲ {L.pb}</span>;
  if (d === "more") return <span className="font-bold text-floodlight">▲</span>;
  if (d === "less") return <span className="font-bold text-text/80">▼</span>;
  if (d === "level") return <span className="font-bold text-text/80">=</span>;
  return <span className="text-muted-text">–</span>;
}

function Place({ standing, L, fallback }: { standing: MyStanding | null; L: L; fallback?: string | null }) {
  if (standing && isFirst(standing)) {
    return <span className="whitespace-nowrap rounded-full bg-floodlight px-2 py-0.5 text-[11px] font-bold text-void">{L.rank(1, standing.shared, standing.of)}</span>;
  }
  const text = fallback ?? rankText(L, standing);
  return text ? <span className="text-xs text-text/85">{text}</span> : <span className="text-muted-text">–</span>;
}

export function SheetLayout(props: LayoutProps) {
  const L = useReportLayoutCopy();
  const { room, copy, r, now, colors, names, replay, stats, me, players, durationSeconds, onShare } = props;
  const claimed = players.filter((player) => player.claimed);
  const form = stats.competition?.personalForm ?? null;
  const marks = formMarks(me, form);
  const headline = pickHeadline(me, claimed, form);
  const pbSpeed = form ? isPersonalBest("topSpeed", me.topSpeedKmh, form.bests.topSpeedKmh, form.matchesUsed) : false;
  const pbDistance = form ? isPersonalBest("distance", me.distanceKm, form.bests.distanceKm, form.matchesUsed) : false;
  const dribbles = myStanding(claimed, "dribblesWon", me.playerId);
  const touchRate = metricValue(me, "touchRate");
  const passPct = me.passesTried && me.passesCompleted !== null ? Math.round((100 * me.passesCompleted) / me.passesTried) : null;
  const halves = me.report ? compareHalves(me.report.blocks, durationSeconds) : null;
  const blocks = me.report ? foldBlocks(me.report.blocks, durationSeconds) : [];
  const topRate = Math.max(...blocks.map((block) => block.metresPerMinute ?? 0), 1);
  const watch = room.footage.ready && room.footage.shareToken && room.phase !== "expired" ? `/w/${room.footage.shareToken}?m=${room.code}` : null;
  const moments = myMoments(me, L);
  const team = stats.team;
  const possession = team && team.possessionPercent.length >= 2 && room.teamCount !== 3 ? team.possessionPercent : null;
  const view = headline ? headlineView(headline, me, L) : null;

  type Row = { key: string; label: string; you: ReactNode; place: ReactNode; form: ReactNode };
  const rows: Row[] = [];
  if (me.distanceKm !== null) rows.push({ key: "km", label: L.rowDistance, you: <>{me.distanceKm.toFixed(1)} <small className="text-xs text-muted-text">{L.km}</small></>, place: <Place standing={myStanding(claimed, "distanceRate", me.playerId)} L={L} />, form: <Arrow d={marks?.distance ?? null} pb={pbDistance} L={L} /> });
  if (me.topSpeedKmh !== null) rows.push({ key: "speed", label: L.rowSpeed, you: <>{Math.round(me.topSpeedKmh)} <small className="text-xs text-muted-text">{L.kmh}</small></>, place: <Place standing={myStanding(claimed, "topSpeed", me.playerId)} L={L} />, form: <Arrow d={marks?.speed ?? null} pb={pbSpeed} L={L} /> });
  if (me.passesCompleted !== null && me.passesTried) rows.push({ key: "passes", label: L.rowPasses, you: <>{me.passesCompleted}<small className="text-xs text-muted-text">/{me.passesTried}</small></>, place: <Place standing={myStanding(claimed, "passes", me.playerId)} L={L} fallback={passPct !== null ? L.completed(passPct) : null} />, form: <Arrow d={null} L={L} /> });
  if (me.dribblesWon !== null) rows.push({ key: "dribbles", label: L.rowDribbles, you: <>{me.dribblesWon}</>, place: <Place standing={dribbles} L={L} fallback={dribbles?.top && dribbles.top.value > me.dribblesWon && !isFirst(dribbles) ? L.offTop(Math.round(dribbles.top.value - me.dribblesWon)) : null} />, form: <Arrow d={null} L={L} /> });
  if (touchRate !== null) rows.push({ key: "touches", label: L.rowTouches, you: <>{Math.round(touchRate)} <small className="text-xs text-muted-text">/10′</small></>, place: <Place standing={myStanding(claimed, "touchRate", me.playerId)} L={L} />, form: <Arrow d={marks?.touches ?? null} L={L} /> });

  return (
    <div className="flex flex-col gap-3" data-testid="report-layout-sheet">
      <LayoutHeader room={room} copy={copy} L={L} now={now} onShare={onShare} title={L.sheetTitle} />
      {view && (
        <div className="flex items-center gap-3 rounded-2xl bg-floodlight px-3.5 py-3 text-void" data-testid="report-headline">
          {view.badge && <span className="shrink-0 rounded-full bg-void px-2 py-1 text-[10px] font-extrabold uppercase text-floodlight rtl:normal-case">{view.badge}</span>}
          <span className="min-w-0 flex-1 text-sm font-bold leading-snug">
            <span className="whitespace-nowrap"><Num>{view.value}</Num> {view.unit}</span> · {view.lines.join(" ")}
          </span>
          {view.at !== null && watchHref(room, view.at) && (
            <Link href={watchHref(room, view.at)!} aria-label={L.watchIt} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-void text-floodlight"><Play className="h-4 w-4 fill-current" /></Link>
          )}
        </div>
      )}

      <table className="w-full border-collapse overflow-hidden rounded-2xl bg-surface text-sm" data-testid="report-sheet-table">
        <thead>
          <tr className="text-[11px] text-muted-text">
            <th scope="col" className="px-3 pb-1.5 pt-2.5 text-start font-semibold">{L.colStat}</th>
            <th scope="col" className="px-2 pb-1.5 pt-2.5 text-end font-semibold">{L.colYou}</th>
            <th scope="col" className="px-2 pb-1.5 pt-2.5 text-start font-semibold">{L.colPitch}</th>
            {marks && <th scope="col" className="px-3 pb-1.5 pt-2.5 text-center font-semibold">{L.colForm(marks.matches)}</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} className="border-t border-line">
              <th scope="row" className="px-3 py-2.5 text-start font-medium text-text/85">{row.label}</th>
              <td className="whitespace-nowrap px-2 py-2.5 text-end font-display text-lg font-bold"><span dir="ltr">{row.you}</span></td>
              <td className="px-2 py-2.5">{row.place}</td>
              {marks && <td className="px-3 py-2.5 text-center text-xs">{row.form}</td>}
            </tr>
          ))}
          {halves && !halves.level && blocks.length > 1 && (
            <tr className="border-t border-line">
              <th scope="row" className="px-3 py-2.5 text-start font-medium text-text/85">{L.rowSecondHalf}</th>
              <td className="px-2 py-2.5 text-end"><Num className={cn("font-display text-lg font-bold", halves.change > 0 ? "text-floodlight" : "text-text")}>{halves.change > 0 ? "+" : "−"}{Math.round(Math.abs(halves.change) * 100)}%</Num></td>
              <td colSpan={marks ? 2 : 1} className="px-3 py-2.5">
                <div dir="ltr" className="flex h-6 items-end gap-[3px]" aria-hidden="true">
                  {blocks.map((block, index) => (
                    <span key={block.index} className={cn("flex-1 rounded-[2px]", index >= blocks.length / 2 ? "bg-floodlight" : "bg-[#3A4560]")} style={{ height: `${Math.max(8, ((block.metresPerMinute ?? 0) / topRate) * 100)}%` }} />
                  ))}
                </div>
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {moments.length > 0 && (
        <div className="no-scrollbar -mx-4 flex gap-1.5 overflow-x-auto px-4">
          {moments.slice(0, 8).map((moment) => {
            const href = watchHref(room, moment.at);
            const body = <><span className={moment.kind === "dribble" ? "text-turf" : "text-floodlight"}>▶</span>{moment.kind === "sprint" ? L.sprint : moment.label} <Num>{clock(moment.at)}</Num></>;
            const cls = "flex min-h-11 shrink-0 items-center gap-1.5 rounded-xl border border-line bg-surface px-3 text-[13px] font-semibold";
            return href ? <Link key={`${moment.kind}-${moment.at}`} href={href} className={cls}>{body}</Link> : <span key={`${moment.kind}-${moment.at}`} className={cls}>{body}</span>;
          })}
        </div>
      )}

      {possession && (
        <div className="flex flex-col gap-1.5 rounded-xl bg-surface px-3 py-2.5">
          <div className="flex items-center justify-between text-xs text-muted-text">
            <span><bdi>{names.A}</bdi> · <Num>{Math.round(possession[0])}%</Num></span>
            <span>{L.possession} <span className="ms-1 rounded-full bg-muted-text px-1.5 text-[10px] font-bold text-void">{L.sidesBeta}</span></span>
            <span><Num>{Math.round(possession[1])}%</Num> · <bdi>{names.B}</bdi></span>
          </div>
          <div className="flex h-2 overflow-hidden rounded-full">
            <i className="block h-full" style={{ width: `${possession[0]}%`, background: visibleColour(colors.A, "#F2F4F8") }} />
            <i className="block h-full flex-1" style={{ background: visibleColour(colors.B, "#FF5A3C") }} />
          </div>
        </div>
      )}

      <GoalsToCheck room={room} copy={copy} r={r} colors={colors} names={names} replay={replay} L={L} />
      {watch && (
        <Link href={watch} className="flex min-h-12 items-center justify-center gap-2 rounded-full bg-floodlight text-sm font-extrabold text-void" data-testid="link-watch-full-match">
          <Play className="h-4 w-4 fill-current " />{L.watchMatch}
        </Link>
      )}
      <MatchReelRow room={room} L={L} r={r} />
      <MoreStats me={me} players={players} stats={stats} room={room} r={r} copy={copy} durationSeconds={durationSeconds} L={L} />
    </div>
  );
}
