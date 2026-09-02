ALTER TABLE "claim_match_identity_bindings"
  ADD COLUMN IF NOT EXISTS "vouched_fragments" jsonb DEFAULT '[]'::jsonb NOT NULL;