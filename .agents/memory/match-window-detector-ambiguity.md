---
name: Match-window detector ambiguity
description: How to handle multiple separate games in one recording when the detector lacks booking context.
---

When in-play spans split into multiple games, phase labels alone do not establish which game belongs to the booking. Do not select the first or last group based on position or phase count; return no detector window and leave the recording for admin review. An existing admin-owned match window always takes precedence over a detector proposal or tracking replacement.

**Why:** The booked match may be either earlier or later in a long recording. Guessing can silently remove valid footage from a player's claim and statistics; replacing an admin's explicit correction would reintroduce a known mistake.

**How to apply:** Any automatic match-window rule that sees multiple separated game groups must use reliable booking/time context before selecting a group; otherwise fail closed. Preserve admin ownership when a bundle is replaced or reprocessed.
