import { pgTable, serial, integer, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

/**
 * A highlight reel (2026-10-25): several of a player's own clips joined into
 * one video, with the venue's overlay on every clip and the end screen once,
 * after the last one, over the footage that follows it.
 *
 * The clips are referenced, not copied: the reel is rendered from their
 * recordings with their own windows and crops, so it is only as long-lived as
 * the recordings (14 days) until it has been rendered once.
 */
export const userReelsTable = pgTable("user_reels", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  /** user_clips ids, in play order. */
  clipIds: jsonb("clip_ids").notNull().$type<number[]>(),
  aspectRatio: text("aspect_ratio").notNull().default("9:16"),
  /** Same shape as user_clips.end_screen. */
  endScreen: jsonb("end_screen").$type<{ card?: string; stats?: string[] }>(),
  /** null = never rendered, pending, done, error */
  exportStatus: text("export_status"),
  /** Bunny Storage path (not a URL: Storage is an authenticated origin). */
  exportPath: text("export_path"),
  exportError: text("export_error"),
  durationSec: integer("duration_sec"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, (t) => [index("user_reels_user_idx").on(t.userId)]);

export type UserReelRow = typeof userReelsTable.$inferSelect;
