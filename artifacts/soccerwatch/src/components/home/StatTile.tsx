import type { ReactNode } from "react";
import { Link } from "wouter";
import { ArrowRight, ChevronRight, Play } from "lucide-react";
import { useTileCopy, type TileStrings } from "@/i18n/stat-tile-strings";
import type { StatTile, TileMetric } from "@/lib/stat-tile";
import { cn } from "@/lib/utils";

/**
 * Home's stat tile: one card under "Your next match", picked by the server
 * as the most impressive thing it can say to this player right now (see
 * api-server/src/lib/homeStatTile.ts). Built from the stats-first wireframes.
 *
 * Colour: turf is the player's own number and the eyebrow, lime is the one
 * action (and a personal best), violet marks a rank badge, grey is everyone
 * else. Numbers are always LTR.
 */

type Locale = "en" | "ar";
type Copy = TileStrings & { locale: Locale };

// ---------------------------------------------------------------- formatting

function parts(local: string) {
  return { y: Number(local.slice(0, 4)), m: Number(local.slice(5, 7)), d: Number(local.slice(8, 10)), time: local.slice(11, 16) };
}
function utcNoon(local: string): Date {
  const p = parts(local);
  return new Date(Date.UTC(p.y, p.m - 1, p.d, 12));
}
function daysBetween(a: string, b: string): number {
  return Math.round((utcNoon(b).getTime() - utcNoon(a).getTime()) / 86_400_000);
}
const intl = (locale: Locale) => (locale === "ar" ? "ar-JO" : "en-GB");
function weekday(local: string, locale: Locale): string {
  return new Intl.DateTimeFormat(intl(locale), { weekday: "long", timeZone: "UTC" }).format(utcNoon(local));
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
/** "tonight" / "tomorrow" / "on Friday" for a match still to come. */
function whenRef(local: string, nowLocal: string, locale: Locale, capital = false): string {
  const days = daysBetween(nowLocal, local);
  const hour = Number(local.slice(11, 13));
  const en = days === 0 ? (hour >= 17 ? "tonight" : "today") : days === 1 ? "tomorrow" : `on ${weekday(local, "en")}`;
  const ar = days === 0 ? (hour >= 17 ? "الليلة" : "اليوم") : days === 1 ? "بكرا" : `يوم ${weekday(local, "ar")}`;
  const out = locale === "ar" ? ar : en;
  return capital && locale === "en" ? out.charAt(0).toUpperCase() + out.slice(1) : out;
}
function nowLocal(): string {
  return new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 16).replace("T", " ");
}
function clock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`;
}
function value(metric: TileMetric, v: number): string {
  if (metric === "distanceKm") return v.toFixed(2);
  if (metric === "topSpeedKmh") return v.toFixed(1);
  return String(Math.round(v));
}
const pct = (rate: number) => `${Math.round(rate * 100)}%`;
function watchAt(watch: string | null, seconds: number | null): string | null {
  if (!watch) return null;
  return seconds === null ? watch : `${watch}&t=${Math.max(0, Math.round(seconds - 8))}`;
}

// ---------------------------------------------------------------- pieces

function N({ children, className }: { children: ReactNode; className?: string }) {
  return <span dir="ltr" className={cn("font-display tabular-nums", className)}>{children}</span>;
}

function Shell({ children, glow = true, testId }: { children: ReactNode; glow?: boolean; testId: string }) {
  return (
    <section
      data-testid={`stat-tile-${testId}`}
      className={cn("relative overflow-hidden rounded-3xl border p-5 sm:p-6", glow ? "border-turf/25" : "border-line")}
      style={{
        background: glow
          ? "radial-gradient(120% 100% at 100% 0%, rgba(47,216,196,.13), transparent 60%), radial-gradient(90% 90% at 0% 100%, rgba(123,92,255,.14), transparent 60%), #141B2C"
          : "#141B2C",
      }}
    >
      {children}
    </section>
  );
}

function Two({ left, right, className }: { left: ReactNode; right: ReactNode; className?: string }) {
  return (
    <div className={cn("grid gap-6 md:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)] md:items-center md:gap-10", className)}>
      <div className="flex min-w-0 flex-col">{left}</div>
      <div className="min-w-0">{right}</div>
    </div>
  );
}

function Eyebrow({ children, chip }: { children: ReactNode; chip?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <p className="text-xs font-bold uppercase tracking-[0.16em] text-turf rtl:tracking-normal">{children}</p>
      {chip}
    </div>
  );
}

function Chip({ children, tone = "grey" }: { children: ReactNode; tone?: "grey" | "violet" }) {
  return (
    <span className={cn(
      "inline-flex items-center rounded-full px-3 py-1 text-[11px] font-bold uppercase tracking-wider rtl:tracking-normal",
      tone === "violet" ? "border border-violet/50 bg-violet/15 text-[#A98CFF] normal-case tracking-normal" : "bg-raised text-text",
    )}>
      {children}
    </span>
  );
}

function Head({ children }: { children: ReactNode }) {
  return <h3 className="mt-2 font-display text-[26px] font-bold leading-[1.15] sm:text-[30px]">{children}</h3>;
}

function Body({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn("mt-2 text-sm leading-relaxed text-muted-text sm:text-[15px]", className)}>{children}</p>;
}

function Cta({ href, children, primary = true }: { href: string | null; children: ReactNode; primary?: boolean }) {
  if (!href) return null;
  return (
    <Link
      href={href}
      className={cn(
        "mt-5 inline-flex min-h-11 w-fit items-center gap-1.5 rounded-full px-5 text-sm font-bold",
        primary ? "bg-floodlight text-void" : "border border-floodlight/80 text-floodlight",
      )}
    >
      {children}
      <ChevronRight className="h-4 w-4 rtl:rotate-180" aria-hidden />
    </Link>
  );
}

/**
 * The headline number. `word` makes the unit part of the headline ("17 passes"),
 * big and in the reader's direction, so the line underneath can stay short.
 */
function Big({ v, unit, tone = "text", size = "lg", word = false }: { v: string; unit?: string; tone?: "text" | "lime" | "turf"; size?: "lg" | "xl"; word?: boolean }) {
  return (
    <p className={cn("flex items-baseline", word ? "gap-3" : "gap-2")} dir={word ? undefined : "ltr"}>
      <span dir="ltr" className={cn(
        "font-display font-bold leading-none tabular-nums",
        size === "xl" ? "text-[72px] sm:text-[84px]" : "text-[56px] sm:text-[64px]",
        tone === "lime" ? "text-floodlight" : tone === "turf" ? "text-turf" : "text-text",
      )}>{v}</span>
      {unit && (word
        ? <span className={cn("font-display font-bold leading-none text-text", size === "xl" ? "text-[40px] sm:text-[46px]" : "text-[30px] sm:text-[34px]")}>{unit}</span>
        : <span className="font-display text-lg font-bold text-muted-text">{unit}</span>)}
    </p>
  );
}

function Bars({ items, highlight, format }: { items: Array<{ label: string; value: number }>; highlight: number; format: (v: number) => string }) {
  const max = Math.max(...items.map((i) => i.value), 1e-9);
  return (
    <div dir="ltr" className="flex h-44 items-end gap-2 sm:gap-3">
      {items.map((item, index) => {
        const on = index === highlight;
        return (
          <div key={index} className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1.5">
            <span className={cn("font-display text-sm tabular-nums", on ? "font-bold text-turf" : "text-muted-text")}>{format(item.value)}</span>
            <span
              className={cn("w-full rounded-t-lg", on ? "bg-turf" : "bg-[#2B3550]")}
              style={{ height: `${Math.max(3, (item.value / max) * 100)}%`, maxHeight: "calc(100% - 44px)" }}
            />
            <span className="truncate text-[11px] text-muted-text">{item.label}</span>
          </div>
        );
      })}
    </div>
  );
}

function Meter({ label, valueText, fraction, mine }: { label: string; valueText: string; fraction: number; mine: boolean }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className={cn("flex justify-between text-xs", mine ? "font-bold text-text" : "text-muted-text")}>
        <span>{label}</span>
        <N className="font-sans">{valueText}</N>
      </div>
      <div dir="ltr" className="h-2 overflow-hidden rounded-full bg-[#1E2740]">
        <div className={cn("h-full rounded-full", mine ? "bg-turf" : "bg-[#4A5470]")} style={{ width: `${Math.min(100, Math.max(2, fraction * 100))}%` }} />
      </div>
    </div>
  );
}

function SmallStat({ v, unit, label }: { v: string; unit?: string; label: string }) {
  return (
    <div className="min-w-0 border-line pe-5 [&:not(:last-child)]:border-e">
      <p dir="ltr" className="font-display text-xl font-bold tabular-nums rtl:text-end">{v}{unit && <span className="ms-1 text-xs font-semibold text-muted-text">{unit}</span>}</p>
      <p className="text-xs text-muted-text">{label}</p>
    </div>
  );
}

// ---------------------------------------------------------------- tiles

export function StatTileCard({ tile }: { tile: StatTile }) {
  const c = useTileCopy();
  const now = nowLocal();
  switch (tile.kind) {
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
    case "style": return <Style tile={tile} c={c} />;
    case "challenge": return <Challenge tile={tile} c={c} now={now} />;
    case "dribbles": return <Dribbles tile={tile} c={c} now={now} />;
    case "matchesPlayed": return <MatchesPlayed tile={tile} c={c} now={now} />;
    case "shots": return <Shots tile={tile} c={c} now={now} />;
    case "passingTrend": return <PassingTrend tile={tile} c={c} />;
    case "teamShare": return <TeamShare tile={tile} c={c} now={now} />;
    case "dribbleDuel": return <DribbleDuel tile={tile} c={c} now={now} />;
    case "week": return <Week tile={tile} c={c} />;
    case "friends": return <Friends tile={tile} c={c} now={now} />;
    case "unclaimed": return <Unclaimed tile={tile} c={c} now={now} />;
    default: return null;
  }
}

type P<K extends StatTile["kind"]> = { tile: Extract<StatTile, { kind: K }>; c: Copy; now: string };

const matchWhen = (m: { startLocal: string }, c: Copy, now: string) => c.matchAt(dayRef(m.startLocal, now, c.locale), m.startLocal.slice(11, 16));

function LastMatch({ tile, c, now }: P<"lastMatch">) {
  const unit = c.units[tile.metric];
  const max = Math.max(tile.value, tile.pitchAverage, 1e-9);
  const shown = (["topSpeedKmh", "distanceKm", "touches", "passesCompleted"] as const).filter((m) => tile.secondary[m] !== undefined).slice(0, 3);
  return (
    <Shell testId="lastMatch">
      <Two
        left={<>
          <Eyebrow>{c.lastMatchEyebrow}</Eyebrow>
          <Head>{c.lastMatchHead[tile.metric]}</Head>
          <Body className="mt-1">{c.lastMatchMeta(tile.match.fieldName, matchWhen(tile.match, c, now), tile.match.players)}</Body>
          {shown.length > 0 && (
            <div className="mt-4 flex gap-5">
              {shown.map((m) => <SmallStat key={m} v={value(m, tile.secondary[m]!)} unit={m === "topSpeedKmh" ? c.units.topSpeedKmh : m === "distanceKm" ? c.units.distanceKm : undefined} label={c.small[m]} />)}
            </div>
          )}
          <Cta href={`/m/${tile.match.code}`}>{c.matchReport}</Cta>
        </>}
        right={<div className="flex flex-col gap-3 md:items-end">
          <Chip tone="violet">{c.numberOne(c.metricShort[tile.metric])}</Chip>
          <Big v={value(tile.metric, tile.value)} unit={c.bigUnit(tile.metric, tile.value)} word />
          <div className="flex w-full flex-col gap-3">
            <Meter label={c.you} valueText={`${value(tile.metric, tile.value)} ${unit}`} fraction={tile.value / max} mine />
            <Meter label={c.pitchAverage} valueText={`${value(tile.metric, tile.pitchAverage)} ${unit}`} fraction={tile.pitchAverage / max} mine={false} />
          </div>
        </div>}
      />
    </Shell>
  );
}

function PersonalBest({ tile, c, now }: P<"personalBest">) {
  const unit = c.units[tile.metric];
  const day = dayRef(tile.match.startLocal, now, c.locale);
  const time = tile.match.startLocal.slice(11, 16);
  const run = tile.metric === "topSpeedKmh";
  const watch = watchAt(tile.match.watch, tile.at);
  const left = (
    <>
      <Eyebrow chip={<Chip>{c.metricShort[tile.metric]}</Chip>}>{c.newBest}</Eyebrow>
      <div className="mt-3"><Big v={value(tile.metric, tile.value)} unit={c.bigUnit(tile.metric, tile.value)} tone="lime" size="xl" word /></div>
      {run ? (
        <Body className="mt-3 text-[15px] text-text/85">
          {c.bestSpeedBody(tile.at !== null ? clock(tile.at) : null, day, time)}
          {tile.fasterAtField !== null && <> {c.fasterAtField(tile.fasterAtField, tile.match.fieldName)}</>}
        </Body>
      ) : (
        <Body className="mt-3 text-[15px] text-text/85">{c.bestRest[tile.metric]} {c.bestOn(day, time)}</Body>
      )}
      <p className="mt-2 text-xs text-muted-text">{c.oldBest(`${value(tile.metric, tile.previousBest)}${tile.metric === "distanceKm" || run ? ` ${unit}` : ""}`, longDate(tile.previousBestLocal, c.locale))}</p>
      <Cta href={run && watch ? watch : `/m/${tile.match.code}`}>{run && watch ? c.watchRun : c.matchReport}</Cta>
    </>
  );
  if (!(run && watch)) return <Shell testId="personalBest"><div className="max-w-xl">{left}</div></Shell>;
  return (
    <Shell testId="personalBest">
      <Two
        left={left}
        right={
          <Link href={watch} className="block overflow-hidden rounded-2xl border border-line bg-void/60">
            <div className="relative flex aspect-video items-center justify-center" style={{ background: "repeating-linear-gradient(135deg,#141B2C 0 10px,#182035 10px 20px)" }}>
              <span className="absolute start-3 top-2 text-[11px] text-muted-text">{c.clipNote}</span>
              <span className="flex h-12 w-12 items-center justify-center rounded-full bg-void/90"><Play className="h-5 w-5 fill-current" /></span>
            </div>
            <p className="px-3 py-2.5 text-sm font-semibold">{c.yourSprint} · <N>{tile.at !== null ? clock(tile.at) : ""}</N></p>
          </Link>
        }
      />
    </Shell>
  );
}

function gapText(km: number, c: Copy): string {
  return km < 1 ? `${Math.round(km * 1000 / 10) * 10} ${c.locale === "ar" ? "م" : "m"}` : `${km.toFixed(1)} ${c.units.distanceKm}`;
}

function Rival({ tile, c, now }: P<"rival">) {
  const leading = tile.myRank === 1;
  const gap = Math.abs(tile.other.distanceKm - tile.mine);
  const max = Math.max(tile.other.distanceKm, tile.mine, 1e-9);
  const upcoming = tile.upcoming;
  return (
    <Shell testId="rival">
      <Two
        left={<>
          <Eyebrow>{tile.fieldName} · {monthName(tile.month, c.locale)}</Eyebrow>
          <Head>{leading ? c.rivalLead(tile.fieldName) : c.rivalAhead(tile.other.name, gapText(gap, c))}</Head>
          <div className="mt-4 flex flex-col gap-3">
            {(leading
              ? [{ label: c.you, v: tile.mine, mine: true }, { label: tile.other.name, v: tile.other.distanceKm, mine: false }]
              : [{ label: tile.other.name, v: tile.other.distanceKm, mine: false }, { label: c.you, v: tile.mine, mine: true }]
            ).map((row) => <Meter key={row.label} label={row.label} valueText={`${row.v.toFixed(1)} ${c.units.distanceKm}`} fraction={row.v / max} mine={row.mine} />)}
          </div>
          <Body>{leading ? c.rivalLeadBody(tile.other.name, gapText(gap, c)) : c.rivalAheadBody}</Body>
          {upcoming
            ? <Cta href={`/m/${upcoming.code}`}>{whenRef(upcoming.startLocal, now, c.locale, true)} <N className="font-sans">{upcoming.startLocal.slice(11, 16)}</N></Cta>
            : <Cta href="/book">{c.bookNext}</Cta>}
        </>}
        right={<div className="flex flex-col gap-2">
          <div className="flex justify-between text-xs text-muted-text"><span>{c.distanceThisMonth}</span><span className="text-turf">{c.allPlayers(tile.total)}</span></div>
          {tile.board.map((row) => (
            <div key={`${row.rank}-${row.name}`} className={cn("flex items-center gap-3 rounded-xl px-3 py-2.5", row.me ? "border border-turf/60 bg-turf/5" : "bg-[#182035]")}>
              <span className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-void font-display text-lg font-bold", row.me && "text-turf")}><N>{row.rank}</N></span>
              <span className="min-w-0 flex-1 truncate text-sm font-semibold">{row.me ? c.you : row.name}</span>
              <N className="font-sans text-sm text-muted-text">{row.distanceKm.toFixed(1)} {c.units.distanceKm}</N>
            </div>
          ))}
        </div>}
      />
    </Shell>
  );
}

function Form({ tile, c, now }: P<"form">) {
  const unit = c.units[tile.metric];
  const last = tile.values.at(-1)!;
  const diff = tile.latest - tile.average;
  const diffText = tile.metric === "touches" ? `${Math.round(diff)} ${unit}` : `${diff.toFixed(tile.metric === "distanceKm" ? 2 : 1)} ${unit}`;
  return (
    <Shell testId="form">
      <Two
        left={<>
          <Eyebrow>{c.formEyebrow}</Eyebrow>
          <Head>{c.formHead(tile.metric, tile.streak)}</Head>
          <Body>
            {c.formBody(`${value(tile.metric, tile.latest)} ${unit}`, dayRef(last.startLocal, now, c.locale), diffText)}
            {tile.upcoming && c.keepGoing(`${whenRef(tile.upcoming.startLocal, now, c.locale)} ${tile.upcoming.startLocal.slice(11, 16)}`)}
          </Body>
          <div className="mt-4 flex flex-wrap gap-2">
            {(["distanceKm", "topSpeedKmh", "touches"] as const).map((m) => (
              <span key={m} className={cn("rounded-full px-3 py-1 text-xs font-semibold", m === tile.metric ? "bg-raised text-text" : "border border-line text-muted-text")}>{c.metricShort[m]}</span>
            ))}
          </div>
          <Cta href="/matches">{c.allMatches}</Cta>
        </>}
        right={<Bars
          items={tile.values.map((v) => ({ label: shortDate(v.startLocal, c.locale), value: v.value }))}
          highlight={tile.values.length - 1}
          format={(v) => (tile.metric === "touches" ? String(v) : v.toFixed(1))}
        />}
      />
    </Shell>
  );
}

function NotFound({ tile, c, now }: P<"notFound">) {
  const day = dayRef(tile.match.startLocal, now, c.locale);
  const teaser = tile.teaser ? c.notFoundTeaser[tile.teaser.metric] : undefined;
  const players = tile.match.players;
  return (
    <Shell testId="notFound">
      <Two
        left={<>
          <Eyebrow>{matchWhen(tile.match, c, now)} · {tile.match.fieldName}</Eyebrow>
          <Head>{teaser && tile.teaser ? teaser(value(tile.teaser.metric, tile.teaser.value), day) : c.notFoundPlain(day)}</Head>
          <Body>{c.notFoundBody}</Body>
          {players > 0 && (
            <div className="mt-4 flex max-w-sm flex-col gap-1.5">
              <div dir="ltr" className="h-2 overflow-hidden rounded-full bg-[#1E2740]"><div className="h-full rounded-full bg-turf" style={{ width: `${Math.max(4, (tile.found / players) * 100)}%` }} /></div>
              <p className="text-xs font-semibold">{c.found(tile.found, players)}</p>
            </div>
          )}
          <Cta href={`/find/${tile.findRecordingId}`}>{c.findYourself}</Cta>
        </>}
        right={<div className="flex flex-col gap-3">
          {[
            [c.yourDistance, `-.-- ${c.units.distanceKm}`],
            [c.yourTopSpeed, `--.- ${c.units.topSpeedKmh}`],
            [c.yourPlace, players ? `#- ${c.of} ${players}` : "#-"],
          ].map(([label, ghost]) => (
            <div key={label} className="flex items-center justify-between rounded-xl bg-[#182035] px-4 py-4">
              <span className="text-sm text-muted-text">{label}</span>
              <N className="text-2xl font-bold text-[#4A5470]">{ghost}</N>
            </div>
          ))}
        </div>}
      />
    </Shell>
  );
}

function Passing({ tile, c, now }: P<"passing">) {
  const dots = Math.min(tile.tried, 33);
  const scale = tile.tried / dots;
  const completedDots = Math.round(tile.completed / scale);
  return (
    <Shell testId="passing">
      <Two
        left={<>
          <Eyebrow>{c.passingEyebrow} · {matchWhen(tile.match, c, now)}</Eyebrow>
          <Head>{c.passingHead(tile.completed, tile.tried)}</Head>
          <Body>{tile.bestRate ? c.passingBest(pct(tile.rate)) : c.passingRate(pct(tile.rate))}{tile.pitchRate !== null && c.pitchAveraged(pct(tile.pitchRate))}</Body>
          <Cta href={tile.match.watch ?? `/m/${tile.match.code}`} primary={false}>{tile.match.watch ? c.watchPasses : c.matchReport}</Cta>
        </>}
        right={<div className="flex flex-col gap-3">
          <div dir="ltr" className="grid grid-cols-11 gap-2">
            {Array.from({ length: dots }, (_, i) => (
              <span key={i} className={cn("aspect-square rounded-full", i < completedDots ? "bg-turf" : "border-2 border-[#4A5470]")} />
            ))}
          </div>
          <div className="flex gap-4 text-xs text-muted-text">
            <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-turf" /><N className="font-sans">{tile.completed}</N> {c.completed}</span>
            <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full border-2 border-[#4A5470]" /><N className="font-sans">{tile.tried - tile.completed}</N> {c.lost}</span>
          </div>
          <Big v={String(Math.round(tile.rate * 100))} unit="%" />
        </div>}
      />
    </Shell>
  );
}

function Touches({ tile, c, now }: P<"touches">) {
  const startMin = tile.firstIndex * 5;
  const max = Math.max(...tile.blocks, 1);
  return (
    <Shell testId="touches" glow={false}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Eyebrow>{c.touchesEyebrow} · {matchWhen(tile.match, c, now)}</Eyebrow>
          <Head>{c.touchesHead(tile.total, tile.everySeconds)}</Head>
        </div>
        {tile.match.watch && <Cta href={tile.match.watch} primary={false}>{c.everyTouch}</Cta>}
      </div>
      <div dir="ltr" className="mt-5 flex h-36 items-end gap-1.5 sm:gap-2">
        {tile.blocks.map((count, i) => {
          const on = tile.firstIndex + i === tile.busiest.index;
          return (
            <div key={i} className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1">
              <span className={cn("font-display text-xs tabular-nums", on ? "font-bold text-turf" : "text-muted-text")}>{count}</span>
              <span className={cn("w-full rounded-t-md", on ? "bg-turf" : "bg-[#2B3550]")} style={{ height: `${Math.max(3, (count / max) * 78)}%` }} />
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex items-center justify-between gap-2 text-xs text-muted-text" dir="ltr">
        <span>{startMin}′</span>
        <span className="hidden text-center sm:inline" dir={c.locale === "ar" ? "rtl" : "ltr"}>{c.busiest(tile.busiest.index * 5, tile.busiest.index * 5 + 5, tile.busiest.count)}</span>
        <span>{startMin + tile.blocks.length * 5}′</span>
      </div>
      <p className="mt-2 text-xs text-muted-text sm:hidden">{c.busiest(tile.busiest.index * 5, tile.busiest.index * 5 + 5, tile.busiest.count)}</p>
    </Shell>
  );
}

function DistanceTotal({ tile, c, now }: P<"distanceTotal">) {
  const name = c.milestoneName(tile.milestone);
  const scaleMax = tile.passed ? Math.max(tile.totalKm, tile.milestone) : tile.milestone;
  const lastDay = dayRef(tile.latestLocal, now, c.locale);
  const shades = ["#1E8F86", "#22A69B", "#25B8AC", "#2AC8BB", "#2FD8C4"];
  return (
    <Shell testId="distanceTotal">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <Eyebrow>{c.sinceEyebrow(longDate(tile.sinceLocal, c.locale), tile.matches)}</Eyebrow>
          <Head>{tile.passed ? c.passedHead(name, tile.fieldName) : c.totalHead(tile.totalKm.toFixed(1), tile.fieldName)}</Head>
          <Body>
            {tile.passed
              ? c.passedBody(tile.totalKm.toFixed(1), tile.matches)
              : tile.milestone === 21.1 || tile.milestone === 42.2
                ? c.toGoBody(name, String(tile.milestone), tile.matchesToGo, lastDay)
                : c.toGoBodyKm(String(tile.milestone), tile.matchesToGo, lastDay)}
          </Body>
        </div>
        <div className="hidden shrink-0 sm:block"><Big v={tile.totalKm.toFixed(1)} unit={c.units.distanceKm} /></div>
      </div>
      <div className="mt-6">
        <div dir="ltr" className="flex h-3.5 overflow-hidden rounded-full bg-[#1E2740]">
          {tile.perMatch.map((km, i) => (
            <span key={i} className="h-full border-e border-void/70 last:border-e-0" style={{ width: `${(km / scaleMax) * 100}%`, background: shades[Math.max(0, shades.length - tile.perMatch.length + i)] ?? "#2FD8C4" }} />
          ))}
        </div>
        <div dir="ltr" className="mt-2 flex justify-between text-xs text-muted-text">
          <span>0 {c.units.distanceKm}</span>
          <span className="hidden sm:inline" dir={c.locale === "ar" ? "rtl" : "ltr"}>{c.eachBlock}</span>
          <span>{tile.milestone} {c.units.distanceKm}{tile.milestone === 21.1 || tile.milestone === 42.2 ? `, ${name}` : ""}</span>
        </div>
      </div>
    </Shell>
  );
}

function DistanceSpells({ tile, c, now }: P<"distanceSpells">) {
  const last = tile.spells.at(-1)!;
  const from = tile.strongest * 10;
  return (
    <Shell testId="distanceSpells" glow={false}>
      <Two
        left={<>
          <Eyebrow>{c.distanceEyebrow} · {matchWhen(tile.match, c, now)}</Eyebrow>
          <Head>{tile.finishedStrongest ? c.strongerHead : c.strongestHead(from, from + 10)}</Head>
          <Body>{tile.finishedStrongest ? c.strongerBody(String(last)) : c.strongestBody(String(tile.spells[tile.strongest]))}</Body>
        </>}
        right={<Bars
          items={tile.spells.map((m, i) => ({ label: `${i * 10}–${i * 10 + 10}′`, value: m }))}
          highlight={tile.strongest}
          format={(v) => `${v} ${c.locale === "ar" ? "م" : "m"}`}
        />}
      />
    </Shell>
  );
}

function Ranks({ tile, c, now }: P<"ranks">) {
  return (
    <Shell testId="ranks" glow={false}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Eyebrow>{matchWhen(tile.match, c, now)} · {c.players(tile.claimed)}</Eyebrow>
          <Head>{c.ranksHead}</Head>
        </div>
        <Cta href={`/m/${tile.match.code}`} primary={false}>{c.fullTable}</Cta>
      </div>
      <div className="mt-5 grid grid-cols-2 gap-3 sm:flex">
        {tile.ranks.map((r, i) => (
          <div key={r.metric} className={cn("min-w-0 flex-1 rounded-2xl p-4", i === 0 ? "border border-turf/60 bg-turf/5" : "bg-[#182035]")}>
            <span className={cn("inline-flex h-11 min-w-11 items-center justify-center rounded-xl bg-void px-2 font-display text-xl font-bold", i === 0 && "text-turf")}>
              {c.locale === "ar" ? <N>{`#${r.rank}`}</N> : <N>{c.ordinal(r.rank)}</N>}
            </span>
            <p className="mt-3 text-sm font-semibold">{c.metric[r.metric]}</p>
            <p className="text-xs text-muted-text">{r.of !== null
              ? <><N className="font-sans">{value(r.metric, r.value)}</N> {c.of} <N className="font-sans">{r.of}</N></>
              : <><N className="font-sans">{value(r.metric, r.value)}</N>{r.metric === "distanceKm" ? ` ${c.units.distanceKm}` : r.metric === "topSpeedKmh" ? ` ${c.units.topSpeedKmh}` : ""}</>}</p>
          </div>
        ))}
      </div>
    </Shell>
  );
}

function Style({ tile, c }: { tile: Extract<StatTile, { kind: "style" }>; c: Copy }) {
  const total = Math.max(1, tile.passes + tile.dribbles + tile.shots + tile.other);
  const share = (n: number) => `${Math.round((n / total) * 100)}%`;
  const segs = [
    { label: c.passes, n: tile.passes, cls: "bg-turf text-void" },
    { label: c.dribbles, n: tile.dribbles, cls: "bg-violet text-white" },
    { label: c.shotsOnTarget, n: tile.shots, cls: "bg-floodlight text-void" },
    { label: c.otherTouches, n: tile.other, cls: "bg-[#2B3550] text-text" },
  ].filter((s) => s.n > 0);
  return (
    <Shell testId="style" glow={false}>
      <Eyebrow>{c.styleEyebrow(tile.matches)}</Eyebrow>
      <Head>{c.styleHead[tile.lean]}</Head>
      <Body>{c.styleBody(tile.touches, share(tile.passes))}</Body>
      <div dir="ltr" className="mt-6 flex h-12 overflow-hidden rounded-xl">
        {segs.map((s) => (
          <span key={s.label} className={cn("flex items-center overflow-hidden whitespace-nowrap border-e-2 border-surface px-3 text-xs font-bold last:border-e-0", s.cls)} style={{ width: `${(s.n / total) * 100}%` }}>
            {(s.n / total) > 0.12 && <span className="hidden sm:inline">{s.label} {s.n}</span>}
          </span>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-text">
        {segs.map((s) => <span key={s.label}>{s.label} <N className="font-sans">{share(s.n)}</N></span>)}
      </div>
    </Shell>
  );
}

function Challenge({ tile, c, now }: P<"challenge">) {
  const when = whenRef(tile.upcoming.startLocal, now, c.locale);
  const at = (v: number) => `${Math.min(100, Math.max(0, (v / tile.scaleMax) * 100))}%`;
  const fmt = (v: number) => (tile.metric === "distanceKm" ? v.toFixed(1) : String(Math.round(v)));
  const unit = tile.metric === "distanceKm" ? c.units.distanceKm : c.units[tile.metric];
  return (
    <Shell testId="challenge">
      <Two
        left={<>
          <Eyebrow>{c.challengeEyebrow(whenRef(tile.upcoming.startLocal, now, c.locale, true), tile.upcoming.startLocal.slice(11, 16), tile.upcoming.fieldName)}</Eyebrow>
          <Head>{c.challengeHead[tile.metric](fmt(tile.target), when)}</Head>
          <Body>{c.challengeBody(fmt(tile.average), fmt(tile.target))}</Body>
          <Cta href={`/m/${tile.upcoming.code}`} primary={false}>{c.openMatch}</Cta>
        </>}
        right={<div className="flex flex-col gap-4">
          <div className="md:self-end"><Big v={fmt(tile.target)} unit={c.bigUnit(tile.metric, tile.target)} word /></div>
          <div dir="ltr" className="relative mt-6 h-12">
            <span className="absolute inset-x-0 top-5 h-2 rounded-full bg-[#1E2740]" />
            <span className="absolute top-5 h-2 rounded-full bg-[#4A5470]" style={{ width: at(tile.average) }} />
            <span className="absolute top-0 -translate-x-1/2 whitespace-nowrap text-[11px] text-muted-text" style={{ left: at(tile.average) }}>{c.average} {fmt(tile.average)}</span>
            <span className="absolute top-3.5 h-5 w-0.5 -translate-x-1/2 bg-text/70" style={{ left: at(tile.best) }} />
            <span className="absolute top-9 -translate-x-1/2 whitespace-nowrap text-[11px] text-muted-text" style={{ left: at(tile.best) }}>{c.best} {fmt(tile.best)}</span>
            <span className="absolute top-3 h-6 w-6 -translate-x-1/2 rounded-full bg-floodlight" style={{ left: at(tile.target) }} />
            <span className="absolute -top-5 -translate-x-1/2 whitespace-nowrap text-[11px] font-bold text-floodlight" style={{ left: at(tile.target) }}>{c.target} {fmt(tile.target)}</span>
          </div>
          <div dir="ltr" className="flex justify-between text-xs text-muted-text"><span>0</span><span>{tile.scaleMax}</span></div>
        </div>}
      />
    </Shell>
  );
}

function Dribbles({ tile, c, now }: P<"dribbles">) {
  const tries = tile.won + tile.lost;
  return (
    <Shell testId="dribbles" glow={false}>
      <div className="flex items-start justify-between gap-3">
        <Eyebrow>{c.dribblesEyebrow} · {dayRef(tile.match.startLocal, now, c.locale)}</Eyebrow>
        {tile.rank !== null && tile.rank <= 3 && <Chip tone="violet">{c.rankBadge(tile.rank, c.metricShort.dribblesWon)}</Chip>}
      </div>
      <div className="mt-3 flex gap-8">
        <div><N className="block text-[72px] font-bold leading-none">{tile.won}</N><p className="mt-1 text-sm text-text">{c.won}</p></div>
        <div><N className="block text-[72px] font-bold leading-none text-[#4A5470]">{tile.lost}</N><p className="mt-1 text-sm text-muted-text">{c.lost}</p></div>
      </div>
      <div dir="ltr" className="mt-4 flex gap-1.5">
        {Array.from({ length: tries }, (_, i) => <span key={i} className={cn("h-2.5 flex-1 rounded-full", i < tile.won ? "bg-turf" : "bg-[#2B3550]")} />)}
      </div>
      <Body className="mt-4">{c.dribblesBody(tries, tile.won)}{tile.leaderName && c.onlyMore(tile.leaderName)}</Body>
    </Shell>
  );
}

function MatchesPlayed({ tile, c, now }: P<"matchesPlayed">) {
  const counts = new Map<string, number>();
  for (const d of tile.dates) counts.set(d, (counts.get(d) ?? 0) + 1);
  const add = (date: string, n: number) => {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  const makes = tile.upcomingDate ? c.makes(whenRef(`${tile.upcomingDate} 20:00`, now, c.locale), tile.total + 1) : null;
  return (
    <Shell testId="matchesPlayed" glow={false}>
      <Eyebrow>{c.matchesEyebrow}</Eyebrow>
      <div className="mt-3 flex items-end gap-3">
        <N className="text-[72px] font-bold leading-none">{tile.total}</N>
        <p className="pb-2 text-base text-muted-text">{c.matchesBody(makes)}</p>
      </div>
      <div className="mt-5 grid grid-cols-[auto_repeat(7,minmax(0,1fr))] items-center gap-1.5 sm:gap-2">
        <span />
        {c.weekdays.map((d, i) => <span key={i} className="text-center text-xs text-muted-text">{d}</span>)}
        {tile.weekStarts.map((monday) => (
          <WeekRow key={monday} label={shortDate(monday, c.locale)}>
            {Array.from({ length: 7 }, (_, i) => {
              const date = add(monday, i);
              const n = counts.get(date) ?? 0;
              const next = date === tile.upcomingDate;
              return (
                <span key={date} className={cn("flex h-9 items-center justify-center rounded-lg text-xs font-bold", n ? "bg-turf text-void" : next ? "border-2 border-dashed border-floodlight" : "bg-[#182035]")}>
                  {n > 1 ? <N className="font-sans">{n}</N> : null}
                </span>
              );
            })}
          </WeekRow>
        ))}
      </div>
    </Shell>
  );
}

function WeekRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <span className="pe-2 text-xs text-muted-text">{label}</span>
      {children}
    </>
  );
}

function Shots({ tile, c, now }: P<"shots">) {
  const first = tile.times[0] ?? null;
  return (
    <Shell testId="shots" glow={false}>
      <Eyebrow>{c.shotsEyebrow} · {dayRef(tile.match.startLocal, now, c.locale)}</Eyebrow>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <N className="me-2 text-[72px] font-bold leading-none">{tile.shots}</N>
        {tile.times.map((t) => {
          const href = watchAt(tile.match.watch, t);
          const body = <N className="font-sans text-sm">{clock(t)}</N>;
          return href
            ? <Link key={t} href={href} className="rounded-xl bg-[#182035] px-4 py-3 text-text hover:bg-raised">{body}</Link>
            : <span key={t} className="rounded-xl bg-[#182035] px-4 py-3">{body}</span>;
        })}
      </div>
      <Body className="mt-4">{c.shotsBody}</Body>
      <Cta href={watchAt(tile.match.watch, first) ?? `/m/${tile.match.code}`} primary={false}>{tile.match.watch ? c.watchThem : c.matchReport}</Cta>
    </Shell>
  );
}

function PassingTrend({ tile, c }: { tile: Extract<StatTile, { kind: "passingTrend" }>; c: Copy }) {
  const first = tile.rates[0];
  const last = tile.rates.at(-1)!;
  return (
    <Shell testId="passingTrend">
      <Eyebrow>{c.trendEyebrow}</Eyebrow>
      <div dir="ltr" className="mt-3 flex items-center gap-5 rtl:justify-end">
        <span className="font-display text-[56px] font-bold leading-none tabular-nums">{pct(first.rate)}</span>
        <ArrowRight className="h-8 w-12 text-[#4A5470]" aria-hidden />
        <span className="font-display text-[56px] font-bold leading-none tabular-nums">{pct(last.rate)}</span>
      </div>
      <Body className="mt-3">{c.trendBody}</Body>
      <div className="mt-6 flex flex-col gap-2.5">
        {tile.rates.map((r, i) => {
          const on = i === tile.rates.length - 1;
          return (
            <div key={r.startLocal} className="grid grid-cols-[4.5rem_minmax(0,1fr)_3rem] items-center gap-3 text-sm">
              <span className="text-muted-text">{shortDate(r.startLocal, c.locale)}</span>
              <div dir="ltr" className="h-2.5 overflow-hidden rounded-full bg-[#1E2740]"><div className={cn("h-full rounded-full", on ? "bg-turf" : "bg-[#4A5470]")} style={{ width: `${r.rate * 100}%` }} /></div>
              <N className={cn("font-sans text-end", on && "font-bold")}>{pct(r.rate)}</N>
            </div>
          );
        })}
      </div>
    </Shell>
  );
}

function TeamShare({ tile, c, now }: P<"teamShare">) {
  const share = tile.mine / tile.teamTotal;
  const rest = Math.max(0, tile.teamTotal - tile.mine - tile.teammates.reduce((a, b) => a + b, 0));
  const segs = [...tile.teammates.map((n) => ({ n })), ...(rest > 0 ? [{ n: rest, rest: true }] : [])];
  return (
    <Shell testId="teamShare" glow={false}>
      <Eyebrow>{c.teamEyebrow} · {dayRef(tile.match.startLocal, now, c.locale)}</Eyebrow>
      <Head>{c.teamHead(share)}</Head>
      <div dir="ltr" className="mt-6 flex h-12 overflow-hidden rounded-xl">
        <span className="flex items-center whitespace-nowrap bg-turf px-4 text-sm font-bold text-void" style={{ width: `${share * 100}%` }}>{c.you} {tile.mine}</span>
        {segs.map((s, i) => (
          <span key={i} className={cn("flex items-center border-s-2 border-surface px-3 text-sm font-semibold", "rest" in s ? "bg-[#1E2740] text-muted-text" : "bg-[#3A4560] text-text")} style={{ width: `${(s.n / tile.teamTotal) * 100}%` }}>
            {!("rest" in s) && s.n / tile.teamTotal > 0.07 ? s.n : ""}
          </span>
        ))}
      </div>
      <Body className="mt-3">{c.teamBody(tile.mine, tile.teamTotal, tile.teammates[0] ?? null)}</Body>
    </Shell>
  );
}

function DribbleDuel({ tile, c, now }: P<"dribbleDuel">) {
  const theyWon = tile.other.won > tile.me.won;
  const diff = Math.abs(tile.other.won - tile.me.won);
  const rate = (w: number, t: number) => (t ? Math.round((w / t) * 100) : 0);
  const note = theyWon && tile.other.tries > tile.me.tries && rate(tile.me.won, tile.me.tries) > rate(tile.other.won, tile.other.tries);
  return (
    <Shell testId="dribbleDuel">
      <Eyebrow>{c.duelEyebrow} · {dayRef(tile.match.startLocal, now, c.locale)}</Eyebrow>
      <Head>{c.duelHead(tile.other.name, diff, theyWon)}</Head>
      <div className="mt-6 grid grid-cols-[1fr_auto_1fr] items-center text-center">
        <div>
          <N className="block text-[72px] font-bold leading-none text-turf">{tile.me.won}</N>
          <p className="mt-2 font-semibold">{c.you}</p>
          <p className="text-sm text-muted-text">{c.duelLine(tile.me.won, tile.me.tries, rate(tile.me.won, tile.me.tries))}</p>
        </div>
        <span className="text-sm text-muted-text">{c.vs}</span>
        <div>
          <N className="block text-[72px] font-bold leading-none">{tile.other.won}</N>
          <p className="mt-2 font-semibold">{tile.other.name}</p>
          <p className="text-sm text-muted-text">{c.duelLine(tile.other.won, tile.other.tries, rate(tile.other.won, tile.other.tries))}</p>
        </div>
      </div>
      {note && <p className="mt-4 text-center text-sm text-muted-text">{c.duelNote}</p>}
    </Shell>
  );
}

function Week({ tile, c }: { tile: Extract<StatTile, { kind: "week" }>; c: Copy }) {
  const cells: Array<[string, number | null, string]> = [
    [String(tile.touches), null, c.touchesLabel],
    [String(tile.passesCompleted), tile.passesTried, c.passesCompleted],
    [String(tile.dribblesWon), tile.dribbles, c.dribblesWon],
    [String(tile.shots), null, c.shotsLabel],
  ];
  return (
    <Shell testId="week" glow={false}>
      <Eyebrow>{c.weekEyebrow}</Eyebrow>
      <Head>{c.weekHead(tile.matches, tile.distanceKm.toFixed(1))}</Head>
      <div className="mt-5 grid grid-cols-2 gap-3">
        {cells.map(([v, of, label]) => (
          <div key={label} className="rounded-2xl bg-[#182035] p-4">
            <p dir="ltr" className="font-display text-3xl font-bold tabular-nums rtl:text-end">{v}{of !== null && <span className="ms-1.5 text-base text-muted-text">{c.of} {of}</span>}</p>
            <p className="mt-1 text-sm text-muted-text">{label}</p>
          </div>
        ))}
      </div>
    </Shell>
  );
}

function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?";
}

function Friends({ tile, c, now }: P<"friends">) {
  const cell = (v: number | null, digits = 0) => (v === null ? "–" : digits ? v.toFixed(digits) : String(v));
  return (
    <Shell testId="friends">
      <Two
        left={<>
          <Eyebrow>{matchWhen(tile.match, c, now)} · {tile.match.fieldName}</Eyebrow>
          <Head>{c.friendsHead(tile.peers.map((p) => p.name))}</Head>
          <Body>{c.friendsBody}</Body>
          <Cta href={`/find/${tile.findRecordingId}`}>{c.claimStats}</Cta>
        </>}
        right={<div>
          <div>
            <div className="grid grid-cols-[minmax(0,1fr)_3rem_4rem] sm:grid-cols-[minmax(0,1fr)_3.5rem_4.5rem_3.5rem_4.5rem] gap-2 px-3 pb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-text rtl:tracking-normal">
              <span>{dayRef(tile.match.startLocal, now, c.locale)}</span>
              <span className="text-end">{c.cols.km}</span><span className="text-end">{c.cols.top}</span><span className="hidden text-end sm:block">{c.cols.shots}</span><span className="hidden text-end sm:block">{c.cols.dribbles}</span>
            </div>
            <div className="flex flex-col gap-1.5">
              {tile.peers.map((p) => (
                <div key={p.name} className="grid grid-cols-[minmax(0,1fr)_3rem_4rem] sm:grid-cols-[minmax(0,1fr)_3.5rem_4.5rem_3.5rem_4.5rem] items-center gap-2 rounded-xl bg-[#182035] px-3 py-2.5">
                  <span className="flex min-w-0 items-center gap-2"><span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-violet/25 text-[10px] font-bold text-[#C9B8FF]">{initials(p.name)}</span><span className="truncate text-sm font-semibold">{p.name}</span></span>
                  {[cell(p.distanceKm, 1), cell(p.topSpeedKmh, 1), cell(p.shots), cell(p.dribblesWon)].map((v, i) => <N key={i} className={cn("text-end text-base font-bold", i >= 2 && "hidden sm:block")}>{v}</N>)}
                </div>
              ))}
              <div className="grid grid-cols-[minmax(0,1fr)_3rem_4rem] sm:grid-cols-[minmax(0,1fr)_3.5rem_4.5rem_3.5rem_4.5rem] items-center gap-2 rounded-xl border border-floodlight/40 bg-floodlight/5 px-3 py-2.5">
                <span className="flex items-center gap-2"><span className="flex h-7 w-7 items-center justify-center rounded-full border border-dashed border-floodlight text-xs font-bold text-floodlight">?</span><span className="text-sm font-semibold">{c.you}</span></span>
                {[0, 1, 2, 3].map((i) => <span key={i} className={cn("text-end font-display text-base text-muted-text", i >= 2 && "hidden sm:block")}>?</span>)}
              </div>
            </div>
          </div>
        </div>}
      />
    </Shell>
  );
}

function Unclaimed({ tile, c, now }: P<"unclaimed">) {
  const cells: Array<[string, string]> = [
    [c.topSpeed, c.units.topSpeedKmh],
    [c.distanceRan, c.units.distanceKm],
    [c.shotsOnGoal, c.units.shots],
    [c.successfulDribbles, c.units.dribblesWon],
  ];
  return (
    <Shell testId="unclaimed">
      <Two
        left={<>
          <Eyebrow>{matchWhen(tile.match, c, now)} · {tile.match.fieldName}</Eyebrow>
          <Head>{c.nobodyHead}</Head>
          <Body>{c.nobodyBody}</Body>
          <Cta href={`/find/${tile.findRecordingId}`}>{c.claimMatch}</Cta>
        </>}
        right={<div className="grid grid-cols-2 gap-3">
          {cells.map(([label, unit]) => (
            <div key={label} className="rounded-2xl bg-[#182035] p-4">
              <p className="text-sm text-muted-text">{label}</p>
              <p className="mt-2 flex items-baseline gap-2"><span className="font-display text-4xl font-bold text-turf">?</span><span className="text-sm text-[#4A5470]">{unit}</span></p>
            </div>
          ))}
        </div>}
      />
    </Shell>
  );
}
