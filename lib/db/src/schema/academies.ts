import { sql } from "drizzle-orm";
import { pgTable, serial, text, integer, boolean, timestamp, unique, index, real, check } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { fieldsTable } from "./fields";
import { recordingsTable } from "./recordings";
import { academySessionsTable } from "./academySessions";

export const academiesTable = pgTable("academies", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  /** academy, or venue: a field business run from the Field console (see venues.ts). */
  kind: text("kind").notNull().default("academy"),
  fieldId: integer("field_id").notNull().references(() => fieldsTable.id, { onDelete: "cascade" }),
  daysOfWeek: text("days_of_week").notNull().default(""),
  description: text("description"),
  logoUrl: text("logo_url"),
  contactPhone: text("contact_phone"),
  /** Owner-edited profile (Academy console → Profile). All optional; location falls back to the field's. */
  nameAr: text("name_ar"),
  whatsappPhone: text("whatsapp_phone"),
  email: text("email"),
  address: text("address"),
  latitude: real("latitude"),
  longitude: real("longitude"),
  instagramUrl: text("instagram_url"),
  facebookUrl: text("facebook_url"),
  websiteUrl: text("website_url"),
  /** Bunny Storage CDN URL of this academy's branding intro clip, prepended to exports and playback of its clips. */
  introVideoUrl: text("intro_video_url"),
  joinCode: text("join_code"),
  liveAccess: boolean("live_access").notNull().default(false),
  cameraIds: text("camera_ids").notNull().default(""),
  /**
   * Creative hub brand pack (PACK_STYLES in api-zod creativeScene.ts), set by an admin.
   * Only this academy is offered that pack's style. Null = house styles only.
   */
  creativePack: text("creative_pack"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique("academies_join_code_unique").on(table.joinCode),
  // KEEP IN SYNC with PACK_STYLES, migrations/0057 and ensureAdditiveColumns (a test compares them).
  check("academies_creative_pack_check", sql`${table.creativePack} is null or ${table.creativePack} in ('iris', 'souqar', 'barca', 'juventus', 'knights', 'jufa')`),
]);

export const academyRecordingsTable = pgTable("academy_recordings", {
  id: serial("id").primaryKey(),
  academyId: integer("academy_id").notNull().references(() => academiesTable.id, { onDelete: "cascade" }),
  recordingId: integer("recording_id").notNull().references(() => recordingsTable.id, { onDelete: "cascade" }),
  sessionId: integer("session_id").references(() => academySessionsTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique().on(t.academyId, t.recordingId),
  index("academy_recordings_session_id_idx").on(t.sessionId),
]);

export const insertAcademySchema = createInsertSchema(academiesTable).omit({ id: true, createdAt: true });
export type InsertAcademy = z.infer<typeof insertAcademySchema>;
export type Academy = typeof academiesTable.$inferSelect;
