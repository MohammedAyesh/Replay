import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { matchPlayersTable, matchRoomsTable } from "./matchRooms";
import { usersTable } from "./users";

export type MatchPlayerStatsCacheValue = {
  minutes: number | null;
  distanceKm: number | null;
  topSpeedKmh: number | null;
  touches: number | null;
  passesTried: number | null;
  passesCompleted: number | null;
  passesReceived: number | null;
  dribbles: number | null;
  dribblesWon: number | null;
  dribblesLost: number | null;
  shots: number | null;
  goals: number | null;
};

/**
 * Derived match metrics for a confirmed roster identity. The fingerprint
 * records the claimed parts and tracking bundle IDs that produced the cache;
 * recordingIds makes invalidation cheap when a claim or bundle changes.
 */
export const matchPlayerStatsCacheTable = pgTable("match_player_stats_cache", {
  id: serial("id").primaryKey(),
  matchId: integer("match_id").notNull().references(() => matchRoomsTable.id, { onDelete: "cascade" }),
  matchPlayerId: integer("match_player_id").notNull().references(() => matchPlayersTable.id, { onDelete: "cascade" }),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  recordingIds: integer("recording_ids").array().notNull().default(sql`ARRAY[]::integer[]`),
  fingerprint: text("fingerprint").notNull(),
  stats: jsonb("stats").$type<MatchPlayerStatsCacheValue>().notNull(),
  computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("match_player_stats_cache_match_player_uidx").on(table.matchId, table.matchPlayerId),
  index("match_player_stats_cache_user_idx").on(table.userId),
]);

export const insertMatchPlayerStatsCacheSchema = createInsertSchema(matchPlayerStatsCacheTable)
  .omit({ id: true, computedAt: true });
export type InsertMatchPlayerStatsCache = z.infer<typeof insertMatchPlayerStatsCacheSchema>;
export type MatchPlayerStatsCache = typeof matchPlayerStatsCacheTable.$inferSelect;