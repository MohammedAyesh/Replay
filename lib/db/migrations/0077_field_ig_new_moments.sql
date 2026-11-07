-- Field Instagram calendar (2026-11-07 templates): six more kinds (the moment of the day, so close,
-- pass, skill and best goals of the week, same hour today) and skill nominations beside saves.
-- Widening checks only; no data changes. Also applied at boot (ensureAdditiveColumns WIDENED_CHECKS).
ALTER TABLE "venue_ig_items" DROP CONSTRAINT IF EXISTS "venue_ig_items_kind_check";
ALTER TABLE "venue_ig_items" ADD CONSTRAINT "venue_ig_items_kind_check" CHECK ("kind" in ('booking_clip', 'award_nominees', 'award_winner', 'versus', 'top5', 'thanks', 'match_week', 'player_week', 'milestone', 'open_slots', 'leaderboard', 'match_highlights', 'day_best', 'moment_day', 'so_close', 'pass_week', 'skill_week', 'best_goals', 'same_hour'));
ALTER TABLE "venue_ig_nominations" DROP CONSTRAINT IF EXISTS "venue_ig_nominations_category_check";
ALTER TABLE "venue_ig_nominations" ADD CONSTRAINT "venue_ig_nominations_category_check" CHECK ("category" in ('save', 'skill'));
