import { useMemo, useState } from "react";
import { Link } from "wouter";
import { ChevronDown, Loader2, Play, Share2 } from "lucide-react";
import { PlayerAvatar } from "@/components/match/bits";
import { useMatchStatsData, type PlayerStats, type Stats, type TeamStats } from "@/components/match/MatchStats";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useToast } from "@/hooks/use-toast";
import type { ReportStrings } from "@/i18n/report-strings";
import type { MatchStrings } from "@/i18n/match-strings";
import { useAuth } from "@/lib/auth";
import type { MatchReplay, MatchRoom, TeamSide } from "@/lib/match-api";
import {
  RIVAL_METRICS,
  band,
  clock,
  compareHalves,
  defaultRival,
  fiveMinuteRows,
  foldBlocks,
  foldHeat,
  formLine,
  formatMetric,
  isPersonalBest,
  levelWith,
  metricValue,
  minuteMark,
  rankedCount,
  rivalRows,
  standOut,
  standings,
  tally,
  type ReportMetric,
  type ReportPlayer,
} from "@/lib/match-report";
import { cn } from "@/lib/utils";
import { BigStat, HeatGrid, Num, PillToggle, Section, StripPlot, visibleColour } from "./ReportParts";
import { drawShareCard, shareOrSaveCard } from "./shareCard";

type R = ReportStrings & { locale: "en" | "ar" };
type Copy = MatchStrings & { locale: "en" | "ar" };

export function watchHref(room: MatchRoom, seconds: number): string | null {
  return room.footage.shareToken ? `/w/${room.footage.shareToken}?m=${room.code}&t=${Math.max(0, Math.round(seconds - 8))}` : null;
}

const UNITS: Partial<Record<ReportMetric, string>> = {
  distanceRate: "km",
  distance: "km",
  topSpeed: "km/h",
};

function unitGap(metric: ReportMetric, value: number): string {
  const unit = UNITS[metric];
  return `${formatMetric(metric, value)}${unit ? ` ${unit}` : ""}`;
}

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}

/* ------------------------------------------------------------------ YOU */

export function YouSection({ me, players, stats, room, r, durationSeconds, replay, teamNames }: {
  me: PlayerStats;
  players: PlayerStats[];
  stats: Stats;
  room: MatchRoom;
  r: R;
  durationSeconds: number;
  replay: MatchReplay | undefined;
  teamNames: Record<TeamSide, string>;
}) {
  const { toast } = useToast();
  const [sharing, setSharing] = useState(false);
  const claimed = players.filter((player) => player.claimed);
  const note = (metric: ReportMetric) => {
    const table = standings(claimed, metric);
    const mine = table.find((entry) => entry.player.playerId === me.playerId);
    if (!mine) return null;
    if (!mine.ranked) return { text: r.notRankedShort(Math.round(me.minutes ?? 0)), tone: "muted" as const };
    const of = rankedCount(claimed, metric);
    const ordinal = r.ordinal(mine.rank);
    const level = levelWith(claimed, metric, me.playerId);
    const text = !mine.shared
      ? r.rankOf(ordinal, of)
      : level.length === 1
        ? r.levelWith(ordinal, firstName(level[0].name))
        : r.rankShared(ordinal, of);
    return { text, tone: mine.rank <= 3 ? "lime" as const : "muted" as const };
  };
  const distance = metricValue(me, "distanceRate");
  const speed = metricValue(me, "topSpeed");
  const touches = metricValue(me, "touchRate");
  const cells: Array<{ metric: ReportMetric; value: number | null; label: string }> = [
    { metric: "distanceRate", value: distance, label: r.perTenOnCamera },
    { metric: "topSpeed", value: speed, label: r.kmhTop },
    { metric: "touchRate", value: touches, label: r.touchesPerTen },
  ];
  const shown = cells.filter((cell) => cell.value !== null);
  const totals = [
    me.distanceKm !== null ? r.kmTotal(me.distanceKm.toFixed(1)) : null,
    me.passesTried !== null && me.passesCompleted !== null && me.passesTried > 0 ? r.passesFound(me.passesCompleted, me.passesTried) : null,
    me.dribblesWon !== null ? r.dribblesWon(me.dribblesWon) : null,
    me.goals ? r.goals(me.goals) : null,
  ].filter(Boolean) as string[];
  const form = stats.competition?.personalForm ?? null;
  const line = form ? formLine(me, form.averages, form.matchesUsed) : null;
  const formText = line
    ? `${r.formAgainst(line.matches)}: ${[
      line.distance ? r.formDistance[line.distance] : null,
      line.speed ? r.formSpeed[line.speed] : null,
      line.touches ? r.formTouches[line.touches] : null,
    ].filter(Boolean).join(r.locale === "ar" ? "، " : ", ")}.`
    : null;
  const pbs = form ? [
    isPersonalBest("distance", me.distanceKm, form.bests.distanceKm, form.matchesUsed) ? r.groundCovered : null,
    isPersonalBest("topSpeed", me.topSpeedKmh, form.bests.topSpeedKmh, form.matchesUsed) ? r.topSpeed : null,
  ].filter(Boolean) as string[] : [];

  const share = async () => {
    setSharing(true);
    try {
      const mineGoals = new Set(me.report?.goalTimes.map((at) => Math.round(at)) ?? []);
      const blob = await drawShareCard({
        brand: "Replay",
        dateLine: new Intl.DateTimeFormat(r.locale === "ar" ? "ar-JO" : "en-GB", { timeZone: "Asia/Amman", weekday: "short", day: "numeric", month: "short" }).format(new Date(room.startMs)),
        teamA: teamNames.A,
        teamB: teamNames.B,
        score: room.score ? `${room.score.a}–${room.score.b}` : null,
        heading: r.shareMyNight,
        stats: shown.map((cell) => ({ value: formatMetric(cell.metric, cell.value!), label: cell.label, note: note(cell.metric)?.text ?? null })),
        durationSeconds,
        spans: me.report?.spans ?? [],
        goals: (replay?.goals ?? []).map((goal) => ({
          at: goal.atSeconds,
          colour: goal.side ? room.teams[goal.side]?.color ?? "#8A93A6" : "#8A93A6",
          mine: goal.scorer?.playerId === me.playerId || [...mineGoals].some((at) => Math.abs(at - goal.atSeconds) < 20),
        })),
        timelineCaption: r.timelineCaption(Math.round((me.minutes ?? 0)), Math.round(durationSeconds / 60)),
        link: room.url.replace(/^https?:\/\//, ""),
        precision: r.precision,
        rtl: r.locale === "ar",
      });
      const result = await shareOrSaveCard(blob, `replay-${room.code}.png`, r.shareMyNight);
      if (result === "saved") toast({ title: r.shareSaved });
    } catch {
      toast({ title: r.shareFailed, variant: "destructive" });
    } finally {
      setSharing(false);
    }
  };

  return (
    <Section eyebrow={r.you}>
      {shown.length > 0 ? (
        <div className="grid grid-cols-3 gap-2.5">
          {shown.map((cell) => {
            const n = note(cell.metric);
            return <BigStat key={cell.metric} value={formatMetric(cell.metric, cell.value!)} label={cell.label} note={n?.text} noteTone={n?.tone} />;
          })}
        </div>
      ) : null}
      {totals.length > 0 && (
        <p className="text-xs leading-5 text-muted-text">
          {totals.join(" · ")}{formText ? `. ${formText}` : ""}
        </p>
      )}
      {pbs.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {pbs.map((label) => (
            <span key={label} className="rounded-full border border-floodlight/40 px-2.5 py-1 text-[11px] font-semibold text-floodlight">{r.personalBest} · {label}</span>
          ))}
        </div>
      )}
      <button
        type="button"
        disabled={sharing}
        onClick={() => void share()}
        className="flex min-h-10 items-center justify-center gap-2 self-start rounded-full border border-line px-4 text-sm font-semibold text-text disabled:opacity-60"
        data-testid="button-share-my-night"
      >
        {sharing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Share2 className="h-4 w-4" />}
        {sharing ? r.shareMaking : r.shareMyNight}
      </button>
    </Section>
  );
}

