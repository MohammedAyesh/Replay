---
name: Shirt-number identity
description: Correctness constraints for deriving player identities from jersey-number sidecars in the claim flow.
---

For each pipeline group, choose the shirt number with the greatest sum of `seenFrames` across its numbered tracks. If the group's tracks report different numbers, keep the weighted winner but mark the group uncertain. A player identity is the pair of shirt number and kit key; never merge players by number alone. If a kit key is unavailable, do not create a pair identity.

**Why:** The same shirt number can appear on opposing kits. A number-only merge can silently assign one player's playing time to an opponent.

**How to apply:** When building number-based choices or carrying identities between chunks, key by both number and kit. Preserve uncertain groups for explicit confirmation; a weighted winner is not itself a verified claim.