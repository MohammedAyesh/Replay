/**
 * Goals players confirm (2026-10-25, "anyone confirms").
 *
 * The footage cannot tell a goal from a save: on recordings 392 and 394 no
 * position or ball feature after the ball reached the mouth separated the ten
 * real goals from the saves, and the goal detector found 7 of 7 on one match
 * and 0 of 3 on the other. What it CAN do is find every chance: the detector's
 * goals, the shots on target and goals.py's raw goal events together held all
 * ten real goals. So Replay lists those candidates and a goal counts only once
 * a player in the match says it was one. One "goal" vote from anyone confirms;
 * a "not a goal" vote with no "goal" vote sets it aside. A voter can take his
 * vote back.
 *
 * Who scored is still Replay's: the strike before the ball went in, and an own
 * goal (credited to the attacking side, to no player) when that touch was the
 * defending side's (matchPlay.credit, the minimap's attacking direction).
 */
import { and, eq, inArray } from "drizzle-orm";
import { db, recordingGoalVotesTable } from "@workspace/db";
import {
  creditGoalAt,
  detectedGoals,
  detectedShots,
  goalContext,
  mouthEntryBefore,
  pitchSizeOf,
  shotContext,
  type DetectedGoal,
} from "./matchPlay";
import type { RecordingPlay } from "./matchPlayLoad";

export const GOAL_REVIEW = {
  /** a shot this close before (or just after) a detected goal is that goal, seconds */
  shotMergeBefore: 8,
  shotMergeAfter: 3,
  /** a raw goals.py event this long after a candidate is that candidate (it is timed when play stopped), seconds */
  eventMergeBefore: 20,
  eventMergeAfter: 2,
  /** raw goals.py events this close together are one candidate, seconds */
  eventMergeSeconds: 10,
  /** a vote belongs to the candidate within this of its time, seconds */
  voteMatchSeconds: 3,
} as const;

export type GoalVerdict = "goal" | "not_goal";
export type GoalVote = { atTenths: number; userId: number; verdict: GoalVerdict };

export type GoalCandidate = DetectedGoal & {
  /** what found it: the goal detector, a shot on target, or a goals.py goal event */
  source: "goal" | "shot" | "event";
  /** its key for votes: tracking seconds x 10 */
  key: number;
};

export type ReviewedGoal = GoalCandidate & {
  status: "confirmed" | "rejected" | "open";
  confirmedBy: number[];
  rejectedBy: number[];
};

export const tenths = (t: number) => Math.round(t * 10);

/** Every chance that may have been a goal, in time order. */
export function goalCandidates(play: Pick<RecordingPlay, "events" | "touches" | "manifest" | "sidecars" | "phases" | "inPlay" | "direction" | "segments" | "kits" | "bib">): GoalCandidate[] {
  const pitch = pitchSizeOf(play.manifest);
  const gctx = goalContext(play);
  const out: GoalCandidate[] = detectedGoals(play.events, play.touches, pitch, gctx)
    .map((g) => ({ ...g, source: "goal" as const, key: tenths(g.t) }));
  const near = (t: number, before: number, after: number) => out.some((c) => t >= c.t - after && t <= c.t + before);
  for (const s of detectedShots(play.events, play.touches, pitch, shotContext(play))) {
    // a shot GOAL_REVIEW.shotMergeBefore s before a detected goal is its strike
    if (out.some((c) => c.source === "goal" && s.t >= c.t - GOAL_REVIEW.shotMergeBefore && s.t <= c.t + GOAL_REVIEW.shotMergeAfter)) continue;
    const g = creditGoalAt(s.t + 0.05, play.touches, pitch, null, gctx.direction ?? null);
    out.push({ ...g, t: s.t, source: "shot", key: tenths(s.t) });
  }
  const raw = play.events.filter((e) => e.type.toLowerCase() === "goal").map((e) => e.t).sort((a, b) => a - b);
  let last = -Infinity;
  for (const t of raw) {
    if (t - last <= GOAL_REVIEW.eventMergeSeconds) { last = t; continue; }
    last = t;
    if (near(t, GOAL_REVIEW.eventMergeBefore, GOAL_REVIEW.eventMergeAfter)) continue;
    // goals.py times it when play stopped: the ball's entry before it is the moment
    const entry = mouthEntryBefore(t, play.touches, pitch, gctx);
    const at = entry?.t ?? t;
    const g = creditGoalAt(at, play.touches, pitch, entry?.goalX ?? null, gctx.direction ?? null);
    out.push({ ...g, t: at, source: "event", key: tenths(at) });
  }
  return out.sort((a, b) => a.t - b.t);
}

