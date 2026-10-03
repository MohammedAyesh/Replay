import { boolean, check, date, integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
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
  userId: integer("user_id").references(() => usersTable.id, { onDelete: "set null" }),
  isActive: boolean("is_active").notNull().default(true),
  monthlyDiscountFils: integer("monthly_discount_fils").notNull().default(0),
  subscriptionExpiresOn: date("subscription_expires_on", { mode: "string" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check("academy_players_name_nonempty_check", sql`length(trim(${table.name})) > 0`),
  check("academy_players_jersey_number_nonnegative_check", sql`${table.jerseyNumber} is null or ${table.jerseyNumber} >= 0`),
  check("academy_players_monthly_discount_nonnegative_check", sql`${table.monthlyDiscountFils} >= 0`),
]);

export const insertAcademyPlayerSchema = createInsertSchema(academyPlayersTable).omit({ id: true, createdAt: true });
export type InsertAcademyPlayer = z.infer<typeof insertAcademyPlayerSchema>;
export type AcademyPlayer = typeof academyPlayersTable.$inferSelect;