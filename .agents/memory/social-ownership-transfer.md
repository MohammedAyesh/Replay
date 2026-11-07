---
name: Meta social ownership transfer
description: Ownership rules for synced Meta posts and comments when a Page or Instagram account changes academies.
---

**Rule:** A Meta Page or Instagram account belongs to one academy at a time; do not enable shared connections by weakening the unique account constraints. An Instagram-only login may transfer an Instagram identity only when the signed-in user owns both academies. If the source connection also has a Facebook Page, detach only Instagram and keep the Page connected there. When sync returns an existing Instagram media ID or Facebook post ID, its matching post and comments/replies belong to the academy currently connected to that account. Match exact channel and external post IDs; do not bulk-transfer unrelated Replay-created content. Preserve post deletion and comment moderation/deletion state, and keep unrelated DM threads and academy-specific field items scoped to their academy.

**Why:** Webhooks and imported Meta content are routed to one academy, so allowing two simultaneous owners would create ambiguous inbox and data ownership. Transferring only Instagram avoids taking an unrelated Facebook Page connection away from the source academy.

**How to apply:** Authorize a transfer only after confirming the same user owns both academies, and perform source detachment plus target connection atomically. During sync, update ownership only for exact external IDs returned by the current account. Move comment rows by channel plus external post ID, changing only their academy owner.
