import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Link } from "wouter";
import { ChevronRight } from "lucide-react";
import { useTileCopy, type TileStrings } from "@/i18n/stat-tile-strings";
import type { StatTile, TileMetric } from "@/lib/stat-tile";
import { cn } from "@/lib/utils";
import { findPath } from "@/lib/find-nav";

/**
 * Home's stat tiles, in the Whoop style: a near-black card of one fixed
 * height, the title and the match along the top, one strong visual with a
 * big number, one sentence, and three supporting numbers along the bottom.
 * The whole card is the link. Each visual draws in once, when the card
 * comes into view.
 *
 * Colour says what kind of number it is: teal is running and effort, lime is
 * on the ball, violet is duels, gold is records and shots, silver is
 * standings and other players. Numbers are always LTR, in Rajdhani; in
 * Arabic the charts run right to left like the text.
 */

type Locale = "en" | "ar";
type Copy = TileStrings & { locale: Locale };

const TEAL = "#2FD8C4";
const LIME = "#D4FF4F";
const VIOLET = "#9B85FF";
const GOLD = "#E9B949";
const SILVER = "#C9CFDA";
const MUTED = "#3A4560";
const TRACK = "#141B2C";

// ---------------------------------------------------------------- formatting

function parts(local: string) {
  return { y: Number(local.slice(0, 4)), m: Number(local.slice(5, 7)), d: Number(local.slice(8, 10)) };
}
function utcNoon(local: string): Date {
  const p = parts(local);
  return new Date(Date.UTC(p.y, p.m - 1, p.d, 12));
}
function daysBetween(a: string, b: string): number {
  return Math.round((utcNoon(b).getTime() - utcNoon(a).getTime()) / 86_400_000);
}
const intl = (locale: Locale) => (locale === "ar" ? "ar-JO" : "en-GB");
function weekday(local: string, locale: Locale, style: "long" | "short" = "long"): string {
  return new Intl.DateTimeFormat(intl(locale), { weekday: style, timeZone: "UTC" }).format(utcNoon(local));
}
function shortDate(local: string, locale: Locale): string {
  return new Intl.DateTimeFormat(intl(locale), { day: "numeric", month: "short", timeZone: "UTC", numberingSystem: "latn" }).format(utcNoon(local));
}
function longDate(local: string, locale: Locale): string {
  return new Intl.DateTimeFormat(intl(locale), { day: "numeric", month: "long", timeZone: "UTC", numberingSystem: "latn" }).format(utcNoon(local));
}
function monthName(month: string, locale: Locale): string {
  return new Intl.DateTimeFormat(intl(locale), { month: "long", timeZone: "UTC" }).format(new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, 15)));
}
/** "Tuesday" for the last week, "14 Sep" before that. */
function dayRef(local: string, nowLocal: string, locale: Locale): string {
  const age = daysBetween(local, nowLocal);
  return age >= 0 && age <= 6 ? weekday(local, locale) : shortDate(local, locale);
}
/** "Tue 20:00" for the last week, "14 Sep 20:00" before that. */
function matchWhen(local: string, nowLocal: string, locale: Locale): string {
  const age = daysBetween(local, nowLocal);
  const day = age >= 0 && age <= 6 ? weekday(local, locale, "short") : shortDate(local, locale);
  return `${day} ${local.slice(11, 16)}`;
}
/** "tonight" / "tomorrow" / "Friday" for a match still to come. */
function whenRef(local: string, nowLocal: string, locale: Locale): string {
  const days = daysBetween(nowLocal, local);
  const hour = Number(local.slice(11, 13));
  if (locale === "ar") return days === 0 ? (hour >= 17 ? "الليلة" : "اليوم") : days === 1 ? "بكرا" : `يوم ${weekday(local, "ar")}`;
  return days === 0 ? (hour >= 17 ? "tonight" : "today") : days === 1 ? "tomorrow" : weekday(local, "en");
}
function nowLocal(): string {
  return new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 16).replace("T", " ");
}
/** 588 → "9′48" */
function minuteMark(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}′${String(s % 60).padStart(2, "0")}`;
}
function value(metric: TileMetric, v: number): string {
  if (metric === "distanceKm") return v.toFixed(1);
  if (metric === "topSpeedKmh") return v.toFixed(1);
  return String(Math.round(v));
}
/** Distance shown with one decimal, rounded down so 4.97 never reads as "5.0, nearly 5 km". */
const km = (v: number) => (Math.floor(v * 10) / 10).toFixed(1);
const pct = (rate: number) => `${Math.round(rate * 100)}%`;
function watchAt(watch: string | null, seconds: number | null): string | null {
  if (!watch) return null;
  return seconds === null ? watch : `${watch}&t=${Math.max(0, Math.round(seconds - 8))}`;
}

// ---------------------------------------------------------------- pieces

function N({ children, className }: { children: ReactNode; className?: string }) {
  return <span dir="ltr" className={cn("tile-num", className)}>{children}</span>;
}

type Foot = { v: string; u?: string; l: string };

/** Starts the card's animations the first time it is mostly on screen. */
function useSeen<T extends Element>() {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    if (typeof IntersectionObserver === "undefined") {
      setSeen(true);
      return;
    }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        setSeen(true);
        io.disconnect();
      }
    }, { threshold: 0.6 });
    io.observe(el);
    return () => io.disconnect();
  }, [seen]);
  return { ref, seen };
}

function Card({ testId, href, title, when, line, foot, children }: { testId: string; href: string | null; title: string; when?: string; line?: ReactNode; foot: Foot[]; children: ReactNode }) {
  const { ref, seen } = useSeen<HTMLDivElement>();
  const body = (
    <>
      <div className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 truncate text-[13px] font-semibold text-text">{title}</span>
        <span className="flex shrink-0 items-center gap-1 text-xs text-muted-text">
          {when}
          {href && <ChevronRight className="h-3.5 w-3.5 rtl:rotate-180" aria-hidden />}
        </span>
      </div>
      <div className="relative mt-2.5 flex h-[236px] flex-col justify-center">{children}</div>
      <p className="mt-2 min-h-[36px] text-[13px] leading-snug text-[#C9CFDA]">{line}</p>
      <div className="mt-auto grid grid-cols-3 gap-2 border-t border-[#141B2C] pt-3">
        {foot.slice(0, 3).map((f, i) => (
          <div key={i} className="min-w-0">
            <p className="truncate text-[22px] font-semibold leading-none text-text"><N>{f.v}</N>{f.u && <span className="ms-1 text-[13px] font-semibold">{f.u}</span>}</p>
            <p className="mt-1 truncate text-[11px] text-muted-text">{f.l}</p>
          </div>
        ))}
      </div>
    </>
  );
  const cls = cn("flex h-[440px] w-full flex-col overflow-hidden rounded-[18px] bg-[#05070C] p-[18px] pb-4 text-text", !seen && "tile-wait");
  return (
    <div ref={ref} className="w-full" data-testid={`stat-tile-${testId}`}>
      {href ? <Link href={href} className={cn(cls, "block focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-floodlight")}>{body}</Link> : <div className={cls}>{body}</div>}
    </div>
  );
}

const RING = 2 * Math.PI * 88;

function Ring({ frac, color, big, sub, tick, dashed, size = 200, children }: { frac: number; color: string; big: ReactNode; sub?: ReactNode; tick?: number; dashed?: boolean; size?: number; children?: ReactNode }) {
  const f = Math.min(1, Math.max(0, frac));
  const a = tick === undefined ? 0 : Math.min(1, Math.max(0, tick)) * 2 * Math.PI - Math.PI / 2;
  return (
    <div className="flex flex-col items-center">
      <div className="relative" style={{ width: size, height: size }}>
        <svg viewBox="0 0 200 200" width={size} height={size} aria-hidden>
          <circle cx="100" cy="100" r="88" fill="none" stroke={TRACK} strokeWidth="12" strokeDasharray={dashed ? "6 8" : undefined} />
          {f > 0 && (
            <circle
              className="tile-arc"
              cx="100" cy="100" r="88" fill="none" stroke={color} strokeWidth="12" strokeLinecap="round"
              transform="rotate(-90 100 100)"
              strokeDasharray={RING}
              style={{ strokeDashoffset: RING * (1 - f), ["--tile-arc-from" as string]: RING } as CSSProperties}
            />
          )}
          {tick !== undefined && <line x1={100 + 76 * Math.cos(a)} y1={100 + 76 * Math.sin(a)} x2={100 + 100 * Math.cos(a)} y2={100 + 100 * Math.sin(a)} stroke="#F2F4F8" strokeWidth="3.5" strokeLinecap="round" />}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center px-8 text-center">
          <span className="text-[56px] font-semibold leading-none tracking-tight"><N>{big}</N></span>
          {sub && <span className="tile-fade mt-1.5 text-xs font-semibold leading-tight" style={{ color }}>{sub}</span>}
        </div>
      </div>
      {children}
    </div>
  );
}

function SmallRing({ frac, color, big, label }: { frac: number; color: string; big: string; label: string }) {
  const C = 2 * Math.PI * 53;
  const f = Math.min(1, Math.max(0, frac));
  return (
    <div className="flex flex-col items-center gap-2">
      <div className="relative h-[130px] w-[130px]">
        <svg viewBox="0 0 130 130" width="130" height="130" aria-hidden>
          <circle cx="65" cy="65" r="53" fill="none" stroke={TRACK} strokeWidth="10" />
          {f > 0 && <circle className="tile-arc" cx="65" cy="65" r="53" fill="none" stroke={color} strokeWidth="10" strokeLinecap="round" transform="rotate(-90 65 65)" strokeDasharray={C} style={{ strokeDashoffset: C * (1 - f), ["--tile-arc-from" as string]: C } as CSSProperties} />}
        </svg>
        <span className="absolute inset-0 flex items-center justify-center text-[34px] font-semibold"><N>{big}</N></span>
      </div>
      <span className="text-xs text-[#C9CFDA]">{label}</span>
    </div>
  );
}

function Headline({ big, unit, sub, color }: { big: string; unit?: string; sub?: ReactNode; color: string }) {
  return (
    <div>
      <p className="flex items-baseline gap-2"><span className="text-[52px] font-semibold leading-none tracking-tight"><N>{big}</N></span>{unit && <span className="font-display text-[22px] font-semibold">{unit}</span>}</p>
      {sub && <p className="tile-fade mt-1 text-xs font-semibold" style={{ color }}>{sub}</p>}
    </div>
  );
}

function Bars({ values, labels, hi, color, format }: { values: number[]; labels?: string[]; hi: number; color: string; format?: (v: number) => string }) {
  const max = Math.max(...values, 1e-9);
  const many = values.length > 8;
  return (
    <div className="mt-3">
      <div className="flex h-[112px] items-end gap-[5px] border-b border-[#1E2740]">
        {values.map((v, i) => (
          <div key={i} className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1">
            {!many && <span className={cn("text-xs font-semibold", i === hi ? "text-text" : "text-muted-text")}><N>{format ? format(v) : v}</N></span>}
            <span className="tile-grow block w-full rounded-t" style={{ height: `${Math.max(3, (v / max) * (many ? 100 : 82))}%`, background: i === hi ? color : "#232C42", animationDelay: `${i * 40}ms` }} />
          </div>
        ))}
      </div>
      {labels && (
        many
          ? <div className="mt-1.5 flex justify-between text-[10px] text-muted-text"><N>{labels[0]}</N><N>{labels.at(-1)}</N></div>
          : <div className="mt-1.5 flex gap-[5px]">{labels.map((l, i) => <span key={i} className="min-w-0 flex-1 truncate text-center text-[10px] text-muted-text"><N>{l}</N></span>)}</div>
      )}
    </div>
  );
}

function LineChart({ values, color, from, to, rtl, note }: { values: number[]; color: string; from: string; to: string; rtl: boolean; note: string }) {
  const W = 294, H = 120;
  const lo = Math.min(...values), hi = Math.max(...values);
  const pad = (hi - lo) * 0.15 || Math.max(1, hi * 0.1);
  const y = (v: number) => H - 8 - ((v - (lo - pad)) / (hi + pad - (lo - pad))) * (H - 16);
  const x = (i: number) => {
    const t = values.length > 1 ? i / (values.length - 1) : 0.5;
    return 10 + (rtl ? 1 - t : t) * (W - 20);
  };
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  const d = values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");
  return (
    <div className="mt-3">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-[120px] w-full" aria-hidden>
        <line x1="0" x2={W} y1={y(avg)} y2={y(avg)} stroke="#2C3650" strokeDasharray="4 4" />
        <path className="tile-draw" pathLength={1} d={d} fill="none" stroke={color} strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" />
        {values.map((v, i) => {
          const last = i === values.length - 1;
          return <circle key={i} cx={x(i)} cy={y(v)} r={last ? 6 : 4} fill={last ? color : MUTED} stroke="#05070C" strokeWidth="2" />;
        })}
      </svg>
      <div className="mt-1 flex justify-between gap-2 text-[10px] text-muted-text"><span>{from}</span><span className="truncate">{note}</span><span>{to}</span></div>
    </div>
  );
}

type Row = { rank?: string; name: string; v: string; n: number; me?: boolean };

function RankList({ rows, color }: { rows: Row[]; color: string }) {
  const max = Math.max(...rows.map((r) => r.n), 1e-9);
  return (
    <div className="flex flex-col gap-3">
      {rows.slice(0, 5).map((r, i) => (
        <div key={i} className="flex flex-col gap-1.5">
          <div className={cn("flex items-baseline gap-2 text-[13px]", r.me ? "font-bold text-text" : "text-[#C9CFDA]")}>
            {r.rank !== undefined && <span className="w-7 shrink-0 text-[15px] font-semibold text-muted-text"><N>{r.rank}</N></span>}
            <span className="min-w-0 flex-1 truncate">{r.name}</span>
            <span className="text-[18px] font-semibold"><N>{r.v}</N></span>
          </div>
          <span className={cn("block h-1.5 rounded-full bg-[#141B2C]", r.rank !== undefined && "ms-9")}>
            <span className="tile-grow-x block h-1.5 rounded-full" style={{ width: `${Math.max(4, (r.n / max) * 100)}%`, background: r.me ? color : MUTED, animationDelay: `${i * 60}ms` }} />
          </span>
        </div>
      ))}
    </div>
  );
}

function Donut({ segs, center }: { segs: Array<{ label: string; n: number; color: string }>; center: string }) {
  const total = Math.max(1, segs.reduce((a, s) => a + s.n, 0));
  const L = 2 * Math.PI * 68;
  let acc = 0;
  return (
    <div className="flex items-center gap-4">
      <div className="relative h-[170px] w-[170px] shrink-0">
        <svg viewBox="0 0 170 170" width="170" height="170" aria-hidden>
          <circle cx="85" cy="85" r="68" fill="none" stroke={TRACK} strokeWidth="18" />
          {segs.map((s) => {
            const len = (L * s.n) / total;
            const el = <circle key={s.label} cx="85" cy="85" r="68" fill="none" stroke={s.color} strokeWidth="18" strokeDasharray={`${Math.max(0, len - 2)} ${L}`} strokeDashoffset={-acc} transform="rotate(-90 85 85)" />;
            acc += len;
            return el;
          })}
        </svg>
        <span className="absolute inset-0 flex items-center justify-center px-6 text-center font-display text-[24px] font-bold leading-tight">{center}</span>
      </div>
      <div className="flex min-w-0 flex-col gap-2.5">
        {segs.map((s) => (
          <span key={s.label} className="flex items-center gap-2 text-xs">
            <span className="h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ background: s.color }} />
            <span className="truncate">{s.label}</span>
            <b className="text-sm"><N>{pct(s.n / total)}</N></b>
          </span>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- tiles

export function StatTileCard({ tile }: { tile: StatTile }) {
  const c = useTileCopy();
  const now = nowLocal();
  switch (tile.kind) {
    case "strain": return <Strain tile={tile} c={c} now={now} />;
    case "lastMatch": return <LastMatch tile={tile} c={c} now={now} />;
    case "personalBest": return <PersonalBest tile={tile} c={c} now={now} />;
    case "rival": return <Rival tile={tile} c={c} now={now} />;
    case "form": return <Form tile={tile} c={c} now={now} />;
    case "notFound": return <NotFound tile={tile} c={c} now={now} />;
    case "passing": return <Passing tile={tile} c={c} now={now} />;
    case "touches": return <Touches tile={tile} c={c} now={now} />;
    case "distanceTotal": return <DistanceTotal tile={tile} c={c} now={now} />;
    case "distanceSpells": return <DistanceSpells tile={tile} c={c} now={now} />;
    case "ranks": return <Ranks tile={tile} c={c} now={now} />;
    case "style": return <Style tile={tile} c={c} now={now} />;
    case "challenge": return <Challenge tile={tile} c={c} now={now} />;
    case "dribbles": return <Dribbles tile={tile} c={c} now={now} />;
    case "matchesPlayed": return <MatchesPlayed tile={tile} c={c} now={now} />;
    case "shots": return <Shots tile={tile} c={c} now={now} />;
    case "passingTrend": return <PassingTrend tile={tile} c={c} now={now} />;
    case "teamShare": return <TeamShare tile={tile} c={c} now={now} />;
    case "dribbleDuel": return <DribbleDuel tile={tile} c={c} now={now} />;
    case "week": return <Week tile={tile} c={c} now={now} />;
    case "friends": return <Friends tile={tile} c={c} now={now} />;
    case "unclaimed": return <Unclaimed tile={tile} c={c} now={now} />;
    default: return null;
  }
}

type P<K extends StatTile["kind"]> = { tile: Extract<StatTile, { kind: K }>; c: Copy; now: string };

const report = (code: string) => `/m/${code}`;

function Strain({ tile, c, now }: P<"strain">) {
  const s = c.strain;
  const prev = tile.previous;
  const line = prev === null ? s.first : Math.abs(tile.strain - prev) < 0.3 ? s.same : tile.strain > prev ? s.harder(prev.toFixed(1)) : s.easier(prev.toFixed(1));
  const zones: Array<[keyof typeof s.zone, number]> = [["light", 10], ["moderate", 4], ["high", 4], ["allOut", 3]];
  return (
    <Card testId="strain" href={report(tile.match.code)} title={s.title} when={matchWhen(tile.match.startLocal, now, c.locale)} line={line}
      foot={[{ v: String(tile.calories), l: s.calories }, { v: km(tile.distanceKm), u: c.units.distanceKm, l: s.run }, { v: String(tile.minutes), u: c.min, l: s.played }]}>
      <Ring frac={tile.strain / 21} color={TEAL} big={tile.strain.toFixed(1)} sub={s.zone[tile.zone]} size={176}>
        <div className="mt-3 w-full">
          <div className="relative grid h-1.5 grid-cols-[10fr_4fr_4fr_3fr] gap-[3px]">
            {zones.map(([z]) => <span key={z} className="rounded-sm" style={{ background: z === tile.zone ? TEAL : "#1E3A44" }} />)}
            <span className="absolute -top-1 h-3.5 w-1 rounded-full bg-text" style={{ insetInlineStart: `calc(${(tile.strain / 21) * 100}% - 2px)` }} />
          </div>
          <div className="mt-1.5 grid grid-cols-[10fr_4fr_4fr_3fr] gap-[3px] text-[10px] text-muted-text">
            {zones.map(([z]) => <span key={z} className={cn("truncate", z === tile.zone && "text-text")}>{s.zoneShort[z]}</span>)}
          </div>
        </div>
      </Ring>
    </Card>
  );
}

function PersonalBest({ tile, c, now }: P<"personalBest">) {
  const b = c.best;
  const run = tile.metric === "topSpeedKmh";
  const scale = tile.value * 1.18;
  const diff = tile.value - tile.previousBest;
  const watch = run ? watchAt(tile.match.watch, tile.at) : null;
  const foot: Foot[] = run
    ? [{ v: value(tile.metric, tile.previousBest), u: c.units.topSpeedKmh, l: b.old }, { v: `+${diff.toFixed(1)}`, u: c.units.topSpeedKmh, l: b.faster }, tile.fasterAtField !== null ? { v: String(tile.fasterAtField), l: b.fasterAt } : { v: matchWhen(tile.match.startLocal, now, c.locale).split(" ")[1], l: dayRef(tile.match.startLocal, now, c.locale) }]
    : [{ v: value(tile.metric, tile.previousBest), l: b.old }, { v: `+${value(tile.metric, diff)}`, l: b.more }, { v: tile.previousBest > 0 ? `${(tile.value / tile.previousBest).toFixed(1)}×` : "–", l: b.times }];
  return (
    <Card testId="personalBest" href={watch ?? report(tile.match.code)} title={b.title} when={matchWhen(tile.match.startLocal, now, c.locale)}
      line={b.line(`${value(tile.metric, tile.previousBest)}${run ? ` ${c.units.topSpeedKmh}` : ""}`, longDate(tile.previousBestLocal, c.locale))} foot={foot}>
      <Ring frac={tile.value / scale} tick={tile.previousBest / scale} color={GOLD} big={value(tile.metric, tile.value)} sub={b.sub(tile.metric, tile.value)} />
    </Card>
  );
}

function LastMatch({ tile, c, now }: P<"lastMatch">) {
  const l = c.last;
  const unit = tile.metric === "distanceKm" || tile.metric === "topSpeedKmh" ? c.units[tile.metric] : "";
  const shown = (["topSpeedKmh", "distanceKm", "touches", "passesCompleted", "dribblesWon"] as const).filter((m) => m !== tile.metric && tile.secondary[m] !== undefined).slice(0, 3);
  return (
    <Card testId="lastMatch" href={report(tile.match.code)} title={l.title[tile.metric]} when={matchWhen(tile.match.startLocal, now, c.locale)} line={l.line(tile.match.fieldName)}
      foot={shown.map((m) => ({ v: value(m, tile.secondary[m]!), u: m === "distanceKm" || m === "topSpeedKmh" ? c.units[m] : undefined, l: c.small[m] }))}>
      <Headline big={value(tile.metric, tile.value)} unit={unit || c.bigUnit(tile.metric, tile.value)} sub={tile.per10 ? `${l.per10} · ${l.sub(tile.claimed)}` : l.sub(tile.claimed)} color={TEAL} />
      <div className="mt-5">
        <RankList color={TEAL} rows={[
          { name: c.you, v: `${value(tile.metric, tile.value)}${unit ? ` ${unit}` : ""}${tile.per10 ? ` ${c.per10Short}` : ""}`, n: tile.value, me: true },
          { name: l.pitch, v: `${value(tile.metric, tile.pitchAverage)}${unit ? ` ${unit}` : ""}${tile.per10 ? ` ${c.per10Short}` : ""}`, n: tile.pitchAverage },
        ]} />
      </div>
    </Card>
  );
}

function Rival({ tile, c }: P<"rival">) {
  const r = c.rival;
  const gap = Math.abs(tile.other.distanceKm - tile.mine);
  const gapText = gap < 1 ? `${Math.round(gap * 100) * 10} ${c.m}` : `${gap.toFixed(1)} ${c.units.distanceKm}`;
  return (
    <Card testId="rival" href={tile.upcoming ? report(tile.upcoming.code) : "/book"} title={r.title(monthName(tile.month, c.locale))} when={tile.fieldName}
      line={tile.myRank === 1 ? r.lead(tile.other.name, gapText) : r.ahead(tile.other.name, gapText)}
      foot={[{ v: String(tile.myRank), l: r.rank }, { v: tile.perMatch.toFixed(1), u: c.units.distanceKm, l: r.perMatch }, { v: String(tile.total), l: r.players }]}>
      <RankList color={TEAL} rows={tile.board.map((b) => ({ rank: String(b.rank), name: b.me ? c.you : b.name, v: b.distanceKm.toFixed(1), n: b.distanceKm, me: b.me }))} />
    </Card>
  );
}

function Form({ tile, c, now }: P<"form">) {
  const f = c.form;
  const unit = tile.metric === "touches" ? c.bigUnit("touches", tile.latest) : c.units[tile.metric];
  const fmt = (v: number) => (tile.metric === "touches" ? String(Math.round(v)) : v.toFixed(1));
  const vals = tile.values.map((v) => v.value);
  return (
    <Card testId="form" href="/matches" title={f.title[tile.metric]} when={f.when(tile.values.length)}
      line={f.dashed}
      foot={[{ v: fmt(tile.average), l: f.average }, { v: String(tile.streak), l: f.inARow }, { v: fmt(Math.max(...vals)), l: f.best }]}>
      <Headline big={fmt(tile.latest)} unit={unit} sub={f.sub(tile.streak)} color={TEAL} />
      <LineChart values={vals} color={TEAL} rtl={c.locale === "ar"} note=""
        from={shortDate(tile.values[0].startLocal, c.locale)} to={dayRef(tile.values.at(-1)!.startLocal, now, c.locale)} />
    </Card>
  );
}

function NotFound({ tile, c, now }: P<"notFound">) {
  const n = c.notFound;
  const players = tile.match.players;
  const teaser = tile.teaser ? n.teaser[tile.teaser.metric] : undefined;
  const teaserUnit = tile.teaser && (tile.teaser.metric === "topSpeedKmh" || tile.teaser.metric === "distanceKm") ? c.units[tile.teaser.metric] : undefined;
  const foot: Foot[] = [
    tile.teaser ? { v: value(tile.teaser.metric, tile.teaser.value), u: teaserUnit, l: n.teaserLabel[tile.teaser.metric] ?? c.metric[tile.teaser.metric] } : { v: matchWhen(tile.match.startLocal, now, c.locale).split(" ")[1], l: dayRef(tile.match.startLocal, now, c.locale) },
    { v: String(tile.found), l: n.found },
    players ? { v: String(Math.max(0, players - tile.found)), l: n.toGo } : { v: "2", u: c.min, l: n.minutes },
  ];
  return (
    <Card testId="notFound" href={findPath(tile.findRecordingId, tile.match.code)} title={n.title} when={matchWhen(tile.match.startLocal, now, c.locale)}
      line={teaser && tile.teaser ? teaser(value(tile.teaser.metric, tile.teaser.value)) : n.plain} foot={foot}>
      <Ring frac={players ? tile.found / players : 0.1} color={SILVER} big={n.big(tile.found, players)} sub={n.sub} dashed={!players} />
    </Card>
  );
}

function Passing({ tile, c, now }: P<"passing">) {
  const p = c.passing;
  return (
    <Card testId="passing" href={tile.match.watch ?? report(tile.match.code)} title={p.title} when={matchWhen(tile.match.startLocal, now, c.locale)}
      line={tile.bestRate ? p.best : tile.pitchRate !== null ? p.pitch(pct(tile.pitchRate)) : p.plain}
      foot={[{ v: tile.pitchRate !== null ? pct(tile.pitchRate) : "–", l: p.pitchAvg }, { v: String(tile.completed), l: p.completed }, { v: String(tile.tried - tile.completed), l: p.lost }]}>
      <Ring frac={tile.rate} color={LIME} big={pct(tile.rate)} sub={p.sub(tile.completed, tile.tried)} />
    </Card>
  );
}

function Touches({ tile, c, now }: P<"touches">) {
  const t = c.touches;
  const from = tile.busiest.index * 5;
  return (
    <Card testId="touches" href={tile.match.watch ?? report(tile.match.code)} title={t.title} when={matchWhen(tile.match.startLocal, now, c.locale)}
      foot={[{ v: tile.everySeconds !== null ? String(tile.everySeconds) : "–", u: tile.everySeconds !== null ? c.s : undefined, l: t.between }, { v: String(tile.busiest.count), l: t.busiest }, { v: String(tile.blocks.length * 5), u: c.min, l: t.watched }]}>
      <Headline big={String(tile.total)} unit={t.unit(tile.total)} sub={t.sub(from, from + 5)} color={LIME} />
      <Bars values={tile.blocks} hi={tile.busiest.index - tile.firstIndex} color={LIME}
        labels={tile.blocks.map((_, i) => `${(tile.firstIndex + i) * 5}′`)} />
    </Card>
  );
}

function DistanceTotal({ tile, c, now }: P<"distanceTotal">) {
  const t = c.total;
  const name = t.milestone(tile.milestone);
  const lastDay = dayRef(tile.latestLocal, now, c.locale);
  const per = tile.matches ? tile.totalKm / tile.matches : 0;
  return (
    <Card testId="distanceTotal" href="/matches" title={t.title(tile.fieldName)} when={t.when(shortDate(tile.sinceLocal, c.locale))}
      line={tile.passed ? t.passed(name, tile.matches) : t.toGo(name, tile.matchesToGo, lastDay)}
      foot={[{ v: String(tile.matches), l: t.matches }, { v: per.toFixed(1), u: c.units.distanceKm, l: t.perMatch }, { v: (tile.perMatch.at(-1) ?? 0).toFixed(1), u: c.units.distanceKm, l: t.lastMatch }]}>
      <Ring frac={tile.passed ? 1 : tile.totalKm / tile.milestone} color={TEAL} big={km(tile.totalKm)} sub={t.sub(name)} />
    </Card>
  );
}

function DistanceSpells({ tile, c, now }: P<"distanceSpells">) {
  const s = c.spells;
  const total = tile.spells.reduce((a, b) => a + b, 0);
  const avg = total / tile.spells.length;
  const best = tile.spells[tile.strongest];
  const from = tile.strongest * 10;
  return (
    <Card testId="distanceSpells" href={tile.match.watch ? watchAt(tile.match.watch, from * 60) : report(tile.match.code)} title={s.title} when={matchWhen(tile.match.startLocal, now, c.locale)}
      foot={[{ v: (total / 1000).toFixed(1), u: c.units.distanceKm, l: s.total }, { v: `+${Math.round((best / avg - 1) * 100)}%`, l: s.vsAvg }, { v: String(tile.spells.length * 10), u: c.min, l: s.played }]}>
      <Headline big={String(best)} unit={c.m} sub={tile.finishedStrongest ? s.stronger : s.strongest(from, from + 10)} color={TEAL} />
      <Bars values={tile.spells} hi={tile.strongest} color={TEAL} labels={tile.spells.map((_, i) => `${i * 10}–${i * 10 + 10}′`)} />
    </Card>
  );
}

function Ranks({ tile, c, now }: P<"ranks">) {
  const r = c.ranks;
  const unitOf = (m: TileMetric) => (m === "distanceKm" ? ` ${c.units.distanceKm}` : m === "topSpeedKmh" ? ` ${c.units.topSpeedKmh}` : "");
  const of = Math.max(tile.claimed, ...tile.ranks.map((x) => x.rank));
  return (
    <Card testId="ranks" href={report(tile.match.code)} title={r.title} when={matchWhen(tile.match.startLocal, now, c.locale)} line={r.line(tile.claimed)}
      foot={[{ v: String(tile.ranks.filter((x) => x.rank <= 3).length), l: r.top3 }, { v: String(tile.claimed), l: r.claimed }, { v: c.locale === "ar" ? `#${Math.min(...tile.ranks.map((x) => x.rank))}` : c.ordinal(Math.min(...tile.ranks.map((x) => x.rank))), l: r.best }]}>
      <RankList color={SILVER} rows={tile.ranks.map((x) => ({ rank: `${x.shared ? "=" : ""}${c.locale === "ar" ? `#${x.rank}` : c.ordinal(x.rank)}`, name: c.metric[x.metric], v: `${value(x.metric, x.value)}${unitOf(x.metric)}${x.per10 ? ` ${c.per10Short}` : ""}`, n: of + 1 - x.rank, me: true }))} />
    </Card>
  );
}

function Style({ tile, c }: P<"style">) {
  const s = c.style;
  const segs = [
    { label: s.passes, n: tile.passes, color: LIME },
    { label: s.dribbles, n: tile.dribbles, color: VIOLET },
    { label: s.shots, n: tile.shots, color: GOLD },
    { label: s.other, n: tile.other, color: MUTED },
  ].filter((x) => x.n > 0);
  return (
    <Card testId="style" href="/matches" title={s.title} when={s.when(tile.matches)} line={s.line[tile.lean]}
      foot={[{ v: String(tile.matches), l: s.matches }, { v: String(tile.touches), l: s.touches }, { v: String(tile.passes), l: s.passes }]}>
      <Donut segs={segs} center={s.lean[tile.lean]} />
    </Card>
  );
}

function Challenge({ tile, c, now }: P<"challenge">) {
  const ch = c.challenge;
  const fmt = (v: number) => (tile.metric === "distanceKm" ? v.toFixed(1) : String(Math.round(v)));
  const scale = Math.max(tile.scaleMax, tile.target * 1.12);
  return (
    <Card testId="challenge" href={report(tile.upcoming.code)} title={ch.title(whenRef(tile.upcoming.startLocal, now, c.locale))} when={tile.upcoming.fieldName}
      line={ch.line(fmt(tile.best))}
      foot={[{ v: fmt(tile.average), l: ch.average }, { v: fmt(tile.best), l: ch.best }, { v: tile.upcoming.startLocal.slice(11, 16), l: ch.kickoff }]}>
      <Ring frac={tile.best / scale} tick={tile.target / scale} color={LIME} big={fmt(tile.target)} sub={ch.sub[tile.metric]} />
    </Card>
  );
}

function Dribbles({ tile, c, now }: P<"dribbles">) {
  const d = c.dribbles;
  const tries = tile.won + tile.lost;
  return (
    <Card testId="dribbles" href={tile.match.watch ?? report(tile.match.code)} title={d.title} when={matchWhen(tile.match.startLocal, now, c.locale)}
      line={<>{d.line(tries, tile.won)}{tile.leaderName && d.onlyMore(tile.leaderName)}</>}
      foot={[{ v: String(tries), l: d.tried }, { v: tries ? pct(tile.won / tries) : "–", l: d.rate }, { v: tile.rank !== null ? (c.locale === "ar" ? `#${tile.rank}` : c.ordinal(tile.rank)) : "–", l: d.rank }]}>
      <div className="grid grid-cols-2 gap-3">
        <SmallRing frac={tries ? tile.won / tries : 0} color={VIOLET} big={String(tile.won)} label={d.won} />
        <SmallRing frac={tries ? tile.lost / tries : 0} color={MUTED} big={String(tile.lost)} label={d.lost} />
      </div>
    </Card>
  );
}

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function MatchesPlayed({ tile, c, now }: P<"matchesPlayed">) {
  const p = c.played;
  const counts = new Map<string, number>();
  for (const d of tile.dates) counts.set(d, (counts.get(d) ?? 0) + 1);
  const lastWeek = tile.weekStarts.at(-1);
  const thisWeek = lastWeek ? tile.dates.filter((d) => d >= lastWeek).length : 0;
  const weeks = Math.max(1, tile.weekStarts.length);
  return (
    <Card testId="matchesPlayed" href="/matches" title={p.title} when={tile.weekStarts[0] ? p.when(shortDate(tile.weekStarts[0], c.locale)) : undefined}
      line={tile.upcomingDate ? p.keep : p.none}
      foot={[{ v: (tile.total / weeks).toFixed(1), l: p.perWeek }, { v: String(thisWeek), l: p.thisWeek }, tile.upcomingDate ? { v: String(tile.total + 1), l: whenRef(`${tile.upcomingDate} 20:00`, now, c.locale) } : { v: String(tile.weekStarts.length), l: c.locale === "ar" ? "أسابيع" : "weeks" }]}>
      <Headline big={String(tile.total)} unit={c.matches(tile.total)} sub={p.sub} color={TEAL} />
      <div className="mt-4 grid grid-cols-7 gap-1.5">
        {p.weekdays.map((d, i) => <span key={i} className="text-center text-[10px] text-muted-text">{d}</span>)}
        {tile.weekStarts.flatMap((monday) => Array.from({ length: 7 }, (_, i) => {
          const date = addDays(monday, i);
          const n = counts.get(date) ?? 0;
          const next = date === tile.upcomingDate;
          return (
            <span key={date} className={cn("flex h-7 items-center justify-center rounded-lg text-[11px] font-bold", n ? "text-[#05070C]" : next ? "border-[1.5px] border-dashed" : "")}
              style={{ background: n ? TEAL : next ? "transparent" : TRACK, borderColor: next ? LIME : undefined }}>
              {n > 1 ? <N>{n}</N> : null}
            </span>
          );
        }))}
      </div>
    </Card>
  );
}

function Shots({ tile, c, now }: P<"shots">) {
  const s = c.shots;
  const first = tile.times[0] ?? null;
  const last = tile.times.at(-1) ?? null;
  const span = Math.max(40 * 60, Math.ceil(((last ?? 0) * 1.15) / 600) * 600);
  return (
    <Card testId="shots" href={watchAt(tile.match.watch, first) ?? report(tile.match.code)} title={s.title} when={matchWhen(tile.match.startLocal, now, c.locale)} line={s.line}
      foot={[{ v: first !== null ? minuteMark(first) : "–", l: s.first }, { v: last !== null ? minuteMark(last) : "–", l: s.last }, { v: first !== null && last !== null && tile.times.length > 1 ? String(Math.round(last - first)) : "–", u: tile.times.length > 1 ? c.s : undefined, l: s.apart }]}>
      <Headline big={String(tile.shots)} unit={c.bigUnit("shots", tile.shots)} sub={s.sub} color={GOLD} />
      <div className="relative mt-8 h-14">
        <span className="absolute inset-x-0 top-6 h-1 rounded-full bg-[#141B2C]" />
        {tile.times.map((t, i) => (
          <span key={i} className="tile-fade absolute rounded-md px-1.5 py-0.5 text-xs font-semibold text-[#2A1E00]"
            style={{ insetInlineStart: `calc(${(t / span) * 100}% - 18px)`, top: i % 2 ? 30 : 0, background: GOLD, animationDelay: `${600 + i * 120}ms` }}>
            <N>{minuteMark(t)}</N>
          </span>
        ))}
      </div>
      <div className="flex justify-between text-[10px] text-muted-text"><N>0′</N><N>{Math.round(span / 120)}′</N><N>{Math.round(span / 60)}′</N></div>
    </Card>
  );
}

function PassingTrend({ tile, c, now }: P<"passingTrend">) {
  const t = c.trend;
  const first = tile.rates[0];
  const last = tile.rates.at(-1)!;
  return (
    <Card testId="passingTrend" href="/matches" title={t.title} when={t.when(tile.rates.length)}
      foot={[{ v: pct(first.rate), l: t.first }, { v: `+${Math.round((last.rate - first.rate) * 100)}`, l: t.points }, { v: String(tile.rates.length), l: t.matches }]}>
      <Headline big={pct(last.rate)} sub={t.sub(pct(first.rate))} color={LIME} />
      <LineChart values={tile.rates.map((r) => r.rate * 100)} color={LIME} rtl={c.locale === "ar"} note=""
        from={shortDate(first.startLocal, c.locale)} to={dayRef(last.startLocal, now, c.locale)} />
    </Card>
  );
}

function TeamShare({ tile, c, now }: P<"teamShare">) {
  const t = c.team;
  const next = tile.teammates.length ? Math.max(...tile.teammates) : null;
  return (
    <Card testId="teamShare" href={report(tile.match.code)} title={t.title} when={matchWhen(tile.match.startLocal, now, c.locale)} line={t.line(next)}
      foot={[{ v: String(tile.mine), l: t.yours }, { v: String(tile.teamTotal), l: t.total }, { v: next !== null ? String(next) : "–", l: t.next }]}>
      <Ring frac={tile.mine / Math.max(1, tile.teamTotal)} color={LIME} big={pct(tile.mine / Math.max(1, tile.teamTotal))} sub={t.sub} />
    </Card>
  );
}

function DribbleDuel({ tile, c, now }: P<"dribbleDuel">) {
  const d = c.duel;
  const rate = (w: number, t: number) => (t ? w / t : 0);
  const theyWon = tile.other.won > tile.me.won;
  const diff = Math.abs(tile.other.won - tile.me.won);
  const note = theyWon && tile.other.tries > tile.me.tries && rate(tile.me.won, tile.me.tries) > rate(tile.other.won, tile.other.tries);
  return (
    <Card testId="dribbleDuel" href={tile.match.watch ?? report(tile.match.code)} title={d.title} when={matchWhen(tile.match.startLocal, now, c.locale)}
      line={<>{d.head(tile.other.name, diff, theyWon)}{note && d.note}</>}
      foot={[{ v: pct(rate(tile.me.won, tile.me.tries)), l: c.you }, { v: pct(rate(tile.other.won, tile.other.tries)), l: tile.other.name }, { v: String(diff), l: d.won }]}>
      <div className="grid grid-cols-2 gap-3">
        <SmallRing frac={rate(tile.me.won, tile.me.tries)} color={VIOLET} big={`${tile.me.won}/${tile.me.tries}`} label={c.you} />
        <SmallRing frac={rate(tile.other.won, tile.other.tries)} color={MUTED} big={`${tile.other.won}/${tile.other.tries}`} label={tile.other.name} />
      </div>
    </Card>
  );
}

function Week({ tile, c }: P<"week">) {
  const w = c.week;
  const cells: Array<{ v: string; l: string; frac: number | null; color: string }> = [
    { v: tile.distanceKm.toFixed(1), l: w.km, frac: null, color: TEAL },
    { v: String(tile.touches), l: w.touches, frac: null, color: LIME },
    { v: String(tile.passesCompleted), l: w.passes, frac: tile.passesTried ? tile.passesCompleted / tile.passesTried : null, color: LIME },
    { v: String(tile.dribblesWon), l: w.dribbles, frac: tile.dribbles ? tile.dribblesWon / tile.dribbles : null, color: VIOLET },
  ];
  return (
    <Card testId="week" href="/matches" title={w.title} when={undefined} line={w.line(tile.matches)}
      foot={[{ v: String(tile.matches), l: w.matches }, { v: String(tile.shots), l: w.shots }, { v: tile.passesTried ? pct(tile.passesCompleted / tile.passesTried) : "–", l: w.passing }]}>
      <div className="grid grid-cols-2 gap-2.5">
        {cells.map((cell) => (
          <div key={cell.l} className="rounded-2xl bg-[#0D121D] p-3.5">
            <p className="text-[32px] font-semibold leading-none"><N>{cell.v}</N></p>
            <p className="mt-1 truncate text-[11px] text-muted-text">{cell.l}</p>
            {cell.frac !== null && (
              <span className="mt-2.5 block h-1 rounded-full bg-[#141B2C]">
                <span className="tile-grow-x block h-1 rounded-full" style={{ width: `${Math.max(4, cell.frac * 100)}%`, background: cell.color }} />
              </span>
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}

function Friends({ tile, c, now }: P<"friends">) {
  const f = c.friends;
  const peers = [...tile.peers].sort((a, b) => (b.distanceKm ?? -1) - (a.distanceKm ?? -1)).slice(0, 4);
  const top = Math.max(...peers.map((p) => p.distanceKm ?? 0), 1);
  return (
    <Card testId="friends" href={findPath(tile.findRecordingId, tile.match.code)} title={f.title} when={matchWhen(tile.match.startLocal, now, c.locale)} line={f.line(tile.peers.map((p) => p.name).slice(0, 3))}
      foot={[{ v: String(tile.found), l: f.found }, { v: tile.match.players ? String(tile.match.players) : "–", l: f.players }, { v: "2", u: c.min, l: f.minutes }]}>
      <RankList color={LIME} rows={[
        ...peers.map((p) => ({ name: p.name, v: p.distanceKm !== null ? `${p.distanceKm.toFixed(1)} ${c.units.distanceKm}` : "–", n: p.distanceKm ?? 0 })),
        { name: c.you, v: "?", n: top * 0.08, me: true },
      ]} />
    </Card>
  );
}

function Unclaimed({ tile, c, now }: P<"unclaimed">) {
  const u = c.unclaimed;
  return (
    <Card testId="unclaimed" href={findPath(tile.findRecordingId, tile.match.code)} title={u.title} when={matchWhen(tile.match.startLocal, now, c.locale)} line={u.line}
      foot={[{ v: tile.match.players ? String(tile.match.players) : "–", l: u.players }, { v: tile.match.startLocal.slice(11, 16), l: dayRef(tile.match.startLocal, now, c.locale) }, { v: "2", u: c.min, l: u.minutes }]}>
      <Ring frac={0} dashed color={LIME} big="?" sub={u.sub} />
    </Card>
  );
}
