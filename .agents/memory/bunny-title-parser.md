---
name: Bunny title parser formats
description: Bunny archive titles may omit the camera prefix while still carrying an ISO date and time.
---

Public archive filtering can receive Bunny titles in both `camN_YYYY-MM-DD_HH:MM` and bare `YYYY-MM-DD_HH:MM` forms. The bare form must remain parseable by the frontend archive calendar; otherwise the API can return an allowed video that the UI silently drops.

**Why:** A production recording was enabled and matched its whitelist, but its bare date/time title was rejected by the public page parser.

**How to apply:** When adding or changing Bunny title formats, update both the public field archive parser and the admin import parser, and add a regression test for each accepted shape.