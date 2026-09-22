import { pgTable, serial, integer, text, timestamp } from "drizzle-orm/pg-core";
import { footageRequestsTable } from "./footageRequests";
import { usersTable } from "./users";

export const varMarksTable = pgTable("var_marks", {
  id: serial("id").primaryKey(),
  footageRequestId: integer("footage_request_id").notNull().references(() => footageRequestsTable.id, { onDelete: "cascade" }),
  atUtc: timestamp("at_utc", { withTimezone: true }).notNull(),
  kind: text("kind").notNull(),
  note: text("note"),
  createdBy: integer("created_by").notNull().references(() => usersTable.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type VarMark = typeof varMarksTable.$inferSelect;