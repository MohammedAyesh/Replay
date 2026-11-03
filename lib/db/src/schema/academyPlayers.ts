import { boolean, check, date, index, integer, pgTable, serial, text, timestamp, unique, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { academiesTable } from "./academies";
import { academySquadsTable } from "./academySquads";
import { usersTable } from "./users";

export const academyPlayersTable = pgTable("academy_players", {
  id: serial("id").primaryKey(),
  academyId: integer("academy_id").notNull().references(() => academiesTable.id, { onDelete: "cascade" }),
  squadId: integer("squad_id").references(() => academySquadsTable.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  jerseyNumber: integer("jersey_number"),
  position: text("position"),
  dateOfBirth: date("date_of_birth", { mode: "string" }),
  guardianPhone: text("guardian_phone"),
  familyToken: text("family_token"),
  userId: integer("user_id").references(() => usersTable.id, { onDelete: "set null" }),
  isActive: boolean("is_active").notNull().default(true),
  monthlyDiscountFils: integer("monthly_discount_fils").notNull().default(0),
  subscriptionExpiresOn: date("subscription_expires_on", { mode: "string" }),
  /**
   * The family agreed that photos and clips of this child may go on the
   * academy's public pages (0066). Off until the owner ticks it: a child
   * without it gets private clips only and is never put in a public post.
   */
  publicPostsConsent: boolean("public_posts_consent").notNull().default(false),
  publicPostsConsentAt: timestamp("public_posts_consent_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check("academy_players_name_nonempty_check", sql`length(trim(${table.name})) > 0`),
  check("academy_players_jersey_number_nonnegative_check", sql`${table.jerseyNumber} is null or ${table.jerseyNumber} >= 0`),
  check("academy_players_monthly_discount_nonnegative_check", sql`${table.monthlyDiscountFils} >= 0`),
  check("academy_players_family_token_format_check", sql`${table.familyToken} is null or ${table.familyToken} ~ '^[0-9a-f]{32}$'`),
  unique("academy_players_family_token_unique").on(table.familyToken),
]);

export const insertAcademyPlayerSchema = createInsertSchema(academyPlayersTable).omit({ id: true, createdAt: true });
export type InsertAcademyPlayer = z.infer<typeof insertAcademyPlayerSchema>;
export type AcademyPlayer = typeof academyPlayersTable.$inferSelect;
/**
 * A player's photo gallery (0058). The academy uploads them (a team photoshoot,
 * often cut-outs with a transparent background); one is the primary photo the
 * Creative hub's line-ups use. The file lives in Bunny Storage (or on this
 * machine without Storage) and is only ever served through the academy
 * console. `transparent`: the picture has real transparency (a cut-out).
 */
export const academyPlayerPhotosTable = pgTable("academy_player_photos", {
  id: serial("id").primaryKey(),
  academyId: integer("academy_id").notNull().references(() => academiesTable.id, { onDelete: "cascade" }),
  playerId: integer("player_id").notNull().references(() => academyPlayersTable.id, { onDelete: "cascade" }),
  path: text("path").notNull(),
  mime: text("mime").notNull(),
  width: integer("width").notNull(),
  height: integer("height").notNull(),
  transparent: boolean("transparent").notNull().default(false),
  label: text("label"),
  isPrimary: boolean("is_primary").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy: integer("created_by").references(() => usersTable.id, { onDelete: "set null" }),
}, (table) => [
  check("academy_player_photos_mime_check", sql`${table.mime} in ('image/png', 'image/webp')`),
  index("academy_player_photos_player_idx").on(table.playerId, table.createdAt),
  uniqueIndex("academy_player_photos_primary_unique").on(table.playerId).where(sql`${table.isPrimary}`),
]);

export type AcademyPlayerPhoto = typeof academyPlayerPhotosTable.$inferSelect;