/* ------------------------------------------------------------------ everyone */

const STRIP_METRICS: ReportMetric[] = ["distanceRate", "topSpeed", "touchRate"];

function stripLabel(r: R, metric: ReportMetric): string {
  return metric === "distanceRate" ? r.distanceRate : metric === "topSpeed" ? r.topSpeed : r.touchRate;
}

export function EveryoneSection({ players, meId, r }: { players: PlayerStats[]; meId: number | null; r: R }) {
  const [open, setOpen] = useState<ReportMetric | null>(null);
  const claimed = players.filter((player) => player.claimed);
  const unclaimed = players.filter((player) => !player.claimed).length;
  const strips = STRIP_METRICS.map((metric) => {
    const table = standings(claimed, metric);
    if (table.length < 2) return null;
    const me = table.find((entry) => entry.player.playerId === meId) ?? null;
    const top = table.find((entry) => entry.ranked) ?? null;
    const values = table.map((entry) => entry.value);
    const unit = UNITS[metric];
    return {
      metric,
      dots: table.filter((entry) => entry.player.playerId !== meId).map((entry) => ({ id: entry.player.playerId, value: entry.value, ranked: entry.ranked })),
      you: me?.value ?? null,
      bandHalfWidth: me ? band(metric, me.value) : null,
      leader: top ? { name: top.player.playerId === meId ? r.you : firstName(top.player.name), value: top.value } : null,
      range: `${formatMetric(metric, Math.min(...values))} – ${formatMetric(metric, Math.max(...values))}${unit ? ` ${unit}` : ""}`,
    };
  }).filter((strip): strip is NonNullable<typeof strip> => strip !== null);
  if (!strips.length) return null;
  return (
    <Section eyebrow={r.everyone} aside={r.tapALine}>
      <div className="flex flex-col gap-4">
        {strips.map((strip) => (
          <StripPlot
            key={strip.metric}
            label={stripLabel(r, strip.metric)}
            range={<Num>{strip.range}</Num>}
            dots={strip.dots}
            you={strip.you}
            bandHalfWidth={strip.bandHalfWidth}
            leader={strip.leader}
            onOpen={() => setOpen(strip.metric)}
          />
        ))}
      </div>
      <p className="text-xs leading-5 text-muted-text">{r.stripCaption}</p>
      {unclaimed > 0 && <p className="text-xs text-muted-text">{r.notOnLineYet(unclaimed)}</p>}
      <LadderSheet metric={open} onClose={() => setOpen(null)} players={claimed} meId={meId} r={r} unclaimed={unclaimed} />
    </Section>
  );
}

/**
 * One stat, everyone on a vertical axis (M2). Names alternate sides so close
 * values don't collide; each side is pushed apart just enough to read, and
 * the dot stays at the true value.
 */
