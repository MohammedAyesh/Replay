---
name: Roster substitute derivation
description: How analysis roster hints derive a shared substitute count from team RSVP data.
---

When a match room has one shared `substitutesPerTeam` value, use the stored number when present. Otherwise derive `max(0, in-player count - playersPerSide)` for each active team and take the largest result. Count only RSVP `in` players for this derivation; `maybe` players still contribute to squad size and known-shirt-number hints. Keep `totalPlayersExpected = playersPerSide * teamCount + substitutesPerTeam` as a single shared substitute allowance.

**Why:** The room stores one shared substitute setting rather than a value per team, and the total-player estimate uses that shared scalar. Taking the largest confirmed surplus avoids understating the fullest active team without summing per-team extras.

**How to apply:** Use this rule whenever analysis hints are built from a room roster. If the room data model changes to per-team substitute counts, update both the derivation and total-player formula together.