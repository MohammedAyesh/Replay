// Temporary product switches for player-facing features.
// Keep the underlying routes available while hiding the entry points.
export const CLAIM_YOUR_MATCH_ENABLED = false;
// Paid match stats on the match page. Off until stats are produced for every
// booked match automatically; players must never pay for stats that won't come.
export const MATCH_STATS_PAYWALL_ENABLED = CLAIM_YOUR_MATCH_ENABLED;
