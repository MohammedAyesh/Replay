import { check, date, integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { academiesTable } from "./academies";
import { academyFinanceStaffTable } from "./academyFinanceStaff";

export const academyOtherPaymentsTable = pgTable("academy_other_payments", {
  id: serial("id").primaryKey(),
  academyId: integer("academy_id").notNull().references(() => academiesTable.id, { onDelete: "cascade" }),
  staffId: integer("staff_id").references(() => academyFinanceStaffTable.id, { onDelete: "set null" }),
  category: text("category").notNull(),
  label: text("label").notNull(),
  amountFils: integer("amount_fils").notNull(),
  occurredOn: date("occurred_on", { mode: "string" }).notNull(),
  status: text("status", { enum: ["paid", "unpaid"] }).notNull().default("unpaid"),
  paidAt: timestamp("paid_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check("academy_other_payments_category_nonempty_check", sql`length(trim(${table.category})) > 0`),
  check("academy_other_payments_label_nonempty_check", sql`length(trim(${table.label})) > 0`),
  check("academy_other_payments_amount_positive_check", sql`${table.amountFils} > 0`),
  check("academy_other_payments_status_check", sql`${table.status} in ('paid', 'unpaid')`),
  check(
    "academy_other_payments_paid_at_consistency_check",
    sql`(${table.status} = 'paid' and ${table.paidAt} is not null) or (${table.status} = 'unpaid' and ${table.paidAt} is null)`,
  ),
]);

export const insertAcademyOtherPaymentSchema = createInsertSchema(academyOtherPaymentsTable)
  .omit({ id: true, createdAt: true });
export type InsertAcademyOtherPayment = z.infer<typeof insertAcademyOtherPaymentSchema>;
export type AcademyOtherPayment = typeof academyOtherPaymentsTable.$inferSelect;