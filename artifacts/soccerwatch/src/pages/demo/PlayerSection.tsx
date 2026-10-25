import { useMemo, useState } from "react";

import type { DemoCopy, Persona } from "./copy";
import { formatNumber, type DemoPlayer, type DemoReport } from "./data";
import { Heatmap, readable } from "./Report";

type Metric = { key: "distanceKm" | "touches" | "passesCompleted" | "minutes" | "topSpeedKmh"; label: string; unit: string; digits: number };

function average(values: number[]): number {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

export function PlayerSection({ report, persona, copy, reportCopy, locale }: {
  report: DemoReport;
  persona: Persona;
  copy: DemoCopy["sections"]["players"];
  reportCopy: DemoCopy["sections"]["report"];
  locale: "ar" | "en";
}) {
  const players = useMemo(() => {
    const hasEveryNumber = report.players.length > 0 && report.players.every((player) => /^\d+$/.test(player.number?.trim() ?? ""));
    const sorted = [...report.players].sort((a, b) => hasEveryNumber
      ? Number(a.number) - Number(b.number)
      : (b.distanceKm ?? -1) - (a.distanceKm ?? -1));
    return sorted.map((player, index) => ({
      ...player,
      label: hasEveryNumber
        ? `#${player.number}`
        : `${locale === "ar" ? "لاعب" : "Player"} ${formatNumber(index + 1, locale)}`,
    }));
  }, [report.players, locale]);
  const [selected, setSelected] = useState(0);
  const current: DemoPlayer | undefined = players[selected] ?? players[0];
  const sideColour = (side: 0 | 1 | null) => (report.team && side !== null ? readable(report.team.colours[side]) : "#8A93A6");

  const metrics = useMemo(() => {
    const all: Metric[] = [
      { key: "distanceKm", label: reportCopy.distance, unit: reportCopy.km, digits: 1 },
      { key: "touches", label: reportCopy.touches, unit: "", digits: 0 },
      { key: "passesCompleted", label: copy.passes, unit: "", digits: 0 },
      { key: "topSpeedKmh", label: reportCopy.topSpeed, unit: reportCopy.kmh, digits: 1 },
      { key: "minutes", label: reportCopy.minutes, unit: "", digits: 1 },
    ];
    return all.filter((m) => players.filter((p) => typeof p[m.key] === "number").length >= Math.max(2, players.length / 2));
  }, [players, reportCopy, copy.passes]);

  if (!current) return null;

  return (
    <div className="dm-players">
      <div className="dm-chips" role="group" aria-label={copy.pick}>
        {players.map((player, index) => (
          <button
            key={`${player.number ?? "player"}-${index}`}
            type="button"
            aria-pressed={index === selected}
            className={`dm-pchip ${index === selected ? "is-on" : ""}`}
            onClick={() => setSelected(index)}
          >
            <i style={{ background: sideColour(player.side) }} aria-hidden="true" />
            {player.label}
          </button>
        ))}
      </div>

      <div className="dm-pcard-grid">
        <article className="dm-pcard">
          <header className="dm-pcard-head">
            <span className="dm-pcard-badge" style={{ borderColor: sideColour(current.side) }}>{current.label}</span>
            <span className="dm-small">{copy.vsAverage}</span>
          </header>
          <dl className="dm-pstats">
            {metrics.map((metric) => {
              const values = players.map((p) => p[metric.key]).filter((v): v is number => typeof v === "number");
              const value = current[metric.key];
              const avg = average(values);
              const rank = typeof value === "number" ? values.filter((v) => v > value).length + 1 : null;
              const share = typeof value === "number" && avg > 0 ? Math.min(2, value / avg) : 0;
              return (
                <div key={metric.key} className="dm-pstat">
                  <dt>{metric.label}</dt>
                  <dd>
                    <span className="dm-num dm-pstat-value">
                      {typeof value === "number" ? formatNumber(value, locale, metric.digits) : "–"}
                      {metric.unit && <small> {metric.unit}</small>}
                    </span>
                    <span className="dm-pstat-bar" dir="ltr" aria-hidden="true">
                      <i style={{ width: `${share * 50}%` }} className={share >= 1 ? "is-up" : ""} />
                      <b />
                    </span>
                    <span className="dm-small">
                      {copy.average} {formatNumber(avg, locale, metric.digits)}
                      {rank !== null && ` · ${copy.rank(rank, values.length)}`}
                    </span>
                  </dd>
                </div>
              );
            })}
          </dl>
        </article>
        <div className="dm-pside">
          {current.heatmap.length > 0 && (
            <Heatmap player={current} colour="#D4FF4F" label={reportCopy.heatmap(current.label)} />
          )}
        </div>
      </div>
      <p className="dm-small">{reportCopy.find}</p>
    </div>
  );
}
