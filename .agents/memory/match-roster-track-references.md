---
name: Match roster track references
description: The input format and frame-bound source for optional match rosters.
---

`people/match.json` does not carry frame numbers or frame ranges. Each player's `parts` are pairs of `[segmentName, localTrackId]`; derive the claim range from that track's existing start/end frames in the named bundle segment. `minutes` is already a duration.

**Why:** Applying a segment offset or expecting time bounds from the roster sidecar assigns the wrong footage to a player.

**How to apply:** Resolve each pair against the already-parsed segment track IDs, namespace the track for claim storage, and preserve optional-roster behavior when a pair is malformed or references a missing track.