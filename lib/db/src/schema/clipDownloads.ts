import { pgTable, serial, integer, timestamp, index } from "drizzle-orm/pg-core";
import { usersTable } from "./users";
import { userClipsTable } from "./userClips";

/**
 * One row per counted download.
 *
 * This is a ledger, not a counter, because the allowance is a ROLLING thirty
 * days: "five in the last thirty days" cannot be answered by a number that gets
 * reset, only by the timestamps themselves. It is also what makes the reset date
 * shown in the UI a real date — the oldest row plus thirty days — rather than a
 * guess.
 *
 * Rows are kept after they age out of the window. They are the only record of
 * how the free tier is actually used, and the 5/5 instrumentation is worth
 * nothing without the denominator.
 *
 * The clip reference is set-null on delete rather than cascade: deleting a clip
 * must not retroactively hand its downloader an extra slot.
 */
export const clipDownloadsTable = pgTable("clip_downloads", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  clipId: integer("clip_id").references(() => userClipsTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  // Every read is "this user's rows, newest first, inside a window".
  index("clip_downloads_user_created_idx").on(table.userId, table.createdAt),
]);

export type ClipDownloadRow = typeof clipDownloadsTable.$inferSelect;
