-- A camera owns its calibration.
--
-- The pitch model lived inside each recording's tracking manifest, so the same
-- grid had to be uploaded again for every night's footage and a bad
-- calibration could only be fixed one recording at a time. A camera on a mast
-- sees the same pitch the same way every night; the calibration is the
-- camera's, not the recording's.
--
-- `fields.camera_id` is nullable free text with no foreign key, and stays that
-- way -- this migration follows it rather than constraining it, so a field
-- with no camera keeps working and simply has no metres.

CREATE TABLE IF NOT EXISTS "cameras" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL DEFAULT '',
  "pitch_model" jsonb,
  "pitch_model_updated_at" timestamp with time zone,
  "pitch_model_updated_by" integer,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- Every camera any field already names.
INSERT INTO "cameras" ("id", "name")
SELECT DISTINCT "camera_id", "camera_id"
FROM "fields"
WHERE "camera_id" IS NOT NULL AND "camera_id" <> ''
ON CONFLICT ("id") DO NOTHING;

-- Carry across the models already uploaded per recording: for each camera take
-- the most recently uploaded bundle that has one. Recordings are pruned at 14
-- days, so this is the only chance to keep these -- after that the grids exist
-- nowhere but whoever's laptop fitted them.
UPDATE "cameras" AS c
SET "pitch_model" = latest."pitch_model",
    "pitch_model_updated_at" = latest."uploaded_at",
    "updated_at" = now()
FROM (
  SELECT DISTINCT ON (f."camera_id")
         f."camera_id" AS camera_id,
         b."manifest" -> 'pitchModel' AS pitch_model,
         b."updated_at" AS uploaded_at
  FROM "recording_tracking_bundles" b
  JOIN "recordings" r ON r."id" = b."recording_id"
  JOIN "fields" f ON f."id" = r."field_id"
  WHERE f."camera_id" IS NOT NULL
    AND f."camera_id" <> ''
    AND b."manifest" -> 'pitchModel' IS NOT NULL
    AND jsonb_typeof(b."manifest" -> 'pitchModel') = 'object'
  ORDER BY f."camera_id", b."updated_at" DESC
) AS latest
WHERE c."id" = latest.camera_id
  AND c."pitch_model" IS NULL;
