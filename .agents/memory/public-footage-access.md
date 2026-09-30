---
name: Public footage access
description: Shared authorization rules for public recordings, Bunny media, clips, and owner-request footage.
---

Public footage responses must keep hidden fields and explicitly hidden imported recordings private. An imported recording marked Visible by an admin bypasses date/time schedules; unimported Bunny videos still require a matching exact-date schedule. Owner-request videos are not excluded separately, and media proxies must authorize the underlying video using the same rules.

**Why:** Admins need a direct per-recording override when a schedule is missing or incorrect, while field-level hiding and an explicit per-recording hide must continue to protect footage.

**How to apply:** Extend the shared public-footage context and authorization helpers when adding a new public recording, clip, Bunny, or media-proxy route. Check field hiding first; then apply the imported recording's explicit visibility flag, and use schedules for unimported title-derived videos. Do not reintroduce owner-specific exclusion.