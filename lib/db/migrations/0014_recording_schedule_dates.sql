ALTER TABLE "recording_schedules"
  ADD COLUMN IF NOT EXISTS "allowed_date" date;