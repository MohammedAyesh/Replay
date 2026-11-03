import { describe, expect, it } from "vitest";
import {
  ammanMonth,
  bestMoment,
  footageGaps,
  monthBounds,
  noteWords,
  ownBaselineNote,
  playersInData,
  rotationOrder,
  squadGrid,
  type FeatureRow,
  type GridPlayer,
} from "./rules";

const roster = [
  { id: 1, number: 7, isActive: true },
  { id: 2, number: 9, isActive: true },
  { id: 3, number: 11, isActive: true },
  { id: 4, number: 11, isActive: false },
  { id: 5, number: 4, isActive: true },
  { id: 6, number: 4, isActive: true },
];

describe("playersInData", () => {
  it("a player post is solo, by id, by photo or by a shirt number only one active player wears", () => {
    expect(playersInData({ player: { playerId: 2 } }, "potm", roster)).toEqual({ playerIds: [2], solo: true });
    expect(playersInData({ player: { photo: { type: "player", playerId: 1 } } }, "potm", roster)).toEqual({ playerIds: [1], solo: true });
    // #11: one active, one inactive → the active one.
    expect(playersInData({ player: { number: 11 } }, "birthday", roster)).toEqual({ playerIds: [3], solo: true });
    // #4: two active players → nobody can be told, so nobody is logged.
    expect(playersInData({ player: { number: 4 } }, "potm", roster)).toEqual({ playerIds: [], solo: false });
    // An id from another academy is ignored.
    expect(playersInData({ player: { playerId: 99 } }, "potm", roster)).toEqual({ playerIds: [], solo: false });
  });

  it("a player the scene never draws does not count", () => {
    expect(playersInData({ player: { playerId: 2 } }, "fulltime", roster, false)).toEqual({ playerIds: [], solo: false });
  });

  it("a call-up counts every row, by photo first and shirt number otherwise, and is not solo", () => {
    const data = { custom: { n1: "7", n2: "9", n3: "4", n4: "" }, photos: [null, null, null, { type: "player", playerId: 5 }] };
    expect(playersInData(data, "callup", roster)).toEqual({ playerIds: [1, 2, 5], solo: false });
    // The same custom numbers on a template without player rows mean nothing.
    expect(playersInData(data, "fulltime", roster).playerIds).toEqual([]);
  });

  it("a post about one player that also shows another player's picture is not solo", () => {
    expect(playersInData({ player: { playerId: 1 }, media: { type: "player", playerId: 2 } }, "potm", roster)).toEqual({ playerIds: [1, 2], solo: false });
  });
});

describe("months in Amman", () => {
  it("uses the Amman calendar (UTC+3)", () => {
    expect(ammanMonth(new Date("2026-10-31T21:30:00Z"))).toBe("2026-11");
    expect(ammanMonth(new Date("2026-10-31T20:30:00Z"))).toBe("2026-10");
    const { from, to } = monthBounds("2026-11");
    expect(from.toISOString()).toBe("2026-10-31T21:00:00.000Z");
    expect(to.toISOString()).toBe("2026-11-30T21:00:00.000Z");
    expect(monthBounds("2026-12").to.toISOString()).toBe("2026-12-31T21:00:00.000Z");
  });
});

