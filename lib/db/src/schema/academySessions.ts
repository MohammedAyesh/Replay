import { check, integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { academiesTable } from "./academies";
import { academySquadsTable } from "./academySquads";

export const academySessionsTable = pgTable("academy_sessions", {
  id: serial("id").primaryKey(),
  academyId: integer("academy_id").notNull().references(() => academiesTable.id, { onDelete: "cascade" }),
  squadId: integer("squad_id").references(() => academySquadsTable.id, { onDelete: "set null" }),
  type: text("type", { enum: ["training", "match"] }).notNull(),
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
  endsAt: timestamp("ends_at", { withTimezone: true }),
  location: text("location").notNull(),
  opponent: text("opponent"),
  ownScore: integer("own_score"),
  opponentScore: integer("opponent_score"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check("academy_sessions_type_check", sql`${table.type} in ('training', 'match')`),
  check("academy_sessions_end_after_start_check", sql`${table.endsAt} is null or ${table.endsAt} > ${table.startsAt}`),
  check("academy_sessions_scores_nonnegative_check", sql`(${table.ownScore} is null or ${table.ownScore} >= 0) and (${table.opponentScore} is null or ${table.opponentScore} >= 0)`),
  check("academy_sessions_scores_paired_check", sql`(${table.ownScore} is null) = (${table.opponentScore} is null)`),
]);

export const insertAcademySessionSchema = createInsertSchema(academySessionsTable).omit({ id: true, createdAt: true });
export type InsertAcademySession = z.infer<typeof insertAcademySessionSchema>;
export type AcademySession = typeof academySessionsTable.$inferSelect;