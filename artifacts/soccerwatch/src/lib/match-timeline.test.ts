import { describe, expect, it } from "vitest";
import { buildTimeline, filterTimeline, timelineFilters, type TimelineGoalRow, type TimelineInput } from "./match-timeline";
import type { MatchMark } from "./match-api";

function row(at: number, values: Partial<TimelineGoalRow> = {}): TimelineGoalRow {
  return { atSeconds: at, side: "A", scorer: null, recordingId: 7, gameIndex: null, t: at, status: "confirmed", source: "goal", key: at, ...values };
}

function input(values: Partial<TimelineInput> = {}): TimelineInput {
  return { review: [], teamCount: 2, gameCount: 1, roomScore: null, durationSeconds: 3600, me: null, marks: [], ...values };
}

const me = (values: Partial<NonNullable<TimelineInput["me"]>> = {}): TimelineInput["me"] => ({
  playerId: 33,
  team: "B",
  topSpeedKmh: 29.7,
  report: { goalTimes: [], topSpeedAt: null, dribbleWonTimes: [], shotTimes: [] },
  ...values,
});

describe("buildTimeline", () => {
  it("sorts goals by time and keeps a running score when the captain's score agrees", () => {
    const { events, finalScore } = buildTimeline(input({ review: [row(600, { side: "B" }), row(120), row(1500, { side: "B" })], roomScore: { a: 1, b: 2 } }));
    expect(events.map((e) => e.at)).toEqual([120, 600, 1500]);
    expect(events.map((e) => e.score)).toEqual([{ a: 1, b: 0 }, { a: 1, b: 1 }, { a: 1, b: 2 }]);
    expect(finalScore).toEqual({ a: 1, b: 2 });
  });

  it("shows no score from confirmed goals alone: they are only a suggestion", () => {
    const { events, finalScore } = buildTimeline(input({ review: [row(120), row(600, { side: "B" })] }));
    expect(finalScore).toBeNull();
    expect(events.every((e) => e.score === null)).toBe(true);
  });

  it("puts the first team's events at the start and the second team's at the end", () => {
    const { events, columns } = buildTimeline(input({ review: [row(60, { side: "A" }), row(90, { side: "B" }), row(100, { side: null, status: "open" })] }));
    expect(columns).toBe(2);
    expect(events.map((e) => e.side)).toEqual(["start", "end", "centre"]);
  });

  it("drops the running score when it disagrees with the captain's score", () => {
    const { events, finalScore } = buildTimeline(input({ review: [row(60), row(90)], roomScore: { a: 3, b: 1 } }));
    expect(finalScore).toBeNull();
    expect(events.every((e) => e.score === null)).toBe(true);
  });

  it("never claims 0–0 when nothing is confirmed and no score is in", () => {
    expect(buildTimeline(input({ review: [row(60, { status: "open" })] })).finalScore).toBeNull();
    expect(buildTimeline(input()).finalScore).toBeNull();
  });

  it("shows 0–0 when the captain entered it", () => {
    expect(buildTimeline(input({ roomScore: { a: 0, b: 0 } })).finalScore).toEqual({ a: 0, b: 0 });
  });

  it("keeps it when it agrees", () => {
    expect(buildTimeline(input({ review: [row(60), row(90, { side: "B" })], roomScore: { a: 1, b: 1 } })).finalScore).toEqual({ a: 1, b: 1 });
  });

  it("shows no running score for three teams, several games, or a goal with no side", () => {
    const one = { a: 1, b: 0 };
    expect(buildTimeline(input({ review: [row(60)], teamCount: 3, roomScore: one })).finalScore).toBeNull();
    expect(buildTimeline(input({ review: [row(60)], teamCount: 3 })).columns).toBe(1);
    expect(buildTimeline(input({ review: [row(60)], gameCount: 2, roomScore: one })).finalScore).toBeNull();
    expect(buildTimeline(input({ review: [row(60), row(90, { side: null })], roomScore: one })).events.every((e) => e.score === null)).toBe(true);
  });

  it("leaves out rejected chances and splits open ones into likely goals and plain chances", () => {
    const { events } = buildTimeline(input({ review: [row(60, { status: "rejected" }), row(90, { status: "open", source: "goal" }), row(120, { status: "open", source: "shot" })] }));
    expect(events.map((e) => e.kind)).toEqual(["likely", "chance"]);
    expect(events[0].score).toBeNull();
  });

  it("treats rows from an older server, with no status, as confirmed goals", () => {
    const { events } = buildTimeline(input({ review: [row(60, { status: undefined })] }));
    expect(events[0].kind).toBe("goal");
  });

  it("marks the viewer's goals, by scorer or by his report's goal times", () => {
    const { events } = buildTimeline(input({
      me: me({ report: { goalTimes: [305], topSpeedAt: null, dribbleWonTimes: [], shotTimes: [] } }),
      review: [row(60, { scorer: { playerId: 33, name: "Mohammed" } }), row(300, { side: "B" }), row(900, { scorer: { playerId: 31, name: "Other" } })],
    }));
    expect(events.map((e) => e.mine)).toEqual([true, true, false]);
  });

  it("never takes the other team's goal from his report's goal times", () => {
    const { events } = buildTimeline(input({
      me: me({ report: { goalTimes: [305], topSpeedAt: null, dribbleWonTimes: [], shotTimes: [] } }),
      review: [row(300, { side: "A" })],
    }));
    expect(events[0].mine).toBe(false);
  });

  it("never credits an own goal to anyone", () => {
    const { events } = buildTimeline(input({ me: me({ report: { goalTimes: [60], topSpeedAt: null, dribbleWonTimes: [], shotTimes: [] } }), review: [row(60, { ownGoal: true, scorer: { playerId: 33, name: "x" } })] }));
    expect(events[0].mine).toBe(false);
    expect(events[0].scorer).toBeNull();
    expect(events[0].ownGoal).toBe(true);
  });

  it("adds the viewer's sprint, dribbles and shots on his side", () => {
    const { events } = buildTimeline(input({ me: me({ report: { goalTimes: [], topSpeedAt: 1020, dribbleWonTimes: [400], shotTimes: [800] } }) }));
    expect(events.map((e) => e.kind)).toEqual(["dribble", "shot", "sprint"]);
    expect(events.every((e) => e.mine && e.side === "end" && e.team === "B")).toBe(true);
    expect(events[2].speedKmh).toBe(29.7);
  });

  it("folds a shot into the chance it was instead of listing it twice", () => {
    const { events } = buildTimeline(input({ me: me({ report: { goalTimes: [], topSpeedAt: null, dribbleWonTimes: [], shotTimes: [122] } }), review: [row(120, { status: "open", source: "shot", side: "B" })] }));
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("chance");
    expect(events[0].mine).toBe(true);
  });

  it("never turns a nearby shot into his goal, or into the other team's chance", () => {
    const shotAt = (t: number) => me({ report: { goalTimes: [], topSpeedAt: null, dribbleWonTimes: [], shotTimes: [t] } });
    const rebound = buildTimeline(input({ me: shotAt(600), review: [row(603, { side: "B" })] }));
    expect(rebound.events).toHaveLength(1);
    expect(rebound.events[0]).toMatchObject({ kind: "goal", mine: false });
    const theirs = buildTimeline(input({ me: shotAt(122), review: [row(120, { status: "open", source: "shot", side: "A" })] }));
    expect(theirs.events[0].mine).toBe(false);
  });

  it("counts his moments once when the footage was analysed twice", () => {
    const { events } = buildTimeline(input({ me: me({ report: { goalTimes: [], topSpeedAt: null, dribbleWonTimes: [400, 400, 401.2, 900], shotTimes: [800, 800.5] } }) }));
    expect(events.map((e) => [e.kind, e.at])).toEqual([["dribble", 400], ["shot", 800], ["dribble", 900]]);
    expect(new Set(events.map((e) => e.id)).size).toBe(events.length);
  });

  it("keeps flags from before kick-off and after the end outside the match", () => {
    const marks: MatchMark[] = [
      { id: 1, kind: "foul", note: null, atUtc: "", offsetSeconds: -90, byName: null, mine: true },
      { id: 2, kind: "foul", note: null, atUtc: "", offsetSeconds: 700, byName: null, mine: true },
      { id: 3, kind: "foul", note: null, atUtc: "", offsetSeconds: 3700, byName: null, mine: true },
    ];
    const { events } = buildTimeline(input({ marks }));
    expect(events.map((e) => [e.at, e.phase])).toEqual([[-90, "before"], [700, "during"], [3700, "after"]]);
  });

  it("leaves out a goal in his report that no confirmed goal or chance matches", () => {
    const { events } = buildTimeline(input({ me: me({ report: { goalTimes: [500], topSpeedAt: null, dribbleWonTimes: [], shotTimes: [501] } }) }));
    expect(events).toHaveLength(0);
  });

  it("adds flags with a time, in the middle, and skips flags without one", () => {
    const marks: MatchMark[] = [
      { id: 1, kind: "foul", note: null, atUtc: "", offsetSeconds: 700, byName: "Ali", mine: false },
      { id: 2, kind: "goal", note: null, atUtc: "", offsetSeconds: null, byName: null, mine: true },
    ];
    const { events } = buildTimeline(input({ marks }));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "flag", side: "centre", flag: { kind: "foul", byName: "Ali" } });
  });

  it("gives every event a minute like the goal list (1-based)", () => {
    const { events } = buildTimeline(input({ review: [row(0), row(59), row(60, { side: "B" })] }));
    expect(events.map((e) => e.minute)).toEqual([1, 1, 2]);
  });

  it("gives every event a distinct id", () => {
    const { events } = buildTimeline(input({ review: [row(60), row(60, { key: 61, side: "B" })], me: me({ report: { goalTimes: [], topSpeedAt: 60, dribbleWonTimes: [60], shotTimes: [] } }) }));
    expect(new Set(events.map((e) => e.id)).size).toBe(events.length);
  });
});

