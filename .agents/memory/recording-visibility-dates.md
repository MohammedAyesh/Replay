---
name: Recording visibility dates
description: The recording visibility model uses exact whitelisted dates rather than recurring weekdays.
---

Unimported Bunny videos are visible according to per-field entries containing an exact calendar date and a start/end time window. The selected date is the window's start date. When the end time is earlier than the start time, the window continues into the following calendar date and still ends exclusively. An imported recording explicitly marked Visible by an admin bypasses this schedule; one marked hidden stays hidden. A future date may be whitelisted before any recording exists, and matching Bunny titles are evaluated directly without requiring a database import.

**Why:** Recurring weekday rules could expose the wrong recording dates and did not support scheduling a specific future event. Same-day clock comparisons made valid overnight windows impossible to match, while requiring a schedule after an admin explicitly enabled Visible made the toggle misleading.

**How to apply:** Use the shared schedule matcher for unimported Bunny titles and preserve its next-date rollover. Apply explicit recording visibility before schedule matching on every imported-recording listing and media route, while keeping field-level hiding authoritative. Treat `00:00` as the exclusive end at midnight for windows such as `20:00–00:00`. The admin Recordings tab should remain calendar-first and should not reintroduce a long recording list or weekday selector.