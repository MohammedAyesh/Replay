import { check, integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { academiesTable } from "./academies";
import { academySquadsTable } from "./academySquads";
import { usersTable } from "./users";

export const academyAnnouncementsTable = pgTable("academy_announcements", {
  id: serial("id").primaryKey(),
  academyId: integer("academy_id").notNull().references(() => academiesTable.id, { onDelete: "cascade" }),
  squadId: integer("squad_id").references(() => academySquadsTable.id, { onDelete: "set null" }),
  title: text("title").notNull(),
  body: text("body").notNull(),
  createdBy: integer("created_by").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check("academy_announcements_title_nonempty_check", sql`length(trim(${table.title})) > 0`),
  check("academy_announcements_body_nonempty_check", sql`length(trim(${table.body})) > 0`),
]);

export const insertAcademyAnnouncementSchema = createInsertSchema(academyAnnouncementsTable).omit({ id: true, createdAt: true });
export type InsertAcademyAnnouncement = z.infer<typeof insertAcademyAnnouncementSchema>;
export type AcademyAnnouncement = typeof academyAnnouncementsTable.$inferSelect;