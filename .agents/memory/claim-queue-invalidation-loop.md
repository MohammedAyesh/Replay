---
name: Claim queue invalidation loop
description: Preventing the Claim Your Match offline queue from creating a permanent refetch and loading-skeleton cycle.
---

Only invalidate Claim Match queries after at least one queued action was successfully synchronized. Keep the queue-flush callback dependent on stable mutation functions rather than whole mutation result objects.

**Why:** An empty queue flush previously invalidated the active demo query. Unstable mutation-object dependencies recreated the callback after each render, so the effect repeatedly flushed, invalidated, refetched, and rendered while the page remained on its loading skeleton.

**How to apply:** Any change to Claim Match offline synchronization must preserve the empty-queue early return and condition query invalidation on a successful queue mutation.