function LadderSheet({ metric, onClose, players, meId, r, unclaimed }: {
  metric: ReportMetric | null;
  onClose: () => void;
  players: PlayerStats[];
  meId: number | null;
  r: R;
  unclaimed: number;
}) {
  const [mode, setMode] = useState<"rate" | "total">("rate");
  const effective: ReportMetric | null = metric === null
    ? null
    : mode === "total" && metric === "distanceRate" ? "distance" : mode === "total" && metric === "touchRate" ? "touches" : metric;
  const table = effective ? standings(players, effective) : [];
  const height = Math.max(320, table.length * 44);
  const values = table.map((entry) => entry.value);
  const min = values.length ? Math.min(...values) : 0;
  const max = values.length ? Math.max(...values) : 1;
  const span = Math.max(max - min, 1e-9);
  const y = (value: number) => 16 + (1 - (value - min) / span) * (height - 32);
  const me = table.find((entry) => entry.player.playerId === meId) ?? null;
  const placed = useMemo(() => {
    const sides: Array<Array<{ index: number; y: number }>> = [[], []];
    table.forEach((entry, index) => sides[index % 2].push({ index, y: y(entry.value) }));
    const out = new Map<number, number>();
    for (const side of sides) {
      let last = -Infinity;
      for (const item of side.sort((a, b) => a.y - b.y)) {
        const at = Math.max(item.y, last + 30);
        out.set(item.index, at);
        last = at;
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effective, players, height]);
  const above = me && me.ranked ? table.filter((entry) => entry.ranked && entry.rank < me.rank).at(-1) ?? null : null;
  const level = me && effective ? levelWith(players, effective, me.player.playerId) : [];
  const summary = !me || !effective ? null
    : !above ? r.ladderTop
      : effective === "distanceRate"
        ? r.ladderAhead(firstName(above.player.name), `${formatMetric(effective, above.value - me.value)} km`, Math.round((above.value - me.value) * 1000))
        : r.ladderAheadPlain(firstName(above.player.name), unitGap(effective, above.value - me.value));
  return (
    <Sheet open={metric !== null} onOpenChange={(next) => { if (!next) onClose(); }}>
      <SheetContent side="bottom" dir={r.locale === "ar" ? "rtl" : "ltr"} closeLabel={r.close} className="flex max-h-[92dvh] flex-col overflow-hidden rounded-t-3xl border-line bg-void px-5 pb-6 pt-5 text-text">
        <SheetHeader className="shrink-0 pe-8 text-start">
          <SheetTitle className="font-display text-2xl font-bold">{metric ? r.ladderTitle[metric] : ""}</SheetTitle>
          <SheetDescription className="sr-only">{r.everyone}</SheetDescription>
        </SheetHeader>
        {metric !== "topSpeed" && (
          <div className="mt-3 shrink-0">
            <PillToggle
              value={mode}
              onChange={(value) => {
                if (value === "rate" || value === "total") setMode(value);
              }}
              options={[{ value: "rate", label: r.perTen }, { value: "total", label: r.wholeGame }]}
            />
          </div>
        )}
        <div className="mt-4 flex-1 overflow-y-auto">
          <div dir="ltr" className="relative" style={{ height }}>
            <div className="absolute inset-y-0 left-1/2 w-px bg-[#3A4560]" />
            {me && me.ranked && effective && (() => {
              const b = band(effective, me.value);
              const top = y(me.value + b);
              const bottom = y(me.value - b);
              return (
                <>
                  <div className="absolute inset-x-0 border-y border-dashed border-floodlight/35 bg-floodlight/[0.08]" style={{ top, height: Math.max(2, bottom - top) }} />
                  <span className="absolute right-0 text-[10px] font-semibold uppercase tracking-[0.1em] text-floodlight" style={{ top: top - 14 }}>{r.levelWithYou}</span>
                </>
              );
            })()}
            <span className="absolute left-0 top-0 font-mono text-[10px] text-muted-text">{effective ? unitGap(effective, max) : ""}</span>
            <span className="absolute bottom-0 left-0 font-mono text-[10px] text-muted-text">{effective ? unitGap(effective, min) : ""}</span>
            {table.map((entry, index) => {
              const mine = entry.player.playerId === meId;
              const labelY = placed.get(index) ?? y(entry.value);
              const right = index % 2 === 0;
              const minutes = Math.round(entry.player.minutes ?? 0);
              return (
                <div key={entry.player.playerId}>
                  <span
                    className={cn(
                      "absolute left-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full",
                      mine ? "h-[15px] w-[15px] border-[3px] border-floodlight bg-void" : entry.ranked ? "h-[9px] w-[9px] bg-[#8A93A6]" : "h-[9px] w-[9px] border border-dashed border-[#8A93A6]",
                    )}
                    style={{ top: y(entry.value) }}
                  />
                  <span
                    className={cn("absolute w-[44%] -translate-y-1/2 truncate text-[13px]", right ? "left-[calc(50%+14px)] text-left" : "right-[calc(50%+14px)] text-right", mine ? "font-semibold text-floodlight" : entry.ranked ? "text-text" : "text-muted-text")}
                    style={{ top: labelY }}
                  >
                    {right ? (
                      <>
                        {mine ? r.you : firstName(entry.player.name)} <Num className="text-[15px] font-bold">{formatMetric(effective!, entry.value)}</Num>{" "}
                        <span className="text-[10px] text-muted-text">{entry.ranked ? r.minOnCamera(minutes) : r.notRanked(minutes)}{mine && entry.ranked ? ` · ${entry.shared ? "=" : ""}${r.ordinal(entry.rank)}` : ""}</span>
                      </>
                    ) : (
                      <>
                        <span className="text-[10px] text-muted-text">{entry.ranked ? r.minOnCamera(minutes) : r.notRanked(minutes)}{mine && entry.ranked ? ` · ${entry.shared ? "=" : ""}${r.ordinal(entry.rank)}` : ""}</span>{" "}
                        <Num className="text-[15px] font-bold">{formatMetric(effective!, entry.value)}</Num> {mine ? r.you : firstName(entry.player.name)}
                      </>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
        <div className="mt-3 flex shrink-0 flex-col gap-1.5 border-t border-[#1B2236] pt-3">
          {summary && (
            <p className="text-xs leading-5 text-text">
              {summary}{level.length > 0 && me ? ` ${r.ladderShare(level.map((p) => firstName(p.name)).join(", "), `${me.shared ? "=" : ""}${r.ordinal(me.rank)}`)}` : ""}
            </p>
          )}
          {unclaimed > 0 && <p className="text-[11px] text-muted-text">{r.notOnLineYet(unclaimed)}</p>}
        </div>
      </SheetContent>
    </Sheet>
  );
}

/* ------------------------------------------------------------------ the night */

export function NightSection({ me, r, durationSeconds, room }: { me: PlayerStats; r: R; durationSeconds: number; room: MatchRoom }) {
  const [open, setOpen] = useState(false);
  const report = me.report;
  if (!report || !report.blocks.length) return null;
  const blocks = foldBlocks(report.blocks, durationSeconds);
  const rates = blocks.map((block) => block.metresPerMinute ?? 0);
  const top = Math.max(...rates, 1);
  const pct = (seconds: number) => `${Math.min(100, Math.max(0, (seconds / Math.max(1, durationSeconds)) * 100))}%`;
  const halves = compareHalves(report.blocks, durationSeconds);
  const hasDistance = blocks.some((block) => block.metres !== null);
  return (
    <Section eyebrow={r.yourNight}>
      <div dir="ltr" className="relative">
        <div className="relative h-4">
          {report.goalTimes.map((at, index) => (
            <span key={`g${index}`} title={`${r.yourGoal} ${minuteMark(at)}′`} className="absolute top-0 h-3 w-3 -translate-x-1/2 rounded-full border-[3px] border-floodlight bg-void" style={{ left: pct(at) }} />
          ))}
          {report.topSpeedAt !== null && (
            <span title={`${r.fastestRun} ${minuteMark(report.topSpeedAt)}′`} className="absolute top-0.5 -translate-x-1/2 border-x-[5px] border-t-[8px] border-x-transparent border-t-turf" style={{ left: pct(report.topSpeedAt) }} />
          )}
        </div>
        <div className="flex h-[96px] items-end gap-1">
          {blocks.map((block) => (
            <div key={block.index} className="flex h-full flex-1 flex-col justify-end" title={`${Math.round(block.from / 60)}–${Math.round(block.to / 60)}′`}>
              {block.onCamera && block.metresPerMinute !== null ? (
                <div className="rounded-t-[3px] bg-floodlight" style={{ height: `${Math.max(4, (block.metresPerMinute / top) * 100)}%` }} />
              ) : (
                <div className="h-[6px] rounded-[2px] bg-[#232C42]" title={r.offCamera} />
              )}
            </div>
          ))}
        </div>
        <div className="relative mt-2 h-3" aria-label={r.touchesRow}>
          {report.touchTimes.map((at, index) => (
            <span key={index} className="absolute top-0 h-3 w-px bg-[#8A93A6]" style={{ left: pct(at) }} />
          ))}
        </div>
        <div className="mt-1 flex justify-between font-mono text-[10px] text-muted-text">
          <span>0′</span><span>{Math.round(durationSeconds / 120)}′</span><span>{Math.round(durationSeconds / 60)}′</span>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-text">
        {hasDistance && <span className="flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-sm bg-floodlight" />{r.metresPerMin}</span>}
        <span className="flex items-center gap-1.5"><i className="h-1.5 w-2.5 rounded-sm bg-[#232C42]" />{r.offCamera}</span>
        <span className="flex items-center gap-1.5"><i className="h-2.5 w-px bg-[#8A93A6]" />{r.touchesRow}</span>
        {report.topSpeedAt !== null && <span className="flex items-center gap-1.5"><i className="border-x-[4px] border-t-[6px] border-x-transparent border-t-turf" />{r.fastestRun}</span>}
      </div>
      {halves && (
        <p className="text-xs leading-5 text-text">
          {halves.level ? r.halvesLevel : halves.change < 0 ? r.halvesDown(Math.round(-halves.change * 100)) : r.halvesUp(Math.round(halves.change * 100))}
        </p>
      )}
      <button type="button" onClick={() => setOpen(true)} className="self-start text-sm font-semibold text-turf">{r.openMinutes} ›</button>
      <MinutesSheet open={open} onClose={() => setOpen(false)} me={me} r={r} durationSeconds={durationSeconds} room={room} />
    </Section>
  );
}

function MinutesSheet({ open, onClose, me, r, durationSeconds, room }: { open: boolean; onClose: () => void; me: PlayerStats; r: R; durationSeconds: number; room: MatchRoom }) {
  if (!me.report) return null;
  const rows = fiveMinuteRows(me.report, durationSeconds);
  const top = Math.max(...rows.map((row) => (row.onCamera && row.metres !== null ? row.metres / (row.seconds / 60) : 0)), 1);
  const halves = compareHalves(me.report.blocks, durationSeconds);
  return (
    <Sheet open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <SheetContent side="bottom" dir={r.locale === "ar" ? "rtl" : "ltr"} closeLabel={r.close} className="flex max-h-[92dvh] flex-col overflow-hidden rounded-t-3xl border-line bg-void px-5 pb-6 pt-5 text-text">
        <SheetHeader className="shrink-0 pe-8 text-start">
          <SheetTitle className="font-display text-2xl font-bold">{r.minutesTitle}</SheetTitle>
          <SheetDescription className="sr-only">{r.yourNight}</SheetDescription>
        </SheetHeader>
        <div className="mt-3 grid shrink-0 grid-cols-[3rem_1fr_5rem_4.5rem] gap-2 border-b border-[#1B2236] pb-2 text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-text rtl:tracking-normal">
          {r.minutesHead.map((head) => <span key={head}>{head}</span>)}
        </div>
        <div className="flex-1 overflow-y-auto">
          {rows.map((row) => {
            const rate = row.onCamera && row.metres !== null ? row.metres / (row.seconds / 60) : null;
            const events = [
              ...row.goals.map((at) => ({ at, label: r.momentGoal, lime: true })),
              ...row.dribbles.map((at) => ({ at, label: r.momentDribble, lime: false })),
              ...(row.fastest && me.report!.topSpeedAt !== null ? [{ at: me.report!.topSpeedAt, label: `${r.fastestRun} ${Math.round(me.topSpeedKmh ?? 0)} km/h`, lime: false }] : []),
            ].sort((a, b) => a.at - b.at);
            return (
              <div key={row.index} className={cn("grid min-h-11 grid-cols-[3rem_1fr_5rem_4.5rem] items-center gap-2 border-b border-[#1B2236] py-1.5 text-xs", !row.onCamera && "text-muted-text/60", row.goals.length > 0 && "bg-floodlight/[0.06]")}>
                <Num className="font-bold">{Math.round(row.from / 60)}′</Num>
                <span className="flex min-w-0 flex-wrap gap-x-2 gap-y-0.5">
                  {!row.onCamera ? <span>{r.offCamera}</span> : events.map((event, index) => {
                    const href = watchHref(room, event.at);
                    const text = <><Num>{clock(event.at)}</Num> {event.label}</>;
                    return href
                      ? <Link key={index} href={href} className={cn("font-semibold", event.lime ? "text-floodlight" : "text-turf")}>{text}</Link>
                      : <span key={index} className={event.lime ? "text-floodlight" : "text-text"}>{text}</span>;
                  })}
                </span>
                <span className="h-2 overflow-hidden rounded-full bg-[#1B2236]" dir="ltr">
                  {rate !== null && <span className="block h-full rounded-full bg-floodlight" style={{ width: `${(rate / top) * 100}%` }} />}
                </span>
                <span dir="ltr" className="relative h-3">
                  {row.touchTimes.map((at, index) => (
                    <span key={index} className="absolute top-0 h-3 w-px bg-[#8A93A6]" style={{ left: `${((at - row.from) / 300) * 100}%` }} />
                  ))}
                </span>
              </div>
            );
          })}
        </div>
        {halves && (
          <p className="mt-3 shrink-0 text-xs text-muted-text">
            {r.halvesSummary(Math.round(halves.first), Math.round(halves.second))}
          </p>
        )}
      </SheetContent>
    </Sheet>
  );
}

/* ------------------------------------------------------------------ moments */

export function MomentsSection({ me, room, r }: { me: PlayerStats; room: MatchRoom; r: R }) {
  const report = me.report;
  if (!report) return null;
  const tiles = [
    ...report.goalTimes.map((at) => ({ at, label: r.momentGoal, lime: true })),
    ...(report.topSpeedAt !== null && me.topSpeedKmh !== null ? [{ at: report.topSpeedAt, label: r.momentSpeed(Math.round(me.topSpeedKmh)), lime: false }] : []),
    ...report.dribbleWonTimes.map((at) => ({ at, label: r.momentDribble, lime: false })),
  ].sort((a, b) => a.at - b.at).slice(0, 12);
  if (!tiles.length) return null;
  return (
    <Section eyebrow={r.moments}>
      <div className="no-scrollbar -mx-4 flex gap-2.5 overflow-x-auto px-4 pb-1">
        {tiles.map((tile, index) => {
          const href = watchHref(room, tile.at);
          const body = (
            <>
              <span className={cn("font-display text-[11px] font-bold uppercase tracking-[0.12em] rtl:tracking-normal", tile.lime ? "text-floodlight" : "text-turf")}>{tile.label}</span>
              <Num className="text-2xl font-bold leading-none">{clock(tile.at)}</Num>
              {href && <Play className="absolute end-3 top-3 h-3.5 w-3.5 fill-current text-muted-text" />}
            </>
          );
          const cls = "relative flex h-[92px] w-[132px] shrink-0 flex-col justify-between rounded-xl border border-line bg-surface p-3";
          return href ? <Link key={index} href={href} className={cls}>{body}</Link> : <div key={index} className={cls}>{body}</div>;
        })}
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------ rival */

function rivalLabel(r: R, metric: ReportMetric): string {
  switch (metric) {
    case "distanceRate": return r.distanceRate;
    case "topSpeed": return r.topSpeed;
    case "touchRate": return r.touchRate;
    case "passes": return r.passesMetric;
    case "dribblesWon": return r.dribblesMetric;
    default: return r.goalsMetric;
  }
}

export function RivalSection({ players, meId, room, r }: { players: PlayerStats[]; meId: number | null; room: MatchRoom; r: R }) {
  const claimed = players.filter((player) => player.claimed);
  const me = claimed.find((player) => player.playerId === meId) ?? null;
  const [leftId, setLeftId] = useState<number | null>(null);
  const [rightId, setRightId] = useState<number | null>(null);
  const [sheet, setSheet] = useState(false);
  if (claimed.length < 2) return null;
  const left = me ?? claimed.find((player) => player.playerId === leftId) ?? claimed[0];
  const fallbackRight = me ? defaultRival(claimed, me.playerId) : claimed.find((player) => player.playerId !== left.playerId) ?? null;
  const right = claimed.find((player) => player.playerId === rightId && player.playerId !== left.playerId) ?? fallbackRight;
  if (!right) return null;
  const rows = rivalRows(left, right).filter((row) => row.mine !== null && row.theirs !== null);
  const score = tally(rows);
  const leftName = me ? r.you : firstName(left.name);
  const rightName = firstName(right.name);
  const avatar = (id: number) => room.players.find((player) => player.id === id);
  const picker = (value: number, others: PlayerStats[], onPick: (id: number) => void, tone: "lime" | "violet") => (
    <div className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4 pb-1">
      {others.map((player) => {
        const selected = player.playerId === value;
        const info = avatar(player.playerId);
        return (
          <button key={player.playerId} type="button" onClick={() => onPick(player.playerId)} aria-pressed={selected} className="flex w-14 shrink-0 flex-col items-center gap-1">
            <PlayerAvatar name={player.name} initials={info?.initials} avatarUrl={info?.avatarUrl} size={40} ring={selected ? (tone === "lime" ? "#D4FF4F" : "#7B5CFF") : undefined} />
            <span className={cn("w-full truncate text-center text-[10px]", selected ? "font-semibold text-text" : "text-muted-text")}>{firstName(player.name)}</span>
          </button>
        );
      })}
    </div>
  );
  return (
    <Section eyebrow={me ? <>{r.youAgainst} <span className="normal-case tracking-normal" style={{ color: "#A98CFF" }}>{rightName}</span></> : r.compareTwo}>
      {!me && picker(left.playerId, claimed, (id) => { setLeftId(id); if (id === right.playerId) setRightId(null); }, "lime")}
      {picker(right.playerId, claimed.filter((player) => player.playerId !== left.playerId), setRightId, "violet")}
      <div className="flex flex-col gap-3">
        {rows.map((row) => {
          const all = claimed.map((player) => metricValue(player, row.metric)).filter((value): value is number => value !== null);
          const lo = Math.min(...all, row.mine!, row.theirs!);
          const hi = Math.max(...all, row.mine!, row.theirs!);
          const at = (value: number) => `${hi - lo < 1e-9 ? 50 : 6 + ((value - lo) / (hi - lo)) * 88}%`;
          const a = at(row.mine!);
          const b = at(row.theirs!);
          return (
            <div key={row.metric} className="flex flex-col gap-1">
              <div className="flex items-baseline justify-between gap-2 text-[13px]">
                <span className="text-text">{rivalLabel(r, row.metric)}</span>
                <span className="text-xs text-muted-text">
                  {row.outcome === "level" ? <span className="font-semibold text-text">{r.level} · </span> : null}
                  <Num className={row.outcome === "you" ? "font-bold text-floodlight" : ""}>{formatMetric(row.metric, row.mine!)}</Num>
                  {" · "}
                  <Num className={row.outcome === "them" ? "font-bold" : ""}><span style={{ color: row.outcome === "them" ? "#A98CFF" : undefined }}>{formatMetric(row.metric, row.theirs!)}</span></Num>
                </span>
              </div>
              <div dir="ltr" className="relative h-4">
                <div className="absolute inset-x-0 top-[7px] h-px bg-[#232C42]" />
                <div className="absolute top-[6px] h-[3px] bg-[#3A4560]" style={{ left: row.mine! < row.theirs! ? a : b, width: `calc(${row.mine! < row.theirs! ? b : a} - ${row.mine! < row.theirs! ? a : b})` }} />
                <span className="absolute top-[2px] h-3 w-3 -translate-x-1/2 rounded-full" style={{ left: b, background: "#7B5CFF" }} />
                <span className="absolute top-[1px] h-[14px] w-[14px] -translate-x-1/2 rounded-full border-[3px] border-floodlight bg-void" style={{ left: a }} />
              </div>
            </div>
          );
        })}
      </div>
      <p className="font-display text-sm font-bold text-text">
        {me ? r.tallyLine(score.you, score.level, score.them, rightName) : r.tallyLineTwo(leftName, score.you, score.level, rightName, score.them)}
      </p>
      <button type="button" onClick={() => setSheet(true)} className="self-start text-sm font-semibold text-turf">{r.moreComparison} ›</button>
      <RivalSheet open={sheet} onClose={() => setSheet(false)} left={left} right={right} leftName={leftName} rightName={rightName} r={r} />
    </Section>
  );
}

function RivalSheet({ open, onClose, left, right, leftName, rightName, r }: {
  open: boolean; onClose: () => void; left: PlayerStats; right: PlayerStats; leftName: string; rightName: string; r: R;
}) {
  const rows = rivalRows(left, right, [...RIVAL_METRICS, "goals"]).filter((row) => row.mine !== null && row.theirs !== null);
  const score = tally(rows);
  const heat = (player: PlayerStats) => (player.report?.heatmap ? foldHeat(player.report.heatmap.weights, player.report.heatmap.columns, player.report.heatmap.rows, [6, 4]) : null);
  return (
    <Sheet open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <SheetContent side="bottom" dir={r.locale === "ar" ? "rtl" : "ltr"} closeLabel={r.close} className="flex max-h-[92dvh] flex-col overflow-y-auto rounded-t-3xl border-line bg-void px-5 pb-6 pt-5 text-text">
        <SheetHeader className="pe-8 text-start">
          <SheetTitle className="font-display text-2xl font-bold">{leftName} · <span style={{ color: "#A98CFF" }}>{rightName}</span></SheetTitle>
          <SheetDescription className="text-xs text-muted-text">{r.methodsLevel}</SheetDescription>
        </SheetHeader>
        <div className="mt-4 flex flex-col gap-3.5">
          {rows.map((row) => (
            <div key={row.metric} className="flex flex-col gap-1">
              <div className="grid grid-cols-[4rem_1fr_4rem] items-baseline text-[13px]" dir="ltr">
                <Num className={cn(row.outcome === "you" ? "font-bold text-floodlight" : "text-muted-text")}>{formatMetric(row.metric, row.mine!)}</Num>
                <span className="text-center text-xs text-muted-text">{rivalLabel(r, row.metric)}</span>
                <Num className={cn("text-end", row.outcome === "them" ? "font-bold" : "text-muted-text")}><span style={{ color: row.outcome === "them" ? "#A98CFF" : undefined }}>{formatMetric(row.metric, row.theirs!)}</span></Num>
              </div>
              <div dir="ltr" className="relative grid h-2.5 grid-cols-2 gap-px">
                <div className="flex justify-end overflow-hidden rounded-s-full bg-[#1B2236]">
                  {row.outcome === "you" && <i className="block h-full rounded-s-full bg-floodlight" style={{ width: `${Math.max(6, row.beyond * 100)}%` }} />}
                </div>
                <div className="flex overflow-hidden rounded-e-full bg-[#1B2236]">
                  {row.outcome === "them" && <i className="block h-full rounded-e-full" style={{ width: `${Math.max(6, row.beyond * 100)}%`, background: "#7B5CFF" }} />}
                </div>
                {row.outcome === "level" && <span className="absolute inset-0 flex items-center justify-center text-[9px] font-bold uppercase tracking-[0.1em] text-muted-text">{r.level}</span>}
              </div>
            </div>
          ))}
        </div>
        <p className="mt-4 font-display text-base font-bold">{r.tallyLineTwo(leftName, score.you, score.level, rightName, score.them)}</p>
        <div className="mt-5 flex flex-col gap-2">
          <p className="font-display text-[11px] font-bold uppercase tracking-[0.3em] text-turf rtl:tracking-normal">{r.whereYouPlayed}</p>
          <div className="grid grid-cols-2 gap-3">
            <HeatGrid weights={heat(left)} columns={6} rows={4} colour="#2FD8C4" label={leftName} />
            <HeatGrid weights={heat(right)} columns={6} rows={4} colour="#7B5CFF" label={rightName} />
          </div>
          <p className="text-[11px] text-muted-text">{heat(left) || heat(right) ? r.heatNote : r.heatNone}</p>
        </div>
      </SheetContent>
    </Sheet>
  );
}

/* ------------------------------------------------------------------ stood out */

export function StoodOutSection({ players, meId, room, r }: { players: PlayerStats[]; meId: number | null; room: MatchRoom; r: R }) {
  const claimed = players.filter((player) => player.claimed);
  const name = (player: ReportPlayer) => (player.playerId === meId ? r.you : firstName(player.name));
  const rows: Array<{ key: string; label: string; who: string; value: string; note: string | null; mine: boolean }> = [];
  const motm = room.vote.closed ? room.players.filter((player) => room.vote.winners.includes(player.id)) : [];
  if (motm.length) {
    rows.push({ key: "motm", label: r.motmWinner, who: motm.map((player) => (player.id === meId ? r.you : firstName(player.name))).join(", "), value: "", note: null, mine: motm.some((player) => player.id === meId) });
  }
  const pick: Array<[ReportMetric, number]> = [["distanceRate", 0], ["topSpeed", 0], ["touchRate", 0], ["dribblesWon", 2]];
  for (const [metric, minimum] of pick) {
    const out = standOut(claimed, metric, minimum);
    if (!out) continue;
    const unit = UNITS[metric];
    rows.push({
      key: metric,
      label: r.standOut[metric],
      who: out.winners.map(name).join(", "),
      value: `${formatMetric(metric, out.value)}${unit ? ` ${unit}` : ""}${metric === "distanceRate" || metric === "touchRate" ? " /10′" : ""}`,
      note: out.clearBy !== null && out.clearBy > 0 ? r.clearBy(unitGap(metric, out.clearBy)) : out.winners.length > 1 ? r.sharedTop : null,
      mine: out.winners.some((player) => player.playerId === meId),
    });
  }
  const scorers = claimed.filter((player) => (player.goals ?? 0) > 0).sort((a, b) => (b.goals ?? 0) - (a.goals ?? 0));
  if (scorers.length) {
    rows.push({
      key: "goals",
      label: r.standOut.goals,
      who: scorers.map((player) => `${name(player)}${(player.goals ?? 0) > 1 ? ` ×${player.goals}` : ""}`).join(", "),
      value: "",
      note: null,
      mine: scorers.some((player) => player.playerId === meId),
    });
  }
  if (!rows.length) return null;
  const counted = claimed.filter((player) => (player.minutes ?? 0) >= 10).length;
  const total = Math.max(room.players.filter((player) => player.rsvp === "in").length, claimed.length);
  return (
    <Section eyebrow={r.stoodOut}>
      <ul className="flex flex-col divide-y divide-[#1B2236]">
        {rows.map((row) => (
          <li key={row.key} className="flex items-baseline gap-3 py-2.5">
            <span className="w-[38%] shrink-0 text-xs text-muted-text">{row.label}</span>
            <span className={cn("min-w-0 flex-1 truncate text-sm font-semibold", row.mine ? "text-floodlight" : "text-text")}>{row.who}</span>
            <span className="shrink-0 text-end">
              {row.value && <Num className="block text-sm font-bold">{row.value}</Num>}
              {row.note && <span className="block text-[10px] text-muted-text">{row.note}</span>}
            </span>
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted-text">{r.enoughToCount(counted, total)}</p>
    </Section>
  );
}

/* ------------------------------------------------------------------ the sides */

export function TwoSidesSection({ room, r, copy, whole, players }: {
  room: MatchRoom;
  r: R;
  copy: Copy;
  whole: TeamStats | null;
  players: PlayerStats[] | null;
}) {
  const { user } = useAuth();
  const [gameId, setGameId] = useState<number | null>(null);
  const gameQuery = useMatchStatsData(room, user?.id ?? null, gameId, gameId !== null);
  const t = gameId === null ? whole : gameQuery.data?.team ?? null;
  const game = gameId === null ? null : room.games.find((item) => item.id === gameId) ?? null;
  const sideX: TeamSide = game?.teamX ?? "A";
  const sideY: TeamSide = game?.teamY ?? "B";
  const name = (side: string) => room.teams[side as TeamSide]?.name || side;
  const colour = (side: string) => visibleColour(room.teams[side as TeamSide]?.color);
  const pct = (x: number, y: number) => (y > 0 ? Math.round((100 * x) / y) : 0);
  const three = gameId === null && room.teamCount === 3 && Boolean(t && t.sides.length >= 3);
  if (!t && gameId === null) return null;
  const claimed = (players ?? []).filter((player) => player.claimed);
  const km = (side: TeamSide) => claimed.filter((player) => player.team === side).reduce((sum, player) => sum + (player.distanceKm ?? 0), 0);
  const rows: Array<{ label: string; values: number[]; format: (value: number) => string }> = t ? [
    ...(t.goals && t.goals.some((value) => value > 0) ? [{ label: r.goalsRow, values: t.goals, format: (v: number) => String(Math.round(v)) }] : []),
    ...(t.shots ? [{ label: r.shots, values: t.shots, format: (v: number) => String(Math.round(v)) }] : []),
    { label: r.possession, values: t.possessionPercent, format: (v: number) => `${Math.round(v)}%` },
    { label: r.passesCompleted, values: t.passesCompleted, format: (v: number) => String(Math.round(v)) },
    { label: r.passAccuracy, values: t.passesCompleted.map((value, index) => pct(value, t.passesTried[index] ?? 0)), format: (v: number) => `${v}%` },
    ...(t.dribblesWon ? [{ label: r.dribbles, values: t.dribbles ?? t.dribblesWon, format: (v: number) => String(Math.round(v)) }] : []),
    { label: r.touches, values: t.touches, format: (v: number) => String(Math.round(v)) },
  ] : [];
  const sides = three ? t!.sides.slice(0, 3) : [sideX, sideY];
  const showKm = gameId === null && !three && (km("A") > 0 || km("B") > 0);
  return (
    <Section eyebrow={three ? r.threeSides : r.twoSides}>
      {room.games.length >= 2 && (
        <div className="no-scrollbar -mx-4 flex gap-1.5 overflow-x-auto px-4" dir="ltr" data-testid="stats-game-filters">
          <button type="button" onClick={() => setGameId(null)} className={cn("shrink-0 rounded-full border px-3 py-1.5 text-xs font-semibold", gameId === null ? "border-turf text-turf" : "border-line text-muted-text")} data-testid="button-stats-whole-session">{r.wholeSession}</button>
          {room.games.map((item, index) => (
            <button key={item.id} type="button" onClick={() => setGameId(item.id)} className={cn("shrink-0 rounded-full border px-3 py-1.5 text-xs font-semibold", gameId === item.id ? "border-turf text-turf" : "border-line text-muted-text")} data-testid={`button-stats-game-${item.id}`}>
              {r.gameN(index + 1, Math.round(item.startOffsetSec / 60), Math.round(item.endOffsetSec / 60))} · {name(item.teamX)} {copy.vs} {name(item.teamY)}
            </button>
          ))}
        </div>
      )}
      {gameId !== null && gameQuery.isLoading && <Loader2 className="mx-auto h-5 w-5 animate-spin text-muted-text" />}
      {t && (
        three ? (
          <div className="overflow-x-auto" data-testid="stats-three-team-table">
            <table className="w-full min-w-[320px] text-xs">
              <thead>
                <tr className="border-b border-[#1B2236] text-muted-text">
                  <th className="py-2 text-start font-semibold" />
                  {sides.map((side) => <th key={side} className="py-2 text-end font-semibold"><span className="inline-flex items-center gap-1.5"><i className="h-2 w-2 rounded-full" style={{ background: colour(side) }} />{name(side)}</span></th>)}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.label} className="border-b border-[#1B2236] last:border-0">
                    <th className="py-2 text-start font-normal text-muted-text">{row.label}</th>
                    {row.values.slice(0, 3).map((value, index) => <td key={index} className="py-2 text-end"><Num className="font-bold">{row.format(value)}</Num></td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 text-sm font-semibold" dir="ltr">
              <span className="flex min-w-0 items-center gap-2"><i className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: colour(sideX) }} /><span className="truncate">{name(sideX)}</span></span>
              <span />
              <span className="flex min-w-0 items-center justify-end gap-2"><span className="truncate">{name(sideY)}</span><i className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: colour(sideY) }} /></span>
            </div>
            {[...rows, ...(showKm ? [{ label: r.groundCovered, values: [km("A"), km("B")], format: (v: number) => `${v.toFixed(1)} km` }] : [])].map((row) => {
              const [a, b] = [row.values[0] ?? 0, row.values[1] ?? 0];
              const total = a + b;
              return (
                <div key={row.label} className="flex flex-col gap-1">
                  <div className="grid grid-cols-[4.5rem_1fr_4.5rem] items-baseline text-[13px]" dir="ltr">
                    <Num className={cn(a > b ? "font-bold text-text" : "text-muted-text")}>{row.format(a)}</Num>
                    <span className="text-center text-xs text-muted-text">{row.label}</span>
                    <Num className={cn("text-end", b > a ? "font-bold text-text" : "text-muted-text")}>{row.format(b)}</Num>
                  </div>
                  <div dir="ltr" className="flex h-1 overflow-hidden rounded-full bg-[#1B2236]">
                    {total > 0 && <>
                      <i className="block h-full" style={{ width: `${(a / total) * 100}%`, background: colour(sideX), opacity: 0.85 }} />
                      <i className="block h-full" style={{ width: `${(b / total) * 100}%`, background: colour(sideY), opacity: 0.85 }} />
                    </>}
                  </div>
                </div>
              );
            })}
            {showKm && <p className="text-[11px] text-muted-text">{r.claimedOnly}</p>}
          </div>
        )
      )}
    </Section>
  );
}

/* ------------------------------------------------------------------ disclosure */

export function Disclosure({ title, children, defaultOpen = false, testId }: { title: string; children: React.ReactNode; defaultOpen?: boolean; testId?: string }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-b border-[#1B2236]" data-testid={testId}>
      <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open} className="flex min-h-12 w-full items-center justify-between gap-3 py-3 text-start">
        <span className="font-display text-[11px] font-bold uppercase tracking-[0.3em] text-muted-text rtl:tracking-normal rtl:text-xs">{title}</span>
        <ChevronDown className={cn("h-4 w-4 text-muted-text transition-transform", open && "rotate-180")} />
      </button>
      {open && <div className="flex flex-col gap-4 pb-6">{children}</div>}
    </div>
  );
}
