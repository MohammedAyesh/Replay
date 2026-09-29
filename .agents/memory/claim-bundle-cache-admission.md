---
name: Claim bundle cache admission
description: Why claim bundle cache admission does not wait on pending segment reads.
---

Limit the cache to two completed parsed bundles, but do not count pending reads against that limit or wait on them during admission. Evict only the least-recent completed entry; when a read completes, promote it and trim the completed cache to two. Each object download must destroy its read stream after 60 seconds, and failed entries must be removed so the key can be retried.

**Why:** A global admission lock held across storage I/O lets one slow or hung download stall unrelated bundles. A bounded completed cache still controls retained parsed data, while a per-download timeout lets failed reads release their in-flight entry.

**How to apply:** Keep same-key in-flight reads shared, but never await storage work under a global lock. Only evict settled entries, trim after completion, and test concurrent misses, failed-load retry, and timeout cancellation.