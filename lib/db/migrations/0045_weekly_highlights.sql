CREATE TABLE IF NOT EXISTS "weekly_highlights" (
  "id" serial PRIMARY KEY,
  "user_id" integer REFERENCES "users"("id") ON DELETE CASCADE,
  "field_id" integer NOT NULL REFERENCES "fields"("id") ON DELETE CASCADE,
  "week_start" date NOT NULL,
  "title" text NOT NULL,
  "clip_count" integer NOT NULL DEFAULT 0,
  "duration_sec" integer NOT NULL DEFAULT 0,
  "status" text NOT NULL DEFAULT 'draft',
  "published_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "weekly_highlights_status_check" CHECK ("status" IN ('draft', 'published'))
);
CREATE UNIQUE INDEX IF NOT EXISTS "weekly_highlights_personal_week_unique" ON "weekly_highlights" ("user_id", "week_start") WHERE "user_id" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "weekly_highlights_field_week_unique" ON "weekly_highlights" ("field_id", "week_start") WHERE "user_id" IS NULL;
CREATE INDEX IF NOT EXISTS "weekly_highlights_published_week_idx" ON "weekly_highlights" ("status", "week_start");

CREATE TABLE IF NOT EXISTS "highlight_clips" (
  "highlight_id" integer NOT NULL REFERENCES "weekly_highlights"("id") ON DELETE CASCADE,
  "position" integer NOT NULL,
  "clip_id" integer NOT NULL REFERENCES "user_clips"("id") ON DELETE CASCADE,
  "event_type" text NOT NULL,
  "minute" integer,
  "video_url" text NOT NULL,
  "preview_url" text NOT NULL,
  "you_x" real,
  "you_y" real,
  CONSTRAINT "highlight_clips_event_type_check" CHECK ("event_type" IN ('goal', 'assist', 'save', 'tackle')),
  CONSTRAINT "highlight_clips_marker_check" CHECK (("you_x" IS NULL OR "you_x" BETWEEN 0 AND 1) AND ("you_y" IS NULL OR "you_y" BETWEEN 0 AND 1))
);
CREATE UNIQUE INDEX IF NOT EXISTS "highlight_clips_position_unique" ON "highlight_clips" ("highlight_id", "position");

CREATE TABLE IF NOT EXISTS "highlight_notices" (
  "id" serial PRIMARY KEY,
  "user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "highlight_id" integer NOT NULL REFERENCES "weekly_highlights"("id") ON DELETE CASCADE,
  "message" text NOT NULL,
  "status" text NOT NULL DEFAULT 'queued',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "highlight_notices_status_check" CHECK ("status" IN ('queued', 'copied'))
);
CREATE UNIQUE INDEX IF NOT EXISTS "highlight_notices_user_highlight_unique" ON "highlight_notices" ("user_id", "highlight_id");
