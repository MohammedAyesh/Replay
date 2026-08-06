import { pgTable, serial, text, boolean, timestamp, integer, index } from "drizzle-orm/pg-core";
import { fieldsTable } from "./fields";

export const matchesTable = pgTable("matches", {
  id: serial("id").primaryKey(),
  fieldId: integer("field_id").notNull().references(() => fieldsTable.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  scheduledStart: timestamp("scheduled_start", { withTimezone: true }).notNull(),
  scheduledEnd: timestamp("scheduled_end", { withTimezone: true }).notNull(),
  /** scheduled | live | ended | cancelled */
  status: text("status").notNull().default("scheduled"),
  autoStartLive: boolean("auto_start_live").notNull().default(true),
  liveStartedAt: timestamp("live_started_at", { withTimezone: true }),
  liveStoppedAt: timestamp("live_stopped_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("matches_field_id_scheduled_start_idx").on(table.fieldId, table.scheduledStart),
]);

export type Match = typeof matchesTable.$inferSelect;