/**
 * Candidates with the players' verdicts. A "goal" vote at a moment no
 * candidate is near any more (a re-analysis moved things) still stands: the
 * goal is credited at the voted moment.
 */
export function reviewGoals(
  candidates: GoalCandidate[],
  votes: GoalVote[],
  creditAt: (t: number) => DetectedGoal,
): ReviewedGoal[] {
  const reviewed: ReviewedGoal[] = candidates.map((c) => ({ ...c, status: "open", confirmedBy: [], rejectedBy: [] }));
  const orphans = new Map<number, ReviewedGoal>();
  for (const v of votes) {
    const t = v.atTenths / 10;
    let best: ReviewedGoal | null = null;
    for (const c of reviewed) {
      if (Math.abs(c.t - t) <= GOAL_REVIEW.voteMatchSeconds && (!best || Math.abs(c.t - t) < Math.abs(best.t - t))) best = c;
    }
    if (!best) {
      if (v.verdict !== "goal") continue;
      const near = [...orphans.values()].find((o) => Math.abs(o.t - t) <= GOAL_REVIEW.voteMatchSeconds);
      best = near ?? { ...creditAt(t), t, source: "event", key: v.atTenths, status: "open", confirmedBy: [], rejectedBy: [] };
      orphans.set(best.key, best);
    }
    const list = v.verdict === "goal" ? best.confirmedBy : best.rejectedBy;
    if (!list.includes(v.userId)) list.push(v.userId);
  }
  const all = [...reviewed, ...orphans.values()];
  for (const c of all) c.status = c.confirmedBy.length ? "confirmed" : c.rejectedBy.length ? "rejected" : "open";
  return all.sort((a, b) => a.t - b.t);
}

/** The goals that count: the candidates a player confirmed. */
export function confirmedGoals(play: Parameters<typeof goalCandidates>[0], votes: GoalVote[]): DetectedGoal[] {
  if (!votes.some((v) => v.verdict === "goal")) return [];
  return reviewedGoalsOf(play, votes).filter((g) => g.status === "confirmed");
}

export function reviewedGoalsOf(play: Parameters<typeof goalCandidates>[0], votes: GoalVote[]): ReviewedGoal[] {
  const pitch = pitchSizeOf(play.manifest);
  const direction = goalContext(play).direction ?? null;
  return reviewGoals(goalCandidates(play), votes, (t) => {
    const entry = mouthEntryBefore(t + 1, play.touches, pitch, goalContext(play));
    return creditGoalAt(t, play.touches, pitch, entry?.goalX ?? null, direction);
  });
}

/** Every vote on these recordings, by recording. */
export async function goalVotesFor(recordingIds: number[]): Promise<Map<number, GoalVote[]>> {
  const out = new Map<number, GoalVote[]>();
  const ids = [...new Set(recordingIds)].filter(Number.isSafeInteger);
  if (!ids.length) return out;
  let rows: Array<{ recordingId: number; atTenths: number; userId: number; verdict: string }> = [];
  try {
    rows = await db.select({
      recordingId: recordingGoalVotesTable.recordingId,
      atTenths: recordingGoalVotesTable.atTenths,
      userId: recordingGoalVotesTable.userId,
      verdict: recordingGoalVotesTable.verdict,
    }).from(recordingGoalVotesTable).where(inArray(recordingGoalVotesTable.recordingId, ids));
  } catch {
    // before the table exists (the first publish after this change), nobody has confirmed anything
    return out;
  }
  for (const r of rows) {
    if (r.verdict !== "goal" && r.verdict !== "not_goal") continue;
    const list = out.get(r.recordingId) ?? [];
    list.push({ atTenths: r.atTenths, userId: r.userId, verdict: r.verdict });
    out.set(r.recordingId, list);
  }
  return out;
}

/** Cast, change or (verdict null) take back one player's verdict on one candidate. */
export async function setGoalVote(recordingId: number, atTenths: number, userId: number, verdict: GoalVerdict | null, matchId: number | null): Promise<void> {
  if (verdict === null) {
    await db.delete(recordingGoalVotesTable).where(and(
      eq(recordingGoalVotesTable.recordingId, recordingId),
      eq(recordingGoalVotesTable.atTenths, atTenths),
      eq(recordingGoalVotesTable.userId, userId),
    ));
    return;
  }
  await db.insert(recordingGoalVotesTable)
    .values({ recordingId, atTenths, userId, verdict, matchId })
    .onConflictDoUpdate({
      target: [recordingGoalVotesTable.recordingId, recordingGoalVotesTable.atTenths, recordingGoalVotesTable.userId],
      set: { verdict, matchId, updatedAt: new Date() },
    });
}
