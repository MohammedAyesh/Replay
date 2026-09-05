import { pgTable, text, jsonb, integer, timestamp } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

/**
 * The base value of a setting when no rule matches.
 *
 * Every setting ships with a default compiled into the registry, and until now
 * that was the only way to change the value everyone gets: you had to write a
 * global rule. That works, but it puts an ordinary "this is just how the
 * product is configured" decision into the same list as genuinely conditional
 * ones — the Friday-night promotion, the one academy on a different plan — and
 * the list is where you look when something surprising is happening. A base
 * value is not a surprise and should not be sitting in the evidence.
 *
 * So: a rule still beats a default, a default beats the shipped value, and the
 * console can tell you which of the three you are looking at.
 *
 * Only registered keys are accepted; a row for an unknown key is ignored on
 * read, so removing a setting from the registry cannot resurrect it.
 */
export const settingsDefaultsTable = pgTable("settings_defaults", {
  key: text("key").primaryKey(),
  /**
   * jsonb rather than a typed column because a setting is a number, a boolean
   * or a string depending on which one it is. The registry validates the shape
   * before anything is written.
   */
  value: jsonb("value").notNull().$type<number | boolean | string>(),
  note: text("note"),
  updatedBy: integer("updated_by").references(() => usersTable.id, { onDelete: "set null" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type SettingsDefaultRow = typeof settingsDefaultsTable.$inferSelect;
