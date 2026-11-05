import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { academiesTable } from "./academies";
import { usersTable } from "./users";

/**
 * My templates (0073): a design an academy or field edited from a catalogue template and saved
 * to use again. `scene` keeps its bindings ({{media}}, {{custom.title}} …), so it fills with any
 * match's facts. `replacesBase`: it stands in for its catalogue template everywhere, the
 * autopilots included (one per template and size).
 */
export const academyCreativeTemplatesTable = pgTable("academy_creative_templates", {
  id: serial("id").primaryKey(),
  academyId: integer("academy_id").notNull().references(() => academiesTable.id, { onDelete: "cascade" }),
  baseKey: text("base_key").notNull(),
  style: text("style"),
  format: text("format").notNull(),
  kind: text("kind").notNull().default("image"),
  title: text("title").notNull(),
  scene: jsonb("scene").notNull(),
  /** What it was filled with when saved: the card's preview. */
  sampleData: jsonb("sample_data"),
  replacesBase: boolean("replaces_base").notNull().default(false),
  createdBy: integer("created_by").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("academy_creative_templates_academy_idx").on(table.academyId, table.updatedAt),
  uniqueIndex("academy_creative_templates_replaces_unique").on(table.academyId, table.baseKey, table.format).where(sql`${table.replacesBase}`),
  check("academy_creative_templates_kind_check", sql`${table.kind} in ('image', 'video')`),
]);

export type AcademyCreativeTemplate = typeof academyCreativeTemplatesTable.$inferSelect;
