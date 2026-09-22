-- VAR review marks are additive and safe to apply to existing footage requests.
CREATE TABLE IF NOT EXISTS "var_marks" (
  "id" serial PRIMARY KEY NOT NULL,
  "footage_request_id" integer NOT NULL,
  "at_utc" timestamp with time zone NOT NULL,
  "kind" text NOT NULL,
  "note" text,
  "created_by" integer NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'var_marks_footage_request_id_footage_requests_id_fk'
  ) THEN
    ALTER TABLE "var_marks"
      ADD CONSTRAINT "var_marks_footage_request_id_footage_requests_id_fk"
      FOREIGN KEY ("footage_request_id")
      REFERENCES "footage_requests"("id")
      ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'var_marks_created_by_users_id_fk'
  ) THEN
    ALTER TABLE "var_marks"
      ADD CONSTRAINT "var_marks_created_by_users_id_fk"
      FOREIGN KEY ("created_by")
      REFERENCES "users"("id")
      ON DELETE RESTRICT;
  END IF;
END $$;