ALTER TABLE "recording_tracking_bundles"
  ADD COLUMN IF NOT EXISTS "manifest" jsonb;

-- Existing single-file rows are intentionally not copied into the new segment
-- store: they must be re-uploaded as a complete bundle before Claim is enabled.
-- Keeping the old column nullable for one migration makes this schema change
-- deploy-safe for installations that still have an old row.
ALTER TABLE "recording_tracking_bundles"
  ALTER COLUMN "payload" DROP NOT NULL;

CREATE TABLE IF NOT EXISTS "recording_tracking_segments" (
  "id" serial PRIMARY KEY NOT NULL,
  "bundle_id" integer NOT NULL,
  "segment_index" integer NOT NULL,
  "name" text NOT NULL,
  "start_frame" integer NOT NULL,
  "end_frame" integer NOT NULL,
  "start_seconds" double precision NOT NULL,
  "end_seconds" double precision NOT NULL,
  "object_path" text NOT NULL,
  "compressed_bytes" integer DEFAULT 0 NOT NULL,
  "track_count" integer DEFAULT 0 NOT NULL,
  "crossing_count" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "recording_tracking_segments_bundle_id_recording_tracking_bundles_id_fk"
    FOREIGN KEY ("bundle_id") REFERENCES "recording_tracking_bundles"("id") ON DELETE cascade
);

CREATE UNIQUE INDEX IF NOT EXISTS "recording_tracking_segments_bundle_index_unique"
  ON "recording_tracking_segments" USING btree ("bundle_id","segment_index");