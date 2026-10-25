ALTER TABLE academy_players
  ADD COLUMN family_token_expires_at timestamptz;

UPDATE academy_players
SET family_token_expires_at = now() + interval '90 days'
WHERE family_token IS NOT NULL;
