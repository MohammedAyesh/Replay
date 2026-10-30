-- Preserve the exact recording provenance for manually saved clips.
ALTER TABLE "user_clips"
  ADD COLUMN IF NOT EXISTS "source_recording_id" integer
  REFERENCES "recordings"("id") ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS "user_clips_source_recording_idx"
  ON "user_clips" ("source_recording_id");

-- Backfill only when the clip video ID is a complete URL path segment and
-- exactly one recording matches. Ambiguous or partial substring matches stay
-- NULL rather than being assigned to the wrong game.
WITH unique_recording_matches AS (
  SELECT
    clips.id AS clip_id,
    MIN(recordings.id) AS recording_id
  FROM "user_clips" AS clips
  INNER JOIN "recordings" AS recordings
    ON POSITION('/' || clips.video_id || '/' IN recordings.video_url) > 0
  WHERE clips.source_recording_id IS NULL
    AND clips.footage_request_id IS NULL
    AND clips.video_id NOT LIKE 'live:%'
  GROUP BY clips.id
  HAVING COUNT(DISTINCT recordings.id) = 1
)
UPDATE "user_clips" AS clips
SET "source_recording_id" = matches.recording_id
FROM unique_recording_matches AS matches
WHERE clips.id = matches.clip_id;
