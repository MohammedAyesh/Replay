import { pgTable, integer, primaryKey, timestamp } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const followsTable = pgTable(
  "follows",
  {
    followerId: integer("follower_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
    followeeId: integer("followee_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.followerId, t.followeeId] })]
);

export type Follow = typeof followsTable.$inferSelect;
