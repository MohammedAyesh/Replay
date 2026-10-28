import { useMemo, useState, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { ArrowLeft, ChevronLeft, Play, Share2 } from "lucide-react";
import type { PlayerStats, Stats } from "@/components/match/MatchStats";
import { PlayerAvatar } from "@/components/match/bits";
import type { MatchStrings } from "@/i18n/match-strings";
import type { ReportStrings } from "@/i18n/report-strings";
import { useReportLayoutCopy, type LayoutStrings } from "@/i18n/report-layout-strings";
import { whatsappLink, type MatchReplay, type MatchRoom, type TeamSide } from "@/lib/match-api";
import { clock, compareHalves, formatMetric, isPersonalBest, metricValue, standOut, type ReportMetric } from "@/lib/match-report";
import { findPath } from "@/lib/find-nav";
import { RADAR_AXES, radarFor, radarPoints, rateMatch, ratingBand, type RatablePlayer } from "@/lib/replay-rating";
import { cn } from "@/lib/utils";
import { MatchReelRow } from "./CompactReport";
import { Num, visibleColour } from "./ReportParts";
import { TwoSidesSection, watchHref } from "./StatsReport";

type R = ReportStrings & { locale: "en" | "ar" };
type Copy = MatchStrings & { locale: "en" | "ar" };
type L = LayoutStrings & { locale: "en" | "ar" };
type S = L["sofa"];

export type SofaProps = {
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
  /** the rest of the report (goals, clips, vote, squad, tools), shown under Overview */
  overviewExtras?: ReactNode;
};

type Tab = "overview" | "players" | "player";

const BAND_CLASS = {
  great: "bg-turf text-void",
  good: "bg-floodlight text-void",
  fair: "bg-[#A28CFF] text-void",
  low: "bg-[#6B7590] text-void",
} as const;

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}

function kickOff(ms: number): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Amman", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(ms));
}

function dayLabel(ms: number, locale: "en" | "ar"): string {
  return new Intl.DateTimeFormat(locale === "ar" ? "ar-JO-u-nu-latn" : "en-GB", { timeZone: "Asia/Amman", weekday: "short", day: "numeric", month: "short" }).format(new Date(ms));
}

/** Text that stays readable on a team colour. */
function inkOn(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return "#0B0F1A";
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.45 ? "#0B0F1A" : "#F2F5FA";
}

export function RatingChip({ rating, size = "md" }: { rating: number | null; size?: "md" | "lg" }) {
  const cls = size === "lg" ? "h-11 min-w-[58px] rounded-[10px] text-[28px]" : "h-[26px] min-w-10 rounded-[7px] text-[17px]";
  if (rating === null) return <span className={cn("flex items-center justify-center border border-dashed border-[#3A4560] font-display font-bold text-muted-text", cls)}>–</span>;
  return <span dir="ltr" className={cn("flex items-center justify-center font-display font-bold leading-none", BAND_CLASS[ratingBand(rating)], cls)}>{rating.toFixed(1)}</span>;
}

/* ------------------------------------------------------------------ header */

