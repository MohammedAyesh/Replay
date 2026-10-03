import { check, integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { academiesTable } from "./academies";

export const academySquadsTable = pgTable("academy_squads", {
  id: serial("id").primaryKey(),
  academyId: integer("academy_id").notNull().references(() => academiesTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  ageGroup: text("age_group"),
  monthlyFeeFils: integer("monthly_fee_fils").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check("academy_squads_name_nonempty_check", sql`length(trim(${table.name})) > 0`),
  check("academy_squads_monthly_fee_nonnegative_check", sql`${table.monthlyFeeFils} >= 0`),
]);

export const insertAcademySquadSchema = createInsertSchema(academySquadsTable).omit({ id: true, createdAt: true });
export type InsertAcademySquad = z.infer<typeof insertAcademySquadSchema>;
export type AcademySquad = typeof academySquadsTable.$inferSelect;