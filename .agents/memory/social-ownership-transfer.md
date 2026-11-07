---
name: Meta social ownership transfer
description: Ownership rules for synced Meta posts and comments when a Page or Instagram account changes academies.
---

**Rule:** When a connected account sync returns an existing Instagram media ID or Facebook post ID, the matching social post and its comments/replies belong to the academy currently connected to that account. Match exact channel and external post IDs; do not bulk-transfer unrelated Replay-created content. Preserve post deletion and comment moderation/deletion state, and keep unrelated DM threads and academy-specific field items scoped to their academy.

**Why:** A Facebook Page or Instagram account can be disconnected from one academy and connected to another. The new academy should see the same Meta content without restoring anything previously hidden or deleted.

**How to apply:** During sync, update ownership only for exact external IDs returned by the current account. Move comment rows by channel plus external post ID, changing only their academy owner.
