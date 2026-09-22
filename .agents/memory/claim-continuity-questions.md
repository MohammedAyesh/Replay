---
name: Claim continuity questions
description: The contract and data-boundary decision for identity claim interruptions caused by tracking continuity evidence.
---

Internal detection gaps longer than two seconds and changes in optional per-track kit readings are surfaced as a continuity uncertainty. The tracking payload remains unchanged; kit readings are read defensively only when a published bundle already carries them.

**Why:** The claim flow needs to question evidence that a source track resumed as a different player, but the VPS/analysis output and stored tracking format are explicitly out of scope for claim-page fixes.

**How to apply:** Keep continuity as an explicit uncertainty kind in the API contract, and treat absent or unrecognised optional kit metadata as no kit evidence rather than inventing a new bundle field.