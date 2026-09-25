-- Keep partial capture state separate from user-visible processing errors.
ALTER TABLE "user_clips"
  ADD COLUMN IF NOT EXISTS "live_clip_partial" boolean DEFAULT false NOT NULL;

UPDATE "user_clips"
SET
  "live_clip_partial" = true,
  "live_clip_error" = NULL,
  "live_clip_status" = CASE
    WHEN "live_clip_status" = 'failed' AND "live_clip_job_id" IS NOT NULL THEN 'processing'
    ELSE "live_clip_status"
  END
WHERE "live_clip_error" = 'Part of this moment wasn''t recorded (camera gap) — the clip is shorter than you picked.';