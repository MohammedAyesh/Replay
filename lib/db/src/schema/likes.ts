import { pgTable, serial, integer, timestamp, unique, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { usersTable } from "./users";
import { clipsTable } from "./clips";
import { userClipsTable } from "./userClips";

export const likesTable = pgTable(
  "likes",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").notNull().references(() => usersTable.id),
    clipId: integer("clip_id").references(() => clipsTable.id),
    userClipId: integer("user_clip_id").references(() => userClipsTable.id, { onDelete: "cascade" }),
    likedAt: timestamp("liked_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "likes_one_target",
      sql`(${t.clipId} IS NOT NULL)::int + (${t.userClipId} IS NOT NULL)::int = 1`
    ),
    unique("likes_user_clip_uniq").on(t.userId, t.clipId),
    unique("likes_user_userclip_uniq").on(t.userId, t.userClipId),
  ]
);

export type Like = typeof likesTable.$inferSelect;
