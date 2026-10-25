-- Every Nth paid booking earns a free match (2026-10-25). Additive: a kind column,
-- a milestone number, and source_match_id may be empty for loyalty rewards.
ALTER TABLE "free_match_rewards" ADD COLUMN IF NOT EXISTS "kind" text DEFAULT 'challenge' NOT NULL;
ALTER TABLE "free_match_rewards" ADD COLUMN IF NOT EXISTS "milestone" integer;
ALTER TABLE "free_match_rewards" ALTER COLUMN "source_match_id" DROP NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "free_match_rewards_milestone_unique" ON "free_match_rewards" USING btree ("user_id", "kind", "milestone");
