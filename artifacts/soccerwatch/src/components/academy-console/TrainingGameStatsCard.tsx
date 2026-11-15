import React, { useMemo, useState } from "react";
import { AlertTriangle } from "lucide-react";
import type { MatchesStrings } from "@/i18n/matches-strings";
import {
  aggregateTrainingGamePlayers,
  numberedSharePercent,
  type TrainingGame,
  type TrainingGamePlayer,
  type TrainingSessionData,
  type TrainingTeamTotal,
} from "@/lib/academy-training";

type Copy = MatchesStrings & { locale: "ar" | "en" };

function format(value: number | null | undefined, decimals = 1) {
  if (value == null || !Number.isFinite(value)) return "–";
  return new Intl.NumberFormat("en-GB", { maximumFractionDigits: decimals }).format(value);
}

function gameTitle(game: TrainingGame, index: number, training: TrainingSessionData, copy: Copy) {
  const groups = new Map(training.groups.map((group) => [group.id, group.name]));
  const teams = game.teams.map((team, teamIndex) => game.teamNames[teamIndex] || groups.get(team) || team).join(" vs ");
  return copy.gameStats.game(index + 1, teams);
}

function totalForGame(game: TrainingGame, teamId: string): TrainingTeamTotal {
  return game.teamTotals[teamId] ?? { minutes: null, distance: null, touches: null, numberedShare: null };
}

function combinedTotals(games: TrainingGame[], teamId: string): TrainingTeamTotal {
  const rows = games.map((game) => totalForGame(game, teamId));
  const sum = (key: "minutes" | "distance" | "touches") => {
    const values = rows.map((row) => row[key]).filter((value): value is number => value !== null);
    return values.length ? values.reduce((a, b) => a + b, 0) : null;
  };
  const shares = rows.flatMap((row) => {
    if (row.numberedShare === null) return [];
    const percent = numberedSharePercent(row.numberedShare);
    return percent === null ? [] : [{ percent, weight: row.minutes ?? 0 }];
  });
  const weights = shares.filter((row) => row.weight > 0);
  const share = weights.length
    ? weights.reduce((sum, row) => sum + row.percent * row.weight, 0) / weights.reduce((sum, row) => sum + row.weight, 0)
    : shares.length ? shares.reduce((sum, row) => sum + row.percent, 0) / shares.length : null;
  return { minutes: sum("minutes"), distance: sum("distance"), touches: sum("touches"), numberedShare: share };
}

