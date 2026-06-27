import { pgTable, integer, primaryKey, timestamp } from "drizzle-orm/pg-core";
import { usersTable } from "./users";
import { clipsTable } from "./clips";

export const likesTable = pgTable(
  "likes",
  {
    userId: integer("user_id").notNull().references(() => usersTable.id),
    clipId: integer("clip_id").notNull().references(() => clipsTable.id),
    likedAt: timestamp("liked_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.clipId] })]
);

export type Like = typeof likesTable.$inferSelect;
