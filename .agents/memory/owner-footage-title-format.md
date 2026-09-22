---
name: Owner footage title format
description: Machine-readable Bunny title convention for footage requested from the owner console.
---

Owner-requested footage is titled:

`cam{N}_owner-{requestId}_{YYYY-MM-DD}_{HH:MM}`

The date and time are the Amman-local booking start, not the end time. A booking that crosses midnight keeps the start date. This remains compatible with the existing Format C parser used by the public archive and admin recordings views.

**Why:** Owner footage must be identifiable and excluded from public archive listings without relying on human-readable field names or a legacy parenthetical marker.

**How to apply:** Build titles from the field camera identifier and request id at queue time. Treat the title as private-owner media when filtering public Bunny videos.