import { check, date, integer, pgTable, serial, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { academiesTable } from "./academies";
import { academyPlayersTable } from "./academyPlayers";

export const academyPlayerRenewalsTable = pgTable("academy_player_renewals", {
  id: serial("id").primaryKey(),
  academyId: integer("academy_id").notNull().references(() => academiesTable.id, { onDelete: "cascade" }),
  playerId: integer("player_id").notNull().references(() => academyPlayersTable.id, { onDelete: "cascade" }),
  monthsPurchased: integer("months_purchased").notNull(),
  amountFils: integer("amount_fils").notNull(),
  effectiveMonthlyFeeFils: integer("effective_monthly_fee_fils").notNull(),
  previousExpiresOn: date("previous_expires_on", { mode: "string" }).notNull(),
  newExpiresOn: date("new_expires_on", { mode: "string" }).notNull(),
  paidAt: timestamp("paid_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check(
    "academy_player_renewals_months_check",
    sql`${table.monthsPurchased} between 1 and 12`,
  ),
  check("academy_player_renewals_amount_nonnegative_check", sql`${table.amountFils} >= 0`),
  check(
    "academy_player_renewals_monthly_fee_nonnegative_check",
    sql`${table.effectiveMonthlyFeeFils} >= 0`,
  ),
]);

export const insertAcademyPlayerRenewalSchema = createInsertSchema(academyPlayerRenewalsTable)
  .omit({ id: true, paidAt: true, createdAt: true });
export type InsertAcademyPlayerRenewal = z.infer<typeof insertAcademyPlayerRenewalSchema>;
export type AcademyPlayerRenewal = typeof academyPlayerRenewalsTable.$inferSelect;