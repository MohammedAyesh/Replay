import { describe, expect, it, vi } from "vitest";

vi.mock("@workspace/db", () => ({ db: {}, recordingGoalVotesTable: {} }));

import { reviewGoals, tenths, type GoalCandidate, type GoalVote } from "./goalReview";
import type { DetectedGoal, Lab } from "./matchPlay";

const DARK: Lab = [50, 128, 129];
const cand = (t: number, source: GoalCandidate["source"], trackId: string | null = "s1:t1"): GoalCandidate =>
  ({ t, trackId, kit: DARK, lead: 1, touchF: Math.round(t * 20), source, key: tenths(t) });
const vote = (t: number, userId: number, verdict: GoalVote["verdict"]): GoalVote => ({ atTenths: tenths(t), userId, verdict });
const creditAt = (t: number): DetectedGoal => ({ t, trackId: "s9:t9", kit: DARK, lead: 1, touchF: null });

// Recording 394's three real goals were a shot each (39:59, 82:02, 89:08); the
// goal detector found none of them. Players confirm them from the chances list.
describe("goal review: anyone confirms", () => {
  const candidates = [cand(2399, "shot"), cand(2410, "shot"), cand(4922, "shot"), cand(5348, "event")];

  it("counts nothing until somebody says goal", () => {
    const r = reviewGoals(candidates, [], creditAt);
    expect(r.map((g) => g.status)).toEqual(["open", "open", "open", "open"]);
  });

  it("confirms a chance on one player's goal, whatever anyone else says", () => {
    const r = reviewGoals(candidates, [vote(2399, 7, "goal"), vote(2399, 8, "not_goal"), vote(2410, 8, "not_goal")], creditAt);
    expect(r.find((g) => g.t === 2399)).toMatchObject({ status: "confirmed", confirmedBy: [7], rejectedBy: [8] });
    expect(r.find((g) => g.t === 2410)?.status).toBe("rejected");
    expect(r.filter((g) => g.status === "confirmed")).toHaveLength(1);
  });

  it("finds the chance a vote was cast on after a re-analysis moved it by a second or two", () => {
    const moved = [cand(2401.2, "shot")];
    const r = reviewGoals(moved, [vote(2399, 7, "goal")], creditAt);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ t: 2401.2, status: "confirmed" });
  });

  it("keeps a confirmed goal whose chance is gone, credited at the voted moment", () => {
    const r = reviewGoals([], [vote(3000, 7, "goal"), vote(3001, 8, "goal"), vote(3100, 7, "not_goal")], creditAt);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ t: 3000, status: "confirmed", trackId: "s9:t9", confirmedBy: [7, 8] });
  });

  it("puts a vote on the nearest chance only", () => {
    const close = [cand(100, "goal"), cand(104, "shot")];
    const r = reviewGoals(close, [vote(103.5, 7, "goal")], creditAt);
    expect(r.map((g) => g.status)).toEqual(["open", "confirmed"]);
  });
});
