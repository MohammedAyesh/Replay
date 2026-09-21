-- Link owner-request clips back to the request that supplied their footage.
-- Additive and safe to run more than once.
ALTER TABLE "user_clips"
  ADD COLUMN IF NOT EXISTS "footage_request_id" integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'user_clips'::regclass
      AND contype = 'f'
      AND conkey = ARRAY[
        (SELECT attnum FROM pg_attribute
         WHERE attrelid = 'user_clips'::regclass
           AND attname = 'footage_request_id')
      ]::smallint[]
  ) THEN
    ALTER TABLE "user_clips"
      ADD CONSTRAINT "user_clips_footage_request_id_footage_requests_id_fk"
      FOREIGN KEY ("footage_request_id")
      REFERENCES "footage_requests"("id")
      ON DELETE SET NULL;
  END IF;
END $$;