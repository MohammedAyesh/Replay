---
name: Claim Match queue rejections
description: Offline Claim Match queue flushing must separate invalid payloads from transient delivery failures.
---

Treat ordinary permanent client validation rejections as discardable queued actions and continue flushing later actions; keep network and retryable HTTP failures queued and stop the drain.

**Why:** One invalid offline answer should not block every later answer, while transient outages must not lose user work.

**How to apply:** Use the HTTP status on the API error, exempt retryable client statuses such as conflict, timeout, throttling, and request-too-early, and surface discarded-action feedback in the UI.