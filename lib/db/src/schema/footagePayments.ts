import { pgTable, serial, integer, text, timestamp } from "drizzle-orm/pg-core";
import { usersTable } from "./users";
import { fieldsTable } from "./fields";

export const footagePaymentsTable = pgTable("footage_payments", {
  id: serial("id").primaryKey(),
  fieldId: integer("field_id").notNull().references(() => fieldsTable.id, { onDelete: "cascade" }),
  amountFils: integer("amount_fils").notNull(),
  method: text("method").notNull(),
  note: text("note"),
  recordedBy: integer("recorded_by").notNull().references(() => usersTable.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type FootagePayment = typeof footagePaymentsTable.$inferSelect;