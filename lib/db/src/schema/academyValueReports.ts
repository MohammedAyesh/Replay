import { check, index, integer, pgTable, serial, text, timestamp, unique } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { academiesTable } from "./academies";
import { academyContactsTable } from "./academyWhatsapp";
import { usersTable } from "./users";

/**
 * Every change of a People contact's stage or kind (0068), written by a
 * database trigger on academy_contacts (installed at boot by
 * ensureAdditiveColumns), so every path that moves a contact is counted:
 * enquiries, trials and players joined per month for the value report.
 */
export const academyContactStageEventsTable = pgTable("academy_contact_stage_events", {
  id: serial("id").primaryKey(),
  academyId: integer("academy_id").notNull().references(() => academiesTable.id, { onDelete: "cascade" }),
  contactId: integer("contact_id").notNull().references(() => academyContactsTable.id, { onDelete: "cascade" }),
  fromStage: text("from_stage"),
  toStage: text("to_stage"),
  fromKind: text("from_kind"),
  toKind: text("to_kind"),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("academy_contact_stage_events_academy_idx").on(table.academyId, table.at),
  index("academy_contact_stage_events_contact_idx").on(table.contactId),
]);

/** A month's value report shared by link (/vr/<token>), until the owner turns the link off. */
export const academyValueReportSharesTable = pgTable("academy_value_report_shares", {
  id: serial("id").primaryKey(),
  academyId: integer("academy_id").notNull().references(() => academiesTable.id, { onDelete: "cascade" }),
  month: text("month").notNull(),
  token: text("token").notNull(),
  createdBy: integer("created_by").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
}, (table) => [
  unique("academy_value_report_shares_token_unique").on(table.token),
  check("academy_value_report_shares_month_check", sql`${table.month} ~ '^[0-9]{4}-[0-9]{2}$'`),
  check("academy_value_report_shares_token_check", sql`${table.token} ~ '^[0-9a-f]{32}$'`),
]);

export type AcademyContactStageEvent = typeof academyContactStageEventsTable.$inferSelect;