function TeamStats({ teamId, label, players, total, copy, idPrefix }: {
  teamId: string;
  label: string;
  players: TrainingGamePlayer[];
  total: TrainingTeamTotal;
  copy: Copy;
  idPrefix: string;
}) {
  const share = numberedSharePercent(total.numberedShare);
  return (
    <section className="space-y-2" data-testid={`${idPrefix}-team-${teamId}`}>
      <h4 className="flex items-center gap-2 text-sm font-bold text-text" dir="auto">{label}</h4>
      {players.length ? (
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full min-w-[640px] text-start text-xs">
            <thead className="bg-raised text-[10px] uppercase tracking-wide text-muted-text">
              <tr>
                <th className="px-2 py-2 text-start">{copy.gameStats.number}</th>
                <th className="px-2 py-2 text-end">{copy.gameStats.minutes}</th>
                <th className="px-2 py-2 text-end">{copy.gameStats.distance}</th>
                <th className="px-2 py-2 text-end">{copy.gameStats.pace}</th>
                <th className="px-2 py-2 text-end">{copy.gameStats.topSpeed}</th>
                <th className="px-2 py-2 text-end">{copy.gameStats.sprints}</th>
                <th className="px-2 py-2 text-end">{copy.gameStats.touches}</th>
              </tr>
            </thead>
            <tbody>
              {players.map((player) => (
                <tr key={`${player.team}-${player.number}`} className="border-t border-line/70" data-testid={`${idPrefix}-shirt-${player.number}`}>
                  <th scope="row" className="whitespace-nowrap px-2 py-2 text-start font-bold text-text">
                    <span dir="ltr">#{player.number}</span>
                    {player.keeper && <span className="ms-1 rounded bg-raised px-1 py-0.5 text-[9px] text-muted-text">{copy.gameStats.keeper}</span>}
                    {player.shared && <span className="ms-1 inline-flex align-middle text-amber-400" role="img" aria-label={copy.gameStats.shared} title={copy.gameStats.shared}><AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" /></span>}
                  </th>
                  <td className="px-2 py-2 text-end tabular-nums">{format(player.minutes, 1)}</td>
                  <td className="px-2 py-2 text-end tabular-nums">{format(player.distance, 0)}</td>
                  <td className="px-2 py-2 text-end tabular-nums">{format(player.mPerMin, 1)}</td>
                  <td className="px-2 py-2 text-end tabular-nums">{format(player.topKmh, 1)}</td>
                  <td className="px-2 py-2 text-end tabular-nums">{format(player.sprints, 0)}</td>
                  <td className="px-2 py-2 text-end tabular-nums">{format(player.touches, 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <p className="text-xs text-muted-text">{copy.gameStats.noPlayers}</p>}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-raised/60 px-3 py-2 text-[11px] text-muted-text" data-testid={`${idPrefix}-totals-${teamId}`}>
        <span className="font-bold text-text">{copy.gameStats.teamTotals}</span>
        <span>{copy.gameStats.minutes}: {format(total.minutes, 1)}</span>
        <span>{copy.gameStats.distance}: {format(total.distance, 0)}</span>
        <span>{copy.gameStats.touches}: {format(total.touches, 0)}</span>
        {share !== null && <span>{copy.gameStats.numberedShare(share)}</span>}
      </div>
    </section>
  );
}

export function TrainingGameStatsCard({ training, copy }: { training: TrainingSessionData; copy: Copy }) {
  const [tab, setTab] = useState<"games" | "totals">("games");
  const [selectedGame, setSelectedGame] = useState(0);
  const acrossGames = useMemo(() => aggregateTrainingGamePlayers(training.games), [training.games]);
  const isApproximate = training.ground?.toLowerCase().includes("approximate") ?? false;
  const selected = training.games[selectedGame];

  if (!training.games.length) {
    return <section className="rounded-xl bg-raised/50 p-4" data-testid="training-game-stats"><h3 className="font-display text-base font-bold">{copy.gameStats.title}</h3><p className="mt-2 text-sm text-muted-text">{copy.gameStats.noGames}</p></section>;
  }

  const teams = tab === "games"
    ? selected?.teams ?? []
    : [...new Set(acrossGames.map((player) => player.team).concat(training.games.flatMap((game) => game.teams)))];

  return (
    <section className="space-y-4 rounded-xl bg-raised/50 p-4" data-testid="training-game-stats" dir={copy.locale === "ar" ? "rtl" : "ltr"}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="font-display text-base font-bold text-text">{copy.gameStats.title}</h3>
        <div className="flex gap-1 rounded-lg bg-void p-1" role="tablist" aria-label={copy.gameStats.title}>
          <button type="button" role="tab" aria-selected={tab === "games"} onClick={() => setTab("games")}
            className={`min-h-8 rounded-md px-3 text-xs font-bold ${tab === "games" ? "bg-floodlight text-void" : "text-muted-text"}`} data-testid="training-tab-games">{copy.gameStats.games}</button>
          <button type="button" role="tab" aria-selected={tab === "totals"} onClick={() => setTab("totals")}
            className={`min-h-8 rounded-md px-3 text-xs font-bold ${tab === "totals" ? "bg-floodlight text-void" : "text-muted-text"}`} data-testid="training-tab-session-totals">{copy.gameStats.sessionTotals}</button>
        </div>
      </div>
      {tab === "games" && selected && (
        <label className="block max-w-xl text-xs font-bold text-muted-text">
          <span className="mb-1 block">{copy.gameStats.chooseGame}</span>
          <select value={selectedGame} onChange={(event) => setSelectedGame(Number(event.target.value))}
            className="min-h-10 w-full rounded-lg border border-input bg-surface px-3 text-sm font-semibold text-text" data-testid="select-training-game">
            {training.games.map((game, index) => <option key={`${game.start}-${index}`} value={index}>{gameTitle(game, index, training, copy)}</option>)}
          </select>
        </label>
      )}
      <div className="space-y-4">
        {teams.map((teamId, index) => {
          const group = training.groups.find((candidate) => candidate.id === teamId);
          const label = tab === "games" && selected
            ? selected.teamNames[index] || group?.name || teamId
            : group?.name || teamId;
          const players = tab === "games"
            ? aggregateTrainingGamePlayers(selected ? [selected] : []).filter((player) => player.team === teamId)
            : acrossGames.filter((player) => player.team === teamId);
          const total = tab === "games" && selected ? totalForGame(selected, teamId) : combinedTotals(training.games, teamId);
          return <TeamStats key={teamId} teamId={teamId} label={label} players={players} total={total} copy={copy} idPrefix={tab === "games" ? `game-${selectedGame}` : "session"} />;
        })}
        {!teams.length && <p className="text-sm text-muted-text">{copy.gameStats.noPlayers}</p>}
      </div>
      {isApproximate && <p className="text-xs text-muted-text" data-testid="training-ground-estimate">{copy.gameStats.estimate}</p>}
    </section>
  );
}
