import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

/**
 * Template library (0078): templates an admin uploads as a file (Admin → Template library), no code
 * change needed. One row per template and size. `audience`: who sees it in the Creative hub
 * (fields, academies or both); `academyIds`: only those (null = everyone in the audience).
 * `baseKey`: the catalogue template it fills like; with `replacesBase` it stands in for it
 * everywhere, the autopilots included (a field's or academy's own "use instead" still wins).
 * `clips`: a montage's clip count it is laid out for (null = any).
 */
export const creativeLibraryTemplatesTable = pgTable("creative_library_templates", {
  id: serial("id").primaryKey(),
  key: text("key").notNull(),
  titleEn: text("title_en").notNull(),
  titleAr: text("title_ar").notNull(),
  description: text("description"),
  audience: text("audience").notNull().default("field"),
  academyIds: jsonb("academy_ids").$type<number[] | null>(),
  baseKey: text("base_key"),
  replacesBase: boolean("replaces_base").notNull().default(false),
  clips: integer("clips"),
  format: text("format").notNull(),
  kind: text("kind").notNull().default("image"),
  scene: jsonb("scene").notNull(),
  sampleData: jsonb("sample_data"),
  active: boolean("active").notNull().default(true),
  uploadedBy: integer("uploaded_by").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("creative_library_templates_key_format_unique").on(table.key, table.format),
  index("creative_library_templates_base_idx").on(table.baseKey, table.format),
  check("creative_library_templates_audience_check", sql`${table.audience} in ('field', 'academy', 'all')`),
  check("creative_library_templates_kind_check", sql`${table.kind} in ('image', 'video')`),
]);

export type CreativeLibraryTemplate = typeof creativeLibraryTemplatesTable.$inferSelect;
