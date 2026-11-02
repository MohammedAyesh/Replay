import { useMemo } from "react";
import type { AcademyPlayerStats, AcademyTeamStats } from "@/lib/academy-matches-api";
import { COMPARE_COLOURS, METRICS, formatMetric, ratingsFor, type Metric, type MetricKey } from "@/lib/academy-match-metrics";
import type { MatchesStrings } from "@/i18n/matches-strings";
import { cn } from "@/lib/utils";

type Copy = MatchesStrings & { locale: "ar" | "en" };

export type TablePlayer = { playerId: number; name: string; shirtNumber?: number | null; stats: AcademyPlayerStats; highlight?: boolean };

const TABLE_METRICS: MetricKey[] = ["rating", "minutes", "distance", "topSpeed", "touches", "passes", "accuracy", "dribbles", "shots", "goals"];

function metric(key: MetricKey): Metric {
  return METRICS.find((m) => m.key === key)!;
}

/** Us vs them, one split bar per stat. */
export function TeamStatsBars({ team, hasBall, copy }: { team: AcademyTeamStats; hasBall: boolean; copy: Copy }) {
  const rows: Array<{ label: string; values: [number, number]; percent?: boolean }> = [
    ...(hasBall ? [{ label: copy.stats.possession, values: team.possessionPercent, percent: true }] : []),
    { label: copy.stats.teamPasses, values: team.passesCompleted },
    { label: copy.stats.touches, values: team.touches },
    { label: copy.stats.dribbles, values: team.dribblesWon },
    { label: copy.stats.shots, values: team.shots },
    { label: copy.stats.goals, values: team.goals },
  ];
  return (
    <div className="space-y-3" data-testid="match-team-stats">
      <div className="flex justify-between text-xs font-bold uppercase tracking-wide text-muted-text"><span>{copy.stats.us}</span><span>{copy.stats.them}</span></div>
      {rows.map((row) => {
        const [a, b] = row.values;
        const total = a + b;
        const share = total > 0 ? a / total : 0.5;
        return (
          <div key={row.label}>
            <div className="flex items-baseline justify-between text-sm">
              <span className="font-display text-lg font-bold tabular-nums text-text">{row.percent ? `${Math.round(a)}%` : a}</span>
              <span className="text-xs text-muted-text">{row.label}</span>
              <span className="font-display text-lg font-bold tabular-nums text-muted-text">{row.percent ? `${Math.round(b)}%` : b}</span>
            </div>
            <div className="mt-1 flex h-2 overflow-hidden rounded-full bg-raised">
              <div className="h-full bg-turf" style={{ width: `${share * 100}%` }} />
              <div className="h-full flex-1 bg-white/20" />
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Every player's numbers for one match, with the Replay rating. Tick boxes pick players to compare. */
export function PlayerStatsTable({ players, copy, selected, onToggle }: { players: TablePlayer[]; copy: Copy; selected?: number[]; onToggle?: (playerId: number) => void }) {
  const ratings = useMemo(() => ratingsFor(players), [players]);
  const rows = useMemo(
    () => [...players].sort((a, b) => (ratings.get(b.playerId) ?? -1) - (ratings.get(a.playerId) ?? -1) || (b.stats.minutes ?? 0) - (a.stats.minutes ?? 0)),
    [players, ratings],
  );
  const units = { km: copy.stats.km, kmh: copy.stats.kmh };
  return (
    <div className="overflow-x-auto rounded-2xl border border-line bg-surface" data-testid="match-player-table">
      <table className="w-full min-w-[760px] text-sm">
        <thead>
          <tr className="border-b border-line text-[11px] font-bold uppercase tracking-wide text-muted-text">
            {onToggle && <th className="w-10 px-3 py-2" />}
            <th className="px-3 py-2 text-start">{copy.stats.player}</th>
            {TABLE_METRICS.map((key) => <th key={key} className="px-2 py-2 text-end">{copy.stats[key]}</th>)}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((p) => {
            const rating = ratings.get(p.playerId) ?? null;
            const pick = selected?.indexOf(p.playerId) ?? -1;
            return (
              <tr key={p.playerId} className={cn(p.highlight && "bg-floodlight/10")} data-testid={`match-player-row-${p.playerId}`}>
                {onToggle && (
                  <td className="px-3 py-2">
                    <input type="checkbox" checked={pick >= 0} onChange={() => onToggle(p.playerId)} className="h-4 w-4 accent-[#2FD8C4]" aria-label={`${copy.stats.compare} ${p.name}`} />
                  </td>
                )}
                <td className="px-3 py-2">
                  <span className="flex items-center gap-2">
                    {pick >= 0 && <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: COMPARE_COLOURS[pick] }} />}
                    {p.shirtNumber != null && <span className="w-6 shrink-0 text-center font-display font-bold tabular-nums text-muted-text">{p.shirtNumber}</span>}
                    <span className={cn("font-semibold", p.highlight ? "text-floodlight" : "text-text")} dir="auto">{p.name}</span>
                  </span>
                </td>
                {TABLE_METRICS.map((key) => {
                  const m = metric(key);
                  const value = m.value(p.stats, rating);
                  return (
                    <td key={key} className={cn("px-2 py-2 text-end tabular-nums", key === "rating" ? "font-display font-bold text-text" : "text-muted-text")}>
                      {key === "rating" && rating !== null
                        ? <span className={cn("rounded-md px-1.5 py-0.5", rating >= 7.5 ? "bg-turf/20 text-turf" : rating >= 6.5 ? "bg-floodlight/15 text-floodlight" : "bg-raised text-text")}>{formatMetric(value, m, copy.locale, units)}</span>
                        : formatMetric(value, m, copy.locale, units)}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export type ComparePlayer = { id: number | string; name: string; values: Partial<Record<MetricKey, number | null>> };

/** Two or three players, one bar each per stat, scaled to the best of them. */
export function CompareBars({ players, copy, metrics = TABLE_METRICS }: { players: ComparePlayer[]; copy: Copy; metrics?: MetricKey[] }) {
  const units = { km: copy.stats.km, kmh: copy.stats.kmh };
  return (
    <div className="space-y-4" data-testid="match-compare">
      <div className="flex flex-wrap gap-3">
        {players.map((p, i) => (
          <span key={p.id} className="flex items-center gap-1.5 text-sm font-semibold text-text" dir="auto">
            <span className="h-2.5 w-2.5 rounded-full" style={{ background: COMPARE_COLOURS[i] }} />{p.name}
          </span>
        ))}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {metrics.map((key) => {
          const m = metric(key);
          const values = players.map((p) => p.values[key] ?? null);
          const max = Math.max(0, ...values.map((v) => v ?? 0));
          if (values.every((v) => v === null)) return null;
          return (
            <div key={key}>
              <p className="text-xs font-bold uppercase tracking-wide text-muted-text">{copy.stats[key]}</p>
              <div className="mt-1.5 space-y-1.5">
                {values.map((v, i) => (
                  <div key={players[i].id} className="flex items-center gap-2">
                    <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-raised">
                      <div className="h-full rounded-full" style={{ width: `${max > 0 && v !== null ? Math.max(3, (v / max) * 100) : 0}%`, background: COMPARE_COLOURS[i] }} />
                    </div>
                    <span className="w-16 shrink-0 text-end text-xs font-semibold tabular-nums text-text">{formatMetric(v, m, copy.locale, units)}</span>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** One match's values, keyed by metric, for CompareBars. */
export function matchValues(stats: AcademyPlayerStats, rating: number | null): Partial<Record<MetricKey, number | null>> {
  return Object.fromEntries(METRICS.map((m) => [m.key, m.value(stats, rating)]));
}

export function scoreLine(session: { ownScore: number | null; opponentScore: number | null }): string | null {
  return session.ownScore !== null && session.opponentScore !== null ? `${session.ownScore} – ${session.opponentScore}` : null;
}