describe("squadGrid", () => {
  const now = new Date("2026-11-20T12:00:00Z");
  const players: GridPlayer[] = [
    { id: 1, name: "Omar", number: 7, squadName: "U12", consent: true },
    { id: 2, name: "Zaid", number: 9, squadName: "U12", consent: true },
    { id: 3, name: "Ali", number: 11, squadName: "U12", consent: false },
    { id: 4, name: "Karim", number: 19, squadName: "U12", consent: false },
    { id: 5, name: "Faris", number: 3, squadName: "U12", consent: true },
  ];
  const f = (playerId: number, at: string, visibility: "public" | "private", solo = false, itemType = "post"): FeatureRow =>
    ({ playerId, itemType, visibility, solo, featuredAt: new Date(at) });
  const features = [
    f(1, "2026-11-05T10:00:00Z", "public", true),
    f(1, "2026-11-08T10:00:00Z", "private", false, "clip"),
    f(2, "2026-11-06T10:00:00Z", "public", false), // only in a line-up: not his solo post
    f(2, "2026-11-08T10:00:00Z", "private", false, "clip"),
    f(3, "2026-11-08T10:00:00Z", "private", false, "clip"),
    f(5, "2026-09-01T10:00:00Z", "public", true),
  ];
  const played = [1, 2, 3, 4].map((playerId) => ({ playerId, sessionId: 50, startsAt: new Date("2026-11-07T15:00:00Z") }));
  const clipsReceived = new Set(["50:1", "50:2", "50:3"]);

  it("colours each child and writes the summary", () => {
    const g = squadGrid({ players, features, played, clipsReceived, targets: { publicPostsPerMonth: 1, privateClipPerMatch: true }, now });
    const by = Object.fromEntries(g.cells.map((c) => [c.number, c]));
    expect(g.month).toBe("2026-11");
    expect(by[7].status).toBe("green");
    // In a line-up, not a solo post yet: amber, waiting for his own post.
    expect(by[9].status).toBe("amber");
    expect(by[9].missing).toEqual(["public_post"]);
    // Private only: his private clip is the whole target.
    expect(by[11]).toMatchObject({ status: "green", mode: "private_only", missing: [] });
    // Never featured anywhere: red, and no days since.
    expect(by[19]).toMatchObject({ status: "red", daysSince: null, mode: "private_only" });
    // Featured before, not this month.
    expect(by[3]).toMatchObject({ status: "amber", daysSince: 80 });
    expect(g.summary.featured).toBe(2);
    expect(g.summary.total).toBe(5);
    expect(g.summary.notYet.map((x) => x.number)).toEqual([3, 9, 19]);
  });

  it("follows the owner's targets", () => {
    const g = squadGrid({ players, features, played, clipsReceived, targets: { publicPostsPerMonth: 0, privateClipPerMatch: true }, now });
    expect(g.cells.find((c) => c.number === 9)!.status).toBe("green");
    // A missing private clip keeps a child amber while that target is on.
    const g2 = squadGrid({ players, features, played, clipsReceived: new Set(["50:2", "50:3"]), targets: { publicPostsPerMonth: 1, privateClipPerMatch: true }, now });
    expect(g2.cells.find((c) => c.number === 7)!.missing).toEqual(["private_clip"]);
    const g3 = squadGrid({ players, features, played, clipsReceived: new Set(), targets: { publicPostsPerMonth: 1, privateClipPerMatch: false }, now });
    expect(g3.cells.find((c) => c.number === 7)!.status).toBe("green");
  });

  it("can look at another month and ignores anything after now", () => {
    const g = squadGrid({ players, features, played, clipsReceived, targets: { publicPostsPerMonth: 1, privateClipPerMatch: true }, now, month: "2026-09" });
    expect(g.cells.find((c) => c.number === 3)!.status).toBe("green");
    const early = squadGrid({ players, features, played, clipsReceived, targets: { publicPostsPerMonth: 1, privateClipPerMatch: true }, now: new Date("2026-11-01T00:00:00Z") });
    expect(early.cells.find((c) => c.number === 7)!.status).toBe("red");
  });
});

describe("footageGaps", () => {
  const m = (sessionId: number, day: number, inSquad: number[], found: number[]) =>
    ({ sessionId, startsAt: new Date(Date.UTC(2026, 10, day)), inSquad, found });
  it("counts back the run of matches with no footage of a child, newest first", () => {
    const matches = [m(1, 1, [7, 8, 9], [7, 8, 9]), m(2, 8, [7, 8, 9], [8]), m(3, 15, [7, 8], [8]), m(4, 22, [7, 8, 9], [8, 9])];
    const gaps = footageGaps(matches, [7, 8, 9]);
    expect(gaps).toEqual([{ playerId: 7, matches: 3, latestSessionId: 4 }]);
    // Not in the squad is not a gap; found in the latest ends the run.
    expect(footageGaps([m(5, 1, [9], [])], [7, 9])).toEqual([{ playerId: 9, matches: 1, latestSessionId: 5 }]);
  });
});

describe("rotationOrder", () => {
  const now = new Date("2026-11-20T12:00:00Z");
  const ago = (days: number) => new Date(now.getTime() - days * 86_400_000);
  const cands = [{ playerId: 1, goals: 3 }, { playerId: 2, goals: 0 }, { playerId: 3, goals: 1 }, { playerId: 4, goals: 2 }];
  it("puts whoever waited longest first, never featured before everyone", () => {
    const last = new Map<number, Date | null>([[1, ago(2)], [2, ago(40)], [3, null], [4, ago(41)]]);
    // 3 never featured; 2 and 4 both waited 5 full weeks, so performance breaks the tie (4 scored more).
    expect(rotationOrder(cands, last, (c) => [c.goals], now).map((c) => c.playerId)).toEqual([3, 4, 2, 1]);
  });
  it("the best performer does not win while someone has waited a week longer", () => {
    const last = new Map<number, Date | null>([[1, ago(1)], [2, ago(9)], [3, ago(2)], [4, ago(3)]]);
    expect(rotationOrder(cands, last, (c) => [c.goals], now)[0].playerId).toBe(2);
  });
});

describe("bestMoment and the own-baseline note", () => {
  it("prefers a goal, then a shot, a dribble …, a plain clip of him last", () => {
    const ms = [{ kind: "touch-spell", momentSeconds: 10 }, { kind: "dribble", momentSeconds: 50 }, { kind: "presence", momentSeconds: 5 }, { kind: "your-shot", momentSeconds: 90 }];
    expect(bestMoment(ms)?.kind).toBe("your-shot");
    expect(bestMoment([{ kind: "presence", momentSeconds: 3 }])?.kind).toBe("presence");
    expect(bestMoment([])).toBeNull();
  });

  it("compares a child only with his own earlier matches", () => {
    expect(ownBaselineNote({ dribblesWon: 3 }, [])).toEqual({ kind: "first" });
    expect(ownBaselineNote({ dribblesWon: 3 }, [{ dribblesWon: 1 }])).toEqual({ kind: "first" });
    expect(ownBaselineNote({ dribblesWon: 3, touches: 40 }, [{ dribblesWon: 1, touches: 38 }, { dribblesWon: 4, touches: 36 }, { dribblesWon: 1, touches: 39 }]))
      .toEqual({ kind: "above", stat: "dribblesWon", value: 3, usual: 1, matches: 3 });
    expect(ownBaselineNote({ goals: 2 }, [{ goals: 0 }, { goals: 1 }])).toEqual({ kind: "best", stat: "goals", value: 2, matches: 2 });
    // Below his usual everywhere: no comparison at all (never "worse than usual").
    expect(ownBaselineNote({ touches: 10 }, [{ touches: 30 }, { touches: 40 }])).toBeNull();
    // A 2% faster top speed is noise.
    expect(ownBaselineNote({ topSpeedKmh: 20.4 }, [{ topSpeedKmh: 20 }, { topSpeedKmh: 19 }])).toBeNull();
  });

  it("words the note for parents, in Arabic and English", () => {
    const above = { kind: "above", stat: "dribblesWon", value: 3, usual: 1, matches: 3 } as const;
    expect(noteWords(above, "en")).toBe(" — 3 dribbles won, more than his usual 1");
    expect(noteWords(above, "ar")).toBe(" — 3 مراوغات ناجحة، أكثر من معدّله (1)");
    expect(noteWords({ kind: "best", stat: "goals", value: 1, matches: 4 }, "en")).toBe(" — 1 goal, his best yet");
    expect(noteWords({ kind: "first" }, "ar")).toBe("");
    expect(noteWords(null, "en")).toBe("");
  });
});
