import { pgTable, serial, text, integer, boolean, timestamp, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { fieldsTable } from "./fields";
import { recordingsTable } from "./recordings";

export const academiesTable = pgTable("academies", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  fieldId: integer("field_id").notNull().references(() => fieldsTable.id, { onDelete: "cascade" }),
  daysOfWeek: text("days_of_week").notNull().default(""),
  description: text("description"),
  logoUrl: text("logo_url"),
  liveAccess: boolean("live_access").notNull().default(false),
  cameraId: text("camera_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const academyRecordingsTable = pgTable("academy_recordings", {
  id: serial("id").primaryKey(),
  academyId: integer("academy_id").notNull().references(() => academiesTable.id, { onDelete: "cascade" }),
  recordingId: integer("recording_id").notNull().references(() => recordingsTable.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [unique().on(t.academyId, t.recordingId)]);

export const insertAcademySchema = createInsertSchema(academiesTable).omit({ id: true, createdAt: true });
export type InsertAcademy = z.infer<typeof insertAcademySchema>;
export type Academy = typeof academiesTable.$inferSelect;
