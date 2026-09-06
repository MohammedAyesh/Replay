-- Every human identity decision, with the geometry that produced it.
--
-- Mirrors the `corrections` table in /opt/replay/labels/labels.db on vps1
-- (same three kinds) so offline labelling sessions and in-product ones can be
-- merged into one training set later. That table has never had a row written
-- to it; this one is written on every tap.
--
-- geom is frozen at decision time rather than derived later because the 48
-- human picks already in labels.db have a NULL geom column, and tracking
-- bundles here are replaced and pruned at 14 days — a label without its
-- features has a two-week shelf life.

CREATE TABLE IF NOT EXISTS "claim_chain_labels" (
  "id" serial PRIMARY KEY NOT NULL,
  "user_id" integer NOT NULL,
  "recording_id" integer NOT NULL,
  "bundle_fingerprint" text NOT NULL,
  "kind" text NOT NULL,
  "at_frame" integer NOT NULL,
  "wrong_track_id" text,
  "right_track_id" text,
  "decision_ms" integer,
  "geom" jsonb,
  "detector_swap_evidence" double precision,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "claim_chain_labels_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade,
  CONSTRAINT "claim_chain_labels_recording_id_recordings_id_fk"
    FOREIGN KEY ("recording_id") REFERENCES "recordings"("id") ON DELETE cascade
);

CREATE INDEX IF NOT EXISTS "claim_chain_labels_recording_idx"
  ON "claim_chain_labels" USING btree ("recording_id", "at_frame");
CREATE INDEX IF NOT EXISTS "claim_chain_labels_user_idx"
  ON "claim_chain_labels" USING btree ("user_id", "created_at");
CREATE INDEX IF NOT EXISTS "claim_chain_labels_bundle_idx"
  ON "claim_chain_labels" USING btree ("bundle_fingerprint");
