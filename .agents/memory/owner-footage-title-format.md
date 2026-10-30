---
name: Owner footage title format
description: Machine-readable Bunny title convention for footage requested from the owner console.
---

Generated owner-request footage is titled:

`cam{N}_owner-{requestId}_{YYYY-MM-DD}_{HH:MM}`

The date and time are the Amman-local booking start, not the end time. A booking that crosses midnight keeps the start date. On first import only, this marker makes an owner-requested recording visible by default. The persisted recording visibility flag remains authoritative afterward.

**Why:** Field owners explicitly request these games, so requiring a separate admin visibility toggle delayed access. Re-syncing must not override later admin choices to hide or show a recording.

**How to apply:** Recognize the generated owner marker only while creating a new imported recording and set its initial `isVisible` value. Never infer ongoing access from the title or overwrite visibility on an existing row during sync; field-level hiding remains authoritative.