---
name: Recording visibility dates
description: The recording visibility model uses exact whitelisted dates rather than recurring weekdays.
---

Recording visibility is controlled by per-field entries containing an exact calendar date and a start/end time window. The selected date is the window's start date. When the end time is earlier than the start time, the window continues into the following calendar date and still ends exclusively. A future date may be whitelisted before any recording exists; matching Bunny titles are evaluated directly, so visibility does not depend on manually importing rows into the database.

**Why:** Recurring weekday rules could expose the wrong recording dates and did not support scheduling a specific future event. Comparing overnight clock times as if they were on one date made valid windows such as 23:00–01:00 impossible to match.

**How to apply:** Use the shared schedule matcher for both server visibility and admin preview so their date rollover rules cannot drift. Treat `00:00` as the exclusive end at midnight for evening windows such as `20:00–00:00`. The public Bunny collection route should parse current ISO-style and legacy compact titles, with imported database rows retained only as compatibility support. The admin Recordings tab should remain calendar-first and should not reintroduce a long recording list or weekday selector.