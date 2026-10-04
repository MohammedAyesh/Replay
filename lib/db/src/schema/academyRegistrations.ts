import { sql } from "drizzle-orm";
import { check, date, index, integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { academiesTable } from "./academies";
import { academyPlayersTable } from "./academyPlayers";
import { academySquadsTable } from "./academySquads";
import { usersTable } from "./users";

export const academyRegistrationsTable = pgTable("academy_registrations", {
  id: serial("id").primaryKey(),
  academyId: integer("academy_id").notNull().references(() => academiesTable.id, { onDelete: "cascade" }),
  playerName: text("player_name").notNull(),
  dateOfBirth: date("date_of_birth", { mode: "string" }),
  guardianName: text("guardian_name"),
  guardianPhone: text("guardian_phone").notNull(),
  preferredSquadId: integer("preferred_squad_id").references(() => academySquadsTable.id, { onDelete: "set null" }),
  notes: text("notes"),
  locale: text("locale").notNull().default("ar"),
  status: text("status").notNull().default("pending"),
  createdPlayerId: integer("created_player_id").references(() => academyPlayersTable.id, { onDelete: "set null" }),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  reviewedBy: integer("reviewed_by").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("academy_registrations_academy_status_idx").on(table.academyId, table.status),
  check("academy_registrations_player_name_nonempty_check", sql`length(trim(${table.playerName})) > 0`),
  check("academy_registrations_locale_check", sql`${table.locale} in ('ar', 'en')`),
  check("academy_registrations_status_check", sql`${table.status} in ('pending', 'approved', 'rejected')`),
]);

export const insertAcademyRegistrationSchema = createInsertSchema(academyRegistrationsTable)
  .omit({ id: true, createdAt: true });
export type InsertAcademyRegistration = z.infer<typeof insertAcademyRegistrationSchema>;
export type AcademyRegistration = typeof academyRegistrationsTable.$inferSelect;