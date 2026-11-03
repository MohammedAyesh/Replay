-- Creative hub brand packs: which academy gets which pack style (admin sets it). Additive only.
-- The allowed keys are PACK_STYLES in lib/api-zod/src/creativeScene.ts.
ALTER TABLE "academies" ADD COLUMN IF NOT EXISTS "creative_pack" text CONSTRAINT "academies_creative_pack_check" CHECK ("creative_pack" is null or "creative_pack" in ('iris', 'souqar', 'barca', 'juventus', 'knights', 'jufa'));