function SofaHeader({ room, copy, S, colors, names, onShare, tab, setTab }: {
  room: MatchRoom; copy: Copy; S: S; colors: Record<TeamSide, string>; names: Record<TeamSide, string>;
  onShare: () => void; tab: Tab; setTab: (tab: Tab) => void;
}) {
  const [, setLocation] = useLocation();
  const three = room.teamCount === 3;
  const meSide = room.me?.team ?? null;
  const team = (side: TeamSide) => (
    <div className="flex min-w-0 flex-col items-center gap-1.5">
      <span className="h-12 w-12 rounded-full border-[3px] border-line" style={{ background: visibleColour(colors[side]) }} />
      <span className="flex max-w-full items-center gap-1 truncate text-[13px] font-semibold">
        <bdi className="truncate">{names[side]}</bdi>
        {meSide === side && <span className="rounded bg-floodlight px-1 text-[10px] font-bold text-void">{S.youTag}</span>}
      </span>
    </div>
  );
  return (
    <div className="flex flex-col">
      <div className="flex h-12 items-center justify-between pt-1">
        <button type="button" onClick={() => (window.history.length > 1 ? window.history.back() : setLocation("/home"))} aria-label={copy.back} className="flex h-11 w-11 items-center justify-center">
          <ArrowLeft className="h-5 w-5 rtl:rotate-180" />
        </button>
        <span className="truncate text-sm font-semibold text-muted-text">{room.title || room.field.name}</span>
        <button type="button" onClick={onShare} aria-label={copy.share} className="flex h-11 w-11 items-center justify-center">
          <Share2 className="h-[19px] w-[19px]" />
        </button>
      </div>
      {three ? (
        <div className="grid grid-cols-3 items-center gap-2 py-2">{(["A", "B", "C"] as TeamSide[]).map((side) => <div key={side}>{team(side)}</div>)}</div>
      ) : (
        <div className="grid grid-cols-3 items-center py-2" dir="ltr">
          {team("A")}
          <div className="flex flex-col items-center gap-0.5">
            <Num className={cn("font-display text-[40px] font-bold leading-none tracking-wider", !room.score && "text-[#4A5470]")}>
              {room.score ? `${room.score.a} : ${room.score.b}` : "– : –"}
            </Num>
            <span className="text-xs font-semibold text-muted-text">{S.fullTime}</span>
            <span className="text-[11px] text-muted-text" dir="auto">{dayLabel(room.startMs, copy.locale)} · <Num>{kickOff(room.startMs)}</Num></span>
          </div>
          {team("B")}
        </div>
      )}
      {!room.score && !three && (
        <p className="mb-2 flex min-h-10 items-center justify-center gap-2 rounded-[10px] bg-surface text-[13px] text-text/80">
          {S.scoreNotIn}{room.canManage && <span className="font-bold text-turf">· {S.addScore}</span>}
        </p>
      )}
      <div role="tablist" aria-label={S.tabOverview} className="-mx-4 grid grid-cols-3 border-b border-line px-4">
        {([["overview", S.tabOverview], ["players", S.tabPlayers], ["player", S.tabYou]] as Array<[Tab, string]>).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={cn("min-h-11 text-sm", tab === id ? "font-bold text-text shadow-[inset_0_-3px_0_#D4FF4F]" : "font-semibold text-muted-text")}
            data-testid={`sofa-tab-${id}`}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ overview */

function TwoSidedRow({ label, a, b, format, colors, bar = false }: { label: string; a: number; b: number; format: (v: number) => string; colors: [string, string]; bar?: boolean }) {
  const lead = Math.abs(a - b) < 1e-9 ? null : a > b ? 0 : 1;
  const pill = (value: number, side: 0 | 1) => (
    <Num className={cn("min-w-11 rounded-full px-2 py-0.5 text-center text-sm", lead === side ? "font-bold" : "font-semibold")}>
      <span style={lead === side ? { background: colors[side], color: inkOn(colors[side]), borderRadius: 999, padding: "2px 8px", margin: "-2px -8px" } : undefined}>{format(value)}</span>
    </Num>
  );
  return (
    <div className="flex flex-col gap-1.5 border-t border-line py-2.5 first:border-t-0">
      <div className="flex items-center justify-between" dir="ltr">
        {pill(a, 0)}
        <span className="text-sm text-text/80" dir="auto">{label}</span>
        {pill(b, 1)}
      </div>
      {bar && a + b > 0 && (
        <div className="flex h-1.5 gap-1" dir="ltr">
          <span className="flex flex-1 justify-end overflow-hidden rounded-full bg-line"><i className="block h-full" style={{ width: `${(100 * a) / (a + b)}%`, background: colors[0], opacity: lead === 0 ? 1 : 0.55 }} /></span>
          <span className="flex flex-1 overflow-hidden rounded-full bg-line"><i className="block h-full" style={{ width: `${(100 * b) / (a + b)}%`, background: colors[1], opacity: lead === 1 ? 1 : 0.55 }} /></span>
        </div>
      )}
    </div>
  );
}

function Overview({ room, copy, r, S, L, colors, names, stats, me, players, ratings, onOpenMe, extras }: {
  room: MatchRoom; copy: Copy; r: R; S: S; L: L; colors: Record<TeamSide, string>; names: Record<TeamSide, string>;
  stats: Stats; me: PlayerStats; players: PlayerStats[]; ratings: Map<number, number>; onOpenMe: () => void; extras?: ReactNode;
}) {
  const claimed = players.filter((player) => player.claimed);
  const team = stats.team;
  const two = room.teamCount !== 3 && team && team.sides.length >= 2;
  const sideA = (team?.sides[0] ?? "A") as TeamSide;
  const sideB = (team?.sides[1] ?? "B") as TeamSide;
  const pairColours: [string, string] = [visibleColour(colors[sideA], "#F2F4F8"), visibleColour(colors[sideB], "#FF6B1A")];
  const found = (side: TeamSide) => claimed.filter((player) => player.team === side).length;
  const pct = (x: number, y: number) => (y > 0 ? Math.round((100 * x) / y) : 0);
  const viewer = room.players.find((player) => player.id === me.playerId);
  const nameOf = (player: { playerId: number; name: string }) => (player.playerId === me.playerId ? r.you : firstName(player.name));
  const best = ([
    ["distanceRate", S.mostDistance, 0],
    ["topSpeed", S.topSpeed, 0],
    ["dribblesWon", S.mostDribbles, 1],
    ["touchRate", S.mostTouches, 0],
  ] as Array<[ReportMetric, string, number]>).map(([metric, label, minimum]) => {
    const out = standOut(claimed, metric, minimum);
    if (!out) return null;
    // The viewer leads the names when he shares the top.
    const winners = [...out.winners].sort((a, b) => Number(b.playerId === me.playerId) - Number(a.playerId === me.playerId));
    const who = winners.length > 1 ? S.andMore(nameOf(winners[0]), winners.length - 1) : nameOf(winners[0]);
    const unit = metric === "distanceRate" ? ` ${L.km} /10′` : metric === "topSpeed" ? ` ${L.kmh}` : metric === "touchRate" ? " /10′" : "";
    const lead = winners[0];
    const info = room.players.find((player) => player.id === lead.playerId);
    // Shown with the first-named player's own value, so "You +2 · 30" is your number, not the leader's.
    const value = metricValue(lead, metric) ?? out.value;
    return { metric, label, who, value: `${formatMetric(metric, value)}${unit}`, info, mine: out.winners.some((w) => w.playerId === me.playerId) };
  }).filter((row): row is NonNullable<typeof row> => row !== null);

  return (
    <div className="flex flex-col gap-3 pt-3">
      <button type="button" onClick={onOpenMe} className="flex items-center gap-3 rounded-[14px] bg-surface p-3 text-start" data-testid="sofa-your-match">
        <PlayerAvatar name={me.name} initials={viewer?.initials} avatarUrl={viewer?.avatarUrl} size={44} ring="#D4FF4F" />
        <span className="min-w-0 flex-1">
          <span className="block text-[11px] font-bold tracking-wide text-muted-text rtl:tracking-normal">{S.yourMatch}</span>
          <span className="block truncate text-[15px] font-bold"><bdi>{me.name}</bdi></span>
          <span className="block truncate text-xs text-muted-text" dir="ltr">
            {[me.distanceKm !== null ? `${me.distanceKm.toFixed(1)} ${L.km}` : null, me.topSpeedKmh !== null ? `${Math.round(me.topSpeedKmh)} ${L.kmh}` : null, me.passesCompleted !== null && me.passesTried ? `${me.passesCompleted}/${me.passesTried}` : null].filter(Boolean).join(" · ")}
          </span>
        </span>
        <RatingChip rating={ratings.get(me.playerId) ?? null} />
      </button>

      {two && team ? (
        <section className="rounded-[14px] bg-surface px-3.5 pb-2.5 pt-1">
          <div className="flex items-center justify-between pb-1.5 pt-2.5">
            <h2 className="text-[15px] font-bold">{S.topStats}</h2>
            <span className="rounded-full bg-muted-text px-1.5 py-0.5 text-[10px] font-bold text-void">{S.beta}</span>
          </div>
          <div className="flex items-center justify-between pb-1 text-[11px] text-muted-text" dir="ltr">
            <bdi>{names[sideA]}</bdi><bdi>{names[sideB]}</bdi>
          </div>
          <TwoSidedRow label={S.possession} a={team.possessionPercent[0] ?? 0} b={team.possessionPercent[1] ?? 0} format={(v) => `${Math.round(v)}%`} colors={pairColours} bar />
          <TwoSidedRow label={S.passesCompleted} a={team.passesCompleted[0] ?? 0} b={team.passesCompleted[1] ?? 0} format={(v) => Math.round(v).toLocaleString("en")} colors={pairColours} />
          <TwoSidedRow label={S.passAccuracy} a={pct(team.passesCompleted[0] ?? 0, team.passesTried[0] ?? 0)} b={pct(team.passesCompleted[1] ?? 0, team.passesTried[1] ?? 0)} format={(v) => `${v}%`} colors={pairColours} />
          <TwoSidedRow label={S.touches} a={team.touches[0] ?? 0} b={team.touches[1] ?? 0} format={(v) => Math.round(v).toLocaleString("en")} colors={pairColours} />
          {team.dribblesWon && <TwoSidedRow label={S.dribblesWon} a={team.dribblesWon[0] ?? 0} b={team.dribblesWon[1] ?? 0} format={(v) => String(Math.round(v))} colors={pairColours} />}
          <TwoSidedRow label={S.playersFound} a={found(sideA)} b={found(sideB)} format={(v) => String(v)} colors={pairColours} />
        </section>
      ) : (
        <TwoSidesSection room={room} r={r} copy={copy} whole={team} players={players} />
      )}

      {best.length > 0 && (
        <section className="rounded-[14px] bg-surface px-3.5 pb-1.5 pt-1">
          <h2 className="pb-1.5 pt-2.5 text-[15px] font-bold">{S.bestOnPitch}</h2>
          <ul>
            {best.map((row) => (
              <li key={row.metric} className="flex min-h-12 items-center gap-2.5 border-t border-line py-1.5">
                <PlayerAvatar name={row.info?.name ?? row.who} initials={row.info?.initials} avatarUrl={row.info?.avatarUrl} size={30} ring={row.mine ? "#D4FF4F" : undefined} />
                <span className="min-w-0 flex-1 text-sm">{row.label}</span>
                <span className={cn("shrink-0 text-sm font-bold", row.mine && "text-floodlight")}><bdi>{row.who}</bdi> · <span dir="ltr" className="whitespace-nowrap">{row.value}</span></span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {extras}
    </div>
  );
}

/* ------------------------------------------------------------------ players */

type Sort = "rating" | "distance" | "speed" | "passes" | "dribbles";

function sortValue(player: PlayerStats, sort: Sort, ratings: Map<number, number>): number | null {
  switch (sort) {
    case "rating": return ratings.get(player.playerId) ?? null;
    case "distance": return player.distanceKm;
    case "speed": return player.topSpeedKmh;
    case "passes": return player.passesCompleted;
    case "dribbles": return player.dribblesWon;
  }
}

function sortLabel(player: PlayerStats, sort: Sort, L: L): string {
  switch (sort) {
    case "distance": return player.distanceKm !== null ? `${player.distanceKm.toFixed(1)} ${L.km}` : "–";
    case "speed": return player.topSpeedKmh !== null ? `${Math.round(player.topSpeedKmh)} ${L.kmh}` : "–";
    case "passes": return player.passesCompleted !== null ? `${player.passesCompleted}${player.passesTried ? `/${player.passesTried}` : ""}` : "–";
    case "dribbles": return player.dribblesWon !== null ? String(player.dribblesWon) : "–";
    default: return "";
  }
}

function PlayersTab({ room, r, S, L, colors, names, me, players, ratings, findRecordingId, onOpen }: {
  room: MatchRoom; r: R; S: S; L: L; colors: Record<TeamSide, string>; names: Record<TeamSide, string>;
  me: PlayerStats; players: PlayerStats[]; ratings: Map<number, number>; findRecordingId: number | null; onOpen: (id: number) => void;
}) {
  const [sort, setSort] = useState<Sort>("rating");
  const claimed = players.filter((player) => player.claimed);
  const unclaimed = players.filter((player) => !player.claimed);
  const sides = Array.from(new Set(claimed.map((player) => player.team ?? "?")));
  sides.sort((a, b) => (a === me.team ? -1 : b === me.team ? 1 : a.localeCompare(b)));
  const ordered = (list: PlayerStats[]) => [...list].sort((a, b) => (sortValue(b, sort, ratings) ?? -1) - (sortValue(a, sort, ratings) ?? -1));
  const findUrl = findRecordingId !== null ? `${window.location.origin}${findPath(findRecordingId, room.code)}` : null;
  const line = (player: PlayerStats) => [
    player.distanceKm !== null ? `${player.distanceKm.toFixed(1)} ${L.km}` : null,
    player.topSpeedKmh !== null ? `${Math.round(player.topSpeedKmh)} ${L.kmh}` : null,
    player.passesCompleted !== null && player.passesTried ? `${player.passesCompleted}/${player.passesTried}` : null,
  ].filter(Boolean).join(" · ");
  const sorts: Array<[Sort, string]> = [["rating", S.sortRating], ["distance", S.sortDistance], ["speed", S.sortSpeed], ["passes", S.sortPasses], ["dribbles", S.sortDribbles]];
  return (
    <div className="flex flex-col gap-3 pt-3" data-testid="sofa-players">
      <div className="no-scrollbar -mx-4 flex gap-1.5 overflow-x-auto px-4" role="tablist" aria-label={S.tabPlayers}>
        {sorts.map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={sort === id} onClick={() => setSort(id)} className={cn("min-h-9 shrink-0 rounded-full px-3 text-xs font-bold", sort === id ? "bg-floodlight text-void" : "border border-line text-muted-text")}>{label}</button>
        ))}
      </div>
      {ratings.size === 0 && sort === "rating" && <p className="text-xs text-muted-text">{S.noRatings}</p>}
      {sides.map((side) => {
        const list = ordered(claimed.filter((player) => (player.team ?? "?") === side));
        const colour = side in colors ? visibleColour(colors[side as TeamSide]) : "#8A93A6";
        return (
          <section key={side} className="rounded-[14px] bg-surface px-3.5 pb-1.5 pt-1">
            <h2 className="flex items-center gap-2 pb-1.5 pt-2.5 text-sm font-bold">
              <i className="h-2.5 w-2.5 rounded-full" style={{ background: colour }} />
              <bdi>{side in names ? names[side as TeamSide] : "–"}</bdi>
            </h2>
            <ul>
              {list.map((player) => {
                const isMe = player.playerId === me.playerId;
                const info = room.players.find((p) => p.id === player.playerId);
                return (
                  <li key={player.playerId}>
                    <button type="button" onClick={() => onOpen(player.playerId)} className={cn("flex w-full items-center gap-2.5 border-t border-line py-2 text-start", isMe && "-mx-1.5 rounded-lg border-transparent bg-floodlight/[0.08] px-1.5")} data-testid={`sofa-player-${player.playerId}`}>
                      <PlayerAvatar name={player.name} initials={info?.initials} avatarUrl={info?.avatarUrl} size={36} ring={isMe ? "#D4FF4F" : undefined} />
                      <span className="min-w-0 flex-1">
                        <span className={cn("flex items-center gap-1.5 text-sm", isMe ? "font-bold" : "font-semibold")}>
                          <bdi className="truncate">{player.name}</bdi>
                          {isMe && <span className="shrink-0 rounded bg-floodlight px-1 text-[10px] font-bold text-void">{S.youTag}</span>}
                        </span>
                        <span className="block truncate text-xs text-muted-text" dir="ltr">{line(player)}</span>
                      </span>
                      {sort === "rating"
                        ? <RatingChip rating={ratings.get(player.playerId) ?? null} />
                        : <Num className="shrink-0 text-sm font-bold">{sortLabel(player, sort, L)}</Num>}
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
      {unclaimed.length > 0 && (
        <section className="rounded-[14px] bg-surface px-3.5 pb-1.5 pt-1">
          <div className="flex items-center justify-between pb-1.5 pt-2.5">
            <h2 className="text-sm font-bold">{S.notFoundYet}</h2>
            {findUrl && <a href={whatsappLink(r.findLinkText(findUrl))} target="_blank" rel="noopener noreferrer" className="flex min-h-11 items-center text-[13px] font-bold text-turf">{r.sendLink}</a>}
          </div>
          <ul>
            {unclaimed.map((player) => {
              const info = room.players.find((p) => p.id === player.playerId);
              return (
                <li key={player.playerId} className="flex items-center gap-2.5 border-t border-line py-2 text-muted-text">
                  <PlayerAvatar name={player.name} initials={info?.initials} avatarUrl={info?.avatarUrl} size={32} dashed />
                  <bdi className="min-w-0 flex-1 truncate text-sm">{player.name}</bdi>
                  <RatingChip rating={null} />
                </li>
              );
            })}
          </ul>
        </section>
      )}
      {ratings.size > 0 && <p className="text-[11px] text-muted-text">{S.ratingNote}</p>}
    </div>
  );
}

/* ------------------------------------------------------------------ player page */

function RadarCard({ player, players, S }: { player: PlayerStats; players: PlayerStats[]; S: S }) {
  const radar = radarFor(player as RatablePlayer, players as RatablePlayer[]);
  if (!radar) return null;
  const cx = 150;
  const cy = 135;
  const R = 100;
  const ring = (pct: number) => radarPoints({ running: pct, speed: pct, passing: pct, dribbling: pct, onBall: pct }, cx, cy, R).map((p) => p.join(",")).join(" ");
  const mine = radarPoints(radar.player, cx, cy, R);
  const avg = radarPoints(radar.average, cx, cy, R).map((p) => p.join(",")).join(" ");
  const outer = radarPoints({ running: 100, speed: 100, passing: 100, dribbling: 100, onBall: 100 }, cx, cy, R);
  const labelAt = radarPoints({ running: 118, speed: 122, passing: 118, dribbling: 118, onBall: 122 }, cx, cy, R);
  const anchors = ["middle", "start", "middle", "middle", "end"] as const;
  const aria = RADAR_AXES.map((axis) => `${S.axis[axis]} ${radar.player[axis] ?? "–"}`).join(", ");
  return (
    <section className="rounded-[14px] bg-surface px-3.5 py-3">
      <div className="flex items-baseline justify-between">
        <h2 className="text-[15px] font-bold">{S.yourStyle}</h2>
        <span className="text-xs text-muted-text">{S.vsPitch}</span>
      </div>
      <svg viewBox="-80 0 460 262" className="h-[230px] w-full" role="img" aria-label={aria}>
        {[100, 66, 33].map((pct) => <polygon key={pct} points={ring(pct)} fill="none" stroke="#26304A" strokeWidth="1" />)}
        {outer.map(([x, y], index) => <line key={index} x1={cx} y1={cy} x2={x} y2={y} stroke="#26304A" />)}
        <polygon points={avg} fill="rgba(154,163,184,0.08)" stroke="#9AA3B8" strokeWidth="1.5" strokeDasharray="4 4" />
        <polygon points={mine.map((p) => p.join(",")).join(" ")} fill="rgba(212,255,79,0.22)" stroke="#D4FF4F" strokeWidth="2.5" />
        {mine.map(([x, y], index) => <circle key={index} cx={x} cy={y} r="4" fill="#D4FF4F" />)}
        {RADAR_AXES.map((axis, index) => {
          const [x, y] = labelAt[index];
          return (
            <text key={axis} x={x} y={y + (index === 0 ? -4 : index >= 2 && index <= 3 ? 14 : 4)} textAnchor={anchors[index]} fill="#F2F5FA" fontSize="13" fontWeight="700" fontFamily="Inter, Cairo, sans-serif">
              {S.axis[axis]} <tspan fill="#9AA3B8" fontWeight="500">{radar.player[axis] ?? "–"}</tspan>
            </text>
          );
        })}
      </svg>
      <div className="flex justify-center gap-4 text-xs text-muted-text">
        <span className="inline-flex items-center gap-1.5"><i className="h-[3px] w-3.5 bg-floodlight" />{firstName(player.name)}</span>
        <span className="inline-flex items-center gap-1.5"><i className="w-3.5 border-t-2 border-dashed border-muted-text" />{S.pitchAverage}</span>
      </div>
    </section>
  );
}

function HeatCard({ player, S }: { player: PlayerStats; S: S }) {
  const heat = player.report?.heatmap;
  if (!heat || !heat.weights.length) return null;
  const max = Math.max(...heat.weights, 1e-9);
  return (
    <section className="flex flex-col gap-2.5 rounded-[14px] bg-surface px-3.5 py-3">
      <h2 className="text-[15px] font-bold">{S.heatMap}</h2>
      <div dir="ltr" role="img" aria-label={S.heatMap} className="relative h-[196px] overflow-hidden rounded-lg border-2 border-[#2A3A33] bg-[#16241E]">
        <div className="absolute inset-0 grid blur-[10px]" style={{ gridTemplateColumns: `repeat(${heat.columns}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${heat.rows}, minmax(0, 1fr))` }}>
          {heat.weights.map((weight, index) => {
            const share = weight / max;
            const colour = share > 0.66 ? "212,255,79" : share > 0.33 ? "47,216,196" : "47,216,196";
            return <span key={index} style={{ background: `rgba(${colour},${Math.min(0.95, share * 1.1)})` }} />;
          })}
        </div>
        <span className="absolute inset-y-0 left-1/2 w-0.5 bg-[#2A3A33]" />
        <span className="absolute left-1/2 top-1/2 h-14 w-14 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-[#2A3A33]" />
        <span className="absolute left-0 top-[30%] h-[40%] w-10 border-2 border-l-0 border-[#2A3A33]" />
        <span className="absolute right-0 top-[30%] h-[40%] w-10 border-2 border-r-0 border-[#2A3A33]" />
      </div>
    </section>
  );
}

function Row({ label, children, href }: { label: string; children: ReactNode; href?: string | null }) {
  const body = <><span className="text-text/80">{label}</span><span className="flex items-center gap-2 font-bold">{children}</span></>;
  const cls = "flex min-h-11 items-center justify-between border-t border-line py-2 text-sm first:border-t-0";
  return href ? <Link href={href} className={cls}>{body}</Link> : <div className={cls}>{body}</div>;
}

function PlayerPage({ room, S, r, me, player, players, ratings, stats, durationSeconds, onBack }: {
  room: MatchRoom; S: S; r: R; me: PlayerStats; player: PlayerStats; players: PlayerStats[]; ratings: Map<number, number>;
  stats: Stats; durationSeconds: number; onBack: (() => void) | null;
}) {
  const L = useReportLayoutCopy();
  const isMe = player.playerId === me.playerId;
  const info = room.players.find((p) => p.id === player.playerId);
  const form = isMe ? stats.competition?.personalForm ?? null : null;
  const pbDistance = form ? isPersonalBest("distance", player.distanceKm, form.bests.distanceKm, form.matchesUsed) : false;
  const pbSpeed = form ? isPersonalBest("topSpeed", player.topSpeedKmh, form.bests.topSpeedKmh, form.matchesUsed) : false;
  const pbCount = Number(pbDistance) + Number(pbSpeed);
  const halves = player.report ? compareHalves(player.report.blocks, durationSeconds) : null;
  const rate = metricValue(player, "distanceRate");
  const report = player.report;
  const moments = report ? [
    ...report.goalTimes.map((at) => ({ at, label: L.goal, lime: true })),
    ...(report.topSpeedAt !== null && player.topSpeedKmh !== null ? [{ at: report.topSpeedAt, label: `${Math.round(player.topSpeedKmh)} ${L.kmh}`, lime: true }] : []),
    ...report.dribbleWonTimes.map((at) => ({ at, label: L.dribble, lime: false })),
    ...(report.shotTimes ?? []).filter((at) => !report.goalTimes.some((g) => Math.abs(g - at) < 5)).map((at) => ({ at, label: S.shot, lime: false })),
  ].sort((a, b) => a.at - b.at) : [];
  const pbChip = <span className="rounded-full bg-floodlight px-1.5 py-px text-[11px] font-bold text-void">{L.pb}</span>;
  const firstOf = (times: number[] | undefined) => (times && times.length ? watchHref(room, times[0]) : null);
  const shots = (player as PlayerStats & { shots?: number | null }).shots ?? null;
  const dribbles = (player as PlayerStats & { dribbles?: number | null }).dribbles ?? null;
  return (
    <div className="flex flex-col gap-3 pt-3" data-testid="sofa-player-page">
      {onBack && (
        <button type="button" onClick={onBack} className="flex min-h-9 items-center gap-1 self-start text-sm font-semibold text-turf">
          <ChevronLeft className="h-4 w-4 rtl:rotate-180" />{S.backToPlayers}
        </button>
      )}
      <div className="flex items-center gap-3.5">
        <PlayerAvatar name={player.name} initials={info?.initials} avatarUrl={info?.avatarUrl} size={64} ring={isMe ? "#D4FF4F" : undefined} />
        <div className="min-w-0 flex-1">
          <p className="truncate font-display text-[22px] font-bold leading-tight"><bdi>{player.name}</bdi></p>
          <p className="text-[13px] text-muted-text">{S.minutesOnCamera(Math.round(player.minutes ?? 0))}</p>
          {pbCount > 0 && <span className="mt-1.5 inline-block rounded-full bg-floodlight px-2 py-0.5 text-[11px] font-bold text-void">{S.personalBests(pbCount)}</span>}
        </div>
        <div className="flex flex-col items-center gap-1">
          <RatingChip rating={ratings.get(player.playerId) ?? null} size="lg" />
          <span className="text-[11px] text-muted-text">{S.rating}</span>
        </div>
      </div>

      <RadarCard player={player} players={players} S={S} />
      <HeatCard player={player} S={S} />

      <section className="rounded-[14px] bg-surface px-3.5 pb-1.5 pt-1">
        <h2 className="pb-1 pt-2.5 text-[15px] font-bold">{S.physical}</h2>
        {player.distanceKm !== null && <Row label={S.distance}>{pbDistance && pbChip}<Num>{player.distanceKm.toFixed(2)} {L.km}</Num></Row>}
        {player.topSpeedKmh !== null && <Row label={S.topSpeed} href={report?.topSpeedAt != null ? watchHref(room, report.topSpeedAt) : null}>{pbSpeed && pbChip}<Num>{player.topSpeedKmh.toFixed(1)} {L.kmh}</Num>{report?.topSpeedAt != null && <Play className="h-3.5 w-3.5 fill-current text-turf" />}</Row>}
        {rate !== null && <Row label={S.distancePer10}><Num>{formatMetric("distanceRate", rate)} {L.km}</Num></Row>}
        {halves && !halves.level && <Row label={S.secondHalf}><Num className={halves.change > 0 ? "text-floodlight" : ""}>{halves.change > 0 ? "+" : "−"}{Math.round(Math.abs(halves.change) * 100)}%</Num></Row>}
      </section>

      <section className="rounded-[14px] bg-surface px-3.5 pb-1.5 pt-1">
        <h2 className="pb-1 pt-2.5 text-[15px] font-bold">{S.onTheBall}</h2>
        {player.touches !== null && <Row label={S.touches}><Num>{player.touches}</Num></Row>}
        {player.passesCompleted !== null && player.passesTried ? <Row label={S.accuratePasses}><Num>{player.passesCompleted}/{player.passesTried}</Num><Num className="font-medium text-muted-text">({Math.round((100 * player.passesCompleted) / player.passesTried)}%)</Num></Row> : null}
        {player.dribblesWon !== null && <Row label={S.dribblesWon} href={firstOf(report?.dribbleWonTimes)}><Num>{player.dribblesWon}{dribbles ? `/${dribbles}` : ""}</Num>{report?.dribbleWonTimes.length ? <Play className="h-3.5 w-3.5 fill-current text-turf" /> : null}</Row>}
        {shots !== null && <Row label={S.shots} href={firstOf(report?.shotTimes)}><Num>{shots}</Num>{report?.shotTimes?.length ? <Play className="h-3.5 w-3.5 fill-current text-turf" /> : null}</Row>}
        {player.goals !== null && <Row label={S.goals} href={firstOf(report?.goalTimes)}><Num>{player.goals}</Num>{report?.goalTimes.length ? <Play className="h-3.5 w-3.5 fill-current text-turf" /> : null}</Row>}
      </section>

      {moments.length > 0 && (
        <section className="flex flex-col gap-2.5 rounded-[14px] bg-surface px-3.5 py-3">
          <h2 className="text-[15px] font-bold">{S.moments}</h2>
          <div className="no-scrollbar -mx-3.5 flex gap-2 overflow-x-auto px-3.5">
            {moments.slice(0, 10).map((moment) => {
              const href = watchHref(room, moment.at);
              const body = <><span className={moment.lime ? "text-floodlight" : "text-turf"}>▶</span>{moment.label} <Num>{clock(moment.at)}</Num></>;
              const cls = "flex min-h-11 shrink-0 items-center gap-1.5 rounded-[10px] bg-[#1B2335] px-3 text-[13px] font-semibold";
              return href ? <Link key={`${moment.label}-${moment.at}`} href={href} className={cls}>{body}</Link> : <span key={`${moment.label}-${moment.at}`} className={cls}>{body}</span>;
            })}
          </div>
        </section>
      )}
      {isMe && <MatchReelRow room={room} L={L} r={r} />}
    </div>
  );
}

/* ------------------------------------------------------------------ the layout */

export function SofaLayout({ room, copy, r, colors, names, stats, me, players, durationSeconds, onShare, overviewExtras }: SofaProps) {
  const L = useReportLayoutCopy();
  const S = L.sofa;
  const [tab, setTab] = useState<Tab>("overview");
  const [selected, setSelected] = useState<number | null>(null);
  const ratings = useMemo(() => {
    const out = new Map<number, number>();
    for (const [id, entry] of rateMatch(players as RatablePlayer[])) out.set(id, entry.rating);
    return out;
  }, [players]);
  const teamNames = useMemo(() => {
    const out = { ...names };
    for (const side of ["A", "B", "C"] as TeamSide[]) if (!room.teams[side]?.name) out[side] = S.teamFallback(side);
    return out;
  }, [names, room.teams, S]);
  const shown = selected !== null ? players.find((player) => player.playerId === selected && player.claimed) ?? me : me;
  const open = (id: number) => { setSelected(id === me.playerId ? null : id); setTab("player"); };
  const findRecordingId = stats.recordings[0] ?? null;
  return (
    <div className="flex flex-col" data-testid="report-layout-sofa">
      <SofaHeader room={room} copy={copy} S={S} colors={colors} names={teamNames} onShare={onShare} tab={tab} setTab={(next) => { setTab(next); if (next === "player") setSelected(null); }} />
      {tab === "overview" && <Overview room={room} copy={copy} r={r} S={S} L={L} colors={colors} names={teamNames} stats={stats} me={me} players={players} ratings={ratings} onOpenMe={() => open(me.playerId)} extras={overviewExtras} />}
      {tab === "players" && <PlayersTab room={room} r={r} S={S} L={L} colors={colors} names={teamNames} me={me} players={players} ratings={ratings} findRecordingId={findRecordingId} onOpen={open} />}
      {tab === "player" && <PlayerPage room={room} S={S} r={r} me={me} player={shown} players={players} ratings={ratings} stats={stats} durationSeconds={durationSeconds} onBack={selected !== null ? () => setTab("players") : null} />}
    </div>
  );
}
