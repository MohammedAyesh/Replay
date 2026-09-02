---
name: Claim identity ownership
description: Per-recording player claims require durable, exclusive ownership and bundle-version validation.
---

The claim system must resolve each user’s answers to one person within one tracking bundle, bind that person to the authenticated user for that recording, and keep competing claimants as disputes for admin review. Only a confirmed binding can newly complete a claim or award clips; a previously completed claim may retain its historical completed flag while a later conflict is pending, but it must expose the conflict and award no new clips. Replacing the bundle invalidates prior bindings because track IDs are bundle-relative.

**Why:** Track IDs are not stable across recordings or replacement uploads, and silently accepting competing claims would award private player data and clips to the wrong account.

**How to apply:** Enforce uniqueness at the database layer for user/recording and confirmed recording/person, snapshot exact contiguous source-track fragments around accepted answers as human-vouched locks, preserve disputed history, make reads recalculate binding state rather than trusting client completion flags, and distinguish post-completion conflict review from bundle replacement (which clears completion). Automatic or manual regrouping may move unvouched fragments but must reject moves of vouched fragments; only an explicit admin release clears those locks. Disjoint vouched fragments may split one inferred identity into deterministic synthetic identities, while overlapping fragments remain a dispute.