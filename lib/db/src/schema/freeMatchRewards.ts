import { pgTable, serial, integer, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { usersTable } from "./users";
import { matchRoomsTable } from "./matchRooms";

/**
 * A free match a player has earned, and later spends on a booking (that
 * booking's room is `usedMatchId`; a booking that never records hands it back).
 *
 * - kind "challenge": he booked by CliQ, found himself and enough friends found
 *   themselves in the same match. `sourceMatchId` is that match; once per player.
 * - kind "loyalty": every Nth paid booking he played earns one. `milestone` is N
 *   (1 for the first five, 2 for the next five...); `sourceMatchId` is empty.
 */
export const freeMatchRewardsTable = pgTable("free_match_rewards", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  kind: text("kind").notNull().default("challenge").$type<"challenge" | "loyalty">(),
  sourceMatchId: integer("source_match_id").references(() => matchRoomsTable.id, { onDelete: "cascade" }),
  /** Loyalty only: which block of N bookings earned it. */
  milestone: integer("milestone"),
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
  uniqueIndex("free_match_rewards_milestone_unique").on(table.userId, table.kind, table.milestone),
  index("free_match_rewards_user_idx").on(table.userId),
]);

export type FreeMatchReward = typeof freeMatchRewardsTable.$inferSelect;
