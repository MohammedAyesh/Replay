CREATE TABLE IF NOT EXISTS "recording_schedules" (
  "id" serial PRIMARY KEY,
  "field_id" integer NOT NULL REFERENCES "fields"("id") ON DELETE CASCADE,
  "day_of_week" smallint,
  "start_time" text NOT NULL,
  "end_time" text NOT NULL,
  "label" text
);
