---
name: VPS1 re-clip replayability
description: Evidence required before treating an external-worker clip export as replayable.
---

Do not mark a VPS1 re-clip snapshot replayable unless the worker reports the exact selected input source and its decoded dimensions. A successful status and output URL alone are not enough.

**Why:** The worker can select a different rendition than the local renderer. Without its source identity and geometry, later replay cannot be compared or validated safely.

**How to apply:** Keep the snapshot and output metadata, mark it non-replayable, and exclude the clip from snapshot-gated batch work until the worker protocol includes those fields.
