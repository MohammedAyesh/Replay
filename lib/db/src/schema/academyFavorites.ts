import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, serial, text, timestamp, unique } from "drizzle-orm/pg-core";
import { academiesTable } from "./academies";
import { usersTable } from "./users";

/**
 * A console user's starred templates, clips and drafts (0072): starred items
 * come first in the Creative hub's lists. Personal: each owner or manager has
 * their own. `itemKey` is a template key, a user clip id, or a creative project id.
 */
export const academyFavoritesTable = pgTable("academy_favorites", {
  id: serial("id").primaryKey(),
  academyId: integer("academy_id").notNull().references(() => academiesTable.id, { onDelete: "cascade" }),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  itemKey: text("item_key").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique("academy_favorites_item_unique").on(table.academyId, table.userId, table.kind, table.itemKey),
  index("academy_favorites_user_idx").on(table.academyId, table.userId),
  check("academy_favorites_kind_check", sql`${table.kind} in ('template', 'clip', 'project')`),
]);
