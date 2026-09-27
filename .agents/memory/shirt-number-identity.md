---
name: Shirt-number identity
description: Correctness constraints for deriving player identities from jersey-number sidecars in the claim flow.
---

For each pipeline group, choose the shirt number with the greatest sum of `seenFrames` across its numbered tracks. If the group's tracks report different numbers, keep the weighted winner but mark the group uncertain. A player identity is the pair of shirt number and kit key; never merge players by number alone. If a kit key is unavailable, do not create a pair identity.

**Why:** The same shirt number can appear on opposing kits, and sidecar readings can conflict. A number-only merge can assign time to an opponent; a weighted winner alone is not proof.

**How to apply:** Key number choices and later-chunk matches by both number and kit. Only picture confirmation establishes the game-wide identity; match it as each later chunk loads, and use the ordinary prompt when no exact pair is found. Do not preload all chunks to search.