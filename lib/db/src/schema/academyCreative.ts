import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { academiesTable } from "./academies";
import { usersTable } from "./users";

/**
 * Creative hub: one post, story or video an academy is making or has made.
 * The whole design lives in `scene` (see @workspace/api-zod creativeScene).
 * Drafts Replay prepares on its own after a match ("For you") carry
 * origin = 'auto' and an origin_key, so the same draft is never made twice.
 */
export const academyCreativeProjectsTable = pgTable("academy_creative_projects", {
  id: serial("id").primaryKey(),
  academyId: integer("academy_id").notNull().references(() => academiesTable.id, { onDelete: "cascade" }),
  kind: text("kind").notNull().default("image"),
  format: text("format").notNull().default("post"),
  title: text("title").notNull().default(""),
  templateKey: text("template_key"),
  style: text("style"),
  status: text("status").notNull().default("draft"),
  origin: text("origin").notNull().default("manual"),
  /** For auto drafts: e.g. "fulltime:session:123". Unique per academy. */
  originKey: text("origin_key"),
  /** The academy session (match / training) the draft is about, if any. */
  sourceSessionId: integer("source_session_id"),
  scene: jsonb("scene").notNull(),
  /** Bound values the scene was filled with (score, names allowed, etc.). */
  data: jsonb("data"),
  /** Last rendered output (Storage path served through the API). */
  outputPath: text("output_path"),
  outputMime: text("output_mime"),
  renderStatus: text("render_status").notNull().default("none"),
  renderError: text("render_error"),
  renderedAt: timestamp("rendered_at", { withTimezone: true }),
  /** Where it went: [{ channel: 'instagram'|'facebook'|'whatsapp'|'ad'|'download', ref?, at }]. */
  publishTargets: jsonb("publish_targets"),
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  createdBy: integer("created_by").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check("academy_creative_projects_kind_check", sql`${table.kind} in ('image', 'video')`),
  check("academy_creative_projects_format_check", sql`${table.format} in ('post', 'square', 'story')`),
  check("academy_creative_projects_status_check", sql`${table.status} in ('draft', 'ready', 'scheduled', 'published', 'skipped')`),
  check("academy_creative_projects_origin_check", sql`${table.origin} in ('auto', 'manual')`),
  check("academy_creative_projects_render_status_check", sql`${table.renderStatus} in ('none', 'queued', 'rendering', 'done', 'failed')`),
  uniqueIndex("academy_creative_projects_origin_unique").on(table.academyId, table.originKey).where(sql`${table.originKey} is not null`),
  index("academy_creative_projects_academy_idx").on(table.academyId, table.updatedAt),
]);

export type AcademyCreativeProject = typeof academyCreativeProjectsTable.$inferSelect;
