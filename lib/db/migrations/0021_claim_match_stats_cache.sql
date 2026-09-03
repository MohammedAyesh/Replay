ALTER TABLE "claim_match_corrections"
  ADD COLUMN IF NOT EXISTS "updated_at" timestamptz NOT NULL DEFAULT now();

ALTER TABLE "claim_match_identity_bindings"
  ADD COLUMN IF NOT EXISTS "computed_stats" jsonb;

ALTER TABLE "claim_match_identity_bindings"
  ADD COLUMN IF NOT EXISTS "stats_computed_at" timestamptz;

ALTER TABLE "claim_match_identity_bindings"
  ADD COLUMN IF NOT EXISTS "stats_input_fingerprint" text;