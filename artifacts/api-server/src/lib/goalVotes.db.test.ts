import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inArray } from "drizzle-orm";
import { db, fieldsTable, recordingGoalVotesTable, recordingsTable, usersTable } from "@workspace/db";
import { goalVotesFor, setGoalVote } from "./goalReview";
import { goalVoteRights } from "./goalRights";
import { oneChanceEach, type ReplayGoal } from "./matchFeed";

const TAG = `gv_${Date.now()}`;
let recordingId: number;
let fieldId: number;
const users: Record<string, number> = {};

beforeAll(async () => {
  for (const [key, isAdmin] of [["player", false], ["stranger", false], ["admin", true]] as const) {
    const [u] = await db.insert(usersTable).values({ name: `${key} ${TAG}`, email: `${TAG}_${key}@test.local`, profileComplete: true, isAdmin })
      .returning({ id: usersTable.id });
    users[key] = u.id;
  }
  const [field] = await db.insert(fieldsTable).values({ name: `Votes ${TAG}`, location: "Test", cameraId: `cam-${TAG}` }).returning({ id: fieldsTable.id });
  fieldId = field.id;
  const [rec] = await db.insert(recordingsTable).values({
    fieldId, court: "1", date: "2026-10-22", timeSlot: "22:00", duration: "01:00:00", videoUrl: `https://example.test/${TAG}.m3u8`, isVisible: true,
  }).returning({ id: recordingsTable.id });
  recordingId = rec.id;
});

afterAll(async () => {
  await db.delete(recordingGoalVotesTable).where(inArray(recordingGoalVotesTable.recordingId, [recordingId]));
  await db.delete(recordingsTable).where(inArray(recordingsTable.id, [recordingId]));
  await db.delete(fieldsTable).where(inArray(fieldsTable.id, [fieldId]));
  await db.delete(usersTable).where(inArray(usersTable.id, Object.values(users)));
});

describe("goal votes in the database", () => {
  it("takes a vote back after a re-analysis moved its chance by a second or two", async () => {
    await setGoalVote(recordingId, 23990, users.player, "goal", null);
    // the chance now sits at 2401.2 s: undo arrives with that key
    await setGoalVote(recordingId, 24012, users.player, null, null);
    expect((await goalVotesFor([recordingId])).get(recordingId) ?? []).toEqual([]);
  });

  it("changing a verdict on a moved chance leaves one vote, not two", async () => {
    await setGoalVote(recordingId, 30000, users.player, "goal", null);
    await setGoalVote(recordingId, 30015, users.player, "not_goal", null);
    const votes = (await goalVotesFor([recordingId])).get(recordingId) ?? [];
    expect(votes).toEqual([{ atTenths: 30015, userId: users.player, verdict: "not_goal" }]);
    await setGoalVote(recordingId, 30015, users.player, null, null);
  });

  it("does not touch his votes on a chance further away, or other players' votes", async () => {
    await setGoalVote(recordingId, 40000, users.player, "goal", null);
    await setGoalVote(recordingId, 40000, users.admin, "goal", null);
    await setGoalVote(recordingId, 40500, users.player, null, null);
    const votes = (await goalVotesFor([recordingId])).get(recordingId) ?? [];
    expect(votes.map((v) => v.userId).sort()).toEqual([users.player, users.admin].sort());
  });
});

describe("who may confirm a goal", () => {
  it("lets an admin vote anywhere and nobody else on footage no match covers", async () => {
    expect((await goalVoteRights(users.admin, recordingId))(100)).toBe(true);
    const stranger = await goalVoteRights(users.stranger, recordingId);
    expect(stranger(null)).toBe(false);
    expect(stranger(100)).toBe(false);
  });
});

describe("one chance each when two recordings share an analysis", () => {
  const g = (recordingId: number, atSeconds: number, status: ReplayGoal["status"] = "open", confirmedBy: string[] = []): ReplayGoal => ({
    atSeconds, side: null, scorer: null, scorers: [], recordingId, gameIndex: null, t: atSeconds,
    status, source: "shot", key: Math.round(atSeconds * 10), ownGoal: false, confirmedBy, rejectedBy: [], myVote: null,
  });

  it("keeps the first recording's copy, or the one players answered on", () => {
    const out = oneChanceEach([g(402, 1306.65), g(401, 1306.65), g(401, 1442.45), g(402, 1442.5, "confirmed", ["Ali"]), g(402, 3000)]);
    expect(out.map((x) => [x.recordingId, x.atSeconds])).toEqual([[401, 1306.65], [402, 1442.5], [402, 3000]]);
  });

  it("never merges two chances of the same recording", () => {
    expect(oneChanceEach([g(401, 100), g(401, 101)])).toHaveLength(2);
  });
});
