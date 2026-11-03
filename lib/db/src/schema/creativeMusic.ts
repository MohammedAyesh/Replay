import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, real, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { academiesTable } from "./academies";
import { usersTable } from "./users";

/**
 * Creative hub music (0063): soundtracks for video scenes.
 *
 * scope 'replay': Replay's library, open to every academy (academy_id null),
 * managed in /admin. The tracks Replay ships carry a `key` (their bundled file,
 * assets/creative/music/<key>.m4a) and are seeded on boot.
 * scope 'academy': a track one academy uploaded; only that academy lists,
 * plays or renders it. `license` records the academy's rights confirmation.
 *
 * Files are AAC .m4a, in Bunny Storage under creative-music/… (or on this
 * machine without Storage; "asset:<key>" for the bundled ones), served only
 * through the API. `waveform`: ≈200 peaks 0..1 for the editor.
 */
export const creativeMusicTracksTable = pgTable("creative_music_tracks", {
  id: serial("id").primaryKey(),
  scope: text("scope").notNull(),
  academyId: integer("academy_id").references(() => academiesTable.id, { onDelete: "cascade" }),
  /** Bundled tracks only: the asset key, e.g. "replay/matchday-anthem" (what seeding matches on). */
  key: text("key"),
  title: text("title").notNull(),
  artist: text("artist"),
  mood: text("mood").notNull(),
  bpm: integer("bpm"),
  durationMs: integer("duration_ms").notNull(),
  path: text("path").notNull(),
  mime: text("mime").notNull().default("audio/mp4"),
  loudnessLufs: real("loudness_lufs"),
  waveform: jsonb("waveform").$type<number[]>(),
  license: text("license").notNull(),
  status: text("status").notNull().default("active"),
  createdBy: integer("created_by").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check("creative_music_tracks_scope_check", sql`${table.scope} in ('replay', 'academy')`),
  check("creative_music_tracks_scope_academy_check", sql`(${table.scope} = 'replay' and ${table.academyId} is null) or (${table.scope} = 'academy' and ${table.academyId} is not null)`),
  check("creative_music_tracks_mood_check", sql`${table.mood} in ('hype', 'epic', 'chill', 'fun', 'emotional', 'cinematic')`),
  check("creative_music_tracks_status_check", sql`${table.status} in ('active', 'hidden')`),
  index("creative_music_tracks_academy_idx").on(table.academyId, table.createdAt),
  uniqueIndex("creative_music_tracks_key_unique").on(table.key).where(sql`${table.key} is not null`),
]);

export type CreativeMusicTrack = typeof creativeMusicTracksTable.$inferSelect;
