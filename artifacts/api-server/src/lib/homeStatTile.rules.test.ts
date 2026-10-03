import { describe, expect, it } from "vitest";

import {
  RANK_BASIS,
  isClearlyFirst,
  isPersonalBest,
  standingOf,
  type HeadlineStat,
  type RankablePlayer,
} from "@workspace/api-zod";
import {
  scoreTiles,
  type HomeTileInput,
  type StatTile,
  type TileMatchRef,
  type TilePeer,
  type TileStats,
} from "./homeStatTile";

/**
 * Home's tiles and the match report must never disagree. Both now use the
 * shared rule set in @workspace/api-zod (statsRanking.ts); these fixtures run
 * Home's tiles and assert every claim they make is one the report's rule
 * (standings / isClearlyFirst / isPersonalBest) also makes.
 */

function stats(partial: Partial<TileStats> = {}): TileStats {
  return {
    minutes: 60, distanceKm: 3, topSpeedKmh: 21, touches: 30, passesTried: 15, passesCompleted: 10, passesReceived: 8,
    dribbles: 4, dribblesWon: 2, dribblesLost: 2, shots: 1, goals: 0, ...partial,
  };
}

function match(id: number, startLocal: string): TileMatchRef {
  return { matchId: id, code: `M${id}`, startLocal, fieldId: 1, fieldName: "Jordan Galaxy", players: 10, watch: null };
}

function peer(id: number, partial: Partial<TileStats>, me = false): TilePeer {
  return { matchPlayerId: id, userId: id, name: `P${id}`, team: "A", me, stats: stats(partial) };
}

function input(lastPeers: TilePeer[], history?: HomeTileInput["history"]): HomeTileInput {
  const mine = lastPeers.find((p) => p.me)!;
  return {
    nowLocal: "2026-10-01 12:00",
    history: history ?? [{ match: match(1, "2026-09-30 22:00"), stats: mine.stats }],
    lastPeers,
    fieldMonth: null,
    fieldFaster: null,
    unclaimed: [],
    upcoming: null,
  };
}

/** The report's view of the same players. */
function reportPlayers(peers: TilePeer[]): RankablePlayer[] {
  return peers.map((p) => ({ playerId: p.matchPlayerId, claimed: true, ...p.stats }));
}

function tiles(i: HomeTileInput): StatTile[] {
  return scoreTiles(i).map((t) => t.tile);
}

/** Every first-place or rank claim Home makes, checked against the report's rule. */
function assertAgrees(peers: TilePeer[], out: StatTile[]) {
  const players = reportPlayers(peers);
  const me = peers.find((p) => p.me)!.matchPlayerId;
  for (const tile of out) {
    if (tile.kind === "lastMatch") {
      expect(isClearlyFirst(players, RANK_BASIS[tile.metric as HeadlineStat], me)).toBe(true);
    }
    if (tile.kind === "ranks") {
      for (const row of tile.ranks) {
        const standing = standingOf(players, RANK_BASIS[row.metric as HeadlineStat], me)!;
        expect(standing.ranked).toBe(true);
        expect(row.rank).toBe(standing.rank);
        expect(Boolean(row.shared)).toBe(standing.shared);
      }
    }
    if (tile.kind === "dribbles" && tile.rank !== null) {
      const standing = standingOf(players, "dribblesWon", me)!;
      expect(standing.ranked && !standing.shared).toBe(true);
      expect(tile.rank).toBe(standing.rank);
    }
  }
}

describe("Home and the report use one ranking rule", () => {
  it("level at the top is not 'further than anyone'", () => {
    // 3.78 km against 3.70 km over the same hour: inside the 5% margin, so the report says =1st.
    const peers = [
      peer(1, { distanceKm: 3.78 }, true),
      peer(2, { distanceKm: 3.7 }),
      peer(3, { distanceKm: 2.8 }),
      peer(4, { distanceKm: 2.6 }),
    ];
    const out = tiles(input(peers));
    expect(out.some((t) => t.kind === "lastMatch" && t.metric === "distanceKm")).toBe(false);
    expect(standingOf(reportPlayers(peers), "distanceRate", 1)).toMatchObject({ rank: 1, shared: true });
    const ranks = out.find((t) => t.kind === "ranks");
    expect(ranks && ranks.kind === "ranks" ? ranks.ranks.find((r) => r.metric === "distanceKm") : null).toMatchObject({ rank: 1, shared: true, per10: true });
    assertAgrees(peers, out);
  });

  it("ranks distance per ten minutes on camera, not on the raw total", () => {
    // Most km overall, but over 80 minutes; Laith covered more per ten minutes.
    const peers = [
      peer(1, { distanceKm: 4.0, minutes: 80 }, true),
      peer(2, { distanceKm: 3.5, minutes: 50 }),
      peer(3, { distanceKm: 2.0, minutes: 60 }),
      peer(4, { distanceKm: 1.8, minutes: 60 }),
    ];
    const out = tiles(input(peers));
    expect(out.some((t) => t.kind === "lastMatch" && t.metric === "distanceKm")).toBe(false);
    expect(standingOf(reportPlayers(peers), "distanceRate", 1)?.rank).toBe(2);
    assertAgrees(peers, out);
  });

  it("clearly first per ten minutes is said, with the per-10 figure", () => {
    const peers = [
      peer(1, { distanceKm: 4.2 }, true),
      peer(2, { distanceKm: 3.0 }),
      peer(3, { distanceKm: 2.8 }),
      peer(4, { distanceKm: 2.6 }),
    ];
    const out = tiles(input(peers));
    expect(out.find((t) => t.kind === "lastMatch")).toMatchObject({ metric: "distanceKm", value: 0.7, per10: true });
    assertAgrees(peers, out);
  });

  it("under ten minutes on camera is never ranked on Home either", () => {
    const peers = [
      peer(1, { distanceKm: 1.5, minutes: 8, topSpeedKmh: 31, dribblesWon: 9, dribbles: 10, dribblesLost: 1, touches: 40, passesCompleted: 20 }, true),
      peer(2, { distanceKm: 3.0 }),
      peer(3, { distanceKm: 2.8 }),
      peer(4, { distanceKm: 2.6 }),
    ];
    const out = tiles(input(peers));
    expect(out.some((t) => t.kind === "lastMatch" || t.kind === "ranks")).toBe(false);
    const dribbles = out.find((t) => t.kind === "dribbles");
    expect(dribbles && dribbles.kind === "dribbles" ? dribbles.rank : null).toBeNull();
    expect(out.some((t) => t.kind === "dribbleDuel")).toBe(false);
    assertAgrees(peers, out);
  });

  it("a dribble duel inside the one-dribble margin is level, not a win", () => {
    const peers = [
      peer(1, { dribblesWon: 5, dribbles: 7 }, true),
      peer(2, { dribblesWon: 6, dribbles: 9 }),
      peer(3, { dribblesWon: 1 }),
    ];
    expect(tiles(input(peers)).some((t) => t.kind === "dribbleDuel")).toBe(false);
    const clear = [
      peer(1, { dribblesWon: 5, dribbles: 7 }, true),
      peer(2, { dribblesWon: 7, dribbles: 9 }),
      peer(3, { dribblesWon: 1 }),
    ];
    expect(tiles(input(clear)).find((t) => t.kind === "dribbleDuel")).toMatchObject({ other: { won: 7 } });
  });

  it("a personal best follows the report's rule: three earlier matches, past the margin", () => {
    const row = (id: number, day: number, topSpeedKmh: number) => ({ match: match(id, `2026-09-${String(day).padStart(2, "0")} 22:00`), stats: stats({ topSpeedKmh }) });
    const pb = (history: HomeTileInput["history"]) => tiles({ ...input([peer(1, {}, true)], history), lastPeers: null })
      .find((t) => t.kind === "personalBest" && t.metric === "topSpeedKmh") ?? null;

    // only two earlier matches: the report wouldn't call it, nor does Home
    const two = [row(1, 30, 26), row(2, 25, 22), row(3, 20, 21)];
    expect(isPersonalBest("topSpeed", 26, 22, 2)).toBe(false);
    expect(pb(two)).toBeNull();

    // three earlier, but +1 km/h is inside the 1.5 km/h margin
    const level = [row(1, 30, 23), row(2, 25, 22), row(3, 20, 21), row(4, 15, 20)];
    expect(isPersonalBest("topSpeed", 23, 22, 3)).toBe(false);
    expect(pb(level)).toBeNull();

    // three earlier and clearly past the old best
    const clear = [row(1, 30, 24.3), row(2, 25, 22.1), row(3, 20, 21), row(4, 15, 20)];
    expect(isPersonalBest("topSpeed", 24.3, 22.1, 3)).toBe(true);
    expect(pb(clear)).toMatchObject({ value: 24.3, previousBest: 22.1 });
  });
});
