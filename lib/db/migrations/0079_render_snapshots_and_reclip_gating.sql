CREATE TABLE IF NOT EXISTS "render_snapshots" (
  "id" serial PRIMARY KEY,
  "artifact_key" text NOT NULL,
  "output_locator" text NOT NULL,
  "output_sha256" text,
  "snapshot" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "render_snapshots_artifact_output_unique"
  ON "render_snapshots" ("artifact_key", "output_locator");
CREATE INDEX IF NOT EXISTS "render_snapshots_artifact_created_idx"
  ON "render_snapshots" ("artifact_key", "created_at");

DO $$
BEGIN
  IF to_regclass('public.camera_4k_reclip_items') IS NOT NULL THEN
    ALTER TABLE "camera_4k_reclip_items"
      ADD COLUMN IF NOT EXISTS "source_export_url" text,
      ADD COLUMN IF NOT EXISTS "snapshot_id" integer
        REFERENCES "render_snapshots"("id") ON DELETE SET NULL;
  END IF;
END
$$;
