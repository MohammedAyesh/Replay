CREATE TABLE IF NOT EXISTS "recording_views" (
  "id" serial PRIMARY KEY,
  "recording_id" integer NOT NULL REFERENCES "recordings"("id") ON DELETE CASCADE,
  "viewer_user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "view_count" integer NOT NULL DEFAULT 1,
  "first_viewed_at" timestamp with time zone NOT NULL DEFAULT now(),
  "last_viewed_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "recording_views_recording_viewer_unique"
  ON "recording_views" ("recording_id", "viewer_user_id");
CREATE INDEX IF NOT EXISTS "recording_views_recording_last_viewed_idx"
  ON "recording_views" ("recording_id", "last_viewed_at");
