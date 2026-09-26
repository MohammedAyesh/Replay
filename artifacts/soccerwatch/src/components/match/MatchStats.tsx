import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import type { MatchStrings } from "@/i18n/match-strings";
import type { MatchRoom, TeamSide } from "@/lib/match-api";
import type { Lab } from "@/lib/game-claim/play";
import { cn } from "@/lib/utils";

/**
 * The match, head to head (GET /m/:code/stats): the two sides mirrored
 * metric by metric, then any two claimed players side by side. Team numbers
 * come from the ball (possession, passing, dribbles, shots, goals spotted);
 * distance and speed add up the players who have claimed themselves.
 */

type PlayerStats = {
  playerId: number;
  name: string;
  team: string | null;
  claimed: boolean;
  minutes: number | null;
  distanceKm: number | null;
  topSpeedKmh: number | null;
  touches: number | null;
  passesTried: number | null;
  passesCompleted: number | null;
  passesReceived: number | null;
  dribbles?: number | null;
  dribblesWon: number | null;
  dribblesLost: number | null;
  shots: number | null;
  goals: number | null;
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

type Stats = {
  available: boolean;
  recordings: number[];
  hasBall: boolean;
  hasPitch: boolean;
  unlocked: boolean;
  players: PlayerStats[] | null;
  team: TeamStats | null;
};

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

const pct = (x: number, y: number) => (y > 0 ? Math.round((100 * x) / y) : 0);

/** One metric, mirrored: side A grows left from the middle, side B grows right. */
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

export function MatchStats({ room, copy }: { room: MatchRoom; copy: MatchStrings }) {
  const [stats, setStats] = useState<Stats | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    fetch(`${basePath}/api/m/${room.code}/stats`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((s: Stats) => { if (live) setStats(s); })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [room.code, room.stats.unlocked]);

  const claimed = useMemo(() => (stats?.players ?? []).filter((p) => p.claimed), [stats]);
  const [pa, setPa] = useState<number | null>(null);
  const [pb, setPb] = useState<number | null>(null);
  useEffect(() => {
    if (!claimed.length) return;
    // default: the busiest player on each side, or the two busiest overall
    const byKm = [...claimed].sort((p, q) => (q.distanceKm ?? 0) - (p.distanceKm ?? 0));
    const first = byKm.find((p) => p.team === "A") ?? byKm[0];
    const second = byKm.find((p) => p.team && p.team !== first.team) ?? byKm.find((p) => p.playerId !== first.playerId) ?? null;
    setPa((v) => v ?? first.playerId);
    setPb((v) => v ?? second?.playerId ?? null);
  }, [claimed]);

  if (failed) return null;
  if (!stats) return <section className="rounded-2xl border border-line bg-surface p-4 text-sm text-muted-text">…</section>;
  const findHref = stats.recordings[0] ? `/find/${stats.recordings[0]}` : null;
  if (!stats.available) {
    return <section className="rounded-2xl border border-line bg-surface p-4 text-sm text-muted-text">{copy.matchStatsNoFootage}</section>;
  }
  const t = stats.team;
  const name = (side: string) => room.teams[side as TeamSide]?.name || side;
  const colors: [string, string] = [room.teams.A.color, room.teams.B.color];
  const bySide = (side: "A" | "B") => claimed.filter((p) => p.team === side);
  const km = (side: "A" | "B") => bySide(side).reduce((s, p) => s + (p.distanceKm ?? 0), 0);
  const top = (side: "A" | "B") => bySide(side).reduce((s, p) => Math.max(s, p.topSpeedKmh ?? 0), 0);
  const hasSideKm = km("A") > 0 || km("B") > 0;
  const int = (v: number) => String(Math.round(v));

  const playerA = claimed.find((p) => p.playerId === pa) ?? null;
  const playerB = claimed.find((p) => p.playerId === pb) ?? null;
  const pvpRows: Array<[string, (p: PlayerStats) => number | null, (v: number) => string]> = [
    [copy.pvpMinutes, (p) => p.minutes, int],
    [copy.pvpKm, (p) => p.distanceKm, (v) => v.toFixed(2)],
    [copy.pvpTop, (p) => p.topSpeedKmh, (v) => v.toFixed(1)],
    [copy.pvpTouches, (p) => p.touches, int],
    [copy.pvpPasses, (p) => p.passesCompleted, int],
    [copy.pvpDribbles, (p) => p.dribbles ?? (p.dribblesWon === null ? null : p.dribblesWon + (p.dribblesLost ?? 0)), int],
    [copy.pvpDribblesWon, (p) => p.dribblesWon, int],
    [copy.pvpDribblesLost, (p) => p.dribblesLost, int],
    [copy.pvpShots, (p) => p.shots, int],
    [copy.pvpGoals, (p) => p.goals, int],
  ];
  const playerColor = (p: PlayerStats | null, fallback: string) => (p?.team ? room.teams[p.team as TeamSide]?.color ?? fallback : fallback);
  const pvpA = playerColor(playerA, colors[0]);
  const pvpB = playerColor(playerB, colors[1]);
  // two players on one side still need two colours to be told apart
  const pvpColors: [string, string] = pvpA.toLowerCase() === pvpB.toLowerCase() ? [pvpA, "#7B5CFF"] : [pvpA, pvpB];

  return (
    <section className="flex flex-col gap-5 rounded-2xl border border-line bg-surface p-4">
      <div>
        <p className="text-base font-bold">{copy.h2hTitle}</p>
        <div className="mt-3 grid grid-cols-[1fr_auto_1fr] items-center gap-2" dir="ltr">
          <span className="flex min-w-0 items-center gap-2 text-sm font-bold">
            <i className="inline-block h-3 w-3 shrink-0 rounded-full ring-1 ring-white/25" style={{ background: colors[0] }} />
            <span className="truncate">{name("A")}</span>
          </span>
          <span className="font-mono text-xs text-muted-text">vs</span>
          <span className="flex min-w-0 items-center justify-end gap-2 text-sm font-bold">
            <span className="truncate">{name("B")}</span>
            <i className="inline-block h-3 w-3 shrink-0 rounded-full ring-1 ring-white/25" style={{ background: colors[1] }} />
          </span>
        </div>
      </div>

      {t && (
        <div className="flex flex-col gap-3.5">
          {t.goals && (t.goals[0] + t.goals[1] > 0) && <MirrorRow label={copy.h2hGoals} a={t.goals[0]} b={t.goals[1]} fmt={int} colors={colors} />}
          {t.shots && <MirrorRow label={copy.h2hShots} a={t.shots[0]} b={t.shots[1]} fmt={int} colors={colors} />}
          <MirrorRow label={copy.teamPossession} a={t.possessionPercent[0]} b={t.possessionPercent[1]} fmt={(v) => `${Math.round(v)}%`} colors={colors} />
          <MirrorRow label={copy.teamPasses} a={t.passesCompleted[0]} b={t.passesCompleted[1]} fmt={int} colors={colors} />
          <MirrorRow
            label={copy.teamCompletion}
            a={pct(t.passesCompleted[0], t.passesTried[0])}
            b={pct(t.passesCompleted[1], t.passesTried[1])}
            fmt={(v) => `${v}%`}
            colors={colors}
          />
          {t.dribblesWon && (
            <>
              <MirrorRow label={copy.h2hDribbles} a={(t.dribbles ?? t.dribblesWon)[0]} b={(t.dribbles ?? t.dribblesWon)[1]} fmt={int} colors={colors} />
              <MirrorRow
                label={copy.h2hDribbleRate}
                a={pct(t.dribblesWon[0], t.dribblesWon[0] + (t.dribblesLost?.[0] ?? 0))}
                b={pct(t.dribblesWon[1], t.dribblesWon[1] + (t.dribblesLost?.[1] ?? 0))}
                fmt={(v) => `${v}%`}
                colors={colors}
              />
            </>
          )}
          <MirrorRow label={copy.teamTouches} a={t.touches[0]} b={t.touches[1]} fmt={int} colors={colors} />
          {hasSideKm && (
            <>
              <MirrorRow label={copy.h2hDistance} a={km("A")} b={km("B")} fmt={(v) => `${v.toFixed(1)} km`} colors={colors} />
              <MirrorRow label={copy.h2hTopSpeed} a={top("A")} b={top("B")} fmt={(v) => (v ? v.toFixed(1) : "—")} colors={colors} />
              <p className="text-[11px] text-muted-text">{copy.h2hClaimedOnly}</p>
            </>
          )}
        </div>
      )}

      {stats.players && claimed.length >= 2 && (
        <div className="flex flex-col gap-3 border-t border-line pt-4">
          <div>
            <p className="text-base font-bold">{copy.pvpTitle}</p>
            <p className="mt-0.5 text-xs text-muted-text">{copy.pvpHint}</p>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {[{ v: pa, set: setPa, other: pb }, { v: pb, set: setPb, other: pa }].map((sel, i) => (
              <select
                key={i}
                value={sel.v ?? ""}
                onChange={(e) => sel.set(Number(e.target.value))}
                className="min-h-11 rounded-xl border border-line bg-raised px-3 text-sm font-semibold text-text"
              >
                {claimed.map((p) => (
                  <option key={p.playerId} value={p.playerId} disabled={p.playerId === sel.other}>{p.name}</option>
                ))}
              </select>
            ))}
          </div>
          {playerA && playerB && (
            <div className="flex flex-col gap-3">
              {pvpRows.map(([label, get, fmt]) => {
                const a = get(playerA);
                const b = get(playerB);
                if (a === null && b === null) return null;
                return (
                  <MirrorRow
                    key={label}
                    label={label}
                    a={a ?? 0}
                    b={b ?? 0}
                    fmt={(v) => (v === 0 && (label === copy.pvpTop) ? "—" : fmt(v))}
                    colors={pvpColors}
                  />
                );
              })}
            </div>
          )}
        </div>
      )}

      {stats.players && claimed.length === 0 && <p className="text-sm text-muted-text">{copy.matchStatsNone}</p>}
      {stats.players && claimed.length > 0 && (stats.players.length - claimed.length) > 0 && (
        <p className="text-xs text-muted-text">{stats.players.filter((p) => !p.claimed).map((p) => p.name).join(", ")} · {copy.notClaimed}</p>
      )}
      {findHref && (
        <Link href={findHref} className="flex min-h-11 items-center justify-center rounded-full border border-floodlight/60 text-sm font-bold text-floodlight">{copy.matchStatsClaim}</Link>
      )}
      <p className="text-xs text-muted-text">{copy.statsFloor}</p>
    </section>
  );
}
