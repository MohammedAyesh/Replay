export type MatchSide = "A" | "B" | "C" | null;

export type ClaimMatchWindow = {
  code: string;
  startSeconds: number;
  endSeconds: number;
  rosterTeam: MatchSide;
  games: Array<{
    startSeconds: number;
    endSeconds: number;
    teamX: string;
    teamY: string;
  }>;
  playerTeamSpans: Array<{
    id: number;
    fromSeconds: number;
    toSeconds: number;
    team: MatchSide;
    source: string;
    createdAt: string;
  }>;
};

export type ClaimTeamSwitch = {
  atSeconds: number;
  teamChanged?: boolean;
  team?: MatchSide;
  matchCode?: string;
};

function timeValue(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function covers(span: ClaimMatchWindow["playerTeamSpans"][number], at: number): boolean {
  return span.fromSeconds <= at && span.toSeconds > at;
}

function teamAt(
  match: ClaimMatchWindow,
  switches: ClaimTeamSwitch[],
  at: number,
): { team: MatchSide; known: boolean } {
  const manual = match.playerTeamSpans
    .filter((span) => span.source !== "claim" && covers(span, at))
    .sort((a, b) => timeValue(b.createdAt) - timeValue(a.createdAt) || b.id - a.id)[0];
  if (manual) return { team: manual.team, known: true };

  const claimSpan = match.playerTeamSpans
    .filter((span) => span.source === "claim" && covers(span, at))
    .sort((a, b) => a.fromSeconds - b.fromSeconds || timeValue(a.createdAt) - timeValue(b.createdAt) || a.id - b.id)
    .at(-1);
  const claimSwitch = switches
    .filter((event) =>
      event.teamChanged === true
      && event.team != null
      && event.atSeconds <= at
      && (!event.matchCode || event.matchCode === match.code))
    .sort((a, b) => a.atSeconds - b.atSeconds)
    .at(-1);

  if (claimSwitch && (!claimSpan || claimSwitch.atSeconds >= claimSpan.fromSeconds)) {
    return { team: claimSwitch.team ?? null, known: true };
  }
  if (claimSpan) return { team: claimSpan.team, known: true };
  return { team: match.rosterTeam, known: match.rosterTeam !== null };
}

/** Time ranges where the player's known team is sitting out the configured game. */
export function matchBenchRanges(match: ClaimMatchWindow, switches: ClaimTeamSwitch[]): Array<[number, number]> {
  const windows = match.games.length
    ? match.games
    : [{ startSeconds: match.startSeconds, endSeconds: match.endSeconds, teamX: "", teamY: "" }];
  const ranges: Array<[number, number]> = [];
  for (const window of windows) {
    const points = [
      window.startSeconds,
      window.endSeconds,
      ...match.playerTeamSpans.flatMap((span) => [span.fromSeconds, span.toSeconds]),
      ...switches
        .filter((event) => !event.matchCode || event.matchCode === match.code)
        .map((event) => event.atSeconds),
    ].filter((value) => value >= window.startSeconds && value <= window.endSeconds);
    const boundaries = [...new Set(points)].sort((a, b) => a - b);
    for (let i = 0; i < boundaries.length - 1; i++) {
      const from = boundaries[i], to = boundaries[i + 1];
      if (to <= from) continue;
      const resolved = teamAt(match, switches, (from + to) / 2);
      const sittingOut = resolved.known && (
        resolved.team === null
        || (match.games.length && resolved.team !== window.teamX && resolved.team !== window.teamY)
      );
      if (sittingOut) ranges.push([from, to]);
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const [from, to] of ranges) {
    const last = merged[merged.length - 1];
    if (last && from <= last[1]) last[1] = Math.max(last[1], to);
    else merged.push([from, to]);
  }
  return merged;
}