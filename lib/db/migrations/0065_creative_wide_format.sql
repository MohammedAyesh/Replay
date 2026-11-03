-- Creative hub: 16:9 clip videos ("wide"), made straight from a clip or a match moment.
-- Widens a check constraint; no data changes. Also applied at boot (ensureAdditiveColumns WIDENED_CHECKS).
ALTER TABLE "academy_creative_projects" DROP CONSTRAINT IF EXISTS "academy_creative_projects_format_check";
ALTER TABLE "academy_creative_projects" ADD CONSTRAINT "academy_creative_projects_format_check" CHECK ("format" in ('post', 'square', 'story', 'wide'));
