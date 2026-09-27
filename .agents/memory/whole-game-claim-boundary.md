---
name: Whole-game claim boundary
description: Why the whole-game identity flow must stay distinct from the chain-claim fallback.
---

The `/find` whole-game flow persists the claimant's name and selected identity parts through its game-save endpoint. Keep `/claim/:id` as a separate, explicit fallback rather than sending `/find` naming or selection actions through the chain-tap flow.

**Why:** The user designated `/claim` for people who cannot see themselves in the whole-game flow. The chain-tap endpoint has distinct overlap and decision-label behavior, so routing ordinary `/find` selections through it can create duplicate labels or unexpectedly move the claimant into the fallback.

**How to apply:** When changing whole-game claiming, extend its game-save contract for associated identity data. Keep legacy `/find-quick/:id` URLs redirecting to `/find/:id`, and leave the `/claim/:id` route independently reachable.