import { check, integer, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { academiesTable } from "./academies";

export const academyPaymentCategoriesTable = pgTable("academy_payment_categories", {
  id: serial("id").primaryKey(),
  academyId: integer("academy_id").notNull().references(() => academiesTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check("academy_payment_categories_name_nonempty_check", sql`length(trim(${table.name})) > 0`),
  uniqueIndex("academy_payment_categories_academy_name_unique")
    .on(table.academyId, sql`lower(${table.name})`),
]);

export const insertAcademyPaymentCategorySchema = createInsertSchema(academyPaymentCategoriesTable)
  .omit({ id: true, createdAt: true });
export type InsertAcademyPaymentCategory = z.infer<typeof insertAcademyPaymentCategorySchema>;
export type AcademyPaymentCategory = typeof academyPaymentCategoriesTable.$inferSelect;