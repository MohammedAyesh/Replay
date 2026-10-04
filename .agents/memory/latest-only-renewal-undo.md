---
name: Latest-only renewal undo
description: Preserve distinct missing-record and stale-latest responses in owner-scoped undo routes.
---

For a latest-only undo, first verify that the requested record exists for the scoped player and academy; only then compare it with the latest record. A missing or already-removed renewal should return 404, while an existing but older renewal should return 409.

**Why:** Checking only the latest renewal first made a retry for an already-deleted renewal look like a conflict, despite the API's missing-resource contract.

**How to apply:** In renewal undo or similar latest-only deletion routes, validate target existence and ownership before checking recency, then test both missing and older IDs.