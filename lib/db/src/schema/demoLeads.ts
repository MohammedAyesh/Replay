import { pgTable, serial, text, boolean, timestamp, index } from "drizzle-orm/pg-core";

/**
 * Call-me-back requests from the public demo (/demo).
 *
 * A prospect leaves a name, the pitch or academy, and a phone number; an admin
 * sees them in Admin → Demo leads and marks them handled. Deliberately not tied
 * to a user: the people filling this in do not have accounts.
 */
export const demoLeadsTable = pgTable("demo_leads", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  place: text("place").notNull(),
  phone: text("phone").notNull(),
  /** "pitch" | "academy": which version of the demo they were reading. */
  persona: text("persona").notNull(),
  locale: text("locale").notNull().default("ar"),
  handled: boolean("handled").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("demo_leads_created_idx").on(table.createdAt),
]);

export type DemoLead = typeof demoLeadsTable.$inferSelect;
