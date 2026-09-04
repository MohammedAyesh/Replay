import { pgTable, serial, integer, text, boolean, timestamp, jsonb, index } from "drizzle-orm/pg-core";

export type SettingScopeRef = { scopeType: "field" | "academy" | "user"; scopeId: number };

/**
 * One admin-configurable override.
 *
 * Deliberately one flat table rather than a column per setting: "everything is
 * adjustable" means the set of keys changes often, and a schema that needs a
 * migration per knob will quietly stop being used. The key comes from the
 * registry in api-server/src/lib/settingsRegistry.ts, which also supplies the
 * type and the default, so a value is validated before it ever lands here.
 *
 * An empty table is the shipped configuration. Nothing resolves differently
 * until somebody writes a row.
 */
export const settingsRulesTable = pgTable("settings_rules", {
  id: serial("id").primaryKey(),
  key: text("key").notNull(),
  /** Typed by the registry entry for `key`; validated on write. */
  value: jsonb("value").notNull().$type<number | boolean | string>(),
  /**
   * Highest wins, ties broken by scope specificity then recency. Priority-first
   * is what lets a campaign deliberately beat a per-user override — and what
   * makes the admin preview necessary rather than decorative.
   */
  priority: integer("priority").notNull().default(0),
  scopeType: text("scope_type").notNull().default("global"),
  /** Null for global. */
  scopeId: integer("scope_id"),
  /** "Everyone except these" — see ruleExcludes in settingsResolver.ts. */
  excludes: jsonb("excludes").notNull().$type<SettingScopeRef[]>().default([]),
  enabled: boolean("enabled").notNull().default(true),
  effectiveFrom: timestamp("effective_from", { withTimezone: true }),
  effectiveUntil: timestamp("effective_until", { withTimezone: true }),
  /** 0 = Sunday. Null means every day. */
  daysOfWeek: jsonb("days_of_week").$type<number[] | null>(),
  /** Minutes since local midnight in `timezone`. Null means all day. */
  startMinute: integer("start_minute"),
  endMinute: integer("end_minute"),
  /**
   * IANA zone the recurring window is written in. Three clocks are live in this
   * system, so the one the admin meant is stored rather than inferred from the
   * host, which runs on Europe/Berlin.
   */
  timezone: text("timezone").notNull().default("Asia/Amman"),
  /** Free text for the admin: why this rule exists. */
  note: text("note"),
  createdBy: integer("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  // Resolution always reads one key's rules.
  index("settings_rules_key_idx").on(table.key),
]);

export type SettingsRuleRow = typeof settingsRulesTable.$inferSelect;
