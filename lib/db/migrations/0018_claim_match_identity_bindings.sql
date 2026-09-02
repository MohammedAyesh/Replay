CREATE TABLE IF NOT EXISTS "claim_match_identity_bindings" (
  "id" serial PRIMARY KEY NOT NULL,
  "user_id" integer NOT NULL,
  "recording_id" integer NOT NULL,
  "person_id" text NOT NULL,
  "tracking_bundle_id" integer NOT NULL,
  "bundle_fingerprint" text NOT NULL,
  "resolution_method" text NOT NULL,
  "support_count" integer DEFAULT 0 NOT NULL,
  "accepted_answer_count" integer DEFAULT 0 NOT NULL,
  "support_percent" double precision DEFAULT 0 NOT NULL,
  "state" text DEFAULT 'pending' NOT NULL,
  "resolved_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "claim_match_identity_bindings_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade,
  CONSTRAINT "claim_match_identity_bindings_recording_id_recordings_id_fk"
    FOREIGN KEY ("recording_id") REFERENCES "recordings"("id") ON DELETE cascade,
  CONSTRAINT "claim_match_identity_bindings_tracking_bundle_id_recording_tracking_bundles_id_fk"
    FOREIGN KEY ("tracking_bundle_id") REFERENCES "recording_tracking_bundles"("id") ON DELETE cascade
);

CREATE UNIQUE INDEX IF NOT EXISTS "claim_match_identity_bindings_user_recording_unique"
  ON "claim_match_identity_bindings" USING btree ("user_id", "recording_id");

CREATE UNIQUE INDEX IF NOT EXISTS "claim_match_identity_bindings_confirmed_person_recording_unique"
  ON "claim_match_identity_bindings" USING btree ("recording_id", "person_id")
  WHERE "state" = 'confirmed';