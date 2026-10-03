import { check, date, integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { academiesTable } from "./academies";
import { academyPlayersTable } from "./academyPlayers";

export const academyFeesTable = pgTable("academy_fees", {
  id: serial("id").primaryKey(),
  academyId: integer("academy_id").notNull().references(() => academiesTable.id, { onDelete: "cascade" }),
  playerId: integer("player_id").notNull().references(() => academyPlayersTable.id, { onDelete: "cascade" }),
  label: text("label").notNull(),
  amountFils: integer("amount_fils").notNull(),
  dueDate: date("due_date", { mode: "string" }).notNull(),
  status: text("status", { enum: ["due", "paid", "waived"] }).notNull().default("due"),
  paidAt: timestamp("paid_at", { withTimezone: true }),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check("academy_fees_label_nonempty_check", sql`length(trim(${table.label})) > 0`),
  check("academy_fees_amount_nonnegative_check", sql`${table.amountFils} >= 0`),
  check("academy_fees_status_check", sql`${table.status} in ('due', 'paid', 'waived')`),
]);

export const insertAcademyFeeSchema = createInsertSchema(academyFeesTable).omit({ id: true, createdAt: true });
export type InsertAcademyFee = z.infer<typeof insertAcademyFeeSchema>;
export type AcademyFee = typeof academyFeesTable.$inferSelect;