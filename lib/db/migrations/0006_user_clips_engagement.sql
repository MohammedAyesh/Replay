-- Migration: add engagement fields to user_clips and extend likes for user-clip targeting
-- Safe to run multiple times (IF NOT EXISTS / DO NOTHING).

-- Add engagement columns to user_clips
ALTER TABLE "user_clips" ADD COLUMN IF NOT EXISTS "is_public" boolean NOT NULL DEFAULT true;
ALTER TABLE "user_clips" ADD COLUMN IF NOT EXISTS "like_count" integer NOT NULL DEFAULT 0;
ALTER TABLE "user_clips" ADD COLUMN IF NOT EXISTS "view_count" integer NOT NULL DEFAULT 0;
ALTER TABLE "user_clips" ADD COLUMN IF NOT EXISTS "share_count" integer NOT NULL DEFAULT 0;
ALTER TABLE "user_clips" ADD COLUMN IF NOT EXISTS "score" integer NOT NULL DEFAULT 0;

-- Extend likes table for user-clip targeting
-- Step 1: drop old primary key (clip_id was NOT NULL, new schema allows NULL)
ALTER TABLE "likes" DROP CONSTRAINT IF EXISTS "likes_pkey";

-- Step 2: add id serial primary key (safe if already exists as primary key)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'likes' AND column_name = 'id'
  ) THEN
    ALTER TABLE "likes" ADD COLUMN "id" serial PRIMARY KEY;
  END IF;
END $$;

-- Step 3: make clip_id nullable
ALTER TABLE "likes" ALTER COLUMN "clip_id" DROP NOT NULL;

-- Step 4: add user_clip_id nullable FK
ALTER TABLE "likes" ADD COLUMN IF NOT EXISTS "user_clip_id" integer;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'likes' AND constraint_name = 'likes_user_clip_id_fkey'
  ) THEN
    ALTER TABLE "likes" ADD CONSTRAINT "likes_user_clip_id_fkey"
      FOREIGN KEY ("user_clip_id") REFERENCES "user_clips"("id");
  END IF;
END $$;

-- Step 5: enforce exactly one target via check constraint
ALTER TABLE "likes" DROP CONSTRAINT IF EXISTS "likes_one_target";
ALTER TABLE "likes" ADD CONSTRAINT "likes_one_target"
  CHECK ((("clip_id" IS NOT NULL)::integer + ("user_clip_id" IS NOT NULL)::integer) = 1);

-- Step 6: unique constraints per target type
ALTER TABLE "likes" DROP CONSTRAINT IF EXISTS "likes_user_clip_uniq";
ALTER TABLE "likes" ADD CONSTRAINT "likes_user_clip_uniq"
  UNIQUE ("user_id", "clip_id");

ALTER TABLE "likes" DROP CONSTRAINT IF EXISTS "likes_user_userclip_uniq";
ALTER TABLE "likes" ADD CONSTRAINT "likes_user_userclip_uniq"
  UNIQUE ("user_id", "user_clip_id");
