import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, pgTable, serial, text, timestamp, unique } from "drizzle-orm/pg-core";
import { academiesTable } from "./academies";
import { academyCreativeProjectsTable } from "./academyCreative";
import { usersTable } from "./users";

/**
 * Academies' Instagram autopilot (0074): the owner's switch, approve-first or automatic, and the
 * day's times for feed posts, Reels and Stories (`times`: { feed: ["18:00"], reel: […], story: […] }).
 */
export const academyIgAutopilotTable = pgTable("academy_ig_autopilot", {
  academyId: integer("academy_id").primaryKey().references(() => academiesTable.id, { onDelete: "cascade" }),
  enabled: boolean("enabled").notNull().default(false),
  publishMode: text("publish_mode").notNull().default("approve"),
  times: jsonb("times"),
  updatedBy: integer("updated_by").references(() => usersTable.id, { onDelete: "set null" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check("academy_ig_autopilot_publish_mode_check", sql`${table.publishMode} in ('approve', 'auto')`),
]);

/** One Creative hub design on the academy's Instagram calendar: its slot, and how it went out. */
export const academyIgItemsTable = pgTable("academy_ig_items", {
  id: serial("id").primaryKey(),
  academyId: integer("academy_id").notNull().references(() => academiesTable.id, { onDelete: "cascade" }),
  projectId: integer("project_id").notNull().references(() => academyCreativeProjectsTable.id, { onDelete: "cascade" }),
  placement: text("placement").notNull(),
  slotAt: timestamp("slot_at", { withTimezone: true }),
  /** Placed by the owner: the planner leaves it where it is. */
  pinned: boolean("pinned").notNull().default(false),
  status: text("status").notNull().default("planned"),
  error: text("error"),
  postId: integer("post_id"),
  igPermalink: text("ig_permalink"),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique("academy_ig_items_project_unique").on(table.projectId),
  index("academy_ig_items_academy_idx").on(table.academyId, table.slotAt),
  check("academy_ig_items_placement_check", sql`${table.placement} in ('feed', 'reel', 'story')`),
  check("academy_ig_items_status_check", sql`${table.status} in ('planned', 'approved', 'publishing', 'published', 'skipped', 'failed')`),
]);

export type AcademyIgAutopilot = typeof academyIgAutopilotTable.$inferSelect;
export type AcademyIgItem = typeof academyIgItemsTable.$inferSelect;
