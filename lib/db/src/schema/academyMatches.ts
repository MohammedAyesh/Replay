import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, pgTable, serial, text, timestamp, unique } from "drizzle-orm/pg-core";
import { academiesTable } from "./academies";
import { academyPlayersTable } from "./academyPlayers";
import { academySessionsTable } from "./academySessions";
import { recordingsTable } from "./recordings";

/**
 * An academy match's page: which recording it shows, whether parents can see it,
 * the kit hints the analysis gets, and the team stats last computed for it.
 */
export const academyMatchPagesTable = pgTable("academy_match_pages", {
  sessionId: integer("session_id").primaryKey().references(() => academySessionsTable.id, { onDelete: "cascade" }),
  academyId: integer("academy_id").notNull().references(() => academiesTable.id, { onDelete: "cascade" }),
  recordingId: integer("recording_id").references(() => recordingsTable.id, { onDelete: "set null" }),
  published: boolean("published").notNull().default(false),
  kitColor: text("kit_color"),
  opponentKitColor: text("opponent_kit_color"),
  playersPerSide: integer("players_per_side"),
  shirtsHaveNumbers: text("shirts_have_numbers").notNull().default("yes"),
  teamStats: jsonb("team_stats"),
  statsFingerprint: text("stats_fingerprint"),
  statsComputedAt: timestamp("stats_computed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check("academy_match_pages_shirts_check", sql`${table.shirtsHaveNumbers} in ('yes', 'no', 'unknown')`),
  check("academy_match_pages_players_per_side_check", sql`${table.playersPerSide} is null or ${table.playersPerSide} between 3 and 11`),
  index("academy_match_pages_academy_idx").on(table.academyId),
]);

/**
 * Who played in an academy match and in which shirt number, and which player the
 * analysis found is them. `rosterPlayerId` is the pipeline's match-roster id; with
 * `boundBy` "owner" it was picked by hand (null = "not in this video"), otherwise
 * the shirt number decides.
 */
export const academyMatchLineupsTable = pgTable("academy_match_lineups", {
  id: serial("id").primaryKey(),
  sessionId: integer("session_id").notNull().references(() => academySessionsTable.id, { onDelete: "cascade" }),
  playerId: integer("player_id").notNull().references(() => academyPlayersTable.id, { onDelete: "cascade" }),
  shirtNumber: integer("shirt_number"),
  inSquad: boolean("in_squad").notNull().default(true),
  rosterPlayerId: text("roster_player_id"),
  boundBy: text("bound_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique("academy_match_lineups_session_player_unique").on(table.sessionId, table.playerId),
  check("academy_match_lineups_shirt_check", sql`${table.shirtNumber} is null or ${table.shirtNumber} between 0 and 99`),
  check("academy_match_lineups_bound_by_check", sql`${table.boundBy} is null or ${table.boundBy} in ('owner')`),
]);

/** One academy player's numbers for one match, kept so players can be compared across matches. */
export const academyMatchPlayerStatsTable = pgTable("academy_match_player_stats", {
  id: serial("id").primaryKey(),
  sessionId: integer("session_id").notNull().references(() => academySessionsTable.id, { onDelete: "cascade" }),
  academyId: integer("academy_id").notNull().references(() => academiesTable.id, { onDelete: "cascade" }),
  playerId: integer("player_id").notNull().references(() => academyPlayersTable.id, { onDelete: "cascade" }),
  recordingId: integer("recording_id").notNull().references(() => recordingsTable.id, { onDelete: "cascade" }),
  rosterPlayerId: text("roster_player_id"),
  stats: jsonb("stats").notNull(),
  computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique("academy_match_player_stats_session_player_unique").on(table.sessionId, table.playerId),
  index("academy_match_player_stats_player_idx").on(table.playerId),
  index("academy_match_player_stats_academy_idx").on(table.academyId),
]);

export type AcademyMatchPage = typeof academyMatchPagesTable.$inferSelect;
export type AcademyMatchLineup = typeof academyMatchLineupsTable.$inferSelect;
