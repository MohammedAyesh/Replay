import { pgTable, serial, text, integer, boolean, timestamp, unique, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { fieldsTable } from "./fields";
import { recordingsTable } from "./recordings";
import { academySessionsTable } from "./academySessions";

export const academiesTable = pgTable("academies", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  fieldId: integer("field_id").notNull().references(() => fieldsTable.id, { onDelete: "cascade" }),
  daysOfWeek: text("days_of_week").notNull().default(""),
  description: text("description"),
  logoUrl: text("logo_url"),
  contactPhone: text("contact_phone"),
  /** Bunny Storage CDN URL of this academy's branding intro clip, prepended to exports and playback of its clips. */
  introVideoUrl: text("intro_video_url"),
  joinCode: text("join_code"),
  liveAccess: boolean("live_access").notNull().default(false),
  cameraIds: text("camera_ids").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [unique("academies_join_code_unique").on(table.joinCode)]);

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
