import { boolean, integer, jsonb, pgTable, real, text, timestamp } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

/**
 * Creative hub → an admin's music for one template (0064). Without a row a
 * template uses Replay's built-in recommendation (TEMPLATE_RECOMMENDED_MUSIC
 * in @workspace/api-zod); deleting the row resets to it.
 *
 * `track_ids`: Replay-scope creative_music_tracks ids in order (the first is
 * the one a video starts with), 0–5 of them; an empty list means "no music".
 * Hidden or deleted tracks are skipped when the recommendation is read.
 */
export const creativeTemplateMusicTable = pgTable("creative_template_music", {
  templateKey: text("template_key").primaryKey(),
  trackIds: jsonb("track_ids").$type<number[]>().notNull().default([]),
  volume: real("volume").notNull(),
  duck: boolean("duck").notNull().default(false),
  fadeInMs: integer("fade_in_ms").notNull(),
  fadeOutMs: integer("fade_out_ms").notNull(),
  startMs: integer("start_ms").notNull().default(0),
  updatedBy: integer("updated_by").references(() => usersTable.id, { onDelete: "set null" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type CreativeTemplateMusic = typeof creativeTemplateMusicTable.$inferSelect;
