import { pgTable, serial, integer, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { usersTable } from "./users";
import { matchRoomsTable } from "./matchRooms";

/**
 * The free-match challenge's reward: a player booked a match, paid by CliQ,
 * found himself in the video and enough friends found themselves in the same
 * match. One row per match that earned it. Used by a later booking (that
 * booking's room is `usedMatchId`); cancelling that booking before it is paid
 * hands the reward back.
 */
export const freeMatchRewardsTable = pgTable("free_match_rewards", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  sourceMatchId: integer("source_match_id").notNull().references(() => matchRoomsTable.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("available").$type<"available" | "used">(),
  freeHours: integer("free_hours").notNull(),
  /** What the free hours were worth when earned, for the admin ledger. */
  worthFils: integer("worth_fils").notNull(),
  /** The friends who found themselves, as names at the time, for the thank-you line. */
  friendNames: text("friend_names").array().notNull().default([]),
  earnedAt: timestamp("earned_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedMatchId: integer("used_match_id").references(() => matchRoomsTable.id, { onDelete: "set null" }),
  usedAt: timestamp("used_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("free_match_rewards_source_unique").on(table.sourceMatchId),
  index("free_match_rewards_user_idx").on(table.userId),
]);

export type FreeMatchReward = typeof freeMatchRewardsTable.$inferSelect;
