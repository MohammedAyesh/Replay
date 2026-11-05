-- Field Instagram calendar: the owner picks the clips a post uses (venue_ig_items.picks), and two
-- more kinds: each match's highlights and the day's best clips. Additive; no data changes.
-- Also applied at boot (ensureAdditiveColumns COLUMNS and WIDENED_CHECKS).
ALTER TABLE "venue_ig_items" ADD COLUMN IF NOT EXISTS "picks" jsonb;
ALTER TABLE "venue_ig_items" DROP CONSTRAINT IF EXISTS "venue_ig_items_kind_check";
ALTER TABLE "venue_ig_items" ADD CONSTRAINT "venue_ig_items_kind_check" CHECK ("kind" in ('booking_clip', 'award_nominees', 'award_winner', 'versus', 'top5', 'thanks', 'match_week', 'player_week', 'milestone', 'open_slots', 'leaderboard', 'match_highlights', 'day_best'));
