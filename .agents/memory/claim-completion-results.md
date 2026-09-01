---
name: Claim completion and results
description: Rules for keeping Claim Match completion authoritative while exposing honest tracking results.
---

Claim Match completion must be monotonic across ordinary progress saves: an older save may not clear a completed claim, while an explicit correction undo can intentionally recalculate it. Completed results should come only from accepted tracking intervals and bundle events; unsupported football metrics must remain clearly unavailable rather than guessed as zero.

**Why:** Final identity answers and periodic progress saves can arrive out of order, and the tracking bundle does not contain calibration or reliable attribution for distance, speed, touches, goals, or assists.

**How to apply:** Preserve completed state in ordinary progress upserts, refresh the active recording query after queued writes, and keep result fields server-derived and typed end to end.