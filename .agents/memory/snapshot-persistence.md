---
name: Best-effort render snapshots
description: Snapshot persistence must not gate completed renders or clip exports.
---

Render output completion is primary. Mark the render/export complete first, then persist its snapshot asynchronously. Snapshot database or asset failures should be logged and reduce replayability rather than fail or hold the output. Avoid snapshot-only hashing or network work on the user clip completion path.

**Why:** The user explicitly requires snapshot persistence to be best-effort so clips remain available even when snapshot storage is slow or unavailable.

**How to apply:** Use this rule for every renderer, clip-export path, and failover that writes to `render_snapshots`. Fail only for errors in generating or publishing the actual output.
