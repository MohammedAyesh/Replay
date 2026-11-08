-- Durable one-off camera-original 4K clip re-render progress and pause state.
CREATE TABLE IF NOT EXISTS "camera_4k_reclip_batches" (
  "id" serial PRIMARY KEY,
  "batch_key" text NOT NULL UNIQUE,
  "status" text DEFAULT 'scheduled' NOT NULL,
  "scope_seeded" boolean DEFAULT false NOT NULL,
  "paused" boolean DEFAULT false NOT NULL,
  "scope_cutoff" timestamp with time zone NOT NULL,
  "total_count" integer DEFAULT 0 NOT NULL,
  "completed_count" integer DEFAULT 0 NOT NULL,
  "failed_count" integer DEFAULT 0 NOT NULL,
  "skipped_count" integer DEFAULT 0 NOT NULL,
  "source_probe_summary" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "lease_token" text,
  "lease_until" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "started_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "camera_4k_reclip_batches_status_check"
    CHECK ("status" in ('scheduled', 'running', 'paused', 'completed'))
);
CREATE INDEX IF NOT EXISTS "camera_4k_reclip_batches_status_idx"
  ON "camera_4k_reclip_batches" ("status", "updated_at");

CREATE TABLE IF NOT EXISTS "camera_4k_reclip_items" (
  "id" serial PRIMARY KEY,
  "batch_id" integer NOT NULL CONSTRAINT "camera_4k_reclip_items_batch_id_camera_4k_reclip_batches_id_fk"
    REFERENCES "camera_4k_reclip_batches"("id") ON DELETE CASCADE,
  "clip_id" integer NOT NULL CONSTRAINT "camera_4k_reclip_items_clip_id_user_clips_id_fk"
    REFERENCES "user_clips"("id") ON DELETE CASCADE,
  "recording_id" integer NOT NULL,
  "video_id" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "failure_reason" text,
  "started_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "elapsed_ms" integer,
  "old_duration_seconds" text,
  "new_duration_seconds" text,
  "old_bytes" bigint,
  "new_bytes" bigint,
  "width" integer,
  "height" integer,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "camera_4k_reclip_items_batch_clip_unique" UNIQUE ("batch_id", "clip_id"),
  CONSTRAINT "camera_4k_reclip_items_status_check"
    CHECK ("status" in ('pending', 'running', 'completed', 'failed', 'skipped'))
);
CREATE INDEX IF NOT EXISTS "camera_4k_reclip_items_batch_status_id_idx"
  ON "camera_4k_reclip_items" ("batch_id", "status", "id");
