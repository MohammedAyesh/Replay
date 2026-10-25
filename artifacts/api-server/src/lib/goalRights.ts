/**
 * Who may say whether a chance was a goal (2026-10-25).
 *
 * One "goal" vote confirms a goal: it changes the score Replay offers, the
 * match stats and everyone's goal clips. So only people in that match may
 * cast one: a player who said he's in, its captain, the field's owner, or
 * an admin. The match page (POST /m/:code/goals/vote) and the "Is this you?"
 * deck both ask here, so the two doors have the same lock.
 */
import { and, eq } from "drizzle-orm";
import { db, fieldOwnersTable, usersTable, type MatchRoom } from "@workspace/db";
import { isPlaying, playerForUser } from "./matchRooms";
import { roomsForRecording } from "./matchFeed";

export type GoalVoter = { id: number; isAdmin?: boolean | null };

async function ownsField(userId: number, fieldId: number): Promise<boolean> {
  const [row] = await db.select({ id: fieldOwnersTable.id }).from(fieldOwnersTable)
    .where(and(eq(fieldOwnersTable.userId, userId), eq(fieldOwnersTable.fieldId, fieldId)));
  return Boolean(row);
}

/** In this match: an "in" player, its captain or the field's owner (admins pass everywhere). */
export async function mayConfirmGoalsInRoom(user: GoalVoter, room: Pick<MatchRoom, "id" | "captainUserId" | "fieldId">): Promise<boolean> {
  if (user.isAdmin) return true;
  if (room.captainUserId === user.id) return true;
  if (isPlaying(await playerForUser(room.id, user.id))) return true;
  return ownsField(user.id, room.fieldId);
}

/**
 * Where in this recording may this user vote? The answer is a test on
 * tracking seconds: a match counts only over its own share of the recording.
 * Called with null it says whether he may vote anywhere in it.
 */
export async function goalVoteRights(userId: number, recordingId: number): Promise<(atSeconds: number | null) => boolean> {
  const [user] = await db.select({ id: usersTable.id, isAdmin: usersTable.isAdmin }).from(usersTable).where(eq(usersTable.id, userId));
  if (!user) return () => false;
  if (user.isAdmin) return () => true;
  const windows: Array<[number, number]> = [];
  for (const { room, fromSeconds, toSeconds } of await roomsForRecording(recordingId)) {
    if (await mayConfirmGoalsInRoom(user, room)) windows.push([fromSeconds, toSeconds]);
  }
  return (atSeconds) => atSeconds === null
    ? windows.length > 0
    : windows.some(([from, to]) => atSeconds >= from && atSeconds < to);
}
