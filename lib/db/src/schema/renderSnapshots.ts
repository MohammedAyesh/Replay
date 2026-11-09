import { index, jsonb, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export type RenderSnapshotAsset = {
  kind: string;
  locator: string | null;
  sha256: string | null;
  version?: string | null;
};

/**
 * Immutable inputs captured for one exact rendered output.
 *
 * `content` carries the full normalized scene/settings used by that renderer;
 * the named fields make the source, framing, branding, music, template and
 * output contract easy to inspect and validate before a replay.
 */
export type RenderSnapshotDocument = {
  schemaVersion: 1;
  renderKind: "user_clip" | "creative_project" | "studio_post";
  renderer: { name: string; version: string };
  renderedAt: string;
  source: Record<string, unknown>;
  timeWindow: Record<string, unknown>;
  crop: unknown;
  output: {
    mimeType: string;
    width: number | null;
    height: number | null;
    durationMs: number | null;
  };
  text: unknown;
  branding: unknown;
  endCard: unknown;
  music: unknown;
  template: { id: string | number | null; version: string | null };
  content: Record<string, unknown>;
  assets: RenderSnapshotAsset[];
  replayable: boolean;
  replayabilityReason: string | null;
};

/**
 * One durable input snapshot per completed output revision. A polymorphic
 * artifact key keeps clip and Creative Hub history in one additive table;
 * outputLocator binds the snapshot to the exact stored file, not a mutable
 * project or clip row.
 */
export const renderSnapshotsTable = pgTable("render_snapshots", {
  id: serial("id").primaryKey(),
  artifactKey: text("artifact_key").notNull(),
  outputLocator: text("output_locator").notNull(),
  outputSha256: text("output_sha256"),
  snapshot: jsonb("snapshot").$type<RenderSnapshotDocument>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("render_snapshots_artifact_output_unique").on(table.artifactKey, table.outputLocator),
  index("render_snapshots_artifact_created_idx").on(table.artifactKey, table.createdAt),
]);

export type RenderSnapshotRow = typeof renderSnapshotsTable.$inferSelect;
