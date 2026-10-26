import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

import type { DemoCopy, Persona } from "./copy";
import { formatNumber, type DemoPlayer, type DemoReport } from "./data";
import { Heatmap, readable } from "./Report";

type MetricKey = "distanceKm" | "topSpeedKmh" | "passesCompleted";
type Metric = { key: MetricKey; label: string; unit: string; digits: number };

/**
 * One player at a time: three numbers in big type and where he played.
 * Starts on the player who ran furthest; the arrows step through the rest.
 * No averages or rank bars: an owner should read it in a glance.
 */
export function PlayerSection({ report, copy, reportCopy, locale }: {
  report: DemoReport;
  persona: Persona;
  copy: DemoCopy["sections"]["players"];
  reportCopy: DemoCopy["sections"]["report"];
  locale: "ar" | "en";
}) {
  const players = useMemo(() => {
    const hasEveryNumber = report.players.length > 0 && report.players.every((player) => /^\d+$/.test(player.number?.trim() ?? ""));
    const sorted = [...report.players].sort((a, b) => (b.distanceKm ?? -1) - (a.distanceKm ?? -1));
    return sorted.map((player, index) => ({
      ...player,
      label: hasEveryNumber
        ? `#${player.number}`
        : `${locale === "ar" ? "لاعب" : "Player"} ${formatNumber(index + 1, locale)}`,
    }));
  }, [report.players, locale]);
  const [selected, setSelected] = useState(0);
  const current: (DemoPlayer & { label: string }) | undefined = players[selected] ?? players[0];

  const metrics = useMemo(() => {
    const all: Metric[] = [
      { key: "distanceKm", label: reportCopy.distance, unit: reportCopy.km, digits: 1 },
      { key: "topSpeedKmh", label: reportCopy.topSpeed, unit: reportCopy.kmh, digits: 1 },
      { key: "passesCompleted", label: copy.passes, unit: "", digits: 0 },
    ];
    return all.filter((m) => players.filter((p) => typeof p[m.key] === "number").length >= Math.max(2, players.length / 2));
  }, [players, reportCopy, copy.passes]);

  if (!current) return null;
  const colour = report.team && current.side !== null ? readable(report.team.colours[current.side]) : "#8A93A6";
  const step = (delta: number) => setSelected((index) => (index + delta + players.length) % players.length);
  const rtl = locale === "ar";

  return (
    <article className="dm-pcard" aria-label={current.label}>
      <header className="dm-pcard-head">
        <button type="button" className="dm-icon-btn dm-pstep" onClick={() => step(-1)} aria-label={copy.previous}>
          {rtl ? <ChevronRight className="dm-icon" /> : <ChevronLeft className="dm-icon" />}
        </button>
        <div className="dm-pcard-who" aria-live="polite">
          <span className="dm-pcard-badge" style={{ borderColor: colour }}>{current.label}</span>
          <span className="dm-small">{copy.of(selected + 1, players.length)}</span>
        </div>
        <button type="button" className="dm-icon-btn dm-pstep" onClick={() => step(1)} aria-label={copy.next}>
          {rtl ? <ChevronLeft className="dm-icon" /> : <ChevronRight className="dm-icon" />}
        </button>
      </header>
      <dl className="dm-ptiles">
        {metrics.map((metric) => {
          const value = current[metric.key];
          const best = typeof value === "number" && players.every((p) => typeof p[metric.key] !== "number" || (p[metric.key] as number) <= value);
          return (
            <div key={metric.key} className={`dm-ptile ${best ? "is-best" : ""}`}>
              <dt>{metric.label}</dt>
              <dd>
                <span className="dm-num">{typeof value === "number" ? formatNumber(value, locale, metric.digits) : "–"}</span>
                {metric.unit && <small>{metric.unit}</small>}
                {best && <em>{copy.best}</em>}
              </dd>
            </div>
          );
        })}
      </dl>
      {current.heatmap.length > 0 && (
        <Heatmap player={current} colour="#D4FF4F" label={reportCopy.heatmap(current.label)} />
      )}
    </article>
  );
}
