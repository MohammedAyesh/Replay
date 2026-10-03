import { check, date, integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { academiesTable } from "./academies";

export const academyFinanceStaffTable = pgTable("academy_finance_staff", {
  id: serial("id").primaryKey(),
  academyId: integer("academy_id").notNull().references(() => academiesTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  role: text("role").notNull(),
  monthlySalaryFils: integer("monthly_salary_fils").notNull(),
  nextSalaryDate: date("next_salary_date", { mode: "string" }).notNull(),
  contractEndDate: date("contract_end_date", { mode: "string" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check("academy_finance_staff_name_nonempty_check", sql`length(trim(${table.name})) > 0`),
  check("academy_finance_staff_role_nonempty_check", sql`length(trim(${table.role})) > 0`),
  check("academy_finance_staff_salary_nonnegative_check", sql`${table.monthlySalaryFils} >= 0`),
]);

export const insertAcademyFinanceStaffSchema = createInsertSchema(academyFinanceStaffTable)
  .omit({ id: true, createdAt: true });
export type InsertAcademyFinanceStaff = z.infer<typeof insertAcademyFinanceStaffSchema>;
export type AcademyFinanceStaff = typeof academyFinanceStaffTable.$inferSelect;