describe("filterTimeline and timelineFilters", () => {
  const { events } = buildTimeline(input({
    me: me({ report: { goalTimes: [], topSpeedAt: 1020, dribbleWonTimes: [], shotTimes: [] } }),
    review: [row(60), row(90, { status: "open", source: "goal" }), row(120, { status: "open", source: "shot" }), row(150, { status: "open", source: "shot" })],
  }));

  it("leaves plain chances out of All, but not his own", () => {
    expect(filterTimeline(events, "all").map((e) => e.kind)).toEqual(["goal", "likely", "sprint"]);
  });

  it("Goals shows confirmed goals; Chances shows every open chance; Mine shows his", () => {
    expect(filterTimeline(events, "goals").map((e) => e.kind)).toEqual(["goal"]);
    expect(filterTimeline(events, "chances").map((e) => e.kind)).toEqual(["likely", "chance", "chance"]);
    expect(filterTimeline(events, "mine").map((e) => e.kind)).toEqual(["sprint"]);
  });

  it("offers only the chips that have something, Mine only for a viewer in the match", () => {
    expect(timelineFilters(events, true).map((f) => [f.id, f.count])).toEqual([["all", 3], ["goals", 1], ["chances", 3], ["mine", 1]]);
    expect(timelineFilters(events, false).map((f) => f.id)).toEqual(["all", "goals", "chances"]);
    expect(timelineFilters(buildTimeline(input()).events, true)).toEqual([{ id: "all", count: 0 }]);
  });
});
