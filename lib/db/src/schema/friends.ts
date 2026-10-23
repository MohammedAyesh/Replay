import { index, integer, pgTable, serial, text, timestamp, unique, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { recordingsTable } from "./recordings";
import { usersTable } from "./users";

export type FriendshipStatus = "pending" | "accepted";

export const friendshipsTable = pgTable(
  "friendships",
  {
    id: serial("id").primaryKey(),
    userLowId: integer("user_low_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    userHighId: integer("user_high_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    requestedBy: integer("requested_by")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("pending").$type<FriendshipStatus>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    respondedAt: timestamp("responded_at", { withTimezone: true }),
  },
  (table) => [
    unique("friendships_pair_unique").on(table.userLowId, table.userHighId),
    index("friendships_user_low_id_idx").on(table.userLowId),
    index("friendships_user_high_id_idx").on(table.userHighId),
  ],
);

export const playerIdentificationRequestsTable = pgTable(
  "player_identification_requests",
  {
    id: serial("id").primaryKey(),
    recordingId: integer("recording_id").notNull().references(() => recordingsTable.id, { onDelete: "cascade" }),
    requesterUserId: integer("requester_user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
    recipientUserId: integer("recipient_user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
    matchCode: text("match_code"),
    rosterPlayerId: text("roster_player_id").notNull(),
    playerName: text("player_name"),
    shirtNumber: text("shirt_number"),
    status: text("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    respondedAt: timestamp("responded_at", { withTimezone: true }),
  },
  (table) => [
    index("player_identification_requests_recipient_status_idx").on(table.recipientUserId, table.status),
    uniqueIndex("player_identification_requests_pending_unique").on(
      table.recordingId, table.requesterUserId, table.recipientUserId, table.rosterPlayerId,
    ).where(sql`${table.status} = 'pending'`),
  ],
);

export type Friendship = typeof friendshipsTable.$inferSelect;