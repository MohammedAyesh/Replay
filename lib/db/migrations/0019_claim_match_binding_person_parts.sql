ALTER TABLE "claim_match_identity_bindings"
  ADD COLUMN IF NOT EXISTS "person_parts" jsonb DEFAULT '[]'::jsonb NOT NULL;