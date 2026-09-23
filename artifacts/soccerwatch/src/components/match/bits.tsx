import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import type { MatchPhase, MatchPlayer, StandingRow, TeamSide } from "@/lib/match-api";

/** A face, or initials on a raised disc when there's no photo. */
export function PlayerAvatar({
  name,
  initials,
  avatarUrl,
  size = 40,
  ring,
  dashed,
  className,
}: {
  name: string;
  initials?: string;
  avatarUrl?: string | null;
  size?: number;
  ring?: string;
  dashed?: boolean;
  className?: string;
}) {
  const [broken, setBroken] = useState(false);
  const letters = initials ?? (name.trim().split(/\s+/).slice(0, 2).map((p) => Array.from(p)[0] ?? "").join("").toUpperCase() || "?");
  return (
    <span
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-raised font-display font-bold text-text",
        dashed ? "border border-dashed border-muted-text/60 bg-transparent text-muted-text" : "border border-line",
        className,
      )}
      style={{
        width: size,
        height: size,
        fontSize: Math.max(10, Math.round(size * 0.38)),
        boxShadow: ring ? `0 0 0 2px ${ring}` : undefined,
      }}
      aria-label={name}
      title={name}
    >
      {avatarUrl && !broken ? (
        <img src={avatarUrl} alt="" className="h-full w-full object-cover" onError={() => setBroken(true)} loading="lazy" />
      ) : (
        <span aria-hidden="true">{letters}</span>
      )}
    </span>
  );
}

/** Server-anchored clock so countdowns don't drift with a wrong phone clock. */
export function useServerNow(serverNow: string | undefined, tickMs = 1000): number {
  const offset = useMemo(() => {
    const parsed = serverNow ? Date.parse(serverNow) : NaN;
    return Number.isFinite(parsed) ? parsed - Date.now() : 0;
  }, [serverNow]);
  const [now, setNow] = useState(() => Date.now() + offset);
  useEffect(() => {
    setNow(Date.now() + offset);
    const timer = window.setInterval(() => setNow(Date.now() + offset), tickMs);
    return () => window.clearInterval(timer);
  }, [offset, tickMs]);
  return now;
}

export function splitDuration(ms: number) {
  const safe = Math.max(0, Math.floor(ms / 1000));
  return {
    days: Math.floor(safe / 86400),
    hours: Math.floor((safe % 86400) / 3600),
    minutes: Math.floor((safe % 3600) / 60),
    seconds: safe % 60,
  };
}

export function Countdown({ targetMs, now, labels }: {
  targetMs: number;
  now: number;
  labels: { days: string; hours: string; minutes: string; seconds: string };
}) {
  const d = splitDuration(targetMs - now);
  const cells: Array<[number, string]> = d.days > 0
    ? [[d.days, labels.days], [d.hours, labels.hours], [d.minutes, labels.minutes]]
    : [[d.hours, labels.hours], [d.minutes, labels.minutes], [d.seconds, labels.seconds]];
  return (
    <div className="flex items-end gap-2" dir="ltr">
      {cells.map(([value, label], i) => (
        <div key={i} className="flex items-baseline gap-0.5">
          <span className="font-mono text-4xl font-bold leading-none tabular-nums text-text">{String(value).padStart(2, "0")}</span>
          <span className="text-xs font-semibold text-muted-text">{label}</span>
        </div>
      ))}
    </div>
  );
}

export function PhaseChip({ phase, label }: { phase: MatchPhase; label: string }) {
  const live = phase === "live";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide",
        live ? "border-live/40 bg-live/15 text-live" : phase === "ready" ? "border-turf/40 bg-turf/10 text-turf" : "border-line bg-raised text-muted-text",
      )}
    >
      {live && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-live" />}
      {label}
    </span>
  );
}

/** Squad fill bar: in (turf), maybe (violet), open. */
export function SquadBar({ inCount, maybe, needed }: { inCount: number; maybe: number; needed: number }) {
  const total = Math.max(needed, inCount + maybe, 1);
  return (
    <div className="flex h-2 w-full overflow-hidden rounded-full bg-raised" aria-hidden="true">
      <span className="h-full bg-turf transition-all" style={{ width: `${(inCount / total) * 100}%` }} />
      <span className="h-full bg-violet/70 transition-all" style={{ width: `${(maybe / total) * 100}%` }} />
    </div>
  );
}

export const TEAM_SWATCHES = ["#F2F4F8", "#FF6B1A", "#7AA2FF", "#2FD8C4", "#FFD23F", "#7B5CFF", "#1F8A4C", "#0B0F1A"];

function readableOn(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return "#0B0F1A";
  const n = Number.parseInt(m[1], 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return (0.299 * r + 0.587 * g + 0.114 * b) > 150 ? "#0B0F1A" : "#F2F4F8";
}

/**
 * The teams board: a vertical pitch, team A defends the bottom half.
 * Managers tap a player, then tap a spot to move them (the half decides the team).
 */
export function PitchBoard({
  players,
  colors,
  editable,
  selectedId,
  onSelect,
  onPlace,
  captainUserId,
}: {
  players: MatchPlayer[];
  colors: Record<TeamSide, string>;
  editable: boolean;
  selectedId: number | null;
  onSelect: (id: number | null) => void;
  onPlace: (x: number, y: number) => void;
  captainUserId: number | null;
}) {
  const placed = players.filter((p) => p.team && p.slotX != null && p.slotY != null && p.rsvp !== "out");
  const onPitchClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!editable || selectedId == null) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * 100;
    const y = ((event.clientY - rect.top) / rect.height) * 100;
    onPlace(Math.min(96, Math.max(4, x)), Math.min(97, Math.max(3, y)));
  };
  return (
    <div
      className={cn(
        "relative mx-auto aspect-[3/4] w-full max-w-[360px] overflow-hidden rounded-2xl border border-line",
        editable && selectedId != null && "cursor-crosshair ring-2 ring-turf/60",
      )}
      style={{ background: "repeating-linear-gradient(180deg,#0F2A2A 0 12.5%,#0D2525 12.5% 25%)" }}
      onClick={onPitchClick}
      dir="ltr"
    >
      <svg viewBox="0 0 300 400" className="pointer-events-none absolute inset-0 h-full w-full" preserveAspectRatio="none" aria-hidden="true">
        <g fill="none" stroke="#2FD8C4" strokeOpacity="0.35" strokeWidth="2">
          <rect x="8" y="8" width="284" height="384" rx="6" />
          <line x1="8" y1="200" x2="292" y2="200" />
          <circle cx="150" cy="200" r="40" />
          <rect x="85" y="8" width="130" height="55" />
          <rect x="85" y="337" width="130" height="55" />
        </g>
      </svg>
      {placed.map((p) => {
        const color = colors[p.team as TeamSide];
        const selected = selectedId === p.id;
        return (
          <button
            key={p.id}
            type="button"
            disabled={!editable}
            onClick={(e) => {
              e.stopPropagation();
              if (editable) onSelect(selected ? null : p.id);
            }}
            className={cn("absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-0.5 transition-all", selected && "scale-110")}
            style={{ left: `${p.slotX}%`, top: `${p.slotY}%` }}
          >
            <span className="relative">
              <span
                className="flex h-10 w-10 items-center justify-center overflow-hidden rounded-full border-2 font-display text-sm font-bold"
                style={{ background: color, color: readableOn(color), borderColor: selected ? "#D4FF4F" : "rgba(11,15,26,.6)" }}
              >
                {p.avatarUrl ? <img src={p.avatarUrl} alt="" className="h-full w-full object-cover" /> : (p.shirtNumber ?? p.initials)}
              </span>
              {p.userId != null && p.userId === captainUserId && (
                <span className="absolute -end-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-floodlight text-[9px] font-black text-void">C</span>
              )}
            </span>
            <span className="max-w-[72px] truncate rounded bg-void/70 px-1 text-[10px] font-semibold text-text">{p.name}</span>
          </button>
        );
      })}
    </div>
  );
}

export function ScoreLine({ score, colors, names, size = "lg" }: {
  score: { a: number; b: number } | null;
  colors: Record<TeamSide, string>;
  names: Record<TeamSide, string>;
  size?: "lg" | "sm";
}) {
  return (
    <div className="flex items-center justify-center gap-4" dir="ltr">
      <TeamTag color={colors.A} name={names.A} />
      <span className={cn("font-mono font-bold tabular-nums text-text", size === "lg" ? "text-5xl" : "text-2xl")}>
        {score ? `${score.a}–${score.b}` : "–"}
      </span>
      <TeamTag color={colors.B} name={names.B} />
    </div>
  );
}

/** Three-team sessions: the table, best first. */
export function StandingsTable({ rows, colors, names, leader, labels, compact = false }: {
  rows: StandingRow[];
  colors: Record<TeamSide, string>;
  names: Record<TeamSide, string>;
  leader: TeamSide | null;
  labels: { table: string; topOfTable: string; tableCols: { p: string; w: string; d: string; l: string; gd: string; pts: string } };
  compact?: boolean;
}) {
  const c = labels.tableCols;
  const cols = compact ? [c.p, c.gd, c.pts] : [c.p, c.w, c.d, c.l, c.gd, c.pts];
  return (
    <div>
      <div className="flex items-center gap-2 px-1 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-text">
        <span className="flex-1">{labels.table}</span>
        {cols.map((h) => <span key={h} className="w-8 text-center">{h}</span>)}
      </div>
      <ul className="flex flex-col gap-1">
        {rows.map((r, i) => {
          const gd = r.goalsFor - r.goalsAgainst;
          const values = compact ? [r.played, gd, r.points] : [r.played, r.won, r.drawn, r.lost, gd, r.points];
          return (
            <li key={r.team} className={cn("flex items-center gap-2 rounded-xl px-2 py-2", leader === r.team ? "bg-floodlight/10" : "bg-raised/60")} data-testid={`standing-${r.team}`}>
              <span className="w-4 font-mono text-xs text-muted-text">{i + 1}</span>
              <span className="h-3.5 w-3.5 shrink-0 rounded-full border border-line" style={{ background: colors[r.team] }} />
              <span className="min-w-0 flex-1 truncate text-sm font-semibold">
                {names[r.team]}
                {leader === r.team && <span className="ms-1.5 text-[10px] font-bold uppercase text-floodlight">{labels.topOfTable}</span>}
              </span>
              {values.map((v, j) => (
                <span key={j} dir="ltr" className={cn("w-8 text-center font-mono text-sm tabular-nums", j === values.length - 1 ? "font-bold text-text" : "text-muted-text")}>
                  {j === values.length - 2 && v > 0 ? `+${v}` : v}
                </span>
              ))}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function TeamTag({ color, name }: { color: string; name: string }) {
  return (
    <span className="flex min-w-0 flex-col items-center gap-1">
      <span className="h-5 w-5 rounded-full border border-line" style={{ background: color }} />
      <span className="max-w-[90px] truncate text-xs font-semibold text-muted-text">{name}</span>
    </span>
  );
}

export function formatClock(ms: number, locale: "en" | "ar"): string {
  return new Intl.DateTimeFormat(locale === "ar" ? "ar-JO" : "en-GB", {
    timeZone: "Asia/Amman", hour: "numeric", minute: "2-digit", hour12: locale === "en" ? false : true,
  }).format(new Date(ms));
}

export function formatDay(ms: number, locale: "en" | "ar", now: number, labels: { today: string; tomorrow: string }): string {
  const key = (v: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Amman" }).format(new Date(v));
  if (key(ms) === key(now)) return labels.today;
  if (key(ms) === key(now + 86400000)) return labels.tomorrow;
  return new Intl.DateTimeFormat(locale === "ar" ? "ar-JO" : "en-GB", {
    timeZone: "Asia/Amman", weekday: "long", day: "numeric", month: "short",
  }).format(new Date(ms));
}

export function formatDate(ms: number, locale: "en" | "ar"): string {
  return new Intl.DateTimeFormat(locale === "ar" ? "ar-JO" : "en-GB", {
    timeZone: "Asia/Amman", day: "numeric", month: "short",
  }).format(new Date(ms));
}
