import { index, integer, pgTable, serial, text, timestamp, unique } from "drizzle-orm/pg-core";
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

export type Friendship = typeof friendshipsTable.$inferSelect;