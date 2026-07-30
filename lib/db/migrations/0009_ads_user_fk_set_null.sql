-- ad_impressions.user_id / ad_clicks.user_id referenced users.id with no
-- ON DELETE action. Both columns are nullable, but the constraint was RESTRICT
-- by default, so DELETE /admin/users/:id raised 23503 for any user who had ever
-- been served an ad — after the handler had already deleted their clips.
--
-- The route now runs in a transaction and detaches these rows itself, so this
-- migration is defence in depth: it makes the database enforce the same thing
-- for any other delete path (psql, a future admin tool, a cascade from above).
--
-- SET NULL rather than CASCADE: an impression is an ad-analytics fact, not user
-- data, and losing it would silently distort historical ad reporting.

ALTER TABLE "ad_impressions" DROP CONSTRAINT IF EXISTS "ad_impressions_user_id_users_id_fk";
ALTER TABLE "ad_impressions"
  ADD CONSTRAINT "ad_impressions_user_id_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL;

ALTER TABLE "ad_impressions" DROP CONSTRAINT IF EXISTS "ad_impressions_clip_id_clips_id_fk";
ALTER TABLE "ad_impressions"
  ADD CONSTRAINT "ad_impressions_clip_id_clips_id_fk"
  FOREIGN KEY ("clip_id") REFERENCES "clips"("id") ON DELETE SET NULL;

ALTER TABLE "ad_clicks" DROP CONSTRAINT IF EXISTS "ad_clicks_user_id_users_id_fk";
ALTER TABLE "ad_clicks"
  ADD CONSTRAINT "ad_clicks_user_id_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL;
