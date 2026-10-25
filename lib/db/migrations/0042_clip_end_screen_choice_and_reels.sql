-- The player's end screen choice and highlight reels (2026-10-25).
-- Additive: two columns (one nullable, one with a default), one new table.
ALTER TABLE "user_clips" ADD COLUMN IF NOT EXISTS "end_screen" jsonb;
ALTER TABLE "user_clips" ADD COLUMN IF NOT EXISTS "end_screen_pending" boolean DEFAULT false NOT NULL;
CREATE TABLE IF NOT EXISTS "user_reels" (
  "id" serial PRIMARY KEY NOT NULL,
  "user_id" integer NOT NULL,
  "title" text NOT NULL,
  "clip_ids" jsonb NOT NULL,
  "aspect_ratio" text DEFAULT '9:16' NOT NULL,
  "end_screen" jsonb,
  "export_status" text,
  "export_path" text,
  "export_error" text,
  "duration_sec" integer,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp with time zone
);
DO $$ BEGIN
  ALTER TABLE "user_reels" ADD CONSTRAINT "user_reels_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
CREATE INDEX IF NOT EXISTS "user_reels_user_idx" ON "user_reels" USING btree ("user_id");
