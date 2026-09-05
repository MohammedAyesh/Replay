import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";

/**
 * The overlay and end card burned into an exported clip.
 *
 * These used to be files on disk under BRANDING_ROOT, defaulting to
 * /opt/replay/branding — a path on the VPS. The export runs on Replit, whose
 * filesystem is rebuilt on every deploy, so that lookup could never have found
 * anything and nothing ever called it. They live in object storage now, and are
 * uploaded through the console like the academy logo.
 *
 * Resolution is academy, then field, then global — the same order the academy
 * intro already uses, so there is one rule to learn rather than two.
 */
export type BrandingScopeType = "academy" | "field" | "global";
export type BrandingKind = "overlay" | "endCard";

export const brandingAssetsTable = pgTable(
  "branding_assets",
  {
    id: serial("id").primaryKey(),
    scopeType: text("scope_type").notNull().$type<BrandingScopeType>(),
    /**
     * The academy or field id, and 0 for the global pair.
     *
     * Zero rather than NULL because this is half of a unique key, and Postgres
     * treats NULLs in a unique index as distinct from each other: with NULL
     * here, every global upload inserted a new row instead of replacing the
     * previous one, and resolution then picked whichever the query happened to
     * return first. Nothing failed; the wrong logo came out.
     */
    scopeId: integer("scope_id").notNull().default(0),
    kind: text("kind").notNull().$type<BrandingKind>(),
    /**
     * The pull-zone URL, as `uploadBufferToBunnyStorage` returns it and as an
     * academy's `introVideoUrl` already stores it. Not a bare storage path: the
     * origin and the pull zone are different hosts, and everything downstream
     * that fetches one of these — the renderer, the console preview — wants the
     * form that carries the AccessKey correctly.
     */
    assetUrl: text("asset_url").notNull(),
    /**
     * Probed at upload, not trusted from the client.
     *
     * An overlay is composited at 0,0 over a fixed output size, so one authored
     * at the wrong dimensions does not fail: it sits in a corner, or covers a
     * third of the picture, and nobody finds out until a clip is shared. The
     * console compares these against the export geometry and says so.
     */
    width: integer("width"),
    height: integer("height"),
    bytes: integer("bytes").notNull().default(0),
    contentType: text("content_type").notNull().default(""),
    uploadedBy: integer("uploaded_by").references(() => usersTable.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // One asset per scope and kind. Replacing is an update, so an old overlay
    // can never linger behind a new one and win by being found first.
    scopeKindUnique: uniqueIndex("branding_assets_scope_kind_unique").on(
      table.scopeType,
      table.scopeId,
      table.kind,
    ),
  }),
);

export type BrandingAssetRow = typeof brandingAssetsTable.$inferSelect;
