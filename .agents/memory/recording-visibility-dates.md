---
name: Recording visibility dates
description: The recording visibility model uses exact whitelisted dates rather than recurring weekdays.
---

Recording visibility is controlled by per-field entries containing an exact calendar date and a start/end time window. A future date may be whitelisted before any recording exists; when a matching Bunny recording is imported, it becomes visible automatically.

**Why:** Recurring weekday rules could expose the wrong recording dates and did not support scheduling a specific future event.

**How to apply:** Keep server-side and admin preview matching on `allowedDate`, `startTime`, and `endTime`. The admin Recordings tab should remain calendar-first and should not reintroduce a long recording list or weekday selector.