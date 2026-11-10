---
name: Owner footage failed-job recovery
description: Recovery polling and the limits of its process-local throttle.
---

Recent failed owner footage requests with a server job ID can be rechecked for three days. Background polling is throttled per request for ten minutes in process memory; admin rechecks bypass that throttle. Only ready/done or partial server results may use normal completion logic. Negative statuses, missing jobs, and errors must not alter the failed row.

**Why:** Recovery must preserve a failed request until the remote job confirms usable footage, while avoiding a schema change for transient poll timing.

**How to apply:** If the throttle must span process restarts or multiple replicas, add durable atomic poll state; otherwise keep this recovery path read-only until a successful completion.
