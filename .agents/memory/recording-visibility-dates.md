---
name: Recording visibility dates
description: The recording visibility model uses exact whitelisted dates rather than recurring weekdays.
---

Recording visibility is controlled by per-field entries containing an exact calendar date and a start/end time window. A future date may be whitelisted before any recording exists; matching Bunny titles are evaluated directly, so visibility does not depend on manually importing rows into the database.

**Why:** Recurring weekday rules could expose the wrong recording dates and did not support scheduling a specific future event.

**How to apply:** Keep server-side and admin preview matching on `allowedDate`, `startTime`, and `endTime`. The public Bunny collection route should parse current ISO-style and legacy compact titles, with imported database rows retained only as compatibility support. The admin Recordings tab should remain calendar-first and should not reintroduce a long recording list or weekday selector.