import { useState } from "react";

import type { DemoCopy } from "./copy";
import { formatNumber, type DemoPlayer, type DemoReport } from "./data";

type Copy = DemoCopy["sections"]["report"];

function readable(hex: string): string {
  // Kits are measured under floodlights; a near-black kit would vanish on the
  // page background, so it is lifted to a visible grey.
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return "#8A93A6";
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return luminance < 0.22 ? "#5B6275" : hex;
}

function Bar({ label, a, b, colours, suffix = "", locale }: {
  label: string;
  a: number;
  b: number;
  colours: [string, string];
  suffix?: string;
  locale: "ar" | "en";
}) {
  const total = a + b;
  const share = total > 0 ? a / total : 0.5;
  return (
    <div className="dm-bar">
      <div className="dm-bar-top" dir="ltr">
        <span className="dm-num">{formatNumber(a, locale)}{suffix}</span>
        <span className="dm-bar-label" dir={locale === "ar" ? "rtl" : "ltr"}>{label}</span>
        <span className="dm-num">{formatNumber(b, locale)}{suffix}</span>
      </div>
      <div className="dm-bar-track" dir="ltr" aria-hidden="true">
        <span style={{ width: `${share * 100}%`, background: readable(colours[0]) }} />
        <span style={{ width: `${(1 - share) * 100}%`, background: readable(colours[1]) }} />
      </div>
    </div>
  );
}

function Heatmap({ player, colour, label }: { player: DemoPlayer; colour: string; label: string }) {
  const max = Math.max(0.0001, ...player.heatmap.map((cell) => cell.weight));
  return (
    <figure className="dm-heat">
      <svg viewBox="0 0 120 80" role="img" aria-label={label}>
        <rect x="0" y="0" width="120" height="80" fill="#10251C" />
        {player.heatmap.map((cell) => (
          <rect
            key={`${cell.x}:${cell.y}`}
            x={(cell.x - 1 / 24) * 120}
            y={(cell.y - 1 / 16) * 80}
            width={10}
            height={10}
            fill={colour}
            opacity={0.15 + 0.8 * (cell.weight / max)}
          />
        ))}
        <g fill="none" stroke="rgba(255,255,255,.55)" strokeWidth="0.6">
          <rect x="1" y="1" width="118" height="78" />
          <line x1="60" y1="1" x2="60" y2="79" />
          <circle cx="60" cy="40" r="9" />
          <rect x="1" y="24" width="12" height="32" />
          <rect x="107" y="24" width="12" height="32" />
        </g>
      </svg>
      <figcaption className="dm-small">{label}</figcaption>
    </figure>
  );
}

export function Report({ report, copy, locale }: { report: DemoReport; copy: Copy; locale: "ar" | "en" }) {
  const withHeat = report.players.filter((player) => player.heatmap.length > 0);
  const [selected, setSelected] = useState<string | null>(withHeat[0]?.label ?? null);
  const current = report.players.find((player) => player.label === selected) ?? withHeat[0] ?? null;
  const team = report.team;
  const sideColour = (side: 0 | 1 | null) => (team && side !== null ? readable(team.colours[side]) : "#8A93A6");
  const showSpeed = report.players.some((player) => player.topSpeedKmh !== null);
  const showDistance = report.players.some((player) => player.distanceKm !== null);
  const showTouches = report.players.some((player) => player.touches !== null);

  return (
    <div className="dm-report">
      {team && (
        <div className="dm-scorebug">
          <div className="dm-scorebug-teams" dir="ltr">
            <span className="dm-team"><i style={{ background: readable(team.colours[0]) }} />{copy.teamA}</span>
            <span className="dm-score dm-num">{team.goals[0]} – {team.goals[1]}</span>
            <span className="dm-team dm-team--end">{copy.teamB}<i style={{ background: readable(team.colours[1]) }} /></span>
          </div>
          <Bar label={copy.possession} a={team.possessionPercent[0]} b={team.possessionPercent[1]} colours={team.colours} suffix="%" locale={locale} />
          <Bar label={copy.passes} a={team.passesCompleted[0]} b={team.passesCompleted[1]} colours={team.colours} locale={locale} />
          <Bar label={copy.shots} a={team.shots[0]} b={team.shots[1]} colours={team.colours} locale={locale} />
          <Bar label={copy.dribbles} a={team.dribblesWon[0]} b={team.dribblesWon[1]} colours={team.colours} locale={locale} />
        </div>
      )}

      {report.players.length > 0 && (
        <div className="dm-report-grid">
          <div className="dm-table-wrap">
            <table className="dm-table">
              <thead>
                <tr>
                  <th scope="col">{copy.player}</th>
                  <th scope="col">{copy.minutes}</th>
                  {showDistance && <th scope="col">{copy.distance}</th>}
                  {showSpeed && <th scope="col">{copy.topSpeed}</th>}
                  {showTouches && <th scope="col">{copy.touches}</th>}
                </tr>
              </thead>
              <tbody>
                {report.players.map((player) => (
                  <tr
                    key={player.label}
                    className={current?.label === player.label ? "is-on" : ""}
                  >
                    <th scope="row">
                      <button type="button" className="dm-row-btn" onClick={() => setSelected(player.label)} disabled={player.heatmap.length === 0}>
                        <i style={{ background: sideColour(player.side) }} aria-hidden="true" />
                        {player.label}
                      </button>
                    </th>
                    <td className="dm-num">{formatNumber(player.minutes, locale)}</td>
                    {showDistance && <td className="dm-num">{player.distanceKm === null ? "–" : `${formatNumber(player.distanceKm, locale, 1)} ${copy.km}`}</td>}
                    {showSpeed && <td className="dm-num">{player.topSpeedKmh === null ? "–" : `${formatNumber(player.topSpeedKmh, locale)} ${copy.kmh}`}</td>}
                    {showTouches && <td className="dm-num">{player.touches === null ? "–" : formatNumber(player.touches, locale)}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
            {withHeat.length > 0 && <p className="dm-small">{copy.tapRow}</p>}
          </div>
          {current && current.heatmap.length > 0 && (
            <Heatmap player={current} colour="#D4FF4F" label={copy.heatmap(current.label)} />
          )}
        </div>
      )}
      <p className="dm-small">{copy.find}</p>
    </div>
  );
}
