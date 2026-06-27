import { pgTable, integer, primaryKey, timestamp } from "drizzle-orm/pg-core";
import { usersTable } from "./users";
import { clipsTable } from "./clips";

export const savedClipsTable = pgTable(
  "saved_clips",
  {
    userId: integer("user_id").notNull().references(() => usersTable.id),
    clipId: integer("clip_id").notNull().references(() => clipsTable.id),
    savedAt: timestamp("saved_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.clipId] })]
);

export type SavedClip = typeof savedClipsTable.$inferSelect;
