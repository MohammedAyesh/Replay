import { describe, expect, it } from "vitest";

import {
  daysBetween,
  mondayOf,
  pickStatTile,
  scoreTiles,
  teaser,
  type HomeTileInput,
  type TileMatchRef,
  type TilePeer,
  type TileStats,
} from "./homeStatTile";

function stats(partial: Partial<TileStats> = {}): TileStats {
  return {
    minutes: 60, distanceKm: 3, topSpeedKmh: 21, touches: 30, passesTried: 15, passesCompleted: 10, passesReceived: 8,
    dribbles: 4, dribblesWon: 2, dribblesLost: 2, shots: 1, goals: 0, ...partial,
  };
}

function match(id: number, startLocal: string, extra: Partial<TileMatchRef> = {}): TileMatchRef {
  return { matchId: id, code: `M${id}`, startLocal, fieldId: 1, fieldName: "Jordan Galaxy", players: 12, watch: `/w/t${id}?m=M${id}`, ...extra };
}

function peer(id: number, name: string, partial: Partial<TileStats>, me = false, team: string | null = "A"): TilePeer {
  return { matchPlayerId: id, userId: id, name, team, me, stats: stats(partial) };
}

function base(overrides: Partial<HomeTileInput> = {}): HomeTileInput {
  return {
    nowLocal: "2026-10-01 12:00",
    history: [],
    lastPeers: null,
    fieldMonth: null,
    fieldFaster: null,
    unclaimed: [],
    upcoming: null,
    ...overrides,
  };
}

describe("dates", () => {
  it("counts days and finds the Monday", () => {
    expect(daysBetween("2026-09-29 23:00", "2026-10-01 12:00")).toBe(2);
    expect(mondayOf("2026-10-01")).toBe("2026-09-28");
    expect(mondayOf("2026-09-28")).toBe("2026-09-28");
    expect(mondayOf("2026-10-04")).toBe("2026-09-28");
  });
});

describe("claim tiles win while a recent match is waiting", () => {
  const history = [
    { match: match(1, "2026-09-25 22:00"), stats: stats({ topSpeedKmh: 30 }) },
    { match: match(2, "2026-09-21 22:00"), stats: stats() },
    { match: match(3, "2026-09-14 22:00"), stats: stats() },
  ];

  it("nobody claimed: the unclaimed tile", () => {
    const tile = pickStatTile(base({ history, unclaimed: [{ match: match(9, "2026-09-30 21:00"), findRecordingId: 77, claimed: 0, peers: [] }] }));
    expect(tile).toMatchObject({ kind: "unclaimed", findRecordingId: 77, match: { code: "M9" } });
  });

  it("friends claimed: their numbers, furthest first", () => {
    const tile = pickStatTile(base({
      history,
      unclaimed: [{
        match: match(9, "2026-09-30 21:00"),
        findRecordingId: 77,
        claimed: 3,
        peers: [peer(1, "Omar", { distanceKm: 4.9 }), peer(2, "Laith", { distanceKm: 5.4 }), peer(3, "Yazan", { distanceKm: 4.2 })],
      }],
    }));
    expect(tile?.kind).toBe("friends");
    expect(tile && tile.kind === "friends" ? tile.peers.map((p) => p.name) : []).toEqual(["Laith", "Omar", "Yazan"]);
  });

  it("one other claimed: a teaser from their numbers", () => {
    const tile = pickStatTile(base({
      unclaimed: [{ match: match(9, "2026-09-30 21:00"), findRecordingId: 77, claimed: 1, peers: [peer(1, "Omar", { topSpeedKmh: 24.3, distanceKm: 3.1 })] }],
    }));
    expect(tile).toMatchObject({ kind: "notFound", found: 1, teaser: { metric: "topSpeedKmh", value: 24.3 } });
  });

  it("an unclaimed match from earlier the same night still counts", () => {
    const tile = pickStatTile(base({ history, unclaimed: [{ match: match(9, "2026-09-25 20:00"), findRecordingId: 77, claimed: 0, peers: [] }] }));
    expect(tile?.kind).toBe("unclaimed");
  });

  it("an unclaimed match more than two weeks old doesn't count", () => {
    const tile = pickStatTile(base({ history, unclaimed: [{ match: match(9, "2026-09-10 21:00"), findRecordingId: 77, claimed: 0, peers: [] }] }));
    expect(tile?.kind).not.toBe("unclaimed");
  });
});

describe("the most impressive number wins", () => {
  it("a new top speed beats everything else in the numbers", () => {
    const history = [
      { match: match(1, "2026-09-29 23:00"), stats: stats({ topSpeedKmh: 24.3, extras: { blocks: [], topSpeedAt: 2472, shotTimes: [], goalTimes: [], team: "A", teamPassesCompleted: null } }) },
      { match: match(2, "2026-09-25 22:00"), stats: stats({ topSpeedKmh: 22.1 }) },
      { match: match(3, "2026-09-21 22:00"), stats: stats({ topSpeedKmh: 21.4 }) },
    ];
    const tile = pickStatTile(base({ history, fieldFaster: 2 }));
    expect(tile).toMatchObject({ kind: "personalBest", metric: "topSpeedKmh", value: 24.3, previousBest: 22.1, at: 2472, fasterAtField: 2 });
  });

  it("first on the pitch by a margin, with the pitch average", () => {
    const history = [
      { match: match(1, "2026-09-29 23:00"), stats: stats({ distanceKm: 3.78 }) },
      { match: match(2, "2026-09-25 22:00"), stats: stats({ distanceKm: 3.9 }) },
      { match: match(3, "2026-09-21 22:00"), stats: stats({ distanceKm: 4.0 }) },
    ];
    const lastPeers = [
      peer(10, "Me", { distanceKm: 3.78, touches: 41, topSpeedKmh: 21 }, true),
      peer(11, "Laith", { distanceKm: 3.1 }),
      peer(12, "Omar", { distanceKm: 2.8 }),
      peer(13, "Yazan", { distanceKm: 2.8 }),
    ];
    const tile = pickStatTile(base({ history, lastPeers }));
    expect(tile).toMatchObject({ kind: "lastMatch", metric: "distanceKm", value: 3.78, pitchAverage: 2.9, claimed: 4 });
  });

  it("passing a half marathon in the newest match is a moment", () => {
    const history = [4.4, 4.5, 4.5, 4.4, 4.2].map((km, i) => ({ match: match(i + 1, `2026-09-${String(29 - i * 3).padStart(2, "0")} 22:00`), stats: stats({ distanceKm: km, topSpeedKmh: 20 + i }) }));
    const tiles = scoreTiles(base({ history }));
    const total = tiles.find((t) => t.tile.kind === "distanceTotal");
    expect(total?.tile).toMatchObject({ milestone: 21.1, passed: true, totalKm: 22 });
    expect(tiles[0].tile.kind).toBe("distanceTotal");
  });

  it("a match later today brings a reachable challenge", () => {
    const history = [12, 14, 15, 17].map((p, i) => ({ match: match(i + 1, `2026-09-${String(29 - i * 4).padStart(2, "0")} 22:00`), stats: stats({ passesCompleted: p, passesTried: p + 8, topSpeedKmh: 30 - i, distanceKm: 3 }) }));
    const tiles = scoreTiles(base({ history, upcoming: { code: "NEXT", startLocal: "2026-10-01 19:00", fieldName: "Jordan Galaxy" } }));
    const challenge = tiles.find((t) => t.tile.kind === "challenge");
    expect(challenge?.tile).toMatchObject({ metric: "passesCompleted", target: 18, best: 17, average: 14.5 });
    expect(challenge?.score).toBe(76);
  });

  it("a rival only when one match can close the gap", () => {
    const history = [{ match: match(1, "2026-10-01 10:00"), stats: stats({ distanceKm: 3.7 }) }, { match: match(2, "2026-10-01 08:00"), stats: stats({ distanceKm: 3.7 }) }, { match: match(3, "2026-10-01 07:00"), stats: stats({ distanceKm: 3.7 }) }];
    const rows = [
      { userId: 1, name: "Laith", distanceKm: 12, me: false },
      { userId: 2, name: "Yazan", distanceKm: 11.4, me: false },
      { userId: 3, name: "Me", distanceKm: 11.1, me: true },
    ];
    const tile = scoreTiles(base({ history, fieldMonth: { fieldName: "Jordan Galaxy", month: "2026-10", rows } })).find((t) => t.tile.kind === "rival")?.tile;
    expect(tile).toMatchObject({ myRank: 3, other: { name: "Yazan", distanceKm: 11.4 }, mine: 11.1, total: 3 });
    const far = scoreTiles(base({ history, fieldMonth: { fieldName: "Jordan Galaxy", month: "2026-10", rows: [{ ...rows[0], distanceKm: 40 }, { ...rows[1], distanceKm: 30 }, rows[2]] } }));
    expect(far.some((t) => t.tile.kind === "rival")).toBe(false);
  });

  it("reads the touches and distance timelines from the cached extras", () => {
    const blocks: Array<[number, number | null, number | null]> = Array.from({ length: 12 }, (_, i) => [i, i >= 10 ? 400 : 300, i === 9 ? 6 : 3]);
    const history = [{ match: match(1, "2026-09-29 23:00"), stats: stats({ touches: 41, extras: { blocks, topSpeedAt: null, shotTimes: [], goalTimes: [], team: "A", teamPassesCompleted: null } }) }];
    const tiles = scoreTiles(base({ history }));
    expect(tiles.find((t) => t.tile.kind === "touches")?.tile).toMatchObject({ total: 41, busiest: { index: 9, count: 6 }, everySeconds: 88 });
    expect(tiles.find((t) => t.tile.kind === "distanceSpells")?.tile).toMatchObject({ spells: [600, 600, 600, 600, 600, 800], finishedStrongest: true });
  });

  it("nothing fits a player with no history and no matches waiting", () => {
    expect(pickStatTile(base())).toBeNull();
  });

  it("an old match counts for less than last night's", () => {
    const fresh = [{ match: match(1, "2026-09-30 22:00"), stats: stats({ shots: 4 }) }];
    const stale = [{ match: match(1, "2026-08-30 22:00"), stats: stats({ shots: 4 }) }];
    const a = scoreTiles(base({ history: fresh })).find((t) => t.tile.kind === "shots")!.score;
    const b = scoreTiles(base({ history: stale })).find((t) => t.tile.kind === "shots")!.score;
    expect(a).toBeGreaterThan(b);
  });
});

describe("teaser", () => {
  it("picks the number furthest above normal", () => {
    expect(teaser([peer(1, "A", { topSpeedKmh: 22, distanceKm: 4.5, dribblesWon: 2, shots: 1 })])).toEqual({ metric: "distanceKm", value: 4.5 });
    expect(teaser([])).toBeNull();
  });
});
