---
name: Owner footage title format
description: Machine-readable Bunny title convention for footage requested from the owner console.
---

Generated owner-request footage is titled:

`cam{N}_owner-{requestId}_{YYYY-MM-DD}_{HH:MM}`

The date and time are the Amman-local booking start, not the end time. A booking that crosses midnight keeps the start date. The title marker is operational metadata and does not decide whether the video is public.

**Why:** Owner-request videos are now public when they satisfy the same field visibility, recording visibility, and schedule rules as other recordings.

**How to apply:** Keep generated titles useful for camera/request identification, but do not use the `owner` marker as an access-control check.