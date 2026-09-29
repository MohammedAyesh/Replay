---
name: Render queue ownership without migrations
description: Cross-replica render handoff coordination when schema changes are out of scope.
---

When a release must remain schema-neutral, represent the short-lived export ownership phase in the existing text status rather than adding a column or table. Use conditional transitions so autoscaled API instances cannot both claim a vps1 handoff or its immediate local fallback, and keep internal markers normalized to `pending` at public API boundaries.

**Why:** Render requests can reach different API instances, while adding a schema migration can block an otherwise ordinary publish. Process-local sets alone cannot coordinate those instances.

**How to apply:** For render handoff/fallback work with a no-schema constraint, use a database compare-and-set on the existing status and make the winner responsible for scheduling the next renderer. Keep user-facing response states unchanged.