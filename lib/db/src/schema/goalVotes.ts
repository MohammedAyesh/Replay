import { check, index, integer, pgTable, serial, text, timestamp, unique } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { recordingsTable } from "./recordings";
import { usersTable } from "./users";
import { matchRoomsTable } from "./matchRooms";

/**
 * Players confirming goals (2026-10-25). Replay finds goal CANDIDATES in the
 * footage (the goal detector, shots on target, goals.py's raw goal events);
 * none of them counts until a player in the match says "that was a goal".
 * One "goal" vote from anyone in the match confirms it. Goals on two of the
 * analysed matches could not be told from saves by position or ball data, so
 * a person decides.
 *
 * Keyed by the recording and the candidate's tracking time in tenths of a
 * second, so a vote outlives the room it was cast from and a re-analysis that
 * shifts a candidate by a second still finds it.
 */
export const recordingGoalVotesTable = pgTable("recording_goal_votes", {
  id: serial("id").primaryKey(),
  recordingId: integer("recording_id").notNull().references(() => recordingsTable.id, { onDelete: "cascade" }),
  /** the candidate's tracking seconds x 10 */
  atTenths: integer("at_tenths").notNull(),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  /** goal | not_goal */
  verdict: text("verdict").notNull(),
  /** the match room it was cast from, for the record */
  matchId: integer("match_id").references(() => matchRoomsTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique("recording_goal_votes_unique").on(table.recordingId, table.atTenths, table.userId),
  index("recording_goal_votes_recording_idx").on(table.recordingId),
  check("recording_goal_votes_verdict_check", sql`${table.verdict} IN ('goal', 'not_goal')`),
]);

export type RecordingGoalVote = typeof recordingGoalVotesTable.$inferSelect;
