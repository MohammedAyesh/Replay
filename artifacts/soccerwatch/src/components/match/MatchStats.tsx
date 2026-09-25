import { useEffect, useState } from "react";
import { Link } from "wouter";
import type { MatchStrings } from "@/i18n/match-strings";
import type { MatchRoom } from "@/lib/match-api";
import { labCss, type Lab } from "@/lib/game-claim/play";

/**
 * What the claims on this match's footage add up to (GET /m/:code/stats):
 * possession and passing per team, and each claimed player's own numbers
 * once stats are unlocked (or free, when the paywall setting is off).
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
  if (failed) return null;
  if (!stats) return <section className="rounded-2xl border border-line bg-surface p-4 text-sm text-muted-text">…</section>;
  const findHref = stats.recordings[0] ? `/find/${stats.recordings[0]}` : null;
  if (!stats.available) {
    return <section className="rounded-2xl border border-line bg-surface p-4 text-sm text-muted-text">{copy.matchStatsNoFootage}</section>;
  }
  const t = stats.team;
  const name = (side: string) => room.teams[side as "A" | "B"]?.name || side;
  const bar = (label: string, a: number, b: number, fmt: (v: number) => string) => {
    const tot = a + b || 1;
    return (
      <div className="grid grid-cols-[6.5rem_1fr] items-center gap-3 text-sm">
        <span className="text-muted-text">{label}</span>
        <div className="flex flex-col gap-1">
          <div className="flex h-2.5 overflow-hidden rounded-full">
            <i className="block h-full" style={{ width: `${(100 * a) / tot}%`, background: labCss(t!.colours[0]) }} />
            <i className="block h-full" style={{ width: `${(100 * b) / tot}%`, background: labCss(t!.colours[1]) }} />
          </div>
          <div dir="ltr" className="flex justify-between text-xs tabular-nums text-muted-text"><span>{fmt(a)}</span><span>{fmt(b)}</span></div>
        </div>
      </div>
    );
  };
  const players = (stats.players ?? []).filter((p) => p.claimed).sort((p, q) => (p.team ?? "Z").localeCompare(q.team ?? "Z") || (q.distanceKm ?? 0) - (p.distanceKm ?? 0));
  const unclaimed = (stats.players ?? []).filter((p) => !p.claimed);
  return (
    <section className="flex flex-col gap-4 rounded-2xl border border-line bg-surface p-4">
      <p className="text-base font-bold">{copy.matchStatsTitle}</p>
      {t ? (
        <div className="flex flex-col gap-3">
          <div className="flex justify-between text-sm font-semibold">
            {t.sides.map((side, i) => (
              <span key={side} className="flex items-center gap-2">
                <i className="inline-block h-3 w-3 rounded-full ring-1 ring-white/25" style={{ background: labCss(t.colours[i]) }} />
                {name(side)}
              </span>
            ))}
          </div>
          {bar(copy.teamPossession, t.possessionPercent[0], t.possessionPercent[1], (v) => `${Math.round(v)}%`)}
          {bar(copy.teamPasses, t.passesCompleted[0], t.passesCompleted[1], (v) => String(v))}
          {bar(copy.teamTouches, t.touches[0], t.touches[1], (v) => String(v))}
          <p className="text-xs text-muted-text">{copy.teamCompletion} {Math.round(t.completionPercent)}% · {t.measured.map((m) => copy.teamColoursFrom(m)).join(" / ")}</p>
        </div>
      ) : null}
      {stats.players ? (
        players.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-muted-text">
                  <th className="py-1 text-start font-medium">{copy.playerCol}</th>
                  <th className="py-1 text-end font-medium">{copy.kmCol}</th>
                  <th className="py-1 text-end font-medium">{copy.topCol}</th>
                  <th className="py-1 text-end font-medium">{copy.touchesCol}</th>
                  <th className="py-1 text-end font-medium">{copy.passesCol}</th>
                </tr>
              </thead>
              <tbody>
                {players.map((p) => (
                  <tr key={p.playerId} className="border-t border-line">
                    <td className="py-2">
                      <span className="flex items-center gap-2">
                        {p.team && <i className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: room.teams[p.team as "A" | "B"]?.color }} />}
                        {p.name}
                      </span>
                    </td>
                    <td dir="ltr" className="py-2 text-end tabular-nums">{p.distanceKm?.toFixed(1) ?? "—"}</td>
                    <td dir="ltr" className="py-2 text-end tabular-nums">{p.topSpeedKmh?.toFixed(1) ?? "—"}</td>
                    <td dir="ltr" className="py-2 text-end tabular-nums">{p.touches ?? "—"}</td>
                    <td dir="ltr" className="py-2 text-end tabular-nums">{p.passesTried === null ? "—" : `${p.passesCompleted ?? "–"}/${p.passesTried}`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {unclaimed.length > 0 && <p className="mt-2 text-xs text-muted-text">{unclaimed.map((p) => p.name).join(", ")} · {copy.notClaimed}</p>}
          </div>
        ) : <p className="text-sm text-muted-text">{copy.matchStatsNone}</p>
      ) : null}
      {findHref && (
        <Link href={findHref} className="flex min-h-11 items-center justify-center rounded-full border border-floodlight/60 text-sm font-bold text-floodlight">{copy.matchStatsClaim}</Link>
      )}
      <p className="text-xs text-muted-text">{copy.statsFloor}</p>
    </section>
  );
}
