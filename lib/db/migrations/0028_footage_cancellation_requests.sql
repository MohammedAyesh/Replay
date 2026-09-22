CREATE TABLE IF NOT EXISTS "footage_cancellation_requests" (
  "id" serial PRIMARY KEY NOT NULL,
  "footage_request_id" integer NOT NULL,
  "requested_by" integer NOT NULL,
  "reason" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "admin_note" text,
  "reviewed_by" integer,
  "reviewed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "footage_cancellation_requests_footage_request_id_unique" UNIQUE("footage_request_id")
);
DO $$ BEGIN
 ALTER TABLE "footage_cancellation_requests" ADD CONSTRAINT "footage_cancellation_requests_footage_request_id_footage_requests_id_fk" FOREIGN KEY ("footage_request_id") REFERENCES "footage_requests"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "footage_cancellation_requests" ADD CONSTRAINT "footage_cancellation_requests_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "users"("id") ON DELETE restrict;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "footage_cancellation_requests" ADD CONSTRAINT "footage_cancellation_requests_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "users"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN null;
END $$;