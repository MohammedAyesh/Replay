ALTER TABLE "match_rooms"
  ADD COLUMN "substitutes_per_team" integer,
  ADD COLUMN "team_a_shirts_have_numbers" text DEFAULT 'unknown' NOT NULL,
  ADD COLUMN "team_b_shirts_have_numbers" text DEFAULT 'unknown' NOT NULL,
  ADD COLUMN "team_c_shirts_have_numbers" text DEFAULT 'unknown' NOT NULL,
  ADD CONSTRAINT "match_rooms_substitutes_per_team_check"
    CHECK ("substitutes_per_team" IS NULL OR "substitutes_per_team" BETWEEN 0 AND 10),
  ADD CONSTRAINT "match_rooms_team_a_shirts_have_numbers_check"
    CHECK ("team_a_shirts_have_numbers" IN ('yes', 'no', 'unknown')),
  ADD CONSTRAINT "match_rooms_team_b_shirts_have_numbers_check"
    CHECK ("team_b_shirts_have_numbers" IN ('yes', 'no', 'unknown')),
  ADD CONSTRAINT "match_rooms_team_c_shirts_have_numbers_check"
    CHECK ("team_c_shirts_have_numbers" IN ('yes', 'no', 'unknown'));