import {
  pgTable,
  serial,
  integer,
  text,
  timestamp,
  boolean,
  real,
  unique,
  index,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";
import { fieldsTable } from "./fields";
import { footageRequestsTable } from "./footageRequests";

/**
 * A match room is the players' side of a booked match. Every owner booking
 * (footage_requests row) gets exactly one room with a short public code, which
 * becomes the link people share: replayjo.com/m/<code>.
 *
 * The booking stays the source of truth for time, field, VAR and footage; the
 * room only adds what players care about: who is coming, the teams, the score,
 * the vote.
 */
export const matchRoomsTable = pgTable("match_rooms", {
  id: serial("id").primaryKey(),
  footageRequestId: integer("footage_request_id").notNull().unique()
    .references(() => footageRequestsTable.id, { onDelete: "cascade" }),
  fieldId: integer("field_id").notNull().references(() => fieldsTable.id, { onDelete: "cascade" }),
  code: text("code").notNull().unique(),
  /** Whoever opens the captain link first (or the first player to join) becomes captain. */
  captainUserId: integer("captain_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  captainToken: text("captain_token").notNull(),
  title: text("title"),
  /** Players per side, e.g. 6 for 6v6. Drives "7 of 12 coming". */
  playersPerSide: integer("players_per_side").notNull().default(6),
  teamAName: text("team_a_name"),
  teamBName: text("team_b_name"),
  teamAColor: text("team_a_color").notNull().default("#F2F4F8"),
  teamBColor: text("team_b_color").notNull().default("#FF6B1A"),
  /** 2 or 3. With three teams, games record which two teams played and a table ranks them. */
  teamCount: integer("team_count").notNull().default(2),
  teamCName: text("team_c_name"),
  teamCColor: text("team_c_color").notNull().default("#2FD8C4"),
  scoreA: integer("score_a"),
  scoreB: integer("score_b"),
  scoreUpdatedAt: timestamp("score_updated_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * One row per person on the roster. user_id is null for people the captain
 * added by name / number / email who have not signed up yet; they appear on
 * the roster with dotted initials and an invite link of their own.
 */
export const matchPlayersTable = pgTable("match_players", {
  id: serial("id").primaryKey(),
  matchId: integer("match_id").notNull().references(() => matchRoomsTable.id, { onDelete: "cascade" }),
  userId: integer("user_id").references(() => usersTable.id, { onDelete: "cascade" }),
  displayName: text("display_name").notNull(),
  contactPhone: text("contact_phone"),
  contactEmail: text("contact_email"),
  invitedByPlayerId: integer("invited_by_player_id"),
  inviteToken: text("invite_token").notNull().unique(),
  /** invited | in | maybe | out */
  rsvp: text("rsvp").notNull().default("invited"),
  /** A | B | C | null (not placed yet) */
  team: text("team"),
  shirtNumber: integer("shirt_number"),
  /** Position on the lineup board as percentages of the pitch (0-100). */
  slotX: real("slot_x"),
  slotY: real("slot_y"),
  rsvpAt: timestamp("rsvp_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique("match_players_match_user_unique").on(table.matchId, table.userId),
  index("match_players_user_idx").on(table.userId),
]);

/** Optional split of one booking into several games, for per-game scores and stats. */
export const matchGamesTable = pgTable("match_games", {
  id: serial("id").primaryKey(),
  matchId: integer("match_id").notNull().references(() => matchRoomsTable.id, { onDelete: "cascade" }),
  idx: integer("idx").notNull(),
  startOffsetSec: integer("start_offset_sec").notNull(),
  endOffsetSec: integer("end_offset_sec").notNull(),
  /** The two teams that played this game; scoreA is team_x's goals, scoreB team_y's. */
  teamX: text("team_x").notNull().default("A"),
  teamY: text("team_y").notNull().default("B"),
  scoreA: integer("score_a"),
  scoreB: integer("score_b"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique("match_games_match_idx_unique").on(table.matchId, table.idx),
]);

/** Man-of-the-match votes: one per voter per match, open for 24 h after the whistle. */
export const motmVotesTable = pgTable("motm_votes", {
  id: serial("id").primaryKey(),
  matchId: integer("match_id").notNull().references(() => matchRoomsTable.id, { onDelete: "cascade" }),
  voterUserId: integer("voter_user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  candidatePlayerId: integer("candidate_player_id").notNull()
    .references(() => matchPlayersTable.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique("motm_votes_match_voter_unique").on(table.matchId, table.voterUserId),
]);

/**
 * Stats purchases. kind: match (0.5 JOD, one player, one match), team (captain
 * unlocks everyone on the roster for one match), monthly (2 JOD, stats-only
 * plan). Paid by CliQ or cash and confirmed by an admin: status pending → paid.
 */
export const statUnlocksTable = pgTable("stat_unlocks", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  matchId: integer("match_id").references(() => matchRoomsTable.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  amountFils: integer("amount_fils").notNull(),
  method: text("method").notNull().default("cliq"),
  reference: text("reference").notNull().unique(),
  status: text("status").notNull().default("pending"),
  validUntil: timestamp("valid_until", { withTimezone: true }),
  confirmedBy: integer("confirmed_by").references(() => usersTable.id, { onDelete: "set null" }),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("stat_unlocks_user_idx").on(table.userId),
]);

export type MatchRoom = typeof matchRoomsTable.$inferSelect;
export type MatchPlayer = typeof matchPlayersTable.$inferSelect;
export type MatchGame = typeof matchGamesTable.$inferSelect;
export type MotmVote = typeof motmVotesTable.$inferSelect;
export type StatUnlock = typeof statUnlocksTable.$inferSelect;
