import { pgTable, serial, integer, text, timestamp, unique } from "drizzle-orm/pg-core";
import { usersTable } from "./users";
import { footageRequestsTable } from "./footageRequests";

export const footageCancellationRequestsTable = pgTable("footage_cancellation_requests", {
  id: serial("id").primaryKey(),
  footageRequestId: integer("footage_request_id").notNull()
    .references(() => footageRequestsTable.id, { onDelete: "cascade" }),
  requestedBy: integer("requested_by").notNull()
    .references(() => usersTable.id, { onDelete: "restrict" }),
  reason: text("reason").notNull(),
  status: text("status").notNull().default("pending"),
  adminNote: text("admin_note"),
  reviewedBy: integer("reviewed_by").references(() => usersTable.id, { onDelete: "set null" }),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  footageRequestUnique: unique("footage_cancellation_requests_footage_request_unique")
    .on(table.footageRequestId),
}));

export type FootageCancellationRequest = typeof footageCancellationRequestsTable.$inferSelect;