---
name: Render queue ownership without migrations
description: Cross-replica render handoff coordination when schema changes are out of scope.
---

When a release must remain schema-neutral, represent the short-lived export ownership phase in the existing text status rather than adding a column or table. Use conditional transitions so autoscaled API instances cannot both claim a vps1 handoff or its immediate local fallback, and keep internal markers normalized to `pending` at public API boundaries.

**Why:** Render requests can reach different API instances, while adding a schema migration can block an otherwise ordinary publish. Process-local sets alone cannot coordinate those instances.

**How to apply:** For render handoff/fallback work with a no-schema constraint, use a database compare-and-set on the existing status and make the winner responsible for scheduling the next renderer. Audit every server-side consumer, normalize response fields to `pending`, and do not re-queue a marker that already identifies renderer ownership.

An internal pending marker is not proof that a primary renderer is still live. After a process restart, process-local ownership and start-time maps are empty, so the recovery sweep must resume reconciliation rather than wait on the persisted marker. Accept a ready backup immediately when it includes every planned branding asset; wait for a primary only when branding is incomplete and that primary is live, with a fixed upper bound. Primary completion must also accept every internal pending state it can legitimately own.

**Why:** Persisted status outlives the process-local renderer. Treating status as liveness can make a ready backup wait forever, while omitting an internal state from the primary's conditional completion leaves a finished file unpublished.

**How to apply:** For competing renderers, separately track actual in-process ownership and persisted handoff status. Make recovery sweeps safe after restart, bound any wait for a better render, and include all valid internal states in conditional completion writes.