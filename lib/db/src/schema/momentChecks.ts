import { check, index, integer, pgTable, serial, text, timestamp, unique } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { recordingsTable } from "./recordings";
import { usersTable } from "./users";

/**
 * "Is this you?" (2026-10-25). After claiming himself, a player swipes
 * through the moments Replay is not sure were his -- a crossing with another
 * player, a stitch between two pieces, someone right next to him, a short
 * piece -- and through goal candidates. One row per answer.
 *
 *   yes  -- it was him: the moment becomes a clip and counts
 *   no   -- it was not: `fromFrame..toFrame` of `trackId` comes off his claim
 *           (and stays off when the /find page saves the claim again)
 *   skip -- can't tell: the moment stays out of his clips and is not asked again
 *
 * `momentId` is the personal moment's id ("me-dribble-1234") or, for a goal
 * card, "goal:<atTenths>" (the vote itself is in recording_goal_votes).
 */
export const claimMomentChecksTable = pgTable("claim_moment_checks", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  recordingId: integer("recording_id").notNull().references(() => recordingsTable.id, { onDelete: "cascade" }),
  momentId: text("moment_id").notNull(),
  verdict: text("verdict").notNull(),
  /** the cut a "no" takes off the claim; null otherwise */
  trackId: text("track_id"),
  fromFrame: integer("from_frame"),
  toFrame: integer("to_frame"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique("claim_moment_checks_unique").on(table.userId, table.recordingId, table.momentId),
  index("claim_moment_checks_recording_idx").on(table.recordingId),
  check("claim_moment_checks_verdict_check", sql`${table.verdict} IN ('yes', 'no', 'skip')`),
]);

export type ClaimMomentCheck = typeof claimMomentChecksTable.$inferSelect;
