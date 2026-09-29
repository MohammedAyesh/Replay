---
name: Claim bundle cache admission
description: Why pending tracking reads share the claim bundle cache's fixed capacity.
---

Count in-flight segment reads as resident entries in the same fixed capacity as completed cache values. Serialize admission, evict the least-recent settled entry immediately, and wait only when the least-recent entry is itself pending; re-check recency after waiting. Reserve the slot before calling the loader.

**Why:** Parsing another large tracking bundle while two reads or cached values are resident can cause a transient memory spike. Waiting on any pending read, instead of the actual least-recent entry, needlessly stalls loads when a settled entry can be evicted.

**How to apply:** Preserve this admission rule when changing cache keys, load concurrency, or eviction policy. Keep tests that verify both the two-entry ceiling and prompt reuse of a settled least-recent slot while a newer load remains pending.