import { pgTable, serial, integer, timestamp, unique } from "drizzle-orm/pg-core";
import { usersTable } from "./users";
import { fieldsTable } from "./fields";

export const fieldOwnersTable = pgTable("field_owners", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  fieldId: integer("field_id").notNull().references(() => fieldsTable.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique("field_owners_user_id_field_id_unique").on(table.userId, table.fieldId),
]);

export type FieldOwner = typeof fieldOwnersTable.$inferSelect;