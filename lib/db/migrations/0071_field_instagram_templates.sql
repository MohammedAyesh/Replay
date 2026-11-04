-- Field Instagram templates: the autopilot posts more kinds (which-is-nicer, top 5, the week's thank-you
-- with its numbers, match and player of the week, milestones, open slots, the monthly scorers) and award
-- nominees as a carousel voted on in the comments. Widens two check constraints; no data changes.
-- Also applied at boot (ensureAdditiveColumns WIDENED_CHECKS).
ALTER TABLE "venue_ig_items" DROP CONSTRAINT IF EXISTS "venue_ig_items_kind_check";
ALTER TABLE "venue_ig_items" ADD CONSTRAINT "venue_ig_items_kind_check" CHECK ("kind" in ('booking_clip', 'award_nominees', 'award_winner', 'versus', 'top5', 'thanks', 'match_week', 'player_week', 'milestone', 'open_slots', 'leaderboard'));
ALTER TABLE "venue_ig_items" DROP CONSTRAINT IF EXISTS "venue_ig_items_placement_check";
ALTER TABLE "venue_ig_items" ADD CONSTRAINT "venue_ig_items_placement_check" CHECK ("placement" in ('story', 'reel', 'carousel'));
