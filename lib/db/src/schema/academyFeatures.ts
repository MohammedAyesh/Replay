import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, pgTable, real, serial, text, timestamp, unique } from "drizzle-orm/pg-core";
import { academiesTable } from "./academies";
import { academyPlayersTable } from "./academyPlayers";
import { academySessionsTable } from "./academySessions";
import { recordingsTable } from "./recordings";
import { userClipsTable } from "./userClips";

/**
 * "Every child appears" (0066).
 *
 * The feature log: one row each time a child appears somewhere the academy
 * made. A public post (Instagram / Facebook, from the player the template is
 * about or the line-up), a clip sent to his own parents, a WhatsApp send of a
 * design he is in, a phone video he is tagged in. `solo` marks an item about
 * him alone (player of the match, meet the player), which is what the public
 * target counts. The same item never counts twice for the same child.
 */
export const FEATURE_ITEM_TYPES = ["post", "clip", "whatsapp", "phone_video"] as const;
export type FeatureItemType = (typeof FEATURE_ITEM_TYPES)[number];

export const academyPlayerFeaturesTable = pgTable("academy_player_features", {
  id: serial("id").primaryKey(),
  academyId: integer("academy_id").notNull().references(() => academiesTable.id, { onDelete: "cascade" }),
  playerId: integer("player_id").notNull().references(() => academyPlayersTable.id, { onDelete: "cascade" }),
  itemType: text("item_type").notNull(),
  /** e.g. the creative project id, the private clip id, the library media id. */
  itemId: text("item_id").notNull(),
  visibility: text("visibility").notNull(),
  solo: boolean("solo").notNull().default(false),
  featuredAt: timestamp("featured_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique("academy_player_features_item_unique").on(table.playerId, table.itemType, table.itemId),
  index("academy_player_features_academy_idx").on(table.academyId, table.featuredAt),
  check("academy_player_features_type_check", sql`${table.itemType} in ('post', 'clip', 'whatsapp', 'phone_video')`),
  check("academy_player_features_visibility_check", sql`${table.visibility} in ('public', 'private')`),
]);

/** The owner's targets for the squad grid (defaults when there is no row). */
export const academyFeatureSettingsTable = pgTable("academy_feature_settings", {
  academyId: integer("academy_id").primaryKey().references(() => academiesTable.id, { onDelete: "cascade" }),
  /** Solo public posts each child with public consent should get per calendar month. */
  publicPostsPerMonth: integer("public_posts_per_month").notNull().default(1),
  /** One private clip per analysed match he played in. */
  privateClipPerMatch: boolean("private_clip_per_match").notNull().default(true),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check("academy_feature_settings_posts_check", sql`${table.publicPostsPerMonth} between 0 and 8`),
]);

/**
 * A child's private clip from one analysed match: his best moment, framed on
 * him, sent to his own parents only. `token` opens it without an account
 * (/kc/<token>); `openedAt` is the first time the family opened it.
 */
export const PLAYER_CLIP_STATUSES = ["prepared", "sent", "no_moment", "failed"] as const;

export const academyPlayerClipsTable = pgTable("academy_player_clips", {
  id: serial("id").primaryKey(),
  academyId: integer("academy_id").notNull().references(() => academiesTable.id, { onDelete: "cascade" }),
  sessionId: integer("session_id").notNull().references(() => academySessionsTable.id, { onDelete: "cascade" }),
  playerId: integer("player_id").notNull().references(() => academyPlayersTable.id, { onDelete: "cascade" }),
  recordingId: integer("recording_id").references(() => recordingsTable.id, { onDelete: "set null" }),
  userClipId: integer("user_clip_id").references(() => userClipsTable.id, { onDelete: "set null" }),
  token: text("token").notNull(),
  momentKind: text("moment_kind"),
  momentSeconds: real("moment_seconds"),
  /** What the moment was and how it compares with his own earlier matches (never with other children). */
  note: jsonb("note"),
  status: text("status").notNull().default("prepared"),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  openedAt: timestamp("opened_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique("academy_player_clips_session_player_unique").on(table.sessionId, table.playerId),
  unique("academy_player_clips_token_unique").on(table.token),
  index("academy_player_clips_academy_idx").on(table.academyId, table.createdAt),
  check("academy_player_clips_status_check", sql`${table.status} in ('prepared', 'sent', 'no_moment', 'failed')`),
  check("academy_player_clips_token_check", sql`${table.token} ~ '^[0-9a-f]{32}$'`),
]);

export type AcademyPlayerFeature = typeof academyPlayerFeaturesTable.$inferSelect;
export type AcademyFeatureSettings = typeof academyFeatureSettingsTable.$inferSelect;
export type AcademyPlayerClip = typeof academyPlayerClipsTable.$inferSelect